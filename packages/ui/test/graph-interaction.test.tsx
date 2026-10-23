import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { useState } from 'react';

import { DependencyGraph } from '../src/graph/dependency-graph';
import { GraphLegend } from '../src/graph/graph-legend';
import { layoutGraph } from '../src/graph/layout';
import type { DependencyGraphProps, GraphLayout } from '../src/graph/types';
import { MILESTONE_EDGES, MILESTONES } from './graph-fixture';

afterEach(cleanup);

const SUMMARY =
  'Dependency graph of 12 milestones in 5 projects, with one cycle.';

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

/** The graph with selection owned by a parent, like a host page. */
function Selectable({ onSelect }: { onSelect: (id: string) => void }) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <DependencyGraph
      nodes={MILESTONES}
      edges={MILESTONE_EDGES}
      ariaSummary={SUMMARY}
      emptyMessage="Nothing to draw."
      selectedId={selected}
      onSelect={(id) => {
        setSelected(id);
        onSelect(id);
      }}
    />
  );
}

describe('DependencyGraph', () => {
  test('labels the drawing and lists every edge for screen readers', () => {
    renderGraph();
    expect(screen.getByRole('img', { name: SUMMARY })).toBeTruthy();
    const table = screen.getByRole('table');
    // Header row + one row per edge.
    expect(table.querySelectorAll('tr')).toHaveLength(
      1 + MILESTONE_EDGES.length
    );
    expect(table.textContent).toContain('Index rebuild');
    expect(table.textContent).toContain('blocks, in a cycle');
  });

  test('shows the empty message when there are no nodes', () => {
    render(
      <DependencyGraph
        nodes={[]}
        edges={[]}
        ariaSummary="Empty."
        emptyMessage="No milestone waits on another."
      />
    );
    expect(screen.getByText('No milestone waits on another.')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  test('nodes are buttons in rank order behind one Tab stop', () => {
    renderGraph({ onSelect: () => undefined });
    const order = layoutGraph(MILESTONES, MILESTONE_EDGES).nodes.map(
      (n) => n.id
    );
    const buttons = screen
      .getAllByRole('button')
      .filter((b) => b.hasAttribute('data-graph-node'));
    expect(buttons.map((b) => b.getAttribute('data-graph-node'))).toEqual(
      order
    );
    // A roving tabindex: only the first node is in the Tab order.
    expect(buttons.filter((b) => b.tabIndex === 0)).toEqual([buttons[0]]);
    // Every node points at the key help.
    const help = buttons[0].getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(help)?.textContent).toContain(
      'Arrow keys move between nodes'
    );
    const name = buttons
      .find((b) => b.getAttribute('data-graph-node') === 'search-m1')
      ?.getAttribute('aria-label');
    expect(name).toContain('Index rebuild');
    expect(name).toContain('unassigned');
    expect(name).toContain('waits on 0, blocks 2');
  });

  test('Enter selects the focused node; aria-pressed follows', () => {
    const onSelect = mock((_id: string) => undefined);
    const { container } = render(<Selectable onSelect={onSelect} />);
    const node = nodeEl(container, 'mobile-m1');
    act(() => node.focus());
    fireEvent.keyDown(node, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0]).toBe('mobile-m1');
    expect(node.getAttribute('aria-pressed')).toBe('true');
    // A click selects too.
    fireEvent.click(nodeEl(container, 'atlas-m3'));
    expect(onSelect.mock.calls[1][0]).toBe('atlas-m3');
    expect(node.getAttribute('aria-pressed')).toBe('false');
  });

  test('arrow keys move focus to the neighbouring rank and along it', () => {
    const { container } = renderGraph({ onSelect: () => undefined });
    const layout = layoutGraph(MILESTONES, MILESTONE_EDGES);
    const first = layout.nodes[0];
    const start = nodeEl(container, first.id);
    act(() => start.focus());
    fireEvent.keyDown(start, { key: 'ArrowRight' });
    const focused = document.activeElement?.getAttribute('data-graph-node');
    const rankOf = new Map(layout.nodes.map((n) => [n.id, n.rank]));
    expect(rankOf.get(focused ?? '')).toBe(first.rank + 1);
    // Down within rank 0 reaches the next box in that column.
    act(() => start.focus());
    fireEvent.keyDown(start, { key: 'ArrowDown' });
    expect(document.activeElement?.getAttribute('data-graph-node')).toBe(
      layout.nodes[1].rank === 0 ? layout.nodes[1].id : first.id
    );
  });

  test('the Tab stop follows focus, and a new selection from outside', () => {
    const { container, rerender } = renderGraph({ onSelect: () => undefined });
    const stops = () =>
      [...container.querySelectorAll<HTMLElement>('[data-graph-node]')]
        .filter((el) => el.tabIndex === 0)
        .map((el) => el.dataset.graphNode);
    act(() => nodeEl(container, 'mobile-m1').focus());
    expect(stops()).toEqual(['mobile-m1']);
    // Leaving the graph keeps the stop where the reader was.
    act(() => nodeEl(container, 'mobile-m1').blur());
    expect(stops()).toEqual(['mobile-m1']);
    // The host selects another node (e.g. from a drawer list).
    rerender(
      <DependencyGraph
        nodes={MILESTONES}
        edges={MILESTONE_EDGES}
        ariaSummary={SUMMARY}
        emptyMessage="Nothing to draw."
        onSelect={() => undefined}
        selectedId="billing-m2"
      />
    );
    expect(stops()).toEqual(['billing-m2']);
  });

  test('Home and End jump to the first and last node', () => {
    const { container } = renderGraph({ onSelect: () => undefined });
    const order = layoutGraph(MILESTONES, MILESTONE_EDGES).nodes;
    const start = nodeEl(container, 'mobile-m1');
    act(() => start.focus());
    fireEvent.keyDown(start, { key: 'End' });
    const last = order[order.length - 1].id;
    expect(document.activeElement?.getAttribute('data-graph-node')).toBe(last);
    fireEvent.keyDown(nodeEl(container, last), { key: 'Home' });
    expect(document.activeElement?.getAttribute('data-graph-node')).toBe(
      order[0].id
    );
  });

  test('focus lights the upstream chain and dims the rest', () => {
    const { container } = renderGraph({ onSelect: () => undefined });
    act(() => nodeEl(container, 'mobile-m2').focus());
    expect(nodeEl(container, 'mobile-m2').dataset.state).toBe('active');
    for (const id of ['mobile-m1', 'search-m1', 'identity-m1', 'identity-m2']) {
      expect(nodeEl(container, id).dataset.state).toBe('lit');
    }
    expect(nodeEl(container, 'atlas-m3').dataset.state).toBe('dim');
    const edge = (key: string) =>
      container
        .querySelector(`[data-edge="${key}"]`)
        ?.getAttribute('data-state');
    expect(edge('search-m1->mobile-m1')).toBe('lit');
    expect(edge('billing-m0->mobile-m1')).toBe('dim');
    // Blur with nothing selected: everything returns to rest.
    act(() => nodeEl(container, 'mobile-m2').blur());
    expect(nodeEl(container, 'atlas-m3').dataset.state).toBeUndefined();
  });

  test('the selected node keeps its chain lit when nothing is hovered', () => {
    const { container } = renderGraph({
      onSelect: () => undefined,
      selectedId: 'billing-m2',
    });
    expect(nodeEl(container, 'billing-m2').dataset.state).toBe('active');
    expect(nodeEl(container, 'atlas-m3').dataset.state).toBe('lit');
    expect(nodeEl(container, 'search-m1').dataset.state).toBe('dim');
  });

  test('hover (not touch) lights a chain', () => {
    const { container } = renderGraph({ onSelect: () => undefined });
    const node = nodeEl(container, 'atlas-m4');
    fireEvent.pointerEnter(node, { pointerType: 'touch' });
    expect(node.dataset.state).toBeUndefined();
    fireEvent.pointerEnter(node, { pointerType: 'mouse' });
    expect(node.dataset.state).toBe('active');
    expect(nodeEl(container, 'atlas-m3').dataset.state).toBe('lit');
    fireEvent.pointerLeave(node, { pointerType: 'mouse' });
    expect(node.dataset.state).toBeUndefined();
  });

  test('zooms with the buttons and keys, and ctrl + wheel only', () => {
    const { container } = renderGraph();
    const value = () => container.querySelector('output')?.textContent;
    expect(value()).toContain('100%');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(value()).toContain('120%');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(value()).toContain('100%');
    const frame = container.firstElementChild as HTMLElement;
    fireEvent.keyDown(frame, { key: '-' });
    expect(value()).toContain('83%');
    // Ctrl/cmd + "-" is the browser's page zoom: left alone.
    fireEvent.keyDown(frame, { key: '-', ctrlKey: true });
    expect(value()).toContain('83%');

    const viewport = container.querySelector<HTMLElement>(
      '[data-graph-viewport]'
    );
    if (viewport === null) throw new Error('viewport');
    const plain = new WheelEvent('wheel', { deltaY: -100, cancelable: true });
    act(() => {
      viewport.dispatchEvent(plain);
    });
    expect(plain.defaultPrevented).toBe(false);
    expect(value()).toContain('83%');
    const pinch = new WheelEvent('wheel', { deltaY: -100, cancelable: true });
    // happy-dom's WheelEvent drops ctrlKey from the init dict; browsers keep it.
    Object.defineProperty(pinch, 'ctrlKey', { value: true });
    act(() => {
      viewport.dispatchEvent(pinch);
    });
    expect(pinch.defaultPrevented).toBe(true);
    expect(value()).not.toContain('83%');
  });

  test('ctrl + wheel still zooms when the graph starts empty', () => {
    const empty = (
      <DependencyGraph
        nodes={[]}
        edges={[]}
        ariaSummary={SUMMARY}
        emptyMessage="Loading."
      />
    );
    const { container, rerender } = render(empty);
    rerender(
      <DependencyGraph
        nodes={MILESTONES}
        edges={MILESTONE_EDGES}
        ariaSummary={SUMMARY}
        emptyMessage="Loading."
      />
    );
    const viewport = container.querySelector<HTMLElement>(
      '[data-graph-viewport]'
    );
    if (viewport === null) throw new Error('viewport');
    const pinch = new WheelEvent('wheel', { deltaY: -100, cancelable: true });
    Object.defineProperty(pinch, 'ctrlKey', { value: true });
    act(() => {
      viewport.dispatchEvent(pinch);
    });
    expect(pinch.defaultPrevented).toBe(true);
    expect(container.querySelector('output')?.textContent).not.toContain(
      '100%'
    );
  });

  test('drag pans the frame; a move with no button down ends the pan', () => {
    const { container } = renderGraph();
    const viewport = container.querySelector<HTMLElement>(
      '[data-graph-viewport]'
    );
    if (viewport === null) throw new Error('viewport');
    const canvas = viewport.firstElementChild as HTMLElement;
    const pointer = { pointerId: 1, pointerType: 'mouse', button: 0 };
    fireEvent.pointerDown(canvas, { ...pointer, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(viewport, {
      ...pointer,
      buttons: 1,
      clientX: 150,
      clientY: 180,
    });
    expect(viewport.scrollLeft).toBe(50);
    expect(viewport.scrollTop).toBe(20);
    expect(viewport.hasAttribute('data-panning')).toBe(true);
    // The pointerup was lost (released outside the window): the next
    // plain move must not keep dragging the canvas.
    fireEvent.pointerMove(viewport, {
      ...pointer,
      buttons: 0,
      clientX: 100,
      clientY: 100,
    });
    expect(viewport.scrollLeft).toBe(50);
    expect(viewport.hasAttribute('data-panning')).toBe(false);
    // A press on a node never pans, so clicks still select.
    fireEvent.pointerDown(nodeEl(container, 'atlas-m3'), {
      ...pointer,
      clientX: 300,
      clientY: 300,
    });
    fireEvent.pointerMove(viewport, {
      ...pointer,
      buttons: 1,
      clientX: 200,
      clientY: 300,
    });
    expect(viewport.scrollLeft).toBe(50);
  });

  test('the edge table names itself instead of repeating the summary', () => {
    renderGraph();
    const caption = screen.getByRole('table').querySelector('caption');
    expect(caption?.textContent).not.toBe(SUMMARY);
    expect(caption?.textContent).toContain('blocker');
  });

  test('read-only graphs render focusable groups, link nodes anchors', () => {
    const { container } = render(
      <DependencyGraph
        nodes={[
          { id: 'a', label: 'Plain', tone: 'default' },
          { id: 'b', label: 'Linked', tone: 'default', href: '/timeline?m=b' },
        ]}
        edges={[{ from: 'a', to: 'b', kind: 'default' }]}
        ariaSummary="Two nodes."
        emptyMessage="Nothing."
      />
    );
    expect(nodeEl(container, 'a').tagName).toBe('DIV');
    expect(nodeEl(container, 'a').tabIndex).toBe(0);
    const link = nodeEl(container, 'b').querySelector('a');
    expect(link?.getAttribute('href')).toBe('/timeline?m=b');
    // The host's <Link> takes no tabIndex prop; the roving stop and the
    // key help still reach its anchor.
    expect(link?.tabIndex).toBe(-1);
    expect(link?.getAttribute('aria-describedby')).toBe(
      nodeEl(container, 'a').getAttribute('aria-describedby')
    );
    act(() => link?.focus());
    expect(nodeEl(container, 'a').tabIndex).toBe(-1);
    expect(link?.tabIndex).toBe(0);
    expect(screen.queryAllByRole('button', { pressed: false })).toHaveLength(0);
  });
});

/**
 * Gives the graph's frame a size for one test: happy-dom lays nothing out,
 * so every clientWidth/clientHeight reads 0. Only the element carrying
 * data-graph-viewport is resized; the returned function restores the
 * prototype.
 */
function sizeViewport(width: number, height: number): () => void {
  const proto = HTMLElement.prototype;
  const own = (key: 'clientWidth' | 'clientHeight') =>
    Object.getOwnPropertyDescriptor(proto, key);
  const saved = {
    clientWidth: own('clientWidth'),
    clientHeight: own('clientHeight'),
  };
  for (const [key, size] of [
    ['clientWidth', width],
    ['clientHeight', height],
  ] as const) {
    Object.defineProperty(proto, key, {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute('data-graph-viewport') ? size : 0;
      },
    });
  }
  return () => {
    for (const key of ['clientWidth', 'clientHeight'] as const) {
      const descriptor = saved[key];
      if (descriptor === undefined) Reflect.deleteProperty(proto, key);
      else Object.defineProperty(proto, key, descriptor);
    }
  };
}

/**
 * Places the graph's frame at `left`…`right` in a window `windowWidth`
 * wide for one test (happy-dom lays nothing out, so every rect is zero);
 * the returned function restores both.
 */
function stubFrame(
  frame: { left: number; right: number },
  windowWidth: number
): () => void {
  const proto = HTMLElement.prototype;
  const rect = Object.getOwnPropertyDescriptor(proto, 'getBoundingClientRect');
  const width = Object.getOwnPropertyDescriptor(window, 'innerWidth');
  const original = proto.getBoundingClientRect;
  Object.defineProperty(proto, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement): DOMRect {
      if (!this.hasAttribute('data-graph-viewport')) {
        return original.call(this);
      }
      return DOMRect.fromRect({
        x: frame.left,
        y: 0,
        width: frame.right - frame.left,
        height: 60,
      });
    },
  });
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: windowWidth,
  });
  return () => {
    if (rect === undefined)
      Reflect.deleteProperty(proto, 'getBoundingClientRect');
    else Object.defineProperty(proto, 'getBoundingClientRect', rect);
    if (width === undefined) Reflect.deleteProperty(window, 'innerWidth');
    else Object.defineProperty(window, 'innerWidth', width);
  };
}

function viewportOf(container: HTMLElement): HTMLElement {
  const viewport = container.querySelector<HTMLElement>(
    '[data-graph-viewport]'
  );
  if (viewport === null) throw new Error('viewport');
  return viewport;
}

describe('DependencyGraph: a host layout and a focus node', () => {
  test('a given layout is used as is: its size, boxes and wrapped labels', () => {
    // Nothing dagre would produce: the labels and positions are the host's.
    const layout: GraphLayout = {
      width: 640,
      height: 200,
      direction: 'LR',
      nodes: [
        {
          id: 'a',
          x: 10,
          y: 20,
          width: 180,
          height: 60,
          rank: 0,
          labelLines: ['Alpha, as the host', 'wrapped it'],
          sublabelLine: 'HOST LINE',
        },
        {
          id: 'b',
          x: 400,
          y: 120,
          width: 180,
          height: 60,
          rank: 1,
          labelLines: ['Beta'],
          sublabelLine: '',
        },
      ],
      edges: [
        {
          key: 'a->b',
          from: 'a',
          to: 'b',
          kind: 'risk',
          weight: 1,
          points: [
            { x: 190, y: 50 },
            { x: 400, y: 150 },
          ],
          path: 'M190,50L400,150',
          arrow: 'M400,150L394,147L394,153Z',
          label: null,
        },
      ],
      groups: [],
    };
    const { container } = render(
      <DependencyGraph
        nodes={[
          { id: 'a', label: 'Alpha', tone: 'default' },
          { id: 'b', label: 'Beta', tone: 'default' },
        ]}
        edges={[{ from: 'a', to: 'b', kind: 'risk' }]}
        ariaSummary="Two nodes."
        emptyMessage="Nothing."
        direction="TB"
        layout={layout}
      />
    );
    const viewport = viewportOf(container);
    expect(viewport.style.getPropertyValue('--graph-h')).toBe('200px');
    const canvas = viewport.firstElementChild as HTMLElement;
    expect(canvas.style.width).toBe('640px');
    expect(canvas.style.height).toBe('200px');
    expect(
      container.querySelector('svg[role="img"]')?.getAttribute('viewBox')
    ).toBe('0 0 640 200');
    const a = nodeEl(container, 'a');
    expect(a.style.left).toBe('10px');
    expect(a.style.top).toBe('20px');
    expect(a.textContent).toContain('Alpha, as the host');
    expect(a.textContent).toContain('HOST LINE');
    expect(nodeEl(container, 'b').style.top).toBe('120px');
    expect(
      container.querySelector('[data-edge="a->b"] path')?.getAttribute('d')
    ).toBe('M190,50L400,150');
  });

  test('focusId marks its node and ends its name, and lights nothing', () => {
    const { container } = renderGraph({
      onSelect: () => undefined,
      focusId: 'mobile-m1',
    });
    const focus = nodeEl(container, 'mobile-m1');
    expect(focus.hasAttribute('data-focus')).toBe(true);
    expect(container.querySelectorAll('[data-focus]')).toHaveLength(1);
    expect(focus.getAttribute('aria-label')).toBe(
      // The resolved Payments SDK edge is not an open wait.
      'Offline sync. Mobile · due Nov 5. waits on 1, blocks 1. focus.'
    );
    // Not a selection: not pressed, and idle means nothing lit or dimmed.
    expect(focus.getAttribute('aria-pressed')).toBe('false');
    expect(
      container.querySelectorAll('[data-graph-node][data-state]')
    ).toHaveLength(0);
    expect(container.querySelectorAll('[data-edge][data-state]')).toHaveLength(
      0
    );
    // With nothing selected or focused yet, Tab lands on the focus node.
    const stops = [
      ...container.querySelectorAll<HTMLElement>('[data-graph-node]'),
    ].filter((el) => el.tabIndex === 0);
    expect(stops).toEqual([focus]);
    // Hover still reads a chain as usual.
    fireEvent.pointerEnter(nodeEl(container, 'mobile-m2'), {
      pointerType: 'mouse',
    });
    expect(focus.dataset.state).toBe('lit');
  });

  test('focusLabel words the name; a link node carries both marks', () => {
    const { container } = render(
      <DependencyGraph
        nodes={[
          { id: 'a', label: 'Blocker', tone: 'default' },
          { id: 'b', label: 'Subject', tone: 'default', href: '/graph?b' },
        ]}
        edges={[{ from: 'a', to: 'b', kind: 'default' }]}
        ariaSummary="Two nodes."
        emptyMessage="Nothing."
        focusId="b"
        focusLabel="the issue this chain is about"
      />
    );
    const wrap = nodeEl(container, 'b');
    expect(wrap.hasAttribute('data-focus')).toBe(true);
    expect(wrap.querySelector('a')?.getAttribute('aria-label')).toBe(
      'Subject. waits on 1, blocks 0. the issue this chain is about.'
    );
    expect(nodeEl(container, 'a').getAttribute('aria-label')).toBe(
      'Blocker. waits on 0, blocks 1.'
    );
  });

  test('the focus is an accent ring standing off the box, never a status', () => {
    const css = readFileSync(
      path.join(
        import.meta.dir,
        '..',
        'src',
        'graph',
        'dependency-graph.module.css'
      ),
      'utf8'
    );
    // A bordered box (forced colours keep borders, not shadows) 3px off
    // the card's edge, in the accent; the selection ring hugs the card.
    const focus = /\.focusRing \{(\s*inset[^}]*)\}/.exec(css)?.[1] ?? '';
    expect(focus).toContain('inset: -6px;');
    expect(focus).toContain('border: 2px solid var(--accent);');
    expect(focus).not.toContain('shadow');
    const ring = /\.ring \{(\s*display[^}]*)\}/.exec(css)?.[1] ?? '';
    expect(ring).toContain('inset: -2px;');
    expect(ring).toContain('border: 2px solid var(--accent);');
    // Status and risk never use the accent: tones, edges and the cycle
    // outline take the semantic hues.
    const toneRule = /\.toneStatus \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(toneRule).toContain('border-color: var(--tone);');
    expect(/\.edgeRisk \{([^}]*)\}/.exec(css)?.[1]).toContain('var(--amber)');
    expect(/\.edgeCycle \{([^}]*)\}/.exec(css)?.[1]).toContain('var(--red)');
    // (The rule that draws it, not the shared positioning one.)
    expect(/\.cycleRing \{(\s*inset[^}]*)\}/.exec(css)?.[1]).toContain(
      'dashed var(--red)'
    );
    // Forced colours repaint the rings in the system highlight.
    expect(css).toContain('@media (forced-colors: active)');
  });

  test('nodes carry their tone, mark, key, chips and rings', () => {
    const { container } = render(
      <DependencyGraph
        nodes={[
          {
            id: 'a',
            label: 'Backfill',
            key: 'ATL-43',
            tone: 'danger',
            state: 'unstarted',
            statusLabel: 'Todo',
            tags: [
              { label: 'Unassigned', tone: 'warning' },
              { label: 'Overdue', tone: 'danger' },
            ],
          },
          {
            id: 'b',
            label: 'Cutover',
            sublabel: 'Atlas · Oct 18',
            tone: 'default',
            status: 'on_track',
            statusLabel: 'On track',
            statusMuted: true,
            external: true,
            inCycle: true,
            tags: [{ label: 'Cycle', tone: 'danger' }],
          },
        ]}
        edges={[
          { from: 'a', to: 'b', kind: 'cycle' },
          { from: 'b', to: 'a', kind: 'cycle' },
        ]}
        ariaSummary="Two nodes."
        emptyMessage="Nothing."
        focusId="a"
        onSelect={() => undefined}
      />
    );
    const a = nodeEl(container, 'a');
    expect(a.dataset.tone).toBe('danger');
    expect(a.getAttribute('aria-label')).toBe(
      'Backfill. ATL-43. Todo. unassigned, overdue. waits on 1, blocks 1. focus.'
    );
    // The workflow-state circle, not a status diamond; hidden from AT.
    expect(a.querySelector('svg[data-kind="unstarted"]')).not.toBeNull();
    expect(a.querySelector('[data-status]')).toBeNull();
    // Chips in their tones, sentence case.
    const chips = [
      ...a.querySelectorAll('[data-tone="warning"], [data-tone="danger"]'),
    ]
      .filter((el) => el !== a)
      .map((el) => `${el.textContent}:${el.getAttribute('data-tone')}`);
    expect(chips).toEqual(['Unassigned:warning', 'Overdue:danger']);
    // The focus ring is drawn; the cycle outline is not (a is in no cycle
    // by its data).
    expect(a.hasAttribute('data-focus')).toBe(true);
    expect(a.hasAttribute('data-cycle')).toBe(false);
    const b = nodeEl(container, 'b');
    expect(b.hasAttribute('data-cycle')).toBe(true);
    // The status diamond, greyed when asked, still named by its label.
    const mark = b.querySelector('[data-status="on_track"]');
    expect(mark?.hasAttribute('data-muted')).toBe(true);
    expect(mark?.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(b.getAttribute('aria-label')).toBe(
      'Cutover. Atlas · Oct 18. On track. cycle. outside this scope. waits on 1, blocks 1.'
    );
  });

  test('the first paint centres the focus node in the frame, not the page', () => {
    const restore = sizeViewport(300, 60);
    try {
      const box = layoutGraph(MILESTONES, MILESTONE_EDGES).nodes.find(
        (n) => n.id === 'mobile-m2'
      );
      if (box === undefined) throw new Error('mobile-m2');
      const scrolled = mock(() => undefined);
      const before = window.scrollY;
      window.addEventListener('scroll', scrolled);
      const { container } = renderGraph({
        focusId: 'mobile-m2',
        selectedId: 'atlas-m2',
      });
      window.removeEventListener('scroll', scrolled);
      const viewport = viewportOf(container);
      const left = box.x + box.width / 2 - 150;
      expect(left).toBeGreaterThan(0);
      expect(viewport.scrollLeft).toBe(left);
      expect(viewport.scrollTop).toBe(Math.max(0, box.y + box.height / 2 - 30));
      expect(window.scrollY).toBe(before);
      expect(scrolled).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  test('without a focus the selection is centred, once', () => {
    const restore = sizeViewport(300, 60);
    try {
      const layout = layoutGraph(MILESTONES, MILESTONE_EDGES);
      const centre = (id: string) => {
        const box = layout.nodes.find((n) => n.id === id);
        if (box === undefined) throw new Error(id);
        return Math.max(0, box.x + box.width / 2 - 150);
      };
      const { container, rerender } = renderGraph({
        onSelect: () => undefined,
        selectedId: 'billing-m2',
      });
      const viewport = viewportOf(container);
      expect(viewport.scrollLeft).toBe(centre('billing-m2'));
      // A later selection never moves the drawing under the reader.
      viewport.scrollLeft = 0;
      rerender(
        <DependencyGraph
          nodes={MILESTONES}
          edges={MILESTONE_EDGES}
          ariaSummary={SUMMARY}
          emptyMessage="Nothing to draw."
          onSelect={() => undefined}
          selectedId="mobile-m2"
        />
      );
      expect(viewport.scrollLeft).toBe(0);
    } finally {
      restore();
    }
  });

  test('a graph that starts empty centres its focus when the frame appears', () => {
    const restore = sizeViewport(300, 60);
    try {
      const props = {
        ariaSummary: SUMMARY,
        emptyMessage: 'Loading.',
        focusId: 'mobile-m2',
      };
      const { container, rerender } = render(
        <DependencyGraph nodes={[]} edges={[]} {...props} />
      );
      rerender(
        <DependencyGraph
          nodes={MILESTONES}
          edges={MILESTONE_EDGES}
          {...props}
        />
      );
      expect(viewportOf(container).scrollLeft).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });

  test('beside a host panel the selection is brought into the uncovered part', () => {
    // A 600px frame from x 100 to 700 in a 1000px window; a 560px panel
    // fixed on the right starts at x 440 and covers the frame's last 260px.
    const restore = sizeViewport(600, 60);
    const unstub = stubFrame({ left: 100, right: 700 }, 1000);
    try {
      const box = layoutGraph(MILESTONES, MILESTONE_EDGES).nodes.find(
        (n) => n.id === 'billing-m2'
      );
      if (box === undefined) throw new Error('billing-m2');
      const props = {
        nodes: MILESTONES,
        edges: MILESTONE_EDGES,
        ariaSummary: SUMMARY,
        emptyMessage: 'Nothing.',
        onSelect: () => undefined,
        selectedId: 'billing-m2',
      };
      const { container, rerender } = render(
        <DependencyGraph {...props} coveredRight={560} />
      );
      const viewport = viewportOf(container);
      // The frame keeps the covered part as padding (scroll room), and the
      // box is brought into the 340px the panel leaves: centred there, or
      // scrolled only until it shows whole (16px clear) when that is less.
      expect(viewport.style.paddingRight).toBe('260px');
      const centred = box.x + box.width / 2 - 170;
      const revealed = box.x + box.width + 16 - 340;
      expect(revealed).toBeLessThan(centred);
      expect(viewport.scrollLeft).toBe(Math.max(0, revealed));
      expect(viewport.scrollLeft).toBeGreaterThan(0);
      // The panel closes: the room goes, the drawing is not re-centred.
      viewport.scrollLeft = 7;
      rerender(<DependencyGraph {...props} />);
      expect(viewport.style.paddingRight).toBe('');
      expect(viewport.scrollLeft).toBe(7);
    } finally {
      unstub();
      restore();
    }
  });

  test('a panel that would leave almost nothing of the frame moves nothing', () => {
    // A phone: the 560px sheet covers the whole 600px window and frame.
    const restore = sizeViewport(600, 60);
    const unstub = stubFrame({ left: 0, right: 600 }, 600);
    try {
      const box = layoutGraph(MILESTONES, MILESTONE_EDGES).nodes.find(
        (n) => n.id === 'billing-m2'
      );
      if (box === undefined) throw new Error('billing-m2');
      const { container } = renderGraph({
        onSelect: () => undefined,
        selectedId: 'billing-m2',
        coveredRight: 560,
      });
      const viewport = viewportOf(container);
      expect(viewport.style.paddingRight).toBe('');
      expect(viewport.scrollLeft).toBe(
        Math.max(0, box.x + box.width / 2 - 300)
      );
    } finally {
      unstub();
      restore();
    }
  });

  test('a focus or selection that is not drawn scrolls nothing', () => {
    const restore = sizeViewport(300, 60);
    try {
      const { container } = renderGraph({ focusId: 'not-drawn' });
      expect(viewportOf(container).scrollLeft).toBe(0);
      expect(viewportOf(container).scrollTop).toBe(0);
    } finally {
      restore();
    }
  });
});

describe('GraphLegend', () => {
  test('lists box and arrow marks in two labelled rows', () => {
    render(<GraphLegend />);
    const legend = screen.getByRole('group', { name: 'Graph legend' });
    expect(legend.textContent).toContain('Boxes');
    expect(legend.textContent).toContain('Arrows');
    expect(legend.textContent).not.toContain('Status');
    expect(screen.getByText('Risk chain')).toBeTruthy();
    expect(screen.getAllByRole('listitem').length).toBeGreaterThan(8);
  });

  test('takes custom items', () => {
    render(
      <GraphLegend
        label="Epic legend"
        items={[{ mark: 'edge-risk', label: 'Waits on you' }]}
      />
    );
    const legend = screen.getByRole('group', { name: 'Epic legend' });
    expect(legend.textContent).not.toContain('Boxes');
    expect(screen.getByText('Waits on you')).toBeTruthy();
  });

  test('a Status row draws the diamonds and circles, hidden, before the boxes', () => {
    render(
      <GraphLegend
        items={[
          { mark: 'node', label: 'Issue' },
          { mark: 'status', status: 'overdue', label: 'Overdue' },
          { mark: 'state', state: 'started', label: 'In progress' },
        ]}
      />
    );
    const legend = screen.getByRole('group', { name: 'Graph legend' });
    const [status, boxes] = within(legend).getAllByRole('list');
    expect(status.textContent).toBe('OverdueIn progress');
    expect(boxes.textContent).toBe('Issue');
    const diamond = status.querySelector('[data-mark="status"]');
    expect(diamond?.getAttribute('aria-hidden')).toBe('true');
    expect(diamond?.querySelector('[data-status="overdue"]')).not.toBeNull();
    expect(
      status.querySelector('[data-mark="state"] svg[data-kind="started"]')
    ).not.toBeNull();
    // The marks are hidden, so no image is announced twice.
    expect(within(legend).queryAllByRole('img')).toHaveLength(0);
  });

  test('the focus swatch repeats the graph’s accent ring', () => {
    const css = readFileSync(
      path.join(
        import.meta.dir,
        '..',
        'src',
        'graph',
        'graph-legend.module.css'
      ),
      'utf8'
    );
    const rule = /\.nodeFocus::after \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('border: 2px solid var(--accent);');
  });
});
