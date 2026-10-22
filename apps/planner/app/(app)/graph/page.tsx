import type { DependencyGraph, GraphScope } from '@better-tracker/core';
import type { Engine } from '@better-tracker/engine';
import { TaskCrumbs } from '@better-tracker/ui';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { buildGraphPage, parseGraphParams } from '../../../lib/adapters/graph';
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

/** The graph for a scope, or null when the URL names a container the
    viewer's mirror does not have (a stale or hidden link → 404). */
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

/* /graph (architecture §8.4 "Graph", §2.10): which boxes wait on which,
   from Linear's blocking relations, at four levels (initiatives,
   projects, milestones, issues) inside the workspace, an initiative
   (?initiative=<id|none>), a project (?project=), a milestone
   (?milestone=), or one issue's blocking chain (?chain=<key>); ?level=
   picks another level the container offers, ?node=<id> selects a box on
   arrival, and ?issue=<key> opens an issue node's slide-over (§8.5). With
   no parameters it is the workspace's milestones. Everyone sees the
   graph; it is read-only. The engine builds the graph from the viewer's
   mirror (a viewer with no initiatives gets the workspace, with a notice),
   lib/adapters/graph.ts maps it, lays it out and computes the Mermaid text
   on the server, and the client island draws it and opens the selected
   node's details. */
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
  const { scope, nodeId } = parseGraphParams(params);
  const issueKey = parseIssueParam(params);
  const [graph, loaded, issueDrawer] = await orSetup(
    Promise.all([
      loadGraph(engine, workspaceId, scope),
      engine.load(workspaceId, actor),
      loadIssueDrawer(engine, actor, issueKey, currentHref('/graph', params)),
    ])
  );
  if (graph === null) notFound();
  const model = buildGraphPage({
    graph,
    snapshot: loaded.snapshot,
    assessments: loaded.assessments,
    allocationPlan: loaded.allocationPlan,
    today: loaded.today,
    nodeId,
    issueKey,
    readOnlyReason: actor.readOnlyReason,
  });

  return (
    <>
      <header className={css.head}>
        {model.trail.length > 0 ? (
          <div className={css.trail}>
            <TaskCrumbs
              label="Graph scope"
              breadcrumb={model.trail}
              taskKey=""
            />
          </div>
        ) : null}
        <h1 className={css.title}>{model.heading}</h1>
        <p className={css.receipts}>{model.receipts}</p>
        {model.notices.map((notice) => (
          <p key={notice.id} className={css.notice} data-notice={notice.id}>
            {notice.text}
          </p>
        ))}
      </header>
      <GraphScreen
        key={model.pageKey}
        model={model}
        issueDrawer={issueDrawer}
      />
      {model.crumb !== null ? <PageCrumb label={model.crumb} /> : null}
    </>
  );
}
