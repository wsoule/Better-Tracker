import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Text contrast of the colour tokens (WCAG AA: 4.5:1 for small text, and
// the mono labels are 9.5–10.5px), computed from tokens.css itself, and a
// guard that every hover flood swaps the text tokens with the paper/ink.

const srcDir = path.join(import.meta.dir, '..', 'src');
const tokensCss = readFileSync(
  path.join(srcDir, 'styles', 'tokens.css'),
  'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '');

/** The `--name: #hex` declarations of the rule whose selector starts so. */
function tokenBlock(selectorStart: string): Map<string, string> {
  const at = tokensCss.indexOf(selectorStart);
  expect(at).toBeGreaterThanOrEqual(0);
  const open = tokensCss.indexOf('{', at);
  const body = tokensCss.slice(open + 1, tokensCss.indexOf('}', open));
  const out = new Map<string, string>();
  for (const match of body.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{3,6})\s*;/gi)) {
    out.set(match[1] ?? '', (match[2] ?? '').toLowerCase());
  }
  return out;
}

function luminance(hex: string): number {
  const full =
    hex.length === 4
      ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
      : hex;
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const light = tokenBlock(':root:where(:not([data-bt-ui-scoped]))');
const dark = {
  ...Object.fromEntries(light),
  ...Object.fromEntries(tokenBlock("html[data-theme='dark']")),
};
const lightTokens = Object.fromEntries(light);

describe('text tokens meet 4.5:1 in both themes', () => {
  for (const [theme, t] of [
    ['light', lightTokens],
    ['dark', dark],
  ] as const) {
    test(theme, () => {
      const paper = t['--paper'] ?? '';
      const ink = t['--ink'] ?? '';
      // Accent text on the paper, hovered, and on an ink hover flood.
      expect(contrast(t['--accent-ink'] ?? '', paper)).toBeGreaterThanOrEqual(
        4.5
      );
      expect(
        contrast(t['--accent-ink-hover'] ?? '', paper)
      ).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(t['--accent-ink-inverse'] ?? '', ink)
      ).toBeGreaterThanOrEqual(4.5);
      // Dim grey text, and the muted inverse it becomes on a flood.
      expect(contrast(t['--grey-2-ink'] ?? '', paper)).toBeGreaterThanOrEqual(
        4.5
      );
      expect(contrast(t['--muted-inverse'] ?? '', ink)).toBeGreaterThanOrEqual(
        4.5
      );
    });
  }

  test('the fill accent is one purple in both themes', () => {
    expect(lightTokens['--accent']).toBe('#9747ff');
    expect(dark['--accent']).toBe('#9747ff');
  });
});

/** Every CSS file under src. */
function cssFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(full);
    return entry.name.endsWith('.css') ? [full] : [];
  });
}

describe('hover floods swap the text tokens', () => {
  test('a block that floods with ink also swaps accent and dim text', () => {
    const missing: string[] = [];
    for (const file of cssFiles(srcDir)) {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const match of css.matchAll(/\{([^{}]*)\}/g)) {
        const body = match[1] ?? '';
        if (!/--background:\s*var\(--ink\)/.test(body)) continue;
        for (const name of [
          '--accent-ink',
          '--accent-ink-hover',
          '--grey-2-ink',
        ]) {
          if (!new RegExp(`${name}:`).test(body)) {
            missing.push(`${path.relative(srcDir, file)}: ${name}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
