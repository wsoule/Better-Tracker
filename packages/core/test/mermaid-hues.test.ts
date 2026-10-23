import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { MERMAID_HUES } from '../src/index';

// The Mermaid export cannot read CSS variables, so MERMAID_HUES copies the
// light theme's status MARK hexes out of the ui's tokens.css (architecture
// §2.10 "Mermaid", §8.2 "Status colours"). This test reads that file and
// keeps the copy equal, and checks the 3:1 the export's doc promises for a
// stroke on the backgrounds pasted Mermaid usually lands on. core:test
// lists tokens.css as an input (moon.yml), so a token change reruns it.

const TOKENS = path.join(
  import.meta.dir,
  '..',
  '..',
  'ui',
  'src',
  'styles',
  'tokens.css'
);

/**
 * The light token block of tokens.css: from its selector to the first
 * closing brace at the start of a line (the block holds no nested rule).
 */
function lightBlock(css: string): string {
  const selector = ':root:where(:not([data-bt-ui-scoped])),\n[data-bt-ui] {';
  const start = css.indexOf(selector);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = css.indexOf('\n}', start);
  expect(end).toBeGreaterThan(start);
  return css.slice(start, end);
}

/** A custom property's hex in a block (`--red: #d92d20;`), or null. */
function hexOf(block: string, name: string): string | null {
  const match = new RegExp(
    `^\\s*--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`,
    'm'
  ).exec(block);
  return match?.[1]?.toLowerCase() ?? null;
}

/** WCAG 2 relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG 2 contrast ratio between two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

describe('MERMAID_HUES', () => {
  const block = lightBlock(readFileSync(TOKENS, 'utf8'));

  test.each(['red', 'amber', 'green'] as const)(
    '%s is the light theme MARK token of tokens.css',
    (hue) => {
      expect(MERMAID_HUES[hue]).toBe(hexOf(block, hue) ?? 'missing');
    }
  );

  // White and GitHub's dark page (#0d1117) behind an edge; Mermaid's
  // default node fills (light #ececff, dark #1f2020) inside a node.
  test.each([
    ['white', '#ffffff'],
    ['the light node fill', '#ececff'],
    ['the dark node fill', '#1f2020'],
    ["GitHub's dark page", '#0d1117'],
  ])('every hue holds 3:1 as a stroke on %s', (_name, ground) => {
    for (const hex of Object.values(MERMAID_HUES)) {
      expect(contrast(hex, ground)).toBeGreaterThanOrEqual(3);
    }
  });
});
