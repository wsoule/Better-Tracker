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

/** The chrome's hatch line (the sidebar, block titlebars) over the paper,
    per theme: darker than the tint in light (#f0f0f0), and the sidebar's
    status marks sit on it. */
const hatch = {
  light: over(
    lightTokens['--paper'] ?? '',
    rgbaToken(':root:where(:not([data-bt-ui-scoped]))', '--hatch')
  ),
  dark: over(
    dark['--paper'] ?? '',
    rgbaToken("html[data-theme='dark']", '--hatch')
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
    const line = hatch[theme];
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

    test(`${theme}: status marks are 3:1 on the paper, the tint, the hatch and a flood`, () => {
      if (theme === 'light') expect(line).toBe('#f0f0f0');
      const pairs = MARK_HUES.flatMap(
        (hue): [string, string, string, string][] => [
          [`--${hue}`, token(`--${hue}`), 'paper', paper],
          [`--${hue}`, token(`--${hue}`), 'tint', wash],
          [`--${hue}`, token(`--${hue}`), 'hatch', line],
          [`--${hue}`, token(`--${hue}`), 'ink', ink],
        ]
      );
      expect(below(3, pairs)).toEqual([]);
    });

    // An accent (purple) flood turns every mark white (--on-accent), so
    // the mark needs --on-accent at 3:1 on the purple.
    test(`${theme}: a mark on the accent flood is 3:1`, () => {
      expect(
        below(3, [
          ['--on-accent', token('--on-accent'), '--accent', token('--accent')],
        ])
      ).toEqual([]);
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

  // The on-track mark is only a 1px hollow edge (StatusMark, the timeline
  // bar's outline), so 3:1 is not enough for it to read on the black
  // paper: --green holds 4.5:1 on the paper in both themes (dark steps it
  // to #1c9444, 4.90:1, where the light #16853c is 4.07:1).
  test('the 1px on-track edge is 4.5:1 on the paper in both themes', () => {
    const pairs: [string, number][] = [
      [
        'light',
        contrast(lightTokens['--green'] ?? '', lightTokens['--paper'] ?? ''),
      ],
      ['dark', contrast(dark['--green'] ?? '', dark['--paper'] ?? '')],
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

/**
 * The rules of a stylesheet as [selector, body] pairs, innermost first
 * (an @media wrapper is skipped; the rules inside it are returned).
 */
function cssRules(css: string): [string, string][] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => [
    (match[1] ?? '').trim(),
    match[2] ?? '',
  ]);
}

describe('coloured floods swap the status mark hues', () => {
  // A block that fills with a colour and retints the ink for its contents
  // (`--foreground: var(--on-accent)` on the purple hover flood or the
  // accent chip, `var(--on-red)` on the graph's overdue box) must turn the
  // status MARK hues to that ink too: a red, amber, green or grey mark is
  // under 3:1 on the purple or the red, and the mark's shape stays to say
  // the status. The swap may sit in the block itself or in a rule that
  // extends its selector (`.accent .mark`); the graph's node glyph reads
  // its hues through --glyph-<hue> (and its grey through those same
  // variables, so --glyph-ink stands in for grey there).
  test('every on-colour flood swaps --red, --amber, --green and --grey', () => {
    const missing: string[] = [];
    for (const file of cssFiles(srcDir)) {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      const rules = cssRules(css);
      for (const [selector, body] of rules) {
        if (!/--foreground:\s*var\(--on-[\w-]+\)/.test(body)) continue;
        const group = rules
          .filter(
            ([other]) =>
              other === selector ||
              [' ', '.', ':'].some((next) => other.startsWith(selector + next))
          )
          .map(([, groupBody]) => groupBody)
          .join('\n');
        for (const hue of ['red', 'amber', 'green', 'grey']) {
          const glyph = hue === 'grey' ? '--glyph-ink' : `--glyph-${hue}`;
          if (!new RegExp(`(--${hue}|${glyph}):`).test(group)) {
            missing.push(
              `${path.relative(srcDir, file)} ${selector}: --${hue}`
            );
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test('the sidebar item hover turns the marks white', () => {
    const css = readFileSync(
      path.join(srcDir, 'shell', 'app-shell.module.css'),
      'utf8'
    ).replace(/\/\*[\s\S]*?\*\//g, '');
    const body = cssRules(css).find(
      ([selector]) => selector === ".item:not([aria-current='page']):hover"
    )?.[1];
    expect(body).toBeDefined();
    for (const hue of ['red', 'amber', 'green', 'grey']) {
      expect([hue, body ?? '']).toEqual([
        hue,
        expect.stringContaining(`--${hue}: var(--on-accent);`),
      ]);
    }
  });
});

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

// The dependency graph's highlights (architecture §8.4 Graph): every line,
// ring and mark is 3:1 on the paper canvas and every word 4.5:1, in both
// themes, read from the tokens the graph's stylesheet actually uses.
// Measured: ink 21.00 / 16.37, the dim grey 5.10 / 5.93, green 4.71 /
// 4.90, amber 3.56 / 5.23, red 4.83 / 4.15, accent 4.51 / 4.25; the
// accent and ink rings 4.66 / 3.85 apart; the "Ready next" word 5.42 /
// 8.86 (9.71 / 4.63 on a selected box's ink), the step digits 21.00 /
// 16.37, receding words 5.10 / 5.93 (8.33 / 5.98 on a selected box).
describe('graph marks meet WCAG in both themes', () => {
  const graphCss = readFileSync(
    path.join(srcDir, 'graph', 'dependency-graph.module.css'),
    'utf8'
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ');

  /** The declarations of the first rule whose selector is exactly `selector`. */
  function graphRule(selector: string): string {
    const at = graphCss.indexOf(`${selector} {`);
    expect([selector, at >= 0]).toEqual([selector, true]);
    const open = graphCss.indexOf('{', at);
    return graphCss.slice(open + 1, graphCss.indexOf('}', open));
  }

  test('each job uses the token measured below', () => {
    const uses: [string, string][] = [
      ['.edge', 'color: var(--foreground)'],
      ['.edgeResolved', 'color: var(--grey-2-ink)'],
      [":where(.graph[data-highlight='status']) .edgeResolved", 'var(--green)'],
      [
        ".edge.dim:is(.edgeDefault, .edgeCross), :where(.graph:not([data-highlight='risk'])) .edge.dim.edgeRisk",
        'color: var(--grey-2-ink)',
      ],
      [
        ".edge.lit:is(.edgeDefault, .edgeCross), :where(.graph:not([data-highlight='risk'])) .edge.lit.edgeRisk",
        'color: var(--accent)',
      ],
      [
        '.node.lit:not(:focus-visible), .node.down:not(:focus-visible), .node.chain:not(:focus-visible)',
        'outline: 2px solid var(--ink)',
      ],
      ['.node.lit:not(:focus-visible)', 'outline-color: var(--accent)'],
      [
        '.node.dim:not(.overdueNode) > .text > :is(.label, .sublabel)',
        'color: var(--grey-2-ink)',
      ],
      // The box being read: the accent flood, its words in --on-accent.
      ['.node.pointed:not(.selected)', 'background: var(--accent)'],
      ['.node.pointed:not(.selected)', 'color: var(--on-accent)'],
      ['.toneEdge', 'border-color: var(--tone)'],
      ['.tagToned', 'color: var(--tone-ink)'],
      ['.next', 'color: var(--green-ink)'],
      ['.next', 'border: 1px solid var(--green)'],
      ['.next', 'background: var(--background)'],
      ['.step', 'background: var(--ink)'],
      ['.step', 'color: var(--paper)'],
      ['.readout', 'color: var(--muted)'],
      // Cluster frames (every item, owner decision 2026-10-23) and their
      // titles, each title on a paper patch.
      ['.cluster', 'border: 1px solid var(--grey-2)'],
      ['.clusterMuted', 'border-color: var(--grey)'],
      ['.clusterTitle', 'color: var(--muted)'],
      ['.clusterTitle', 'background: var(--background)'],
      ['.clusterTitleTop', 'color: var(--foreground)'],
      ['.clusterTitleMuted', 'color: var(--grey-2-ink)'],
    ];
    expect(
      uses
        .filter(([selector, use]) => !graphRule(selector).includes(use))
        .map(([selector, use]) => `${selector}: ${use}`)
    ).toEqual([]);
  });

  for (const [theme, t] of [
    ['light', lightTokens],
    ['dark', dark],
  ] as const) {
    const token = (name: string): string => t[name] ?? '(missing)';
    const paper = token('--paper');
    const ink = token('--ink');

    test(`${theme}: lines, rings and box edges are 3:1 on the canvas`, () => {
      const pairs = [
        // Blocking lines, the downstream and critical rings and lines.
        '--ink',
        // Receding lines, unblocked dots outside Status.
        '--grey-2-ink',
        // The ready edge, unblocked dots under Status, the pill's rule.
        '--green',
        // Blocked and stuck rules, risk chains, cycles.
        '--amber',
        '--red',
        // The upstream ring and lines.
        '--accent',
      ].map((name) => ({ name, ratio: contrast(token(name), paper) }));
      expect(
        pairs.filter(({ ratio }) => !(ratio >= 3)).map(({ name }) => name)
      ).toEqual([]);
    });

    test(`${theme}: cluster frames are 3:1, a muted one on its hatch too`, () => {
      const line = theme === 'light' ? hatch.light : hatch.dark;
      expect(contrast(token('--grey-2'), paper)).toBeGreaterThanOrEqual(3);
      expect(contrast(token('--grey'), paper)).toBeGreaterThanOrEqual(3);
      expect(contrast(token('--grey'), line)).toBeGreaterThanOrEqual(3);
    });

    test(`${theme}: the upstream and downstream rings are 3:1 apart`, () => {
      expect(contrast(token('--accent'), ink)).toBeGreaterThanOrEqual(3);
    });

    test(`${theme}: the graph's words are 4.5:1`, () => {
      const pairs: [string, string, string][] = [
        // "Ready next" on its paper, and on a selected box's ink fill
        // (which swaps --green-ink to its inverse and --background to ink).
        ['pill', token('--green-ink'), paper],
        ['pill on a selected box', token('--green-ink-inverse'), ink],
        // Step digits on the ink badge.
        ['step', paper, ink],
        // Receding words, and on a selected box.
        ['receding', token('--grey-2-ink'), paper],
        ['receding on a selected box', token('--muted-inverse'), ink],
        // The readout line and its hint.
        ['readout', token('--muted'), paper],
        ['readout hint', token('--grey-2-ink'), paper],
        // Readiness chips under Status.
        ['ready chip', token('--green-ink'), paper],
        ['blocked chip', token('--amber-ink'), paper],
        ['stuck chip', token('--red-ink'), paper],
        // Cluster titles on their paper patch: top-level, nested, muted.
        // --foreground is the ink.
        ['top cluster title', ink, paper],
        ['nested cluster title', token('--muted'), paper],
        ['muted cluster title', token('--grey-2-ink'), paper],
      ];
      expect(
        pairs
          .filter(([, fg, bg]) => !(contrast(fg, bg) >= 4.5))
          .map(([label, fg, bg]) => `${label} ${contrast(fg, bg).toFixed(2)}`)
      ).toEqual([]);
    });
  }
});
