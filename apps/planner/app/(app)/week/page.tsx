import {
  BlockBar,
  Button,
  Chip,
  DeadlineList,
  EmptyState,
  Register,
  RegisterCell,
  RegisterRow,
  StatsStrip,
} from '@better-tracker/ui';
import {
  CalendarX,
  CircleDot,
  type LucideIcon,
  Sparkles,
  TriangleAlert,
} from 'lucide-react';
import type { Metadata } from 'next';

import { parseIssueParam, withIssueParam } from '../../../lib/adapters/issue';
import {
  buildWeekPage,
  localHour,
  noMilestoneIssueProjects,
  resolveWeekUserId,
  WEEK_TASK_COLUMNS,
  weekPeopleOptions,
} from '../../../lib/adapters/week';
import { currentHref, loadIssueDrawer } from '../../../lib/issue-load';
import {
  loadTimelineView,
  loadWeekView,
  orSetup,
  requireInstalledActor,
} from '../../../lib/load';
import { withoutNoticeParams } from '../../../lib/workspace-copy';
import { PageCrumb } from '../components/page-crumb';
import WorkspaceGuard from '../components/workspace-guard';
import WorkspaceNotices from '../components/workspace-notices';
import css from './page.module.css';
import WeekIssues from './week-issues';
import WeekUserPicker from './week-user-picker';

export const metadata: Metadata = { title: 'My week' };

/** Gr8r's stat-card key icons, by the adapter's stat id (drawing only;
    the cell's label says it). */
const STAT_ICONS: Record<string, LucideIcon> = {
  open: CircleDot,
  overdue: CalendarX,
  new: Sparkles,
  risk: TriangleAlert,
};

/* /week (architecture §8.4 "My week"): the signed-in person's open issues
   grouped by milestone, with deadlines and the projects they lead that need
   attention. Anyone signed in may pass ?user=<id> to see a person's week
   (no roles since the owner decision of 2026-10-22); the id is checked
   against the mirror here, never trusted from the client. ?issue=<key>
   opens that issue in the slide-over (§8.5). All data comes from the
   engine; lib/adapters/week.ts and issue.ts map it. */
export default async function WeekPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Request data first: the page is per-request, never prerendered.
  const params = await searchParams;
  const { engine, actor, workspaceId, installation } =
    await requireInstalledActor(currentHref('/week', params));
  const viewerId = actor.session.userId;
  const loaded = await orSetup(engine.load(workspaceId, actor));
  const users = loaded.snapshot.data.users;
  const knownUserIds = new Set(
    users.filter((user) => !user.app).map((user) => user.id)
  );
  const userId = resolveWeekUserId({
    requested: params.user,
    viewerId,
    knownUserIds,
  });

  // ?issue= opens the issue slide-over; every row links there, keeping
  // the rest of the URL (a ?user= for someone else's week).
  const issueKey = parseIssueParam(params);
  const linkParams = withoutNoticeParams(params);
  const base = withIssueParam(currentHref('/week', linkParams), null);
  const [week, timeline, drawer] = await orSetup(
    Promise.all([
      loadWeekView(engine, workspaceId, userId),
      loadTimelineView(engine, workspaceId),
      loadIssueDrawer(
        engine,
        actor,
        issueKey,
        currentHref('/week', linkParams)
      ),
    ])
  );
  const page = buildWeekPage({
    issueHref: (key) => withIssueParam(base, key),
    week,
    timeline,
    viewerId,
    hour: localHour(engine.now(), loaded.settings.timezone),
    newBadgeDays: loaded.settings.tuning.newBadgeDays,
    issueProjects: noMilestoneIssueProjects(
      week,
      loaded.snapshot.issues,
      loaded.snapshot.projects
    ),
  });

  return (
    <>
      {page.isSelf ? null : <PageCrumb label={week.userName} />}
      <WorkspaceGuard />
      <header className={css.head}>
        <div className={css.headText}>
          <h1 className={css.title}>{page.heading}</h1>
          <p className={css.receipts}>{page.receipts}</p>
        </div>
        {/* Page-header controls at Gr8r's header size (30px): the person
            picker is a form-size select, so the link beside it matches. */}
        <div className={css.headActions}>
          <Button variant="quiet" href={page.allIssuesHref}>
            {page.allIssuesLabel}
          </Button>
          <WeekUserPicker
            key={userId}
            options={weekPeopleOptions(users, viewerId)}
            value={userId}
            viewerId={viewerId}
          />
        </div>
      </header>
      <WorkspaceNotices
        params={params}
        workspaceName={installation.workspaceName}
      />

      <div className={css.body}>
        <StatsStrip
          cells={page.stats.map((cell) => {
            const Icon = STAT_ICONS[cell.id];
            return Icon === undefined
              ? cell
              : { ...cell, icon: <Icon size={14} strokeWidth={1.8} /> };
          })}
          label={page.isSelf ? 'Your week at a glance' : 'Week at a glance'}
        />
        <div className={css.columns}>
          <div className={css.grid}>
            {/* Each panel sits under its own title (Gr8r's Home), so the
                three panels share one top line. */}
            <section className={css.main} aria-label={page.issuesTitle}>
              <BlockBar title={page.issuesTitle} meta={page.issuesMeta} />
              <WeekIssues
                sections={page.sections}
                columns={WEEK_TASK_COLUMNS}
                label={page.isSelf ? 'My issues' : `${week.userName}'s issues`}
                emptyMessage={page.emptyMessage}
                drawer={drawer}
              />
            </section>
            <aside className={css.side} aria-label="Deadlines and attention">
              <section
                className={css.sideSection}
                aria-label="Upcoming deadlines"
              >
                <BlockBar title="Upcoming deadlines" meta="Next 7 days" />
                <DeadlineList groups={page.deadlines} />
              </section>
              <section className={css.sideSection} aria-label="Needs attention">
                <BlockBar
                  title="Needs attention"
                  meta={
                    page.isSelf ? 'Projects you lead' : 'Projects they lead'
                  }
                />
                {page.attention.length === 0 ? (
                  <EmptyState>{page.attentionEmpty}</EmptyState>
                ) : (
                  <Register
                    columns="minmax(0, 1fr) auto"
                    label="Projects that need attention"
                    stackBelow={700}
                    stackedColumns="minmax(0, 1fr)"
                  >
                    {page.attention.map((item) => (
                      <RegisterRow
                        key={item.id}
                        href={item.href}
                        rowLabel={item.rowLabel}
                        tone={item.tone}
                      >
                        <RegisterCell variant="name" sub={item.detail}>
                          {item.projectName}
                        </RegisterCell>
                        <RegisterCell align="end">
                          <Chip tone={item.tone} filled>
                            {item.flag}
                          </Chip>
                        </RegisterCell>
                      </RegisterRow>
                    ))}
                  </Register>
                )}
              </section>
            </aside>
          </div>
        </div>
      </div>
    </>
  );
}
