import type { GraphScope } from '@better-tracker/core';
import {
  type Actor,
  createEngineFromEnv,
  type Engine,
} from '@better-tracker/engine';
import { createLogger } from '@better-tracker/logger';
import {
  chartModel,
  chartSpec,
  drawnNodes,
  layoutChart,
} from '@better-tracker/ui';
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { buildGraphPage } from '../lib/adapters/graph';

// The /graph chart's layout over the showcase workspace (LINEAR_FIXTURE=
// showcase): the same elkjs call the browser makes (ui chartSpec and
// layoutChart over the page model), at every workspace level, unframed
// (the chart's default) and boxed by parent. A DOM is registered first:
// elkjs's bundled engine runs in-thread only where there is a `document`
// (without one, and with Bun's `self`, it takes itself for a Web Worker).

const WORKSPACE = 'org-northwind';

let engine: Engine;
let member: Actor;

beforeAll(async () => {
  GlobalRegistrator.register();
  engine = await createEngineFromEnv(
    { LINEAR_FIXTURE: 'showcase', APP_URL: 'http://localhost:3000' },
    { logger: createLogger({ name: 'test', level: 'error' }) }
  );
  const chloe = await engine.devSignIn('user-chloe');
  member = (await engine.authenticate(chloe.sessionToken)) as Actor;
});

afterAll(async () => {
  await engine.close();
  await GlobalRegistrator.unregister();
});

/** The page model /graph builds for a scope. */
async function graphPage(scope: GraphScope) {
  const [graph, loaded] = await Promise.all([
    engine.getGraph(WORKSPACE, scope, member),
    engine.load(WORKSPACE, member),
  ]);
  return buildGraphPage({
    graph,
    snapshot: loaded.snapshot,
    assessments: loaded.assessments,
    allocationPlan: loaded.allocationPlan,
    today: loaded.today,
  });
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Whether the segment a–b passes through the inside of `box`, sampled
    every 2px. */
function crosses(
  a: { x: number; y: number },
  b: { x: number; y: number },
  box: Rect
): boolean {
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2));
  for (let k = 0; k <= steps; k += 1) {
    const x = a.x + ((b.x - a.x) * k) / steps;
    const y = a.y + ((b.y - a.y) * k) / steps;
    if (
      x > box.x &&
      x < box.x + box.width &&
      y > box.y &&
      y < box.y + box.height
    ) {
      return true;
    }
  }
  return false;
}

/** Lays a scope's chart out and counts the arrows that run through a box
    they do not join (each box shrunk by 2px, so a line along an edge is
    not a hit), checking every drawn box and arrow got placed. */
async function arrowsBehindBoxes(
  scope: GraphScope,
  opts: { framed: boolean; showUnlinked: boolean }
): Promise<number> {
  const model = await graphPage(scope);
  const chart = chartModel(model.nodes, model.edges, model.clusters);
  const drawn = drawnNodes(chart, {
    hideDone: false,
    showUnlinked: opts.showUnlinked,
  });
  const spec = chartSpec(chart, drawn, model.clusters, opts.framed);
  const layout = await layoutChart(spec);
  expect(layout.nodes.size).toBe(drawn.length);
  expect(layout.edges.length).toBe(spec.edges.length);
  if (opts.framed) expect(layout.groups.length).toBeGreaterThan(0);
  const boxes = [...layout.nodes.values()];
  let count = 0;
  for (const edge of layout.edges) {
    const hit = boxes.some(
      (n) =>
        n.id !== edge.from &&
        n.id !== edge.to &&
        edge.points.some((p, i) => {
          const prev = edge.points[i - 1];
          return (
            prev !== undefined &&
            crosses(prev, p, {
              x: n.x + 2,
              y: n.y + 2,
              width: n.width - 4,
              height: n.height - 4,
            })
          );
        })
    );
    if (hit) count += 1;
  }
  return count;
}

describe('the /graph chart over the showcase', () => {
  // Orthogonal routing (elkjs layered, ORTHOGONAL) never runs an arrow
  // behind a box it does not join: the dagre graph it replaced let up to
  // 8 of the issue level's 247 through (2026-10-23 showcase review).
  for (const level of ['project', 'milestone', 'issue'] as const) {
    test(`${level} level: no arrow runs behind a box, unframed or framed`, async () => {
      expect(
        await arrowsBehindBoxes(
          { level },
          { framed: false, showUnlinked: level !== 'issue' }
        )
      ).toBe(0);
      expect(
        await arrowsBehindBoxes({ level }, { framed: true, showUnlinked: true })
      ).toBe(0);
    }, 30_000);
  }
});
