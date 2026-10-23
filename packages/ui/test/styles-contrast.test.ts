import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Text contrast of the colour tokens (WCAG AA: 4.5:1 for small text; the
// smallest text is 11px), computed from tokens.css itself in both themes:
// every text token on every surface it can sit on, every tone's text on
// its own soft tint, and the text that sits on a fill. Plus a guard that
// the retired pre-Gr8r token names stay gone.

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
// accent's text step and the semantic hues.
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

    test(`${theme}: text on fills`, () => {
      const pairs: [string, string][] = [
        ['--on-accent', '--accent'],
        ['--on-danger', '--red'],
        ['--text-inv', '--text'],
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

});

// Non-text contrast (WCAG 1.4.11, 3:1): what tells a control, its state
// or a meaningful mark from what is around it. The soft lines (--border,
// --border-strong, --divider) are decoration and are not checked; these
// are the edges and marks a person must be able to see.
const NON_TEXT_SURFACES = [
  '--bg',
  '--bg-side',
  '--surface',
  '--surface-2',
  '--surface-3',
  '--sunken',
];
const NON_TEXT: [mark: string, why: string][] = [
  // the edge of a field, a checkbox, the switch's off track
  ['--control-border', 'control boundary'],
  // the focus ring, the active-option bar, the selected segment's ring,
  // a checked box, the on switch
  ['--accent', 'focus ring and selection'],
  // the current nav item's icon
  ['--accent-ink', 'current nav icon'],
  // StatusMark's diamonds: the status hues and the muted grey
  ['--red', 'status mark'],
  ['--amber', 'status mark'],
  ['--green', 'status mark'],
  ['--gray', 'muted status mark'],
  // StateGlyph's workflow colours (the state name sits beside them, but
  // the glyph's shape and hue are what a scanning eye reads)
  ['--st-triage', 'state glyph'],
  ['--st-backlog', 'state glyph'],
  ['--st-todo', 'state glyph'],
  ['--st-progress', 'state glyph'],
  ['--st-review', 'state glyph'],
  ['--st-done', 'state glyph'],
  ['--st-canceled', 'state glyph'],
];

describe('non-text marks meet 3:1 in both themes', () => {
  for (const [theme, tokens] of [
    ['light', lightTokens],
    ['dark', darkTokens],
  ] as const) {
    test(`${theme}: control edges, focus and status marks on every surface`, () => {
      const failing: string[] = [];
      for (const [mark, why] of NON_TEXT) {
        for (const surface of NON_TEXT_SURFACES) {
          const ratio = contrast(hex(tokens, mark), hex(tokens, surface));
          if (ratio < 3)
            failing.push(`${mark} (${why}) on ${surface}: ${ratio}`);
        }
      }
      expect(failing).toEqual([]);
    });

    test(`${theme}: the accent on its own soft tint (a selected row's bar)`, () => {
      const share = tintShare(lightTokens, '--accent-soft');
      const failing: string[] = [];
      for (const base of TINT_BASES) {
        const ground = over(hex(tokens, '--accent'), hex(tokens, base), share);
        const ratio = contrast(hex(tokens, '--accent'), ground);
        if (ratio < 3)
          failing.push(`--accent on --accent-soft/${base}: ${ratio}`);
      }
      expect(failing).toEqual([]);
    });

    test(`${theme}: the switch knob on its track, off and on`, () => {
      // The knob is --on-accent; off it sits on --control-border, on it
      // sits on --accent.
      for (const track of ['--control-border', '--accent']) {
        const ratio = contrast(hex(tokens, '--on-accent'), hex(tokens, track));
        expect({ track, ok: ratio >= 3 }).toEqual({ track, ok: true });
      }
    });
  }

  test('fields, checkboxes and the switch use the control edge, not the soft line', () => {
    const read = (file: string) =>
      readFileSync(path.join(srcDir, file), 'utf8').replace(
        /\/\*[\s\S]*?\*\//g,
        ''
      );
    expect(read('styles/primitives.css')).toContain(
      'border: 1px solid var(--control-border);'
    );
    expect(read('tasks/checkbox.module.css')).toContain(
      'border: 1.5px solid var(--control-border);'
    );
    expect(read('tasks/switch.module.css')).toContain(
      'background: var(--control-border);'
    );
  });
});

/** Every stylesheet and TypeScript source file under src. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(css|tsx?)$/.test(entry.name) ? [full] : [];
  });
}

// The pre-Gr8r names (aliases onto the Gr8r tokens while the screens
// migrated, and the text tokens of the old ink hover flood) were deleted
// once the dependency graph, the last screen on them, was restyled
// (docs/architecture.md §8.2). Nothing may declare or read them again.
const RETIRED = [
  '--paper',
  '--ink',
  '--background',
  '--foreground',
  '--muted',
  '--ink-soft',
  '--grey-2',
  '--grey-2-ink',
  '--grey-3',
  '--grey-4',
  '--tint',
  '--hairline-faint',
  '--hatch',
  '--accent-ink-inverse',
  '--muted-inverse',
  '--ink-soft-inverse',
  '--hairline-inverse',
  '--ease-out-quint',
  '--ease-out-expo',
];

describe('the retired token names are gone', () => {
  test('tokens.css declares none of them, in either theme', () => {
    const declared = RETIRED.filter(
      (name) => lightTokens.has(name) || darkTokens.has(name)
    );
    expect(declared).toEqual([]);
  });

  test('no stylesheet or component reads or sets one', () => {
    const found: string[] = [];
    const files = sourceFiles(srcDir);
    expect(files.some((file) => file.endsWith('tokens.css'))).toBe(true);
    for (const file of files) {
      const source = readFileSync(file, 'utf8').replace(
        /\/\*[\s\S]*?\*\//g,
        ''
      );
      for (const name of RETIRED) {
        // the name as a whole custom property: not --muted inside --muted-x
        if (new RegExp(`${name}(?![\\w-])`).test(source)) {
          found.push(`${path.relative(srcDir, file)}: ${name}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});
