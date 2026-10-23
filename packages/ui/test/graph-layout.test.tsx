import { describe, expect, test } from 'bun:test';

import {
  basisPath,
  clipText,
  GRAPH_METRICS,
  layoutGraph,
  measureNode,
  textWidth,
  wrapText,
} from '../src/graph/layout';
import type { GraphLayout, LaidOutNode } from '../src/graph/types';
import {
  ISSUE_EDGES,
  ISSUES,
  MILESTONE_EDGES,
  MILESTONES,
} from './graph-fixture';

type Box = { x: number; y: number; width: number; height: number };

function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

/** Every pair of boxes that intersect, as "a × b" for a readable failure. */
function collisions(boxes: readonly (Box & { id: string })[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (overlaps(boxes[i], boxes[j])) {
        out.push(`${boxes[i].id} × ${boxes[j].id}`);
      }
    }
  }
  return out;
}

function byId(layout: GraphLayout): Map<string, LaidOutNode> {
  return new Map(layout.nodes.map((n) => [n.id, n]));
}

describe('layoutGraph', () => {
  test('is deterministic: the same input lays out identically', () => {
    const a = layoutGraph(MILESTONES, MILESTONE_EDGES);
    const b = layoutGraph(MILESTONES, MILESTONE_EDGES);
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    // And from fresh copies of the data, as a server and a client would.
    const c = layoutGraph(
      structuredClone(MILESTONES),
      structuredClone(MILESTONE_EDGES)
    );
    expect(c).toEqual(a);
  });

  test('places every node once, inside the canvas, with no overlaps', () => {
    for (const [nodes, edges, options] of [
      [MILESTONES, MILESTONE_EDGES, {}],
      [MILESTONES, MILESTONE_EDGES, { cluster: true }],
      [MILESTONES, MILESTONE_EDGES, { direction: 'TB' as const }],
      [ISSUES, ISSUE_EDGES, {}],
    ] as const) {
      const layout = layoutGraph(nodes, edges, options);
      expect(layout.nodes.map((n) => n.id).sort()).toEqual(
        nodes.map((n) => n.id).sort()
      );
      expect(collisions(layout.nodes)).toEqual([]);
      for (const n of layout.nodes) {
        expect(n.x).toBeGreaterThanOrEqual(0);
        expect(n.y).toBeGreaterThanOrEqual(0);
        expect(n.x + n.width).toBeLessThanOrEqual(layout.width);
        expect(n.y + n.height).toBeLessThanOrEqual(layout.height);
      }
    }
  });

  test('weight labels sit clear of every node box', () => {
    const layout = layoutGraph(MILESTONES, MILESTONE_EDGES);
    const labels = layout.edges.flatMap((e) =>
      e.label === null ? [] : [{ id: `label ${e.key}`, ...e.label }]
    );
    expect(labels).toHaveLength(5);
    for (const label of labels) {
      for (const n of layout.nodes) {
        expect(overlaps(label, n)).toBe(false);
      }
    }
  });

  test('left to right: every acyclic blocker ends before what waits on it', () => {
    const layout = layoutGraph(MILESTONES, MILESTONE_EDGES);
    const at = byId(layout);
    for (const edge of MILESTONE_EDGES) {
      if (edge.kind === 'cycle') continue;
      const from = at.get(edge.from);
      const to = at.get(edge.to);
      expect(from !== undefined && to !== undefined).toBe(true);
      if (from === undefined || to === undefined) continue;
      expect(from.x + from.width).toBeLessThan(to.x);
      expect(from.rank).toBeLessThan(to.rank);
    }
  });

  test('top to bottom puts blockers above', () => {
    const layout = layoutGraph(ISSUES, ISSUE_EDGES, { direction: 'TB' });
    const at = byId(layout);
    for (const edge of ISSUE_EDGES) {
      const from = at.get(edge.from);
      const to = at.get(edge.to);
      if (from === undefined || to === undefined) throw new Error(edge.to);
      expect(from.y + from.height).toBeLessThan(to.y);
    }
  });

  test('returns nodes in focus order: by rank, then down the rank', () => {
    const layout = layoutGraph(MILESTONES, MILESTONE_EDGES);
    for (let i = 1; i < layout.nodes.length; i += 1) {
      const prev = layout.nodes[i - 1];
      const next = layout.nodes[i];
      expect(prev.rank <= next.rank).toBe(true);
      if (prev.rank === next.rank) {
        expect(prev.y + prev.height / 2).toBeLessThanOrEqual(
          next.y + next.height / 2
        );
      }
    }
    expect(layout.nodes[0].rank).toBe(0);
  });

  test('paints faint edges first, risk and cycles last', () => {
    const layout = layoutGraph(MILESTONES, MILESTONE_EDGES);
    const kinds = layout.edges.map((e) => e.kind);
    const order = ['resolved', 'default', 'cross', 'risk', 'cycle'];
    const ranks = kinds.map((k) => order.indexOf(k));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(kinds[0]).toBe('resolved');
    expect(kinds[kinds.length - 1]).toBe('cycle');
  });

  test('routes each edge from border to border with an arrowhead', () => {
    const layout = layoutGraph(MILESTONES, MILESTONE_EDGES);
    const at = byId(layout);
    for (const edge of layout.edges) {
      expect(edge.path.startsWith('M')).toBe(true);
      expect(edge.arrow.endsWith('Z')).toBe(true);
      const tip = edge.points[edge.points.length - 1];
      const to = at.get(edge.to);
      if (to === undefined) throw new Error(edge.to);
      // The tip lands on (within a pixel of) the waiting box's border.
      const onX =
        Math.abs(tip.x - to.x) <= 1.5 ||
        Math.abs(tip.x - (to.x + to.width)) <= 1.5;
      const onY =
        Math.abs(tip.y - to.y) <= 1.5 ||
        Math.abs(tip.y - (to.y + to.height)) <= 1.5;
      expect(onX || onY).toBe(true);
      expect(edge.label === null).toBe(edge.weight <= 1);
    }
  });

  test('drops edges to unknown nodes and repeated pairs', () => {
    const layout = layoutGraph(MILESTONES.slice(0, 3), [
      { from: 'atlas-m2', to: 'atlas-m3', kind: 'default' },
      { from: 'atlas-m2', to: 'atlas-m3', kind: 'risk' },
      { from: 'atlas-m3', to: 'nowhere', kind: 'default' },
    ]);
    expect(layout.edges.map((e) => `${e.key}:${e.kind}`)).toEqual([
      'atlas-m2->atlas-m3:default',
    ]);
  });

  test('frames groups only when asked to cluster', () => {
    expect(layoutGraph(MILESTONES, MILESTONE_EDGES).groups).toEqual([]);
    const clustered = layoutGraph(MILESTONES, MILESTONE_EDGES, {
      cluster: true,
    });
    expect(clustered.groups.map((g) => g.label).sort()).toEqual([
      'Atlas',
      'Billing',
      'Identity',
      'Mobile',
      'Search',
    ]);
    const at = byId(clustered);
    for (const group of clustered.groups) {
      for (const n of MILESTONES.filter((m) => m.group === group.label)) {
        const box = at.get(n.id);
        if (box === undefined) throw new Error(n.id);
        expect(box.x).toBeGreaterThanOrEqual(group.x);
        expect(box.x + box.width).toBeLessThanOrEqual(group.x + group.width);
      }
    }
  });

  test('an empty graph has no size', () => {
    expect(layoutGraph([], [])).toEqual({
      width: 0,
      height: 0,
      direction: 'LR',
      nodes: [],
      edges: [],
      groups: [],
    });
  });
});

describe('node metrics', () => {
  const M = GRAPH_METRICS;

  test('measures Geist proportionally: wide letters take more room', () => {
    expect(textWidth('', 13.5)).toBe(0);
    expect(textWidth('WWWW', 13.5)).toBeGreaterThan(
      textWidth('iiii', 13.5) * 3
    );
    // Twice the size, twice the width; unknown characters still count.
    expect(textWidth('Atlas', 27)).toBeCloseTo(textWidth('Atlas', 13.5) * 2);
    expect(textWidth('日本', 12)).toBeGreaterThan(0);
  });

  test('sizes a box from its label, within the clamp', () => {
    const short = measureNode(MILESTONES[1]);
    expect(short.width).toBeGreaterThanOrEqual(M.minWidth);
    expect(short.labelLines).toEqual(['M3 Cutover']);
    const long = measureNode(ISSUES[3]);
    expect(long.width).toBe(M.maxWidth);
    expect(long.labelLines).toHaveLength(2);
    expect(long.labelLines[1].endsWith('…')).toBe(true);
    // Two label lines and a tag row make a taller box.
    expect(long.height).toBeGreaterThan(short.height);
  });

  test('every wrapped line and sublabel fits inside its box', () => {
    for (const node of [...MILESTONES, ...ISSUES]) {
      const box = measureNode(node);
      const marked = node.status !== undefined || node.state !== undefined;
      const inner =
        box.width -
        (M.padX + M.border) * 2 -
        (marked ? M.glyph + M.glyphGap : 0);
      for (const line of box.labelLines) {
        expect(textWidth(line, M.labelSize)).toBeLessThanOrEqual(inner);
      }
      const key = node.key ?? '';
      const keyWidth =
        key === ''
          ? 0
          : key.length * M.keyAdvance +
            (box.sublabelLine === '' ? 0 : M.keyGap);
      expect(
        keyWidth + textWidth(box.sublabelLine, M.subSize)
      ).toBeLessThanOrEqual(inner);
    }
  });

  test('a key adds its mono line; tags add a chip row', () => {
    const bare = measureNode({ id: 'a', label: 'A', tone: 'default' });
    const keyed = measureNode({
      id: 'a',
      label: 'A',
      key: 'ENG-1',
      tone: 'default',
    });
    expect(keyed.height - bare.height).toBe(M.subGap + M.subLine);
    const tagged = measureNode({
      id: 'a',
      label: 'A',
      tone: 'default',
      tags: [{ label: 'Overdue', tone: 'danger' }],
    });
    expect(tagged.height - bare.height).toBe(M.tagsGap + M.tagHeight);
  });

  test('wraps by words and breaks a word wider than the line', () => {
    const size = M.labelSize;
    const fit = (text: string) => textWidth(text, size) + 0.5;
    expect(wrapText('Switch read path', fit('read path'), size, 2)).toEqual([
      'Switch',
      'read path',
    ]);
    const broken = wrapText('Supercalifragilistic', fit('Supercal'), size, 2);
    expect(broken[0]).toBe('Supercal');
    expect(broken[1].endsWith('…')).toBe(true);
    const cut = wrapText('one two three four five', fit('one two'), size, 2);
    expect(cut[0]).toBe('one two');
    expect(cut[1].startsWith('three')).toBe(true);
    expect(cut[1].endsWith('…')).toBe(true);
    for (const line of [...broken, ...cut]) {
      expect(textWidth(line, size)).toBeLessThanOrEqual(fit('Supercal'));
    }
  });

  test('clips to the longest prefix that fits with an ellipsis', () => {
    expect(clipText('Atlas', 500, 12)).toBe('Atlas');
    const clipped = clipText('Atlas billing migration', 60, 12);
    expect(clipped.endsWith('…')).toBe(true);
    expect(textWidth(clipped, 12)).toBeLessThanOrEqual(60);
    expect(clipText('Atlas', 1, 12)).toBe('…');
  });

  test('basisPath draws straight two-point edges and curves the rest', () => {
    expect(
      basisPath([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ])
    ).toBe('M0,0L10,0');
    const curve = basisPath([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 20, y: 0 },
    ]);
    expect(curve.startsWith('M0,0')).toBe(true);
    expect(curve.endsWith('L20,0')).toBe(true);
    expect(curve).toContain('C');
  });
});
