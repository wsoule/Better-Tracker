import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { useState } from 'react';

import { DependencyGraph } from '../src/graph/dependency-graph';
import { GraphLegend } from '../src/graph/graph-legend';
import { layoutGraph } from '../src/graph/layout';
import type { DependencyGraphProps } from '../src/graph/types';
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

describe('GraphLegend', () => {
  test('lists node and edge marks in two labelled rows', () => {
    render(<GraphLegend />);
    const legend = screen.getByRole('group', { name: 'Graph legend' });
    expect(legend.textContent).toContain('Nodes');
    expect(legend.textContent).toContain('Edges');
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
    expect(legend.textContent).not.toContain('Nodes');
    expect(screen.getByText('Waits on you')).toBeTruthy();
  });
});
