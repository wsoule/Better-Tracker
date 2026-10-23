// Static checks that keep personal API keys where they belong
// (LINEAR_AUTH=api_key, architecture §11): never a Server Action argument
// (Next logs those in development), never an environment variable, the
// connect form a Server Component, every inline script nonce'd, and the
// image's process hardening in place.

import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const PLANNER = join(import.meta.dir, '..');
const ROOT = join(PLANNER, '..', '..');

// Every .ts/.tsx file under `dir` (node_modules, .next and dist skipped).
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === 'dist')
      continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

const plannerCode = [
  ...sources(join(PLANNER, 'app')),
  ...sources(join(PLANNER, 'lib')),
];

describe('no key leaks by construction', () => {
  test("no 'use server' module mentions apiKey", () => {
    const offenders = plannerCode.filter((path) => {
      const text = read(path);
      return /['"]use server['"]/.test(text) && /apiKey/i.test(text);
    });
    expect(offenders).toEqual([]);
  });

  test('no code assigns process.env', () => {
    const dirs = [
      join(PLANNER, 'app'),
      join(PLANNER, 'lib'),
      ...[
        'apps/worker',
        'packages/core',
        'packages/engine',
        'packages/linear',
        'packages/logger',
        'packages/notify',
        'packages/store',
        'packages/ui',
      ].map((dir) => join(ROOT, dir, 'src')),
    ];
    const offenders: string[] = [];
    for (const dir of dirs) {
      for (const path of sources(dir)) {
        const text = read(path);
        if (/process\.env(\.[A-Za-z_]+|\[[^\]]+\])\s*=(?!=)/.test(text)) {
          offenders.push(relative(ROOT, path));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the connect form lives in Server Component files', () => {
    for (const path of [
      'app/(app)/components/connect-key-block.tsx',
      'app/(app)/page.tsx',
    ]) {
      const text = read(join(PLANNER, path));
      expect(text).not.toMatch(/['"]use client['"]/);
    }
    expect(
      read(join(PLANNER, 'app/(app)/components/connect-key-block.tsx'))
    ).toContain('action="/api/auth/key"');
  });

  test('inline scripts are only in the three layouts, each with a nonce', () => {
    const withInline = plannerCode
      .filter((path) => read(path).includes('dangerouslySetInnerHTML'))
      .map((path) => relative(PLANNER, path))
      .sort();
    expect(withInline).toEqual([
      'app/(app)/layout.tsx',
      'app/(gallery)/layout.tsx',
      'app/(gallery)/ui-gallery/shell/page.tsx',
    ]);
    for (const path of withInline) {
      const text = read(join(PLANNER, path));
      const scripts = text.split('<script').slice(1);
      expect(scripts.length).toBeGreaterThan(0);
      for (const script of scripts) {
        const tag = script.slice(0, script.indexOf('/>'));
        expect(tag).toContain('nonce={nonce}');
      }
    }
  });

  test('the image disables SIGUSR1 and core dumps', () => {
    const dockerfile = read(join(ROOT, 'deploy/Dockerfile'));
    const runtime = dockerfile.slice(dockerfile.indexOf('AS runtime'));
    expect(runtime).toMatch(/NODE_OPTIONS=--disable-sigusr1/);
    const cmd = /^CMD \["sh", "-c", "(.*)"\]$/m.exec(runtime)?.[1] ?? '';
    expect(cmd.startsWith('ulimit -c 0 && ')).toBe(true);
  });

  test('there is no instrumentation hook capturing requests', () => {
    for (const name of [
      'instrumentation.ts',
      'instrumentation.js',
      'middleware.ts',
    ]) {
      expect(() => statSync(join(PLANNER, name))).toThrow();
    }
  });
});
