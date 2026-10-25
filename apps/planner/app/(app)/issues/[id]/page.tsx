import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { issuePagePath } from '../../../../lib/adapters/issue';
import { loadIssueModel } from '../../../../lib/issue-load';
import { orSetup, requireInstalledActor } from '../../../../lib/load';
import { PageCrumb } from '../../components/page-crumb';
import WorkspaceGuard from '../../components/workspace-guard';
import IssuePageView from './issue-page-view';

type Params = Promise<{ id: string }>;

/** The tab names the issue by its key; the title needs the engine. */
export async function generateMetadata({
  params,
}: {
  params: Params;
}): Promise<Metadata> {
  const { id } = await params;
  return { title: id.trim().toUpperCase() };
}

/* /issues/[id] (architecture §8.5; owner decision 2026-10-21): one issue
   in the task view's page layout, by identifier ("ENG-24") or id. Every
   signed-in person sees it; the edit controls appear when their own
   Linear token may write, and the routes and the engine enforce that
   again. An issue the planner does not hold is the app's 404. Linked from
   "Copy link", the drawers' "Page" button and the command palette. */
export default async function IssuePage({ params }: { params: Params }) {
  const { id } = await params;
  const { engine, actor } = await requireInstalledActor(
    `/issues/${encodeURIComponent(id)}`
  );
  const key = id.trim();
  if (key === '' || key.length > 200) notFound();
  const model = await orSetup(
    loadIssueModel(engine, actor, key, issuePagePath(key))
  );
  if (model === null) notFound();
  return (
    <>
      <PageCrumb label={model.key} />
      <WorkspaceGuard />
      <IssuePageView model={model} />
    </>
  );
}
