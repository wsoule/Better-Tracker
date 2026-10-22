import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// Text contrast of the colour tokens (WCAG AA: 4.5:1 for small text, and
// the mono labels are 9.5–10.5px; 3:1 for marks, outlines and bars),
// computed from tokens.css itself, and a guard that every hover flood swaps
// the text tokens with the paper/ink.

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

/** The `--name: rgba(r, g, b, a)` declaration in the block that starts so. */
function rgbaToken(
  selectorStart: string,
  name: string
): [number, number, number, number] {
  const at = tokensCss.indexOf(selectorStart);
  const open = tokensCss.indexOf('{', at);
  const body = tokensCss.slice(open + 1, tokensCss.indexOf('}', open));
  const match = new RegExp(
    `${name}:\\s*rgba\\(\\s*(\\d+),\\s*(\\d+),\\s*(\\d+),\\s*([\\d.]+)\\s*\\)`
  ).exec(body);
  expect(match).not.toBeNull();
  const [r, g, b, alpha] = (match ?? []).slice(1).map(Number);
  return [r ?? 0, g ?? 0, b ?? 0, alpha ?? 0];
}

/** An rgba wash composited over a solid hex, as a hex. */
function over(base: string, [r, g, b, alpha]: readonly number[]): string {
  return `#${[r, g, b]
    .map((channel, i) => {
      const under = Number.parseInt(base.slice(1 + i * 2, 3 + i * 2), 16);
      const mixed = Math.round(
        under * (1 - (alpha ?? 0)) + (channel ?? 0) * (alpha ?? 0)
      );
      return mixed.toString(16).padStart(2, '0');
    })
    .join('')}`;
}

/** The --tint hover wash over the paper, per theme. */
const tint = {
  light: over(
    lightTokens['--paper'] ?? '',
    rgbaToken(':root:where(:not([data-bt-ui-scoped]))', '--tint')
  ),
  dark: over(
    dark['--paper'] ?? '',
    rgbaToken("html[data-theme='dark']", '--tint')
  ),
};

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

// The status hues (owner decision 2026-10-22, architecture §8.2): each has a
// MARK colour (--<hue>), a TEXT colour (--<hue>-ink), the text colour for an
// ink hover flood (--<hue>-ink-inverse) and the text ON its fill (--on-<hue>).
const TEXT_HUES = ['red', 'amber', 'green', 'blue'] as const;
const MARK_HUES = [...TEXT_HUES, 'grey'] as const;

describe('status hues meet WCAG in both themes', () => {
  /** "name a:b x.xx" for every pair below `min`, so a failure names it. */
  function below(
    min: number,
    pairs: [string, string, string, string][]
  ): string[] {
    return pairs
      .map(([fgName, fg, bgName, bg]) => ({
        label: `${fgName} on ${bgName}`,
        ratio: contrast(fg, bg),
      }))
      .filter(({ ratio }) => !(ratio >= min))
      .map(({ label, ratio }) => `${label} ${ratio.toFixed(2)}`);
  }

  for (const [theme, t] of [
    ['light', lightTokens],
    ['dark', dark],
  ] as const) {
    const paper = t['--paper'] ?? '';
    const ink = t['--ink'] ?? '';
    const wash = tint[theme];
    const token = (name: string): string => t[name] ?? '(missing)';

    test(`${theme}: status text is 4.5:1 on the paper and the tint`, () => {
      const pairs = TEXT_HUES.flatMap(
        (hue): [string, string, string, string][] => [
          [`--${hue}-ink`, token(`--${hue}-ink`), 'paper', paper],
          [`--${hue}-ink`, token(`--${hue}-ink`), 'tint', wash],
        ]
      );
      expect(below(4.5, pairs)).toEqual([]);
    });

    test(`${theme}: status text on an ink flood is 4.5:1`, () => {
      const pairs = TEXT_HUES.map((hue): [string, string, string, string] => [
        `--${hue}-ink-inverse`,
        token(`--${hue}-ink-inverse`),
        'ink',
        ink,
      ]);
      expect(below(4.5, pairs)).toEqual([]);
    });

    test(`${theme}: status marks are 3:1 on the paper, the tint and a flood`, () => {
      const pairs = MARK_HUES.flatMap(
        (hue): [string, string, string, string][] => [
          [`--${hue}`, token(`--${hue}`), 'paper', paper],
          [`--${hue}`, token(`--${hue}`), 'tint', wash],
          [`--${hue}`, token(`--${hue}`), 'ink', ink],
        ]
      );
      expect(below(3, pairs)).toEqual([]);
    });

    test(`${theme}: text on a status fill is 4.5:1`, () => {
      const pairs = TEXT_HUES.map((hue): [string, string, string, string] => [
        `--on-${hue}`,
        token(`--on-${hue}`),
        `--${hue}`,
        token(`--${hue}`),
      ]);
      expect(below(4.5, pairs)).toEqual([]);
    });
  }

  // A hatched (missing-input) timeline bar names what is missing in amber
  // text on its hatch, whose darkest line is --hairline-faint over the
  // paper (#d9d9d9 light, #444444 dark): --amber-ink-strong is the amber
  // step that reads there.
  test('the strong amber text is 4.5:1 on the hatch and its wash', () => {
    const hatchLight = over(
      lightTokens['--paper'] ?? '',
      rgbaToken(':root:where(:not([data-bt-ui-scoped]))', '--hairline-faint')
    );
    const hatchDark = over(
      dark['--paper'] ?? '',
      rgbaToken("html[data-theme='dark']", '--hairline-faint')
    );
    expect(hatchLight).toBe('#d9d9d9');
    const pairs: [string, number][] = [
      [
        'light on the hatch',
        contrast(lightTokens['--amber-ink-strong'] ?? '', hatchLight),
      ],
      [
        'light on the paper',
        contrast(
          lightTokens['--amber-ink-strong'] ?? '',
          lightTokens['--paper'] ?? ''
        ),
      ],
      [
        'dark on the hatch',
        contrast(dark['--amber-ink-strong'] ?? '', hatchDark),
      ],
    ];
    expect(
      pairs.filter(([, ratio]) => !(ratio >= 4.5)).map(([label]) => label)
    ).toEqual([]);
  });

  test('no status hue is the purple accent', () => {
    for (const t of [lightTokens, dark]) {
      const purples = [t['--accent'], t['--accent-ink'], t['--accent-hover']];
      for (const hue of MARK_HUES) {
        expect(purples).not.toContain(t[`--${hue}`]);
      }
      for (const hue of TEXT_HUES) {
        expect(purples).not.toContain(t[`--${hue}-ink`]);
      }
    }
  });
});

describe('the data-tone hook', () => {
  // The tones and the tokens each one maps to (tokens.css, TONE HOOK).
  const HOOK: Record<string, [string, string]> = {
    muted: ['--grey', '--muted'],
    accent: ['--accent', '--accent-ink'],
    danger: ['--red', '--red-ink'],
    warning: ['--amber', '--amber-ink'],
    success: ['--green', '--green-ink'],
    info: ['--blue', '--blue-ink'],
  };

  test('every tone defines --tone, --tone-ink and --on-tone', () => {
    const flat = tokensCss.replace(/\s+/g, ' ');
    for (const [tone, [mark, text]] of Object.entries(HOOK)) {
      const head = `:where([data-tone='${tone}']) {`;
      const at = flat.indexOf(head);
      expect([tone, at >= 0]).toEqual([tone, true]);
      const body = flat.slice(at + head.length, flat.indexOf('}', at));
      expect(body).toContain(`--tone: var(${mark});`);
      expect(body).toContain(`--tone-ink: var(${text});`);
      expect(body).toContain('--on-tone:');
    }
    // A bare data-tone (default) leaves the surrounding ink alone.
    expect(flat).toContain(
      ':where([data-tone]) { --tone: var(--foreground); --tone-ink: currentcolor;'
    );
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
  test('a block that floods with ink also swaps accent, status and dim text', () => {
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
          '--red-ink',
          '--amber-ink',
          '--green-ink',
          '--blue-ink',
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
