import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The graph page and the graph gallery in the Gr8r look (owner decision
// 2026-10-23, design doc §12; docs/architecture.md §8.2, §8.4 Graph):
// their stylesheets read only the Gr8r token names (the old Analytics
// names are deprecated aliases in the ui package's tokens.css), write no
// hex of their own, draw no mono caps and no hairline collapses, and their
// pages number no sections. The package's own graph files are checked by
// packages/ui/test/graph-contrast.test.ts.

const appDir = path.join(import.meta.dir, '..', 'app');

const GRAPH_DIRS = ['(app)/graph', '(gallery)/ui-gallery/graph'];

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

/** Every file of a kind in the graph directories, comments stripped. */
function sources(pattern: RegExp): { file: string; text: string }[] {
  return GRAPH_DIRS.flatMap((dir) =>
    readdirSync(path.join(appDir, dir))
      .filter((name) => pattern.test(name))
      .map((name) => {
        const file = path.join(dir, name);
        const text = readFileSync(path.join(appDir, file), 'utf8').replace(
          /\/\*[\s\S]*?\*\//g,
          ''
        );
        return { file, text };
      })
  );
}

describe('the graph page and gallery are in the Gr8r look', () => {
  const sheets = sources(/\.css$/);
  const pages = sources(/\.tsx?$/);

  test('there are sheets and pages to check', () => {
    expect(sheets.length).toBe(2);
    expect(pages.length).toBeGreaterThanOrEqual(6);
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

  test('no stylesheet writes a hex, mono caps or a -1px collapse', () => {
    const found: string[] = [];
    for (const { file, text } of sheets) {
      if (/#[0-9a-f]{3,8}\b/i.test(text)) found.push(`${file}: a hex`);
      if (/text-transform:\s*uppercase/.test(text)) {
        found.push(`${file}: uppercase`);
      }
      // Caps tracking in raw ems; the title's --ls-title token is Gr8r's.
      if (/letter-spacing:\s*0?\.\d+em/.test(text)) {
        found.push(`${file}: tracking`);
      }
      if (/margin(-top)?:\s*-1px/.test(text)) found.push(`${file}: -1px`);
      if (/outline:\s*(none|0)\s*;/.test(text)) {
        found.push(`${file}: outline none`);
      }
    }
    expect(found).toEqual([]);
  });

  test('no page numbers its sections', () => {
    const found = pages
      .filter(({ text }) => /<BlockBar[^>]*\sindex=/.test(text))
      .map(({ file }) => file);
    expect(found).toEqual([]);
  });

  test('no flag is written in caps', () => {
    // The node tags are sentence-case words now (ui GraphNodeTag).
    const found = pages
      .filter(({ text }) =>
        /'(UNASSIGNED|OVERDUE|CYCLE|INACTIVE|NO LEAD)'/.test(text)
      )
      .map(({ file }) => file);
    expect(found).toEqual([]);
  });
});
