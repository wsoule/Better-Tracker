import type { Engine } from '@better-tracker/engine';
import {
  DONE_MEANS_MAX_LENGTH,
  WEIGHT_MAX,
  WEIGHT_MIN,
} from '@better-tracker/engine';
import type { Metadata } from 'next';

import { parseIssueParam } from '../../../lib/adapters/issue';
import {
  buildMilestoneDrawer,
  buildTimelinePage,
  parseTimelineSelection,
  parseTimelineState,
  timelineReceipts,
} from '../../../lib/adapters/timeline';
import { engineInputCode } from '../../../lib/engine-errors';
import { currentHref, loadIssueDrawer } from '../../../lib/issue-load';
import {
  loadTimelineView,
  orSetup,
  requestViewer,
  requireInstalledActor,
} from '../../../lib/load';
import WorkspaceGuard from '../components/workspace-guard';
import css from './page.module.css';
import TimelineScreen from './timeline-screen';

export const metadata: Metadata = { title: 'Timeline' };

type MilestoneDetail = Awaited<ReturnType<Engine['getMilestoneDetail']>>;

/** The drawer's milestone, or null when the id is not in the mirror (a
    stale link): the page then says so instead of failing. */
async function loadDetail(
  engine: Engine,
  workspaceId: string,
  milestoneId: string
): Promise<MilestoneDetail | null> {
  try {
    return await engine.getMilestoneDetail(
      workspaceId,
      milestoneId,
      await requestViewer()
    );
  } catch (error) {
    if (engineInputCode(error) === 'not_found') return null;
    throw error;
  }
}

/* /timeline (architecture §8.4 "Timeline", §8.3 slide-over): every open
   project as a lane of milestone bars, grouped by initiative, with the
   missing-input banners above. ?milestone=<id> opens the drawer,
   ?project=<id> focuses a lane, ?issue=<key> shows one of its issues in
   the same panel (§8.5); filters, zoom and dependencies live in the URL
   too. Everyone signed in sees and edits it (owner decision 2026-10-22:
   no roles): weight and "done means…" for everyone, the drag handles and
   the drawer's date and lead with Linear write access (the person's own
   token; without it, an "Allow edits in Linear" notice). A Linear guest
   only looks (owner decision 2026-10-22, "Guests limited to read only"):
   no handles, no edit controls, one read-only notice. The PATCH routes
   and the engine enforce the same rules. All data comes from the engine;
   lib/adapters/timeline.ts maps it. */
export default async function TimelinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Request data first: the page is per-request, never prerendered.
  const params = await searchParams;
  const { engine, actor, workspaceId } = await requireInstalledActor(
    currentHref('/timeline', params)
  );
  const state = parseTimelineState(params);
  const selection = parseTimelineSelection(params);
  const permissions = {
    canWriteLinear: actor.canWriteLinear,
    readOnly: actor.readOnly,
  };

  const [view, graph, loaded, detail, issueDrawer] = await orSetup(
    Promise.all([
      loadTimelineView(engine, workspaceId),
      engine.getGraph(workspaceId, { level: 'milestone' }, actor),
      engine.load(workspaceId, actor),
      selection.milestoneId === null
        ? Promise.resolve(null)
        : loadDetail(engine, workspaceId, selection.milestoneId),
      loadIssueDrawer(
        engine,
        actor,
        parseIssueParam(params),
        currentHref('/timeline', params)
      ),
    ])
  );

  const issues = loaded.snapshot.issues;
  const page = buildTimelinePage({ view, graph, permissions, issues });
  const drawer =
    detail === null
      ? null
      : buildMilestoneDrawer({
          detail,
          today: view.today,
          permissions,
          users: loaded.snapshot.data.users,
          issues,
          view,
          limits: {
            doneMeansMax: DONE_MEANS_MAX_LENGTH,
            weightMin: WEIGHT_MIN,
            weightMax: WEIGHT_MAX,
          },
        });

  return (
    <>
      <WorkspaceGuard />
      <header className={css.head}>
        <h1 className={css.title}>Timeline</h1>
        <p className={css.receipts}>{timelineReceipts(view)}</p>
      </header>
      <TimelineScreen
        model={page}
        urlState={state}
        focusProjectId={selection.projectId}
        drawer={drawer}
        missingMilestoneId={
          selection.milestoneId !== null && detail === null
            ? selection.milestoneId
            : null
        }
        issueDrawer={issueDrawer}
      />
    </>
  );
}
