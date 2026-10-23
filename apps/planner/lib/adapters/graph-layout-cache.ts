import {
  type GraphEdgeData,
  type GraphLayout,
  type GraphLayoutOptions,
  type GraphNodeData,
  layoutGraph,
} from '@better-tracker/ui';

// The /graph page lays its drawing out on the server on every request
// (architecture §8.4 "Graph": Canvas), and dagre is the costliest step of
// it: about 55 ms for the showcase demo's 193-box issue level. The same
// drawing is asked for again and again: opening or closing an issue's
// slide-over re-renders the page for ?issue= with the boxes unchanged, and
// the demo's visitors share one in-memory workspace. layoutGraph is a pure
// function of its input (no DOM, no clock, no randomness), so the last few
// layouts are kept by that exact input: any change to a box (its text,
// tone, tags, cluster) or to an edge (kind, weight) is a different key and
// is laid out afresh, so a stale layout is never served.

/** Layouts kept, most recently used last; the oldest goes first. */
export const LAYOUT_CACHE_SIZE = 24;

const cache = new Map<string, GraphLayout>();

/**
 * layoutGraph(nodes, edges, options), reusing the layout of an identical
 * earlier call. The returned layout is shared between requests: callers
 * hand it to the page as is and never change it.
 */
export function cachedLayoutGraph(
  nodes: readonly GraphNodeData[],
  edges: readonly GraphEdgeData[],
  options: GraphLayoutOptions = {}
): GraphLayout {
  const key = JSON.stringify([nodes, edges, options]);
  const hit = cache.get(key);
  if (hit !== undefined) {
    // Refresh its place so the layouts in use are the last to go.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const layout = layoutGraph(nodes, edges, options);
  cache.set(key, layout);
  while (cache.size > LAYOUT_CACHE_SIZE) {
    const oldest = cache.keys().next();
    if (oldest.done === true) break;
    cache.delete(oldest.value);
  }
  return layout;
}

/** Empties the cache (tests). */
export function clearLayoutCache(): void {
  cache.clear();
}
