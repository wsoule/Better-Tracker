import { WEIGHT_MAX, WEIGHT_MIN } from '@better-tracker/engine';
import type { Metadata } from 'next';

import { parseIssueParam } from '../../../../lib/adapters/issue';
import {
  buildIssueListPage,
  filterValueNames,
  issueListHref,
  parseIssueListParams,
} from '../../../../lib/adapters/issue-list';
import { currentHref, loadIssueDrawer } from '../../../../lib/issue-load';
import {
  loadIssueList,
  orSetup,
  requireInstalledActor,
} from '../../../../lib/load';
import WorkspaceGuard from '../../components/workspace-guard';
import IssuesScreen from './issues-screen';
import css from './page.module.css';

export const metadata: Metadata = { title: 'Issues' };

/* /issues (architecture §8.4 "Issues"; owner request 2026-10-22, "every
   issue in one list"): every issue the person can see, filtered, ordered
   by the weight rule or a field, grouped, with the preset tabs and the
   issue slide-over (?issue=<key>, §8.5). The URL is the whole view
   (lib/adapters/issue-list.ts has its grammar); core's buildIssueList
   filters, orders and groups on the server, narrowed to the viewer
   (§2.13), and the client island only follows it. Open to everyone
   signed in, a Linear guest included (read-only); anyone with a Linear
   write grant moves issues from it (cells, menus, the bulk bar, drag,
   keys; PATCH /api/issues). It lives in the (list) route group so its
   loading.tsx never wraps /issues/[id]. */
export default async function IssuesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Request data first: the page is per-request, never prerendered.
  const params = await searchParams;
  const { engine, actor, workspaceId } = await requireInstalledActor(
    currentHref('/issues', params)
  );
  const urlQuery = parseIssueListParams(params);
  const issueKey = parseIssueParam(params);
  const [{ view, mirrorVersion }, loaded, drawer] = await orSetup(
    Promise.all([
      loadIssueList(engine, workspaceId, issueListHref(urlQuery)),
      engine.load(workspaceId, actor),
      loadIssueDrawer(
        engine,
        actor,
        issueKey,
        issueListHref(urlQuery, { issue: issueKey })
      ),
    ])
  );
  const viewerId = actor.session.userId;
  // Moving issues needs the person's Linear write grant and is never for
  // a guest; the milestone weight is the planner's own (anyone but a
  // guest).
  const canMove = actor.canWriteLinear && !actor.readOnly;
  const { blockersOf, blocking } = loaded.snapshot;
  const page = buildIssueListPage({
    view,
    workspaceId,
    query: urlQuery,
    viewerId,
    readOnly: actor.readOnly,
    readOnlyReason: actor.readOnlyReason,
    canWriteLinear: actor.canWriteLinear,
    canMove,
    related: (issueId) =>
      (blockersOf.get(issueId)?.length ?? 0) > 0 ||
      (blocking.get(issueId)?.length ?? 0) > 0,
  });

  return (
    <>
      <WorkspaceGuard />
      <header className={css.head}>
        <h1 className={css.title}>{page.heading}</h1>
        <p className={css.subtitle}>{page.subtitle}</p>
        <p className={css.receipts}>{page.receipts}</p>
      </header>
      <IssuesScreen
        page={page}
        urlQuery={urlQuery}
        counts={view.counts}
        filterNames={filterValueNames(view)}
        today={view.today}
        viewerId={viewerId}
        mirrorVersion={mirrorVersion}
        workspaceId={workspaceId}
        facts={{
          hasInitiatives: loaded.snapshot.initiatives.size > 0,
          teamCount: loaded.snapshot.teams.size,
        }}
        drawer={drawer}
        permissions={{
          canMove,
          canEditWeight: !actor.readOnly,
          canWriteLinear: actor.canWriteLinear,
          readOnly: actor.readOnly,
        }}
        weightBounds={{ min: WEIGHT_MIN, max: WEIGHT_MAX }}
      />
    </>
  );
}
