import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DependencyGraph } from '../src/graph/dependency-graph';
import { defaultGraphLegend, GraphLegend } from '../src/graph/graph-legend';
import type {
  DependencyGraphProps,
  GraphEdgeData,
  GraphHighlight,
  GraphLegendMark,
  GraphNodeData,
  GraphNodeReadiness,
} from '../src/graph/types';
import { MILESTONE_EDGES, MILESTONES } from './graph-fixture';

// The graph highlights (architecture §8.4 Graph): both paths of the node
// being read (what it waits on lit, what it holds up down), the pill on
// what finishing it alone would unblock, the Status / Risk / Critical path
// modes and the readout line (the lock and the drill-down are
// graph-lock.test.tsx). CSS modules resolve to empty objects under Bun, so
// the drawing is read through its data hooks and the colours through the
// stylesheet.

afterEach(cleanup);

const SUMMARY = 'Dependency graph of 12 milestones.';

function renderGraph(props: Partial<DependencyGraphProps> = {}) {
  return render(
    <DependencyGraph
      nodes={MILESTONES}
      edges={MILESTONE_EDGES}
      ariaSummary={SUMMARY}
      emptyMessage="Nothing to draw."
      {...props}
    />
  );
}

function nodeEl(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-graph-node="${id}"]`);
  if (el === null) throw new Error(`no node ${id}`);
  return el;
}

/** Every drawn node's `data-<attr>`, by id, leaving out unset ones. */
function attrs(container: HTMLElement, attr: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const el of container.querySelectorAll<HTMLElement>(
    '[data-graph-node]'
  )) {
    const value = el.getAttribute(`data-${attr}`);
    if (value !== null) out[el.dataset.graphNode ?? ''] = value;
  }
  return out;
}

/** An edge's base copy's highlight state. */
function edgeState(container: HTMLElement, key: string): string | null {
  return (
    container
      .querySelector(`[data-edge="${key}"]`)
      ?.getAttribute('data-state') ?? null
  );
}

function readoutOf(container: HTMLElement): string {
  return (
    container.querySelector('[data-graph-readout]')?.textContent ?? '(none)'
  );
}

const READY: GraphNodeReadiness = {
  state: 'ready',
  label: 'Ready',
  tone: 'success',
  blockedBy: 0,
  unblocks: 1,
};

const blockedBy = (n: number, unblocks = 0): GraphNodeReadiness => ({
  state: 'blocked',
  label: `Blocked by ${n}`,
  tone: 'warning',
  blockedBy: n,
  unblocks,
});

const DONE: GraphNodeReadiness = {
  state: 'done',
  label: '',
  tone: 'muted',
  blockedBy: 0,
  unblocks: 0,
};

/** The demo's chain ENG-12 → ENG-23 → OPS-20, with ENG-2 done before ENG-26. */
const CHAIN: GraphNodeData[] = [
  {
    id: 'ENG-12',
    key: 'ENG-12',
    label: 'Dual-write payments',
    tone: 'warning',
    tags: ['UNASSIGNED', 'OVERDUE'],
    readiness: READY,
  },
  {
    id: 'ENG-23',
    key: 'ENG-23',
    label: 'Typo tolerance',
    tone: 'default',
    readiness: blockedBy(1, 1),
  },
  {
    id: 'OPS-20',
    key: 'OPS-20',
    label: 'Load test search',
    tone: 'default',
    readiness: blockedBy(1),
  },
  {
    id: 'ENG-2',
    key: 'ENG-2',
    label: 'Schema',
    tone: 'muted',
    status: 'done',
    statusLabel: 'Done',
    readiness: DONE,
  },
  {
    id: 'ENG-26',
    key: 'ENG-26',
    label: 'Backfill',
    tone: 'default',
    readiness: { ...READY, unblocks: 0 },
  },
];

const CHAIN_EDGES: GraphEdgeData[] = [
  { from: 'ENG-12', to: 'ENG-23', kind: 'risk' },
  { from: 'ENG-23', to: 'OPS-20', kind: 'risk', cross: true },
  { from: 'ENG-2', to: 'ENG-26', kind: 'resolved' },
];

function renderChain(props: Partial<DependencyGraphProps> = {}) {
  return render(
    <DependencyGraph
      nodes={CHAIN}
      edges={CHAIN_EDGES}
      ariaSummary="A chain."
      emptyMessage="Nothing."
      onSelect={() => undefined}
      pathWords={{ unit: ['issue', 'issues'] }}
      {...props}
    />
  );
}

describe('DependencyGraph: both paths', () => {
  test('focus lights what it waits on (lit) and what it holds up (down)', () => {
    const { container } = renderGraph({ onSelect: () => undefined });
    act(() => nodeEl(container, 'mobile-m1').focus());
    expect(attrs(container, 'state')).toEqual({
      'atlas-m2': 'dim',
      'atlas-m3': 'dim',
      'atlas-m4': 'dim',
      'billing-m0': 'dim',
      'billing-m1': 'dim',
      'billing-m2': 'dim',
      'search-m1': 'lit',
      'search-m2': 'dim',
      'mobile-m1': 'active',
      'mobile-m2': 'down',
      'identity-m1': 'dim',
      'identity-m2': 'dim',
    });
    expect(edgeState(container, 'search-m1->mobile-m1')).toBe('lit');
    expect(edgeState(container, 'mobile-m1->mobile-m2')).toBe('down');
    // A resolved edge is never walked.
    expect(edgeState(container, 'billing-m0->mobile-m1')).toBe('dim');
  });

  test('a cycle partner, and an edge walked both ways, are drawn as upstream', () => {
    const { container } = renderGraph({ onSelect: () => undefined });
    act(() => nodeEl(container, 'identity-m1').focus());
    const state = attrs(container, 'state');
    expect(state['identity-m2']).toBe('lit');
    expect(state['mobile-m2']).toBe('down');
    expect(state['atlas-m4']).toBe('down');
    expect(edgeState(container, 'identity-m1->identity-m2')).toBe('lit');
    expect(edgeState(container, 'identity-m2->identity-m1')).toBe('lit');
    expect(edgeState(container, 'identity-m2->atlas-m4')).toBe('down');
  });

  test('path edges are drawn again in an aria-hidden overlay with no data hooks', () => {
    const { container } = renderGraph({ onSelect: () => undefined });
    expect(container.querySelector('[data-overlay]')).toBeNull();
    act(() => nodeEl(container, 'mobile-m1').focus());
    const overlay = container.querySelector('[data-overlay]');
    expect(overlay?.getAttribute('aria-hidden')).toBe('true');
    // One copy per lit or down edge (down first, upstream above it), and
    // [data-edge] still finds one element per edge.
    expect(overlay?.children).toHaveLength(2);
    expect(overlay?.querySelectorAll('[data-edge], [data-state]')).toHaveLength(
      0
    );
    expect(container.querySelectorAll('[data-edge]')).toHaveLength(
      MILESTONE_EDGES.length
    );
    // Its last child is drawn on top: the upstream line.
    expect(
      overlay?.lastElementChild?.querySelector('path')?.getAttribute('d')
    ).toBe(
      container
        .querySelector('[data-edge="search-m1->mobile-m1"] path')
        ?.getAttribute('d')
    );
  });

  test('what finishing it alone would unblock carries the pill', () => {
    const { container, rerender } = renderGraph({ onSelect: () => undefined });
    act(() => nodeEl(container, 'search-m1').focus());
    // Without readiness: a target whose only blocking drawn in-edge it is.
    // Offline sync's other in-edge is resolved; Store release (further
    // down) is not a direct target.
    expect(attrs(container, 'next')).toEqual({
      'search-m2': '',
      'mobile-m1': '',
    });
    const pill = nodeEl(container, 'mobile-m1').querySelector(
      '[data-next-pill]'
    );
    expect(pill?.textContent).toBe('Ready next');
    expect(pill?.getAttribute('aria-hidden')).toBe('true');
    // A host words it; and its blockedBy counts what is not drawn.
    rerender(
      <DependencyGraph
        nodes={MILESTONES.map((n) =>
          n.id === 'search-m2' ? { ...n, readiness: blockedBy(2) } : n
        )}
        edges={MILESTONE_EDGES}
        ariaSummary={SUMMARY}
        emptyMessage="Nothing."
        onSelect={() => undefined}
        pathWords={{ next: 'Clear next' }}
      />
    );
    expect(attrs(container, 'next')).toEqual({ 'mobile-m1': '' });
    expect(nodeEl(container, 'mobile-m1').textContent).toContain('Clear next');
  });

  test('idle, nothing is lit, dimmed or marked next', () => {
    const { container } = renderGraph({ highlight: 'status' });
    expect(attrs(container, 'state')).toEqual({});
    expect(attrs(container, 'next')).toEqual({});
    expect(container.querySelectorAll('[data-edge][data-state]')).toHaveLength(
      0
    );
  });
});

describe('DependencyGraph: highlight modes', () => {
  // A ready node the host also tones warning (unassigned), a blocked one,
  // and a done one.
  const NODES: GraphNodeData[] = [
    { id: 'a', label: 'Ready one', tone: 'warning', readiness: READY },
    { id: 'b', label: 'Blocked one', tone: 'default', readiness: blockedBy(1) },
    {
      id: 'c',
      label: 'Done one',
      tone: 'muted',
      status: 'done',
      readiness: DONE,
    },
    {
      id: 'd',
      label: 'Late one',
      tone: 'danger',
      tags: ['OVERDUE'],
      readiness: blockedBy(1),
    },
  ];
  const EDGES: GraphEdgeData[] = [
    { from: 'a', to: 'b', kind: 'risk' },
    { from: 'c', to: 'b', kind: 'resolved' },
    { from: 'b', to: 'd', kind: 'default' },
  ];
  const renderMode = (highlight?: GraphHighlight) =>
    render(
      <DependencyGraph
        nodes={NODES}
        edges={EDGES}
        ariaSummary="Four."
        emptyMessage="Nothing."
        highlight={highlight}
      />
    );

  test('the frame says its highlight, risk by default', () => {
    for (const mode of [undefined, 'status', 'risk', 'critical'] as const) {
      const { container, unmount } = renderMode(mode);
      expect(container.firstElementChild?.getAttribute('data-highlight')).toBe(
        mode ?? 'risk'
      );
      unmount();
    }
  });

  test('data-tone follows the highlight: readiness, tone, or neutral', () => {
    const tones = (mode: GraphHighlight) => {
      const { container, unmount } = renderMode(mode);
      const out = attrs(container, 'tone');
      unmount();
      return out;
    };
    // Divs carry data-tone themselves (a read-only graph without links).
    expect(tones('status')).toEqual({
      a: 'success',
      b: 'warning',
      d: 'warning',
    });
    expect(tones('risk')).toEqual({ a: 'warning', d: 'danger' });
    expect(tones('critical')).toEqual({});
  });

  test('every node says its readiness', () => {
    const { container } = renderMode('critical');
    expect(attrs(container, 'readiness')).toEqual({
      a: 'ready',
      b: 'blocked',
      c: 'done',
      d: 'blocked',
    });
  });

  test('without readiness, Status draws the host tone', () => {
    const tones = (highlight: GraphHighlight) => {
      const { container, unmount } = renderGraph({ highlight });
      const out = attrs(container, 'tone');
      unmount();
      return out;
    };
    expect(tones('status')).toEqual(tones('risk'));
    expect(Object.keys(tones('status'))).toContain('search-m1');
  });

  test('the readiness chip leads the chips in every mode, toned only under Status', () => {
    for (const mode of ['status', 'risk', 'critical'] as const) {
      const { container, unmount } = renderMode(mode);
      const chip = nodeEl(container, 'd').querySelector(
        '[data-readiness-chip]'
      );
      expect([mode, chip?.textContent]).toEqual([mode, 'Blocked by 1']);
      expect(chip?.parentElement?.firstElementChild).toBe(chip ?? null);
      expect([mode, chip?.getAttribute('data-tone') ?? null]).toEqual([
        mode,
        mode === 'status' ? 'warning' : null,
      ]);
      // A done node has no readiness word.
      expect(
        nodeEl(container, 'c').querySelector('[data-readiness-chip]')
      ).toBeNull();
      unmount();
    }
  });

  test('OVERDUE is a red chip wherever the Risk flood is off', () => {
    const overdue = (mode: GraphHighlight) => {
      const { container, unmount } = renderMode(mode);
      const tag = [...nodeEl(container, 'd').querySelectorAll('span')].find(
        (el) => el.textContent === 'OVERDUE'
      );
      const tone = tag?.getAttribute('data-tone') ?? null;
      unmount();
      return tone;
    };
    expect(overdue('risk')).toBeNull();
    expect(overdue('status')).toBe('danger');
    expect(overdue('critical')).toBe('danger');
  });

  test('switching the highlight never moves a box', () => {
    const boxes = (mode: GraphHighlight) => {
      const { container, unmount } = renderMode(mode);
      const out = [
        ...container.querySelectorAll<HTMLElement>('[data-graph-node]'),
      ].map((el) => [
        el.dataset.graphNode,
        el.style.left,
        el.style.top,
        el.style.width,
        el.style.height,
      ]);
      unmount();
      return out;
    };
    const status = boxes('status');
    expect(boxes('risk')).toEqual(status);
    expect(boxes('critical')).toEqual(status);
  });
});

describe('DependencyGraph: the critical path', () => {
  test('at rest it numbers the graph-wide chain and dims the rest', () => {
    const { container } = renderGraph({
      highlight: 'critical',
      onSelect: () => undefined,
    });
    // The 2-cycle shares step 1; Decommission legacy waits on it.
    expect(attrs(container, 'step')).toEqual({
      'identity-m1': '1',
      'identity-m2': '1',
      'atlas-m4': '2',
    });
    const state = attrs(container, 'state');
    expect(state['identity-m1']).toBe('chain');
    expect(state['atlas-m4']).toBe('chain');
    expect(state['mobile-m1']).toBe('dim');
    const badge = nodeEl(container, 'atlas-m4').querySelector(
      '[data-step-badge]'
    );
    expect(badge?.textContent).toBe('2');
    expect(badge?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelectorAll('[data-step-badge]')).toHaveLength(3);
    for (const key of [
      'identity-m1->identity-m2',
      'identity-m2->identity-m1',
      'identity-m2->atlas-m4',
    ]) {
      expect([key, edgeState(container, key)]).toEqual([key, 'chain']);
    }
    expect(edgeState(container, 'atlas-m3->atlas-m4')).toBe('dim');
    // No pills in this mode.
    expect(attrs(container, 'next')).toEqual({});
  });

  test('hover switches to the longest chain through the node', () => {
    const { container } = renderGraph({
      highlight: 'critical',
      onSelect: () => undefined,
    });
    fireEvent.pointerEnter(nodeEl(container, 'mobile-m1'), {
      pointerType: 'mouse',
    });
    expect(attrs(container, 'step')).toEqual({
      'search-m1': '1',
      'mobile-m1': '2',
      'mobile-m2': '3',
    });
    expect(nodeEl(container, 'mobile-m1').dataset.state).toBe('active');
    expect(nodeEl(container, 'search-m1').dataset.state).toBe('chain');
    expect(nodeEl(container, 'identity-m1').dataset.state).toBe('dim');
    expect(readoutOf(container)).toBe(
      'Offline sync · Step 2 of 3 · Longest chain through it: 3 boxes: Index rebuild → Offline sync → Store release 4.2'
    );
  });

  test('a node on no open chain lights nothing else', () => {
    const { container } = renderGraph({
      highlight: 'critical',
      onSelect: () => undefined,
    });
    fireEvent.pointerEnter(nodeEl(container, 'atlas-m2'), {
      pointerType: 'mouse',
    });
    expect(attrs(container, 'step')).toEqual({});
    const state = attrs(container, 'state');
    expect(state['atlas-m2']).toBe('active');
    expect(Object.values(state).filter((s) => s !== 'dim')).toEqual(['active']);
    expect(readoutOf(container)).toBe(
      'M2 Schema freeze · Not on an open chain'
    );
  });

  test('in a chain graph the chain through the focus shows at rest', () => {
    const { container } = renderGraph({
      highlight: 'critical',
      focusId: 'mobile-m2',
    });
    expect(attrs(container, 'step')).toEqual({
      'search-m1': '1',
      'mobile-m1': '2',
      'mobile-m2': '3',
    });
  });

  test('names carry the step on the chain shown at rest, and never change on hover', () => {
    const { container } = renderGraph({
      highlight: 'critical',
      onSelect: () => undefined,
    });
    const name = (id: string) =>
      nodeEl(container, id).getAttribute('aria-label');
    expect(name('identity-m1')).toContain('step 1 of 2 on the critical path');
    expect(name('atlas-m4')).toContain('step 2 of 2 on the critical path');
    expect(name('mobile-m1')).not.toContain('critical path');
    const before = name('mobile-m1');
    fireEvent.pointerEnter(nodeEl(container, 'mobile-m1'), {
      pointerType: 'mouse',
    });
    expect(name('mobile-m1')).toBe(before);
  });

  test('Status and Risk names carry no step', () => {
    for (const highlight of ['status', 'risk'] as const) {
      const { container, unmount } = renderGraph({ highlight });
      expect(
        nodeEl(container, 'atlas-m4').getAttribute('aria-label')
      ).not.toContain('critical path');
      unmount();
    }
  });
});

describe('DependencyGraph: the readout', () => {
  test('at rest: the host text, then how to trace a node', () => {
    const { container } = renderChain({
      readout: '1 ready · 2 blocked · 1 done',
    });
    const line = readoutOf(container);
    expect(line.startsWith('1 ready · 2 blocked · 1 done ')).toBe(true);
    expect(line).toContain(
      'Point at or focus a box to trace what it waits on and holds up; click it to lock the trace.'
    );
    expect(line).toContain(
      'Tap a box to lock the trace of what it waits on and holds up; tap it again to open it.'
    );
    // Plain text, not a live region.
    const p = container.querySelector('[data-graph-readout]');
    expect(p?.tagName).toBe('P');
    expect(p?.hasAttribute('aria-live')).toBe(false);
  });

  test('on hover and focus: the node, its readiness and both paths', () => {
    const { container } = renderChain();
    fireEvent.pointerEnter(nodeEl(container, 'ENG-23'), {
      pointerType: 'mouse',
    });
    expect(readoutOf(container)).toBe(
      'ENG-23 · Blocked by 1 · Waits on 1 open, start with ENG-12 · Holds up 1 · Done would unblock 1: OPS-20'
    );
    fireEvent.pointerLeave(nodeEl(container, 'ENG-23'));
    act(() => nodeEl(container, 'ENG-26').focus());
    expect(readoutOf(container)).toBe(
      'ENG-26 · Ready · Blockers done: ENG-2 · Nothing here waits on it'
    );
    act(() => nodeEl(container, 'ENG-2').focus());
    expect(readoutOf(container)).toBe('ENG-2 · Done · No longer blocks ENG-26');
  });

  test('a chain graph describes its focus at rest, lighting nothing', () => {
    const { container } = renderChain({
      focusId: 'ENG-23',
      highlight: 'status',
    });
    expect(readoutOf(container)).toBe(
      'ENG-23 · Blocked by 1 · Waits on 1 open, start with ENG-12 · Holds up 1 · Done would unblock 1: OPS-20'
    );
    expect(attrs(container, 'state')).toEqual({});
  });

  test('host words reach the readout and the hints; null hides the line', () => {
    const { container, rerender } = renderChain({
      pathWords: { hint: 'Point at an issue.', tapHint: 'Tap an issue.' },
    });
    expect(readoutOf(container)).toBe('Point at an issue.Tap an issue.');
    rerender(
      <DependencyGraph
        nodes={CHAIN}
        edges={CHAIN_EDGES}
        ariaSummary="A chain."
        emptyMessage="Nothing."
        readout={null}
      />
    );
    expect(container.querySelector('[data-graph-readout]')).toBeNull();
  });

  test('under Critical path the hint says what a box shows there', () => {
    const { container } = renderChain({ highlight: 'critical', readout: '' });
    const line = readoutOf(container);
    expect(line).toContain(
      'Point at or focus a box to show the longest chain through it; click it to lock it.'
    );
    expect(line).toContain(
      'Tap a box to lock the longest chain through it; tap it again to open it.'
    );
    expect(line).not.toContain('waits on and holds up');
  });

  test('a box with no issues reads its status, never "Done"', () => {
    const { container } = render(
      <DependencyGraph
        nodes={[
          {
            id: 'm-empty',
            label: 'Push notifications',
            statusLabel: 'No issues yet',
            tone: 'muted',
            readiness: {
              state: 'empty',
              label: '',
              tone: 'muted',
              blockedBy: 0,
              unblocks: 0,
            },
          },
          {
            id: 'm-bare',
            label: 'Bare',
            tone: 'muted',
            readiness: {
              state: 'empty',
              label: '',
              tone: 'muted',
              blockedBy: 0,
              unblocks: 0,
            },
          },
        ]}
        edges={[]}
        ariaSummary="Two."
        emptyMessage="Nothing."
        highlight="status"
        readout="2 with no issues"
      />
    );
    fireEvent.pointerEnter(nodeEl(container, 'm-empty'), {
      pointerType: 'mouse',
    });
    expect(readoutOf(container)).toBe('Push notifications · No issues yet');
    fireEvent.pointerLeave(nodeEl(container, 'm-empty'));
    fireEvent.pointerEnter(nodeEl(container, 'm-bare'), {
      pointerType: 'mouse',
    });
    expect(readoutOf(container)).toBe('Bare · No issues');
  });

  test('an empty graph has no readout', () => {
    const { container } = render(
      <DependencyGraph
        nodes={[]}
        edges={[]}
        ariaSummary="Empty."
        emptyMessage="Nothing."
        readout="0 ready"
      />
    );
    expect(container.querySelector('[data-graph-readout]')).toBeNull();
  });
});

const srcDir = path.join(import.meta.dir, '..', 'src');

/** A stylesheet under src, comments removed and whitespace collapsed. */
function css(file: string): string {
  return readFileSync(path.join(srcDir, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ');
}

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(sheet: string, selector: string, from = 0): string {
  const at = sheet.indexOf(`${selector} {`, from);
  expect([selector, at >= 0]).toEqual([selector, true]);
  const open = sheet.indexOf('{', at);
  return sheet.slice(open + 1, sheet.indexOf('}', open)).trim();
}

describe('DependencyGraph highlight styles (dependency-graph.module.css)', () => {
  const sheet = css('graph/dependency-graph.module.css');
  const forced = sheet.indexOf('@media (forced-colors: active)');

  test('crossing dashes never replace unblocked dots or cycle dashes', () => {
    // Only a blocking, non-cycle kind takes the short dashes of data-cross.
    expect(
      rule(
        sheet,
        '.edge[data-cross]:is(.edgeDefault, .edgeRisk, .edgeCross) .edgeLine'
      )
    ).toBe('stroke-dasharray: 3 3;');
    expect(sheet).not.toMatch(/\[data-cross\][^{]*edgeResolved/);
    expect(sheet).not.toMatch(/\[data-cross\][^{]*edgeCycle/);
    expect(rule(sheet, '.edgeResolved .edgeLine')).toContain(
      'stroke-dasharray: 0.1 4'
    );
    expect(rule(sheet, '.edgeCycle .edgeLine')).toContain(
      'stroke-dasharray: 5 3'
    );
  });

  test('under Status an unblocked edge is green dots and a risk chain is a plain block', () => {
    expect(
      rule(sheet, ":where(.graph[data-highlight='status']) .edgeResolved")
    ).toContain('color: var(--green)');
    expect(
      rule(
        sheet,
        ":where(.graph:is([data-highlight='status'], [data-highlight='critical'])) .edgeRisk"
      )
    ).toContain('color: var(--foreground)');
  });

  test('a dimmed or outside ready box keeps its green edge', () => {
    expect(rule(sheet, '.toneEdge')).toBe('border-color: var(--tone);');
    // The two rules that would repaint a box's border leave the ready
    // edge (and a status rule) alone.
    expect(rule(sheet, '.external:not(.toned, .toneEdge)')).toBe(
      'border-color: var(--muted);'
    );
    expect(rule(sheet, '.external')).toBe('border-style: dashed;');
    expect(
      rule(
        sheet,
        '.node.dim:not(.toned, .toneEdge, .external, .overdueNode, .selected)'
      )
    ).toContain('border-color: var(--hairline-faint)');
  });

  test('receding keeps every word legible: no opacity, the dim text grey', () => {
    expect(sheet).not.toMatch(/\.dim[^{]*\{[^}]*opacity/);
    expect(
      rule(
        sheet,
        '.node.dim:not(.overdueNode) > .text > :is(.label, .sublabel)'
      )
    ).toBe('color: var(--grey-2-ink);');
    // The box itself swaps no inherited colour or token while it recedes
    // (only its own rule): a swap there restyles every element inside
    // every box on each hover (architecture §8.4 "Hover cost").
    expect(
      rule(
        sheet,
        '.node.dim:not(.toned, .toneEdge, .external, .overdueNode, .selected)'
      )
    ).toBe('border-color: var(--hairline-faint);');
    expect(sheet).not.toMatch(/\.node\.dim:not\(\.overdueNode\) \{/);
    expect(
      rule(
        sheet,
        ".edge.dim:is(.edgeDefault, .edgeCross), :where(.graph:not([data-highlight='risk'])) .edge.dim.edgeRisk"
      )
    ).toContain('color: var(--grey-2-ink)');
  });

  test('the paths: an accent ring and line upstream, ink downstream and on the chain', () => {
    const rings = rule(
      sheet,
      '.node.lit:not(:focus-visible), .node.down:not(:focus-visible), .node.chain:not(:focus-visible)'
    );
    expect(rings).toContain('outline: 2px solid var(--ink)');
    expect(rule(sheet, '.node.lit:not(:focus-visible)')).toBe(
      'outline-color: var(--accent);'
    );
    expect(
      rule(
        sheet,
        ".edge.lit:is(.edgeDefault, .edgeCross), :where(.graph:not([data-highlight='risk'])) .edge.lit.edgeRisk"
      )
    ).toContain('color: var(--accent)');
    expect(rule(sheet, '.edge.chain .edgeLine')).toBe('stroke-width: 2.5;');
  });

  test('the pill and the step badge, square and flat', () => {
    const next = rule(sheet, '.next');
    expect(next).toContain('border: 1px solid var(--green)');
    expect(next).toContain('color: var(--green-ink)');
    const step = rule(sheet, '.step');
    expect(step).toContain('background: var(--ink)');
    expect(step).toContain('color: var(--paper)');
    // This look: no radius, no shadows, no mixed tints anywhere.
    expect(sheet).not.toMatch(/radius|box-shadow|color-mix/);
  });

  test('the accent never marks a status', () => {
    for (const selector of [
      '.toneEdge',
      '.tagToned',
      '.tagToned.readyChip::before',
      '.next',
      ":where(.graph[data-highlight='status']) .edgeResolved",
    ]) {
      expect([selector, rule(sheet, selector).includes('accent')]).toEqual([
        selector,
        false,
      ]);
    }
  });

  test('forced colours: Highlight upstream, a dashed ring downstream, GrayText receding', () => {
    expect(forced).toBeGreaterThan(0);
    expect(rule(sheet, '.node.lit:not(:focus-visible)', forced)).toBe(
      'outline-color: Highlight;'
    );
    expect(rule(sheet, '.node.down:not(:focus-visible)', forced)).toBe(
      'outline: 2px dashed CanvasText;'
    );
    expect(rule(sheet, '.graph .edge.lit', forced)).toBe('color: Highlight;');
    expect(rule(sheet, '.graph .edge.dim', forced)).toBe('color: GrayText;');
    const step = rule(sheet, '.step', forced);
    expect(step).toContain('forced-color-adjust: none');
    expect(step).toContain('background: CanvasText');
    expect(rule(sheet, '.next', forced)).toBe('border: 1px solid CanvasText;');
  });

  test('the box being read is flooded in the accent on every input', () => {
    const flood = rule(sheet, '.node.pointed:not(.selected)');
    expect(flood).toContain('background: var(--accent)');
    expect(flood).toContain('color: var(--on-accent)');
    expect(flood).toContain('--foreground: var(--on-accent)');
    // Not only inside the hover media query: a touch pin and keyboard
    // focus get it too.
    const hoverAt = sheet.indexOf('@media (hover: hover)');
    expect(sheet.indexOf('.node.pointed:not(.selected) {')).toBeGreaterThan(
      sheet.indexOf('}', sheet.indexOf('}', hoverAt) + 1)
    );
    const forced = sheet.slice(sheet.indexOf('@media (forced-colors: active)'));
    expect(
      rule(
        forced,
        '.node.pointed:not(:focus-visible), .node.selected:not(:focus-visible, .lit, .down, .chain)'
      )
    ).toBe('outline: 4px double CanvasText; outline-offset: 2px;');
  });

  test('receding never animates a colour: only the flood and the rings fade', () => {
    expect(rule(sheet, '.edge')).toBe('color: var(--foreground);');
    const node = rule(sheet, '.node');
    expect(node).toContain(
      'transition: background-color 0.2s ease, outline-color 0.15s ease;'
    );
  });

  test('reduced motion stills the rings, the pill and the flood', () => {
    const reduced = sheet.slice(
      sheet.indexOf('@media (prefers-reduced-motion: reduce)')
    );
    expect(reduced).toContain(
      '.zoomButton, .lockButton, .readoutAction, .node, .node.pointed:not(.selected), .node:not(.selected):hover, .next, .step { transition: none; }'
    );
  });
});

describe('GraphLegend: the highlight marks', () => {
  const NEW_MARKS: GraphLegendMark[] = [
    'node-ready',
    'node-blocked',
    'node-stuck',
    'node-chain',
    'node-faded',
    'edge-unblocked',
    'edge-chain',
    'path-up',
    'path-down',
    'path-next',
    'path-chain',
  ];

  test('the default legend adds a Paths row and says Unblocked', () => {
    const { getByRole, getByText } = render(<GraphLegend />);
    const legend = getByRole('group', { name: 'Graph legend' });
    expect(legend.textContent).toContain('Paths');
    expect(getByText('Unblocked')).toBeTruthy();
    expect(legend.textContent).not.toContain('Resolved');
    const marks = defaultGraphLegend.map((item) => item.mark);
    for (const mark of ['path-up', 'path-down', 'path-next'] as const) {
      expect(marks).toContain(mark);
    }
  });

  test('every highlight mark has its swatch, in its row', () => {
    const { container } = render(
      <GraphLegend
        label="Graph legend: Critical path"
        items={NEW_MARKS.map((mark) => ({ mark, label: mark }))}
      />
    );
    for (const mark of NEW_MARKS) {
      expect([
        mark,
        container.querySelector(`[data-mark="${mark}"]`) !== null,
      ]).toEqual([mark, true]);
    }
    const rows = [...container.querySelectorAll('[role="group"] > div')].map(
      (row) => row.firstElementChild?.textContent
    );
    expect(rows).toEqual(['Nodes', 'Edges', 'Paths']);
    // The chain swatches carry a step number; the next one its tag.
    expect(
      container.querySelector('[data-mark="node-chain"]')?.textContent
    ).toBe('1');
    expect(
      container.querySelector('[data-mark="path-next"]')?.children
    ).toHaveLength(1);
  });

  test('the swatches draw the graph’s own marks', () => {
    const sheet = css('graph/graph-legend.module.css');
    expect(rule(sheet, '.nodeReady')).toBe('border-color: var(--green);');
    expect(rule(sheet, '.nodeBlocked')).toBe('border: 2px solid var(--amber);');
    expect(rule(sheet, '.nodeStuck')).toBe('border: 2px solid var(--red);');
    expect(rule(sheet, '.edgeUnblocked')).toBe('color: var(--green);');
    expect(
      rule(sheet, '.edgeResolved .edgeLine, .edgeUnblocked .edgeLine')
    ).toContain('stroke-dasharray: 0.1 4');
    expect(rule(sheet, '.edgeChain .edgeLine')).toBe('stroke-width: 2.5;');
    // Only what the box waits on is ringed in the accent; the chain
    // through it is the critical path's own ink ring (as the canvas draws
    // it), and the box being read is the accent flood.
    expect(rule(sheet, '.pathUp')).toBe('outline-color: var(--accent);');
    expect(sheet).not.toContain('.pathUp, .pathChain');
    expect(rule(sheet, '.pathActive')).toBe(
      'border-color: var(--accent); background: var(--accent);'
    );
    const forced = sheet.slice(sheet.indexOf('@media (forced-colors: active)'));
    expect(rule(forced, '.edge')).toBe('color: CanvasText;');
    expect(rule(forced, '.nodeChain, .pathChain')).toBe(
      'outline-color: CanvasText;'
    );
    expect(rule(forced, '.pathActive, .pathLocked')).toContain(
      'outline: 4px double CanvasText'
    );
    // The locked box: the flood and its corner ticks, as drawn, the ticks
    // kept in Highlight through forced colours.
    expect(rule(sheet, '.pathLocked')).toBe(
      '--tick-ink: var(--on-accent); border-color: var(--accent); background: var(--accent);'
    );
    expect(rule(sheet, '.pathLocked::after')).toContain(
      'linear-gradient(var(--tick-ink) 0 0) left top / 5px 2px'
    );
    expect(rule(forced, '.pathLocked::after')).toBe(
      '--tick-ink: Highlight; forced-color-adjust: none;'
    );
    expect(sheet).not.toMatch(/radius|box-shadow|color-mix/);
  });
});
