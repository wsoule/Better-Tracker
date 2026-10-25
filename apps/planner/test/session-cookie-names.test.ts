import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// lib/session-cookies.ts is the only place the planner chooses, reads or
// writes its auth cookies (architecture §8.1 "Session cookies"): one
// missed reader of a plain `mp_session` would sign everyone out on an
// https deployment, where the names are __Host- ones. This scans the app's
// source (app/, lib/, proxy.ts; comments stripped) for a session or OAuth
// cookie name, the old constants, or readCookie(), outside that file.

const ROOT = join(import.meta.dir, '..');
const HELPER = 'lib/session-cookies.ts';

const FORBIDDEN: readonly { what: string; pattern: RegExp }[] = [
  {
    what: 'an auth cookie name',
    pattern: /['"`](?:__Host-)?mp_(?:session|sessions|oauth)\b/,
  },
  {
    what: 'an old cookie constant',
    pattern:
      /\b(?:SESSION_COOKIE|OAUTH_COOKIE|HOST_SESSION_COOKIE|sessionCookieName|OAUTH_COOKIE_PATH)\b/,
  },
  { what: 'readCookie()', pattern: /\breadCookie\s*\(/ },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(?:ts|tsx)$/.test(name)) out.push(path);
  }
  return out;
}

/** The code without its comments (good enough for this scan). */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('auth cookie names live in lib/session-cookies.ts alone', () => {
  test('no other app file names or reads a session cookie', () => {
    const files = [
      ...sourceFiles(join(ROOT, 'app')),
      ...sourceFiles(join(ROOT, 'lib')),
      join(ROOT, 'proxy.ts'),
    ];
    expect(files.length).toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file);
      if (rel === HELPER) continue;
      const text = code(readFileSync(file, 'utf8'));
      for (const { what, pattern } of FORBIDDEN) {
        if (pattern.test(text)) offenders.push(`${rel}: ${what}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the scan would see them (the helper itself names them)', () => {
    const text = code(readFileSync(join(ROOT, HELPER), 'utf8'));
    expect(FORBIDDEN[0]?.pattern.test(text)).toBe(true);
    expect(FORBIDDEN[2]?.pattern.test(text)).toBe(true);
  });
});
