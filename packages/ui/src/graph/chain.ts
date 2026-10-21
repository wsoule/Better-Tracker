import { edgeKey } from './layout';
import type { GraphEdgeData, UpstreamChain } from './types';

// "What is this waiting on?": the transitive blockers of a node, for the
// hover/focus highlight and for a host's "Waits on" list. Pure and
// cycle-safe; the index is built once per edge list, and each walk visits
// every node and edge at most once.

/** Edges grouped by the node that waits on them (`to`). */
export type BlockerIndex = ReadonlyMap<string, readonly GraphEdgeData[]>;

export interface BlockerIndexOptions {
  /**
   * Walk through resolved edges too. Off by default: a closed blocker no
   * longer holds anything up, so it is not part of the chain.
   */
  includeResolved?: boolean;
}

/** Indexes `edges` by waiting node so a walk never rescans the list. */
export function blockerIndex(
  edges: readonly GraphEdgeData[],
  options: BlockerIndexOptions = {}
): BlockerIndex {
  const index = new Map<string, GraphEdgeData[]>();
  for (const edge of edges) {
    if (edge.kind === 'resolved' && options.includeResolved !== true) continue;
    const list = index.get(edge.to);
    if (list === undefined) index.set(edge.to, [edge]);
    else list.push(edge);
  }
  return index;
}

/** Edges grouped by blocker (`from`): what each node holds up. */
export function waiterIndex(
  edges: readonly GraphEdgeData[],
  options: BlockerIndexOptions = {}
): BlockerIndex {
  const index = new Map<string, GraphEdgeData[]>();
  for (const edge of edges) {
    if (edge.kind === 'resolved' && options.includeResolved !== true) continue;
    const list = index.get(edge.from);
    if (list === undefined) index.set(edge.from, [edge]);
    else list.push(edge);
  }
  return index;
}

/**
 * Breadth-first walk from `id` against the edge direction: its blockers,
 * their blockers, and so on. Returns them nearest first (never `id`
 * itself, even when a cycle leads back to it) with the keys of every edge
 * walked, so a renderer can light exactly that sub-graph.
 */
export function upstreamChain(id: string, index: BlockerIndex): UpstreamChain {
  const nodeIds: string[] = [];
  const edgeKeys = new Set<string>();
  const visited = new Set<string>([id]);
  const queue: string[] = [id];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    for (const edge of index.get(current) ?? []) {
      edgeKeys.add(edgeKey(edge.from, edge.to));
      if (visited.has(edge.from)) continue;
      visited.add(edge.from);
      nodeIds.push(edge.from);
      queue.push(edge.from);
    }
  }
  return { id, nodeIds, edgeKeys };
}
