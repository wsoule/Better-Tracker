import {
  type GraphEdgeData,
  type GraphNodeData,
  layoutGraph,
} from '@better-tracker/ui';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  cachedLayoutGraph,
  clearLayoutCache,
  LAYOUT_CACHE_SIZE,
} from '../lib/adapters/graph-layout-cache';

// The /graph page's layout cache: the same drawing is laid out once and
// reused (a slide-over opening and closing, the demo's shared visitors);
// any change to a box or an edge is laid out afresh.

const NODES: GraphNodeData[] = [
  {
    id: 'a',
    label: 'Schema rollout',
    sublabel: 'DATA-45 · Iris',
    tone: 'default',
    status: 'open',
  },
  {
    id: 'b',
    label: 'Report builder',
    sublabel: 'DATA-75 · Kai',
    tone: 'warning',
    status: 'open',
  },
  {
    id: 'c',
    label: 'Go / no-go',
    sublabel: 'GRO-40 · Uma',
    tone: 'default',
    status: 'open',
  },
];
const EDGES: GraphEdgeData[] = [
  { from: 'a', to: 'b', kind: 'default' },
  { from: 'b', to: 'c', kind: 'risk', weight: 2 },
];

afterEach(() => {
  clearLayoutCache();
});

describe('cachedLayoutGraph', () => {
  test('is layoutGraph, and the same input reuses the same layout', () => {
    const first = cachedLayoutGraph(NODES, EDGES, { direction: 'LR' });
    expect(first).toEqual(layoutGraph(NODES, EDGES, { direction: 'LR' }));
    // An equal input built afresh (a new request) is a hit.
    const again = cachedLayoutGraph(
      NODES.map((n) => ({ ...n })),
      EDGES.map((e) => ({ ...e })),
      { direction: 'LR' }
    );
    expect(again).toBe(first);
  });

  test('a changed box, edge or option is laid out afresh', () => {
    const first = cachedLayoutGraph(NODES, EDGES, { direction: 'LR' });
    const renamed = cachedLayoutGraph(
      NODES.map((n) =>
        n.id === 'a' ? { ...n, label: 'Schema rollout, the overdue one' } : n
      ),
      EDGES,
      { direction: 'LR' }
    );
    expect(renamed).not.toBe(first);
    expect(
      renamed.nodes.find((n) => n.id === 'a')?.labelLines.join(' ')
    ).toContain('overdue');
    const rekinded = cachedLayoutGraph(
      NODES,
      EDGES.map((e) => ({ ...e, kind: 'cycle' as const })),
      { direction: 'LR' }
    );
    expect(rekinded).not.toBe(first);
    expect(rekinded.edges.every((e) => e.kind === 'cycle')).toBe(true);
    expect(cachedLayoutGraph(NODES, EDGES, { direction: 'TB' })).not.toBe(
      first
    );
    // The first input is still kept.
    expect(cachedLayoutGraph(NODES, EDGES, { direction: 'LR' })).toBe(first);
  });

  test('keeps only the most recently used layouts', () => {
    const first = cachedLayoutGraph(NODES, EDGES);
    for (let i = 0; i < LAYOUT_CACHE_SIZE; i += 1) {
      cachedLayoutGraph(
        NODES.map((n) => ({ ...n, label: `${n.label} ${i}` })),
        EDGES
      );
    }
    // The oldest went to make room.
    expect(cachedLayoutGraph(NODES, EDGES)).not.toBe(first);
  });
});
