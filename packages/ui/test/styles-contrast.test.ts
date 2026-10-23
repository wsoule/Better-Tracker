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

// The issue list's surfaces in the current look, read from the
// stylesheets so a change there is checked: the bulk bar is paper in a 1px
// ink frame (no inverted fill, no dimmed actions); its picker actions are
// the paper's ink, flooding the accent on hover and the ink while open; a
// selected row carries the 2px accent rule and a drop target the 2px
// accent frame, over the paper and over a row's ink hover flood.
function ruleBody(file: string, selector: RegExp): string {
  const css = readFileSync(path.join(srcDir, file), 'utf8');
  const match = selector.exec(css);
  expect({ file, found: match !== null }).toEqual({ file, found: true });
  return match?.[1] ?? '';
}

describe('the issue list keeps its text readable', () => {
  const bar = ruleBody('tasks/bulk-bar.module.css', /\n\.bar \{([^}]*)\}/);
  const trigger = ruleBody(
    'edit/picker-popover.module.css',
    /\n\.bar \{([^}]*)\}/
  );
  const selectedRule = ruleBody(
    'tasks/task-group-table.module.css',
    /\n\.row\[data-selected='true'\]::before \{([^}]*)\}/
  );
  const dropFrame = ruleBody(
    'tasks/task-group-table.module.css',
    /\n\.group\[data-drop='ok'\]::after \{([^}]*)\}/
  );

  test('the bar and its actions draw from the paper tokens, at full strength', () => {
    expect(bar).toContain('background: var(--background);');
    expect(bar).toContain('color: var(--foreground);');
    expect(bar).toContain('border: 1px solid var(--border);');
    expect(trigger).toContain('color: var(--foreground);');
    for (const body of [bar, trigger]) {
      expect(body).not.toMatch(/opacity|box-shadow|border-radius/);
    }
    expect(selectedRule).toContain('border-left: 2px solid var(--accent);');
    expect(dropFrame).toContain('border: 2px solid var(--accent);');
  });

  for (const [theme, t] of [
    ['light', lightTokens],
    ['dark', dark],
  ] as const) {
    test(`${theme}: the bulk bar's text on its paper, hovered and open`, () => {
      const paper = t['--paper'] ?? '';
      const ink = t['--ink'] ?? '';
      const failing: string[] = [];
      for (const [name, text, ground] of [
        ['count and actions', ink, paper],
        ['note and message', t['--ink-soft'] ?? '', paper],
        ['the clear button', t['--muted'] ?? '', paper],
        ['a hovered action', t['--on-accent'] ?? '', t['--accent'] ?? ''],
        ['an open action', paper, ink],
      ] as const) {
        const ratio = contrast(text, ground);
        if (ratio < 4.5) failing.push(`${name}: ${ratio}`);
      }
      expect(failing).toEqual([]);
    });

    test(`${theme}: the selected-row rule and the drop frame read on the paper and the flood`, () => {
      const accent = t['--accent'] ?? '';
      const failing: string[] = [];
      for (const [ground, color] of [
        ['paper', t['--paper'] ?? ''],
        ['ink flood', t['--ink'] ?? ''],
      ] as const) {
        const ratio = contrast(accent, color);
        if (ratio < 3) failing.push(`accent on ${ground}: ${ratio}`);
      }
      expect(failing).toEqual([]);
    });
  }
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
