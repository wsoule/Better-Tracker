import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DependencyGraph } from '../src/graph/dependency-graph';
import { defaultGraphLegend, GraphLegend } from '../src/graph/graph-legend';
import type { GraphNodeData, GraphNodeTone } from '../src/graph/types';

// Status colours on the dependency graph (owner decision 2026-10-22,
// docs/architecture.md §8.2): overdue floods red, at risk / unassigned
// rule amber, cycles dash red, risk chains run amber, closed or inactive
// marks go grey. The purple accent keeps only the hover flood, focus and
// the copy confirmation. CSS modules resolve to empty objects under Bun,
// so the nodes are checked through the data-tone they emit and the colours
// through their stylesheets.

afterEach(cleanup);

const srcDir = path.join(import.meta.dir, '..', 'src');

/** A stylesheet under src, comments removed and whitespace collapsed. */
function css(file: string): string {
  return readFileSync(path.join(srcDir, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ');
}

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(sheet: string, selector: string): string {
  const at = sheet.indexOf(`${selector} {`);
  expect([selector, at >= 0]).toEqual([selector, true]);
  const open = sheet.indexOf('{', at);
  return sheet.slice(open + 1, sheet.indexOf('}', open)).trim();
}

function nodeEl(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-graph-node="${id}"]`);
  if (el === null) throw new Error(`no node ${id}`);
  return el;
}

const TONES: GraphNodeTone[] = [
  'default',
  'muted',
  'accent',
  'danger',
  'warning',
  'success',
  'info',
];

describe('DependencyGraph node tones', () => {
  test('a status tone reaches the box as data-tone; default and muted do not', () => {
    const nodes: GraphNodeData[] = TONES.map((tone) => ({
      id: tone,
      label: `A ${tone} box`,
      tone,
    }));
    const { container } = render(
      <DependencyGraph
        nodes={nodes}
        edges={TONES.slice(1).map((tone) => ({
          from: 'default',
          to: tone,
          kind: 'default' as const,
        }))}
        ariaSummary="Seven boxes."
        emptyMessage="Nothing."
        onSelect={() => undefined}
      />
    );
    const seen = TONES.map((tone) => [
      tone,
      nodeEl(container, tone).getAttribute('data-tone'),
    ]);
    expect(seen).toEqual([
      ['default', null],
      ['muted', null],
      ['accent', 'accent'],
      ['danger', 'danger'],
      ['warning', 'warning'],
      ['success', 'success'],
      ['info', 'info'],
    ]);
  });

  test('a link box carries its tone on the link itself', () => {
    const { container } = render(
      <DependencyGraph
        nodes={[
          { id: 'a', label: 'Blocker', tone: 'danger', href: '/a' },
          { id: 'b', label: 'Waiter', tone: 'default', href: '/b' },
        ]}
        edges={[{ from: 'a', to: 'b', kind: 'risk' }]}
        ariaSummary="Two boxes."
        emptyMessage="Nothing."
      />
    );
    const link = nodeEl(container, 'a').querySelector('a');
    expect(link?.getAttribute('data-tone')).toBe('danger');
    expect(
      nodeEl(container, 'b').querySelector('a')?.hasAttribute('data-tone')
    ).toBe(false);
  });
});

describe('DependencyGraph colours (dependency-graph.module.css)', () => {
  const sheet = css('graph/dependency-graph.module.css');

  test('risk chains run amber and cycles dash red', () => {
    expect(rule(sheet, '.edgeRisk')).toContain('color: var(--amber)');
    expect(rule(sheet, '.edgeCycle')).toContain('color: var(--red)');
    expect(rule(sheet, '.edgeCycle .edgeLine')).toContain(
      'stroke-dasharray: 5 3'
    );
    // A count on a coloured edge is text: the TEXT token of its hue.
    expect(rule(sheet, '.edgeRisk')).toContain('--edge-ink: var(--amber-ink)');
    expect(rule(sheet, '.edgeCycle')).toContain('--edge-ink: var(--red-ink)');
    expect(rule(sheet, '.weight text')).toContain(
      'fill: var(--edge-ink, currentcolor)'
    );
  });

  test('overdue floods the box red, its text in the on-red ink', () => {
    const flood = rule(sheet, '.node.overdueNode');
    expect(flood).toContain('background: var(--red)');
    expect(flood).toContain('border-color: var(--red)');
    expect(flood).toContain('color: var(--on-red)');
    expect(flood).toContain('--foreground: var(--on-red)');
    // The marks inside turn to the flood's ink, except on the ink fill of
    // a selected box, where the hues hold (3:1 on the ink).
    expect(rule(sheet, '.node.overdueNode:not(.selected)')).toContain(
      '--glyph-red: var(--on-red)'
    );
  });

  test('a cycle is a dashed red outline outside the box', () => {
    expect(rule(sheet, '.cycle::before')).toContain(
      'border: 1px dashed var(--red)'
    );
  });

  test('a status tone is a 2px rule in its hue; muted stays faint', () => {
    expect(rule(sheet, '.toned')).toContain('border: 2px solid var(--tone)');
    const muted = rule(sheet, '.toneMuted');
    expect(muted).toContain('border-color: var(--grey-3)');
    for (const hue of ['green', 'amber', 'red']) {
      expect(muted).toContain(`--glyph-${hue}: var(--grey)`);
    }
  });

  test('the status mark keeps its shapes, in the status hues', () => {
    const node = rule(sheet, '.node');
    expect(node).toContain('--glyph-green: var(--green)');
    expect(node).toContain('--glyph-amber: var(--amber)');
    expect(node).toContain('--glyph-red: var(--red)');
    // Done is the ink fill (never the green: it would match the red fill
    // without red-green vision), through --glyph-ink so a flood or a faint
    // box still recolours it.
    expect(node).toContain('--glyph-ink: var(--foreground)');
    expect(rule(sheet, '.done')).toContain('background: var(--glyph-ink)');
    expect(rule(sheet, '.on_track')).toContain(
      'border-color: var(--glyph-green)'
    );
    expect(rule(sheet, '.at_risk')).toContain(
      'border: 2px solid var(--glyph-amber)'
    );
    expect(rule(sheet, '.overdue')).toContain('background: var(--glyph-red)');
    expect(rule(sheet, '.missing')).toContain('repeating-linear-gradient');
  });

  test('UNASSIGNED is a filled amber chip', () => {
    const tag = rule(sheet, '.tagWarning');
    expect(tag).toContain('background: var(--amber)');
    expect(tag).toContain('color: var(--on-amber)');
    // On the red overdue flood it inverts (a paper chip, red text), so
    // amber never sits on red.
    const onFlood = rule(sheet, '.node.overdueNode:not(.selected) .tagWarning');
    expect(onFlood).toContain('background: var(--on-red)');
    expect(onFlood).toContain('color: var(--red)');
  });

  test('the hover flood stays the accent and turns the marks to its ink', () => {
    const hover = rule(sheet, '.node:not(.selected):hover');
    expect(hover).toContain('background: var(--accent)');
    expect(hover).toContain('--glyph-green: var(--on-accent)');
    expect(hover).toContain('--glyph-amber: var(--on-accent)');
    expect(hover).toContain('--glyph-red: var(--on-accent)');
  });

  test('no status rule uses the purple accent', () => {
    for (const selector of [
      '.edgeRisk',
      '.edgeCycle',
      '.done',
      '.on_track',
      '.at_risk',
      '.overdue',
      '.tagWarning',
      '.toned',
      '.toneMuted',
      '.node.overdueNode',
      '.node.overdueNode.external',
      '.cycle::before',
    ]) {
      expect([selector, rule(sheet, selector).includes('accent')]).toEqual([
        selector,
        false,
      ]);
    }
  });

  test('forced colours keep the filled marks filled', () => {
    const forced = sheet.slice(sheet.indexOf('@media (forced-colors: active)'));
    expect(forced).toContain('.done, .overdue {');
    expect(forced).toContain('background: CanvasText');
  });
});

describe('GraphLegend colours', () => {
  const sheet = css('graph/graph-legend.module.css');

  test('the default legend names needs action with the amber rule', () => {
    const marks = defaultGraphLegend.map((item) => item.mark);
    expect(marks).toContain('node-warning');
    expect(marks).not.toContain('node-accent');
    const { container } = render(<GraphLegend />);
    expect(
      container.querySelector('[data-mark="node-warning"]')
    ).not.toBeNull();
  });

  test('swatches draw the graph’s own status hues', () => {
    expect(rule(sheet, '.nodeWarning')).toContain(
      'border: 2px solid var(--amber)'
    );
    expect(rule(sheet, '.nodeOverdue')).toContain('background: var(--red)');
    expect(rule(sheet, '.nodeCycle::before')).toContain(
      'border: 1px dashed var(--red)'
    );
    expect(rule(sheet, '.edgeRisk')).toContain('color: var(--amber)');
    expect(rule(sheet, '.edgeCycle')).toContain('color: var(--red)');
  });
});

describe('MermaidSource colours', () => {
  test('a refused copy is an error, in red; the confirmation stays purple', () => {
    const sheet = css('graph/mermaid-source.module.css');
    expect(rule(sheet, ".copy[data-state='failed']")).toContain(
      'border-color: var(--red)'
    );
    expect(rule(sheet, ".copy[data-state='copied']")).toContain(
      'border-color: var(--accent)'
    );
  });
});
