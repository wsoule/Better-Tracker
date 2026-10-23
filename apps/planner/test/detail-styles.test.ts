import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// The detail pages (the issue drawer and page host, Runs and a run,
// Settings, Setup, the landing and sign-in page, the error and loading
// states, and the task gallery) in the Gr8r look (owner decision
// 2026-10-23, design doc §12; docs/architecture.md §8.2): their
// stylesheets read only the Gr8r token names (the old Analytics names,
// removed from the ui package's tokens.css), write no hex of their own,
// draw no mono caps, no hairline collapses and no removed outline, and
// their pages number no sections and print no "404" / "ERR" / "SYNC"
// keys.

const appDir = path.join(import.meta.dir, '..', 'app');

/** Directories (every file under them) and single files of the lane. */
const LANE_DIRS = [
  '(app)/components',
  '(app)/runs',
  '(app)/settings',
  '(app)/setup',
  '(gallery)/ui-gallery/task',
];
const LANE_FILES = [
  '(app)/page.tsx',
  '(app)/page.module.css',
  '(app)/error.tsx',
  '(app)/not-found.tsx',
  '(app)/loading.tsx',
  '(app)/loading.module.css',
  '(app)/issues/[id]/issue-page-view.tsx',
  '(app)/issues/[id]/page.tsx',
  'global-error.tsx',
];

/** The pre-Gr8r token names (packages/ui/test/contrast-helpers.ts). */
const RETIRED = [
  '--paper',
  '--ink',
  '--background',
  '--foreground',
  '--muted',
  '--ink-soft',
  '--grey',
  '--grey-2',
  '--grey-2-ink',
  '--grey-3',
  '--grey-4',
  '--tint',
  '--hairline-faint',
  '--hatch',
  '--red-ink',
  '--amber-ink',
  '--amber-ink-strong',
  '--green-ink',
  '--blue-ink',
  '--muted-inverse',
  '--ink-soft-inverse',
  '--hairline-inverse',
  '--ease-out-quint',
  '--ease-out-expo',
];

/** Every file under a directory of the app, as paths relative to it. */
function walk(dir: string): string[] {
  return readdirSync(path.join(appDir, dir)).flatMap((name) => {
    const file = path.join(dir, name);
    return statSync(path.join(appDir, file)).isDirectory()
      ? walk(file)
      : [file];
  });
}

/** Every lane file of a kind, comments stripped. */
function sources(pattern: RegExp): { file: string; text: string }[] {
  return [...LANE_DIRS.flatMap(walk), ...LANE_FILES]
    .filter((file) => pattern.test(file))
    .map((file) => ({
      file,
      text: readFileSync(path.join(appDir, file), 'utf8').replace(
        /\/\*[\s\S]*?\*\//g,
        ''
      ),
    }));
}

describe('the detail pages are in the Gr8r look', () => {
  const sheets = sources(/\.css$/);
  const pages = sources(/\.tsx?$/);

  test('there are sheets and pages to check', () => {
    expect(sheets.length).toBeGreaterThanOrEqual(10);
    expect(pages.length).toBeGreaterThanOrEqual(25);
  });

  test('no stylesheet or page reads a retired token name', () => {
    const found: string[] = [];
    for (const { file, text } of [...sheets, ...pages]) {
      for (const name of RETIRED) {
        if (new RegExp(`${name}(?![\\w-])`).test(text)) {
          found.push(`${file}: ${name}`);
        }
      }
    }
    expect(found).toEqual([]);
  });

  test('no stylesheet writes a hex, mono caps, a -1px collapse or a removed outline', () => {
    const found: string[] = [];
    for (const { file, text } of sheets) {
      if (/#[0-9a-f]{3,8}\b/i.test(text)) found.push(`${file}: a hex`);
      if (/text-transform:\s*uppercase/.test(text)) {
        found.push(`${file}: uppercase`);
      }
      if (/margin(-top)?:\s*-1px/.test(text)) found.push(`${file}: -1px`);
      if (/outline:\s*(none|0)\s*;/.test(text)) {
        found.push(`${file}: outline none`);
      }
    }
    expect(found).toEqual([]);
  });

  test('no page numbers its sections or prints a code key', () => {
    const found: string[] = [];
    for (const { file, text } of pages) {
      if (/<BlockBar[^>]*\sindex=/.test(text)) found.push(`${file}: index`);
      if (/className="blockKey"|padStart\(2, '0'\)/.test(text)) {
        found.push(`${file}: a numbered key`);
      }
      if (/index="(404|ERR|SYNC|500)"/.test(text)) {
        found.push(`${file}: a code key`);
      }
      // Mono caps copy, now sentence case ("Demo data", "First sync
      // pending").
      if (/label="[A-Z][A-Z -]{3,}"/.test(text)) {
        found.push(`${file}: a caps label`);
      }
    }
    expect(found).toEqual([]);
  });
});
