import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Text contrast of the colour tokens (WCAG AA: 4.5:1 for small text; the
// smallest text is 11px), computed from tokens.css itself in both themes:
// every text token on every surface it can sit on, every tone's text on
// its own soft tint, and the text that sits on a fill. Plus a guard that
// every hover flood that has not migrated yet swaps the text tokens.

const srcDir = path.join(import.meta.dir, '..', 'src');
const tokensCss = readFileSync(
  path.join(srcDir, 'styles', 'tokens.css'),
  'utf8'
).replace(/\/\*[\s\S]*?\*\//g, '');

/** Every `--name: value` declaration of the rule whose selector starts so. */
function tokenBlock(selectorStart: string): Map<string, string> {
  const at = tokensCss.indexOf(selectorStart);
  expect(at).toBeGreaterThanOrEqual(0);
  const open = tokensCss.indexOf('{', at);
  const body = tokensCss.slice(open + 1, tokensCss.indexOf('}', open));
  const out = new Map<string, string>();
  for (const declaration of body.split(';')) {
    const match = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(declaration);
    if (match !== null) {
      out.set(match[1] ?? '', (match[2] ?? '').replace(/\s+/g, ' '));
    }
  }
  return out;
}

const lightTokens = tokenBlock(':root:where(:not([data-bt-ui-scoped]))');
const darkTokens = new Map([
  ...lightTokens,
  ...tokenBlock("html[data-theme='dark']"),
]);

/** A token's hex value, following `var(--other)` aliases in the same
    theme; fails the test when it does not end in a literal hex. */
function hex(tokens: Map<string, string>, name: string): string {
  let value = tokens.get(name);
  for (let hops = 0; value !== undefined && hops < 5; hops++) {
    const alias = /^var\((--[\w-]+)\)$/.exec(value);
    if (alias === null) break;
    value = tokens.get(alias[1] ?? '');
  }
  expect({ name, value }).toEqual({
    name,
    value: expect.stringMatching(/^#[0-9a-f]{6}$/i),
  });
  return (value ?? '').toLowerCase();
}

function channels(color: string): number[] {
  return [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16));
}

function luminance(color: string): number {
  const [r, g, b] = channels(color).map((v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** `share` of `top` laid over `base`: what a color-mix(top N%, transparent)
    tint looks like on that surface. */
function over(top: string, base: string, share: number): string {
  const a = channels(top);
  const b = channels(base);
  return `#${a
    .map((v, i) =>
      Math.round(v * share + (b[i] ?? 0) * (1 - share))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`;
}

/** The percentage of a `color-mix(in srgb, var(--hue) N%, transparent)`. */
function tintShare(tokens: Map<string, string>, name: string): number {
  const match =
    /color-mix\(in srgb, var\(--[\w-]+\) (\d+)%, transparent\)/.exec(
      tokens.get(name) ?? ''
    );
  expect(match).not.toBeNull();
  return Number(match?.[1] ?? 0) / 100;
}

// Everything text can sit on, back to front.
const SURFACES = [
  '--bg',
  '--bg-side',
  '--surface',
  '--surface-2',
  '--surface-3',
  '--sunken',
];
// Text tokens: three text steps (--text-4 is for glyphs, never words), the
// accent's text step, the semantic hues, and the aliases old CSS still
// reads.
const TEXT = [
  '--text',
  '--text-2',
  '--text-3',
  '--accent-ink',
  '--accent-ink-hover',
  '--red',
  '--amber',
  '--green',
  '--blue',
  '--foreground',
  '--muted',
  '--ink-soft',
  '--grey-2-ink',
];
// Each tone's text on its own soft tint (a chip, a notice, a selected row),
// over the surfaces a tinted thing sits on.
const TINTS: [text: string, tint: string][] = [
  ['--accent-ink', '--accent-soft'],
  ['--red', '--red-soft'],
  ['--amber', '--amber-soft'],
  ['--green', '--green-soft'],
  ['--blue', '--blue-soft'],
];
const TINT_BASES = ['--surface', '--surface-2', '--bg-side'];

describe('text tokens meet 4.5:1 in both themes', () => {
  for (const [theme, tokens] of [
    ['light', lightTokens],
    ['dark', darkTokens],
  ] as const) {
    test(`${theme}: every text token on every surface`, () => {
      const failing: string[] = [];
      for (const text of TEXT) {
        for (const surface of SURFACES) {
          const ratio = contrast(hex(tokens, text), hex(tokens, surface));
          if (ratio < 4.5) failing.push(`${text} on ${surface}: ${ratio}`);
        }
      }
      expect(failing).toEqual([]);
    });

    test(`${theme}: each tone's text on its own soft tint`, () => {
      const failing: string[] = [];
      for (const [text, tint] of TINTS) {
        const share = tintShare(lightTokens, tint);
        for (const base of TINT_BASES) {
          const ground = over(hex(tokens, text), hex(tokens, base), share);
          const ratio = contrast(hex(tokens, text), ground);
          if (ratio < 4.5) failing.push(`${text} on ${tint}/${base}: ${ratio}`);
        }
      }
      expect(failing).toEqual([]);
    });

    test(`${theme}: text on fills and on an ink flood`, () => {
      const pairs: [string, string][] = [
        ['--on-accent', '--accent'],
        ['--on-danger', '--red'],
        ['--text-inv', '--text'],
        ['--accent-ink-inverse', '--ink'],
        ['--muted-inverse', '--ink'],
        ['--ink-soft-inverse', '--ink'],
      ];
      for (const [text, fill] of pairs) {
        expect({
          text,
          fill,
          ok: contrast(hex(tokens, text), hex(tokens, fill)) >= 4.5,
        }).toEqual({ text, fill, ok: true });
      }
    });
  }

  test('the fill accent is one purple in both themes', () => {
    expect(hex(lightTokens, '--accent')).toBe('#9747ff');
    expect(hex(darkTokens, '--accent')).toBe('#9747ff');
  });

  test('the blueprint hatch is retired', () => {
    expect(lightTokens.get('--hatch')).toBe('transparent');
    expect(darkTokens.get('--hatch')).toBe('transparent');
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
