import type {
  GraphClusterData,
  GraphEdgeData,
  GraphNodeData,
} from '../graph/types';

// What the dependency chart draws and reads, derived from the graph
// family's plain data (GraphNodeData, GraphEdgeData, GraphClusterData):
// each box's state, the blocking edges between drawn boxes, upstream and
// downstream traces, the longest open chain (the critical path), and the
// sets the chart highlights (ready, in progress, at risk). Ported from
// Vadim Sevriuk's Dispatch chart (dependencyChart.ts), which read
// Dispatch's tasks; here every level (initiatives, projects, milestones,
// issues) reads the same way.

/** Where a box stands, as the chart draws it. */
export type ChartState =
  | 'done'
  | 'blocked'
  | 'progress'
  | 'ready'
  | 'open'
  | 'empty';

export interface ChartNode {
  id: string;
  data: GraphNodeData;
  state: ChartState;
  /** Warned about (a danger or warning risk tone: overdue, unassigned, on
      a risk chain, a cycle). */
  atRisk: boolean;
  /** The frames it sits in, outermost first ("Atlas", "Beta"). */
  frames: readonly string[];
}

export interface ChartModel {
  nodes: ReadonlyMap<string, ChartNode>;
  /** Node ids in the host's order: the layout's model order. */
  order: readonly string[];
  /** [blocker, waiting] for every edge whose two ends are drawn; no
      self-loops, de-duplicated, in the host's edge order. */
  edges: readonly (readonly [string, string])[];
  /** Edges that no longer block (one end done), keyed `${from}\0${to}`. */
  resolved: ReadonlySet<string>;
  /** Edges on a blocking cycle, keyed like `resolved`. */
  cycles: ReadonlySet<string>;
  /** Relations each edge stands for (a count pill when more than one). */
  weights: ReadonlyMap<string, number>;
  blockersOf: ReadonlyMap<string, readonly string[]>;
  dependentsOf: ReadonlyMap<string, readonly string[]>;
  /** Open blockers each box has outside the drawing (readiness counts
      more than the drawn edges show); only boxes with at least one. */
  hiddenBlockers: ReadonlyMap<string, number>;
  /** Boxes on at least one edge, either way. */
  linked: ReadonlySet<string>;
  /** Boxes on no edge that are still open, in order. */
  unlinkedOpen: readonly string[];
  /** The longest run of open boxes where each waits on the one before,
      over edges that still block, first blocker to last waiting box; []
      when no such edge joins two open boxes. */
  longestChain: readonly string[];
  readyNow: readonly string[];
  inProgress: readonly string[];
  atRisk: readonly string[];
}

/** The key edges share across the model and the layout. */
export function pairKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

/** The state a box is drawn in, from its readiness (else its status). A
    blocked box stays blocked while some of it is under way: what it waits
    on is the stronger claim. */
export function chartStateOf(node: GraphNodeData): ChartState {
  const readiness = node.readiness?.state;
  if (
    readiness === 'done' ||
    (readiness === undefined && node.status === 'done')
  ) {
    return 'done';
  }
  if (readiness === 'empty') return 'empty';
  if (readiness === 'blocked') return 'blocked';
  if (node.inProgress === true) return 'progress';
  if (readiness === 'ready') return 'ready';
  return 'open';
}

/** Whether a state is still work to do (not done, not an empty box). */
export function isOpenState(state: ChartState): boolean {
  return state !== 'done' && state !== 'empty';
}

/** Each frame's label path, outermost first, by cluster id. */
function framePaths(
  clusters: readonly GraphClusterData[]
): Map<string, string[]> {
  const byId = new Map(clusters.map((c) => [c.id, c]));
  const out = new Map<string, string[]>();
  for (const cluster of clusters) {
    const path: string[] = [];
    const seen = new Set<string>();
    for (
      let at: GraphClusterData | undefined = cluster;
      at !== undefined && !seen.has(at.id);
      at = at.parent === undefined ? undefined : byId.get(at.parent)
    ) {
      seen.add(at.id);
      path.unshift(at.label);
    }
    out.set(cluster.id, path);
  }
  return out;
}

/**
 * The longest run of open boxes where each waits on the one before,
 * following dependents from blocker to waiting box. An iterative
 * depth-first search settles, for every open box, the longest run
 * starting at it; a dependent still on the stack closes a cycle and is
 * skipped, so the walk is exact for acyclic work, terminates on a cycle,
 * and costs O(V+E). Searches start at open boxes with no open blocker
 * first, so a cycle keeps the lead-in that feeds it. Ties keep the earlier
 * dependent and the earliest start. Shorter than two boxes is no chain.
 */
function longestOpenChain(
  order: readonly string[],
  blockersOf: ReadonlyMap<string, readonly string[]>,
  dependentsOf: ReadonlyMap<string, readonly string[]>,
  isOpen: (id: string) => boolean
): string[] {
  const runFrom = new Map<string, number>();
  const next = new Map<string, string>();
  const onStack = new Set<string>();
  const sources = order.filter(
    (id) => isOpen(id) && !(blockersOf.get(id) ?? []).some(isOpen)
  );
  for (const root of [...sources, ...order]) {
    if (!isOpen(root) || runFrom.has(root)) continue;
    const stack = [{ id: root, child: 0 }];
    onStack.add(root);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const dependents = dependentsOf.get(frame.id) ?? [];
      if (frame.child < dependents.length) {
        const dependent = dependents[frame.child++];
        if (
          isOpen(dependent) &&
          !onStack.has(dependent) &&
          !runFrom.has(dependent)
        ) {
          onStack.add(dependent);
          stack.push({ id: dependent, child: 0 });
        }
        continue;
      }
      let best = 1;
      for (const dependent of dependents) {
        const run = runFrom.get(dependent);
        if (run === undefined || run + 1 <= best) continue;
        best = run + 1;
        next.set(frame.id, dependent);
      }
      runFrom.set(frame.id, best);
      onStack.delete(frame.id);
      stack.pop();
    }
  }

  let start: string | undefined;
  let longest = 1;
  for (const id of order) {
    const run = runFrom.get(id) ?? 0;
    if (run > longest) {
      longest = run;
      start = id;
    }
  }
  const chain: string[] = [];
  for (let at = start; at !== undefined; at = next.get(at)) chain.push(at);
  return chain;
}

/**
 * Builds the chart model: one entry per node (first of a repeated id
 * wins), the edges between drawn nodes, the traces' adjacency, and the
 * summaries the toolbar and the inspector read.
 */
export function chartModel(
  nodes: readonly GraphNodeData[],
  edges: readonly GraphEdgeData[],
  clusters: readonly GraphClusterData[] = []
): ChartModel {
  const paths = framePaths(clusters);
  const byId = new Map<string, ChartNode>();
  const order: string[] = [];
  for (const data of nodes) {
    if (byId.has(data.id)) continue;
    byId.set(data.id, {
      id: data.id,
      data,
      state: chartStateOf(data),
      atRisk: data.tone === 'danger' || data.tone === 'warning',
      frames: data.cluster === undefined ? [] : (paths.get(data.cluster) ?? []),
    });
    order.push(data.id);
  }

  const pairs: [string, string][] = [];
  const resolved = new Set<string>();
  const cycles = new Set<string>();
  const weights = new Map<string, number>();
  const blockersOf = new Map<string, string[]>();
  const dependentsOf = new Map<string, string[]>();
  for (const id of order) {
    blockersOf.set(id, []);
    dependentsOf.set(id, []);
  }
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    const key = pairKey(edge.from, edge.to);
    if (weights.has(key)) continue;
    weights.set(key, edge.weight ?? 1);
    if (edge.kind === 'resolved') resolved.add(key);
    if (edge.kind === 'cycle') cycles.add(key);
    pairs.push([edge.from, edge.to]);
    blockersOf.get(edge.to)?.push(edge.from);
    dependentsOf.get(edge.from)?.push(edge.to);
  }

  const isOpen = (id: string) => {
    const node = byId.get(id);
    return node !== undefined && isOpenState(node.state);
  };
  // The critical path walks only the edges that still block.
  const blockingOut = new Map<string, string[]>();
  const blockingIn = new Map<string, string[]>();
  for (const id of order) {
    blockingOut.set(id, []);
    blockingIn.set(id, []);
  }
  for (const [from, to] of pairs) {
    if (resolved.has(pairKey(from, to))) continue;
    blockingOut.get(from)?.push(to);
    blockingIn.get(to)?.push(from);
  }

  const hiddenBlockers = new Map<string, number>();
  for (const id of order) {
    const node = byId.get(id);
    const counted = node?.data.readiness?.blockedBy ?? 0;
    const drawn = (blockingIn.get(id) ?? []).filter(isOpen).length;
    if (counted > drawn) hiddenBlockers.set(id, counted - drawn);
  }

  const linked = new Set(
    order.filter(
      (id) =>
        (blockersOf.get(id) ?? []).length > 0 ||
        (dependentsOf.get(id) ?? []).length > 0
    )
  );
  const where = (test: (node: ChartNode) => boolean) =>
    order.filter((id) => {
      const node = byId.get(id);
      return node !== undefined && test(node);
    });

  return {
    nodes: byId,
    order,
    edges: pairs,
    resolved,
    cycles,
    weights,
    blockersOf,
    dependentsOf,
    hiddenBlockers,
    linked,
    unlinkedOpen: order.filter((id) => !linked.has(id) && isOpen(id)),
    longestChain: longestOpenChain(order, blockingIn, blockingOut, isOpen),
    readyNow: where((n) => n.state === 'ready'),
    inProgress: where((n) => n.state === 'progress'),
    atRisk: where((n) => n.atRisk && isOpenState(n.state)),
  };
}

/**
 * Everything transitively upstream ('up', what it waits on) or downstream
 * ('down', what it holds up) of `id`, nearest first; `id` itself only when
 * a cycle leads back to it. Breadth-first with a visited set, so it stops
 * on cycles.
 */
export function traceChart(
  model: ChartModel,
  id: string,
  dir: 'up' | 'down'
): Set<string> {
  const step = dir === 'up' ? model.blockersOf : model.dependentsOf;
  const reached = new Set<string>();
  const queue = [...(step.get(id) ?? [])];
  for (let head = 0; head < queue.length; head++) {
    const at = queue[head];
    if (reached.has(at)) continue;
    reached.add(at);
    for (const near of step.get(at) ?? []) {
      if (!reached.has(near)) queue.push(near);
    }
  }
  return reached;
}

/**
 * The node ids the chart draws, in order: linked boxes, plus the
 * unlinked ones when `showUnlinked` (every box when nothing is linked at
 * all, so a scope with no relations still shows its boxes), minus done
 * and empty boxes when `hideDone`. `keep` is always drawn (the chain's
 * focus).
 */
export function drawnNodes(
  model: ChartModel,
  opts: { hideDone: boolean; showUnlinked: boolean; keep?: string | null }
): string[] {
  const everything = model.linked.size === 0;
  return model.order.filter((id) => {
    if (id === opts.keep) return true;
    const state = model.nodes.get(id)?.state;
    if (opts.hideDone && state !== undefined && !isOpenState(state)) {
      return false;
    }
    return everything || opts.showUnlinked || model.linked.has(id);
  });
}
