import {
  BlockBar,
  DeadlineList,
  EmptyState,
  Register,
  RegisterCell,
  RegisterRow,
  StatsStrip,
} from '@better-tracker/ui';
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
import { PageCrumb } from '../components/page-crumb';
import css from './page.module.css';
import WeekIssues from './week-issues';
import WeekUserPicker from './week-user-picker';

export const metadata: Metadata = { title: 'My week' };

/* /week (architecture §8.4 "My week"): the signed-in person's open issues
   grouped by milestone, with deadlines and the projects they lead that need
   attention. PMs may pass ?user=<id> to see someone else's week; the id is
   checked here, never trusted from the client, and ignored for everyone
   else. ?issue=<key> opens that issue in the slide-over (§8.5). All data
   comes from the engine; lib/adapters/week.ts and issue.ts map it. */
export default async function WeekPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Request data first: the page is per-request, never prerendered.
  const params = await searchParams;
  const { engine, actor, workspaceId } = await requireInstalledActor();
  const viewerId = actor.session.userId;
  const loaded = await orSetup(engine.load(workspaceId));
  const users = loaded.snapshot.data.users;
  const knownUserIds = new Set(
    users.filter((user) => !user.app).map((user) => user.id)
  );
  const userId = resolveWeekUserId({
    requested: params.user,
    viewerId,
    isPm: actor.isPm,
    knownUserIds,
  });

  // ?issue= opens the issue slide-over; every row links there, keeping
  // the rest of the URL (a PM's ?user=).
  const issueKey = parseIssueParam(params);
  const base = withIssueParam(currentHref('/week', params), null);
  const [week, timeline, drawer] = await orSetup(
    Promise.all([
      loadWeekView(engine, workspaceId, userId),
      loadTimelineView(engine, workspaceId),
      loadIssueDrawer(engine, actor, issueKey, currentHref('/week', params)),
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
      <header className={css.head}>
        <div className={css.headText}>
          <h1 className={css.title}>{page.heading}</h1>
          <p className={css.receipts}>{page.receipts}</p>
        </div>
        {actor.isPm ? (
          <WeekUserPicker
            key={userId}
            options={weekPeopleOptions(users, viewerId)}
            value={userId}
            viewerId={viewerId}
          />
        ) : null}
      </header>

      <div className={css.body}>
        <StatsStrip
          cells={page.stats}
          label={page.isSelf ? 'Your week at a glance' : 'Week at a glance'}
        />
        <div className={css.columns}>
          <div className={css.grid}>
            <div className={css.main}>
              <WeekIssues
                sections={page.sections}
                columns={WEEK_TASK_COLUMNS}
                label={page.isSelf ? 'My issues' : `${week.userName}'s issues`}
                emptyMessage={page.emptyMessage}
                drawer={drawer}
              />
            </div>
            <aside className={css.side} aria-label="Deadlines and attention">
              <section className={css.collapse} aria-label="Upcoming deadlines">
                <BlockBar
                  index="01"
                  title="Upcoming deadlines"
                  meta="Next 7 days"
                />
                <DeadlineList groups={page.deadlines} />
              </section>
              <section className={css.collapse} aria-label="Needs attention">
                <BlockBar
                  index="02"
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
                        tone="accent"
                      >
                        <RegisterCell variant="name" sub={item.detail}>
                          {item.projectName}
                        </RegisterCell>
                        <RegisterCell variant="mono" tone="accent" align="end">
                          {item.flag}
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
