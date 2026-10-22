import type { DependencyGraph, GraphScope } from '@better-tracker/core';
import type { Engine } from '@better-tracker/engine';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { buildGraphPage, parseGraphScope } from '../../../lib/adapters/graph';
import { parseIssueParam } from '../../../lib/adapters/issue';
import { engineInputCode } from '../../../lib/engine-errors';
import { currentHref, loadIssueDrawer } from '../../../lib/issue-load';
import {
  orSetup,
  requestViewer,
  requireInstalledActor,
} from '../../../lib/load';
import { PageCrumb } from '../components/page-crumb';
import GraphScreen from './graph-screen';
import css from './page.module.css';

export const metadata: Metadata = { title: 'Graph' };

/** The graph for a scope, or null when ?milestone= / ?project= names
    something the mirror does not have (a stale link → 404). */
async function loadGraph(
  engine: Engine,
  workspaceId: string,
  scope: GraphScope
): Promise<DependencyGraph | null> {
  try {
    return await engine.getGraph(workspaceId, scope, await requestViewer());
  } catch (error) {
    if (engineInputCode(error) === 'not_found') return null;
    throw error;
  }
}

/* /graph (architecture §8.4 "Graph", §2.10): which milestones wait on
   which, from Linear's blocking relations. ?milestone=<id> or
   ?project=<id> switches to the issue level inside that scope (plus the
   one-hop blockers outside it); ?issue=<key> opens an issue node's
   slide-over (§8.5). Everyone sees the graph; it is read-only. The
   engine builds the graph, lib/adapters/graph.ts maps it (and computes the
   Mermaid text) on the server, and the client island draws it and opens
   the selected node's details. */
export default async function GraphPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Request data first: the page is per-request, never prerendered.
  const params = await searchParams;
  const { engine, actor, workspaceId } = await requireInstalledActor(
    currentHref('/graph', params)
  );
  const scope = parseGraphScope(params);
  const [graph, loaded, issueDrawer] = await orSetup(
    Promise.all([
      loadGraph(engine, workspaceId, scope),
      engine.load(workspaceId, actor),
      loadIssueDrawer(
        engine,
        actor,
        parseIssueParam(params),
        currentHref('/graph', params)
      ),
    ])
  );
  if (graph === null) notFound();
  const model = buildGraphPage({
    graph,
    snapshot: loaded.snapshot,
    assessments: loaded.assessments,
    today: loaded.today,
  });

  return (
    <>
      <header className={css.head}>
        <h1 className={css.title}>{model.heading}</h1>
        <p className={css.receipts}>{model.receipts}</p>
      </header>
      <GraphScreen model={model} issueDrawer={issueDrawer} />
      {model.crumb !== null ? <PageCrumb label={model.crumb} /> : null}
    </>
  );
}
