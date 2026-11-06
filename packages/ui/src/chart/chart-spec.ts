import type { GraphClusterData } from '../graph/types';
import type { ChartSpec } from './chart-layout';
import { type ChartModel, pairKey } from './chart-model';

/** Fixed box footprints: the layout needs every box before anything
    renders, and each card fills its box so routed edges meet its edge. A
    card is 8px padding around a 16px meta row and two 17px title lines,
    plus an 18px frame line when boxes are not drawn inside their frames.
    The card's CSS (dependency-chart.module.css) follows these numbers. */
export const NODE_SIZE = { width: 232, height: 70, frameLine: 18 };

/**
 * The layout spec for the boxes the chart draws (drawnNodes, in model
 * order): every box at NODE_SIZE, the edges between drawn boxes, and,
 * when `framed`, each box inside its innermost frame with every frame
 * that holds a drawn box nested in its parent.
 */
export function chartSpec(
  model: ChartModel,
  drawn: readonly string[],
  clusters: readonly GraphClusterData[],
  framed: boolean
): ChartSpec {
  const drawnSet = new Set(drawn);
  const height = NODE_SIZE.height + (framed ? 0 : NODE_SIZE.frameLine);
  const used = new Set<string>();
  if (framed) {
    const byId = new Map(clusters.map((c) => [c.id, c]));
    for (const id of drawn) {
      let at = model.nodes.get(id)?.data.cluster;
      while (at !== undefined && !used.has(at)) {
        used.add(at);
        at = byId.get(at)?.parent;
      }
    }
  }
  return {
    nodes: drawn.map((id) => ({
      id,
      width: NODE_SIZE.width,
      height,
      group: framed ? (model.nodes.get(id)?.data.cluster ?? null) : null,
    })),
    edges: model.edges
      .filter(([a, b]) => drawnSet.has(a) && drawnSet.has(b))
      .map(([a, b]) => ({ id: pairKey(a, b), from: a, to: b })),
    groups: clusters
      .filter((c) => used.has(c.id))
      .map((c) => ({ id: c.id, label: c.label, parent: c.parent ?? null })),
  };
}
