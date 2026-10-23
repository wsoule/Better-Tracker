import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The whole planner app is in the Gr8r look (owner decision 2026-10-23,
// design doc §12; docs/architecture.md §8.2 "Old token names"): no file
// under app/ reads one of the deprecated Analytics names that the ui
// package's tokens.css still declares as migration aliases, and no sheet
// writes a colour of its own. The per-lane tests (lists-styles,
// detail-styles, graph-styles, timeline-tones-render) say more about
// their screens; this one covers every file, so a sheet added later, or
// one merged in from a branch written before the restyle, fails here
// until it uses the Gr8r names.

const appDir = path.join(import.meta.dir, '..', 'app');

const tokensCss = readFileSync(
  path.join(
    import.meta.dir,
    '..',
    '..',
    '..',
    'packages',
    'ui',
    'src',
    'styles',
    'tokens.css'
  ),
  'utf8'
);

/** The retired names: every custom property tokens.css declares in its
    MIGRATION ALIASES block (up to the light theme's colour-scheme). */
const RETIRED = [
  ...tokensCss
    .slice(
      tokensCss.indexOf('MIGRATION ALIASES'),
      tokensCss.indexOf('color-scheme: light;')
    )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .matchAll(/^\s*(--[\w-]+)\s*:/gm),
].map((match) => match[1] ?? '');

/** Every .css, .ts and .tsx file under a directory, comments stripped. */
function sources(dir: string): { file: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    if (!/\.(css|tsx?)$/.test(entry.name)) return [];
    const text = readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    return [{ file: path.relative(appDir, full), text }];
  });
}

describe('the planner app uses only the Gr8r tokens', () => {
  const files = sources(appDir);

  test('the alias block and the app files are found', () => {
    expect(RETIRED).toContain('--paper');
    expect(RETIRED).toContain('--grey-2-ink');
    expect(RETIRED).toContain('--ease-out-expo');
    expect(files.length).toBeGreaterThan(100);
  });

  test('no file reads or sets a retired name', () => {
    const found = files.flatMap(({ file, text }) =>
      RETIRED.filter((name) => new RegExp(`${name}(?![\\w-])`).test(text)).map(
        (name) => `${file}: ${name}`
      )
    );
    expect(found).toEqual([]);
  });

  test('no stylesheet writes a hex colour of its own', () => {
    const found = files
      .filter(({ file }) => file.endsWith('.css'))
      .flatMap(({ file, text }) =>
        [...text.matchAll(/#[0-9a-f]{3,8}\b/gi)].map(
          (match) => `${file}: ${match[0]}`
        )
      );
    expect(found).toEqual([]);
  });
});
