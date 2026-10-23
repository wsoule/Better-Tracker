import {
  assessWorkspace,
  buildIssueList,
  buildMilestoneDetail,
  buildTimelineView,
  DEFAULT_TUNING,
  defaultSettings,
  type EvalContext,
  indexWorkspace,
  type MilestoneMeta,
  planAllocation,
} from '@better-tracker/core';
import {
  createFixtureWorkspace,
  FIXTURE_MILESTONE_META,
} from '@better-tracker/linear';
import {
  ToastProvider,
  UiLinkProvider,
  type UiLinkProps,
} from '@better-tracker/ui';
import { describe, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  buildIssueListPage,
  filterValueNames,
  parseIssueListParams,
} from '../lib/adapters/issue-list';
import {
  modesReadOnlyRows,
  scheduleReadOnlyRows,
  watcherRows,
  watchersHint,
} from '../lib/adapters/settings';
import {
  buildMilestoneDrawer,
  buildTimelinePage,
  type TimelinePermissions,
} from '../lib/adapters/timeline';
import {
  FIRST_SYNC_PENDING_HEADLINE,
  READ_ONLY_NOTICE,
  readOnlyNotice,
} from '../lib/read-only';
import { modelFor } from './issue-fixture';

// Owner decision 2026-10-22, "Guests limited to read only": the planner's
// client islands and read-only sections rendered to HTML for a Linear
// guest (no browser), over the demo workspace's real view models. A guest
// gets no inputs, Save buttons, drag handles or grant links, and the one
// read-only notice where the edits would be; a member keeps every control.
// next/navigation's hooks need a mounted app router, so they are replaced
// here (the rest of the module stays real).

const realNavigation = await import('next/navigation');
void mock.module('next/navigation', () => ({
  ...realNavigation,
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => '/timeline',
  useSearchParams: () => new URLSearchParams('milestone=ms-compass-1'),
}));

const { default: MilestoneDrawer } =
  await import('../app/(app)/timeline/milestone-drawer');
const { default: TimelineScreen } =
  await import('../app/(app)/timeline/timeline-screen');
const { ReadOnlySettings, ReadOnlyWatchers } =
  await import('../app/(app)/settings/read-only-sections');
const { default: ReadOnlyNotice, ReadOnlyReasonProvider } =
  await import('../app/(app)/components/read-only-notice');
const { default: AppError } = await import('../app/(app)/error');
const { default: IssuePageView } =
  await import('../app/(app)/issues/[id]/issue-page-view');
const { default: IssuesScreen } =
  await import('../app/(app)/issues/(list)/issues-screen');

const TODAY = '2026-10-21';
const GUEST: TimelinePermissions = { canWriteLinear: false, readOnly: true };
const MEMBER: TimelinePermissions = { canWriteLinear: true, readOnly: false };

const snapshot = indexWorkspace(createFixtureWorkspace(TODAY));
const ctx: EvalContext = {
  today: TODAY,
  now: '2026-10-21T12:00:00.000Z',
  tuning: DEFAULT_TUNING,
  meta: new Map<string, MilestoneMeta>(
    FIXTURE_MILESTONE_META.map((m) => [
      m.milestoneId,
      { ...m, updatedAt: '2026-10-01T00:00:00.000Z', updatedBy: null },
    ])
  ),
};
const assessments = assessWorkspace(snapshot, ctx);
const allocationPlan = planAllocation(snapshot, ctx, assessments);
const view = buildTimelineView({ snapshot, ctx, assessments, allocationPlan });
const graph = {
  scope: { level: 'milestone' as const },
  nodes: [],
  edges: [],
  cycles: [],
  fallback: null,
  unplacedRelations: 0,
  unrelatedIssues: 0,
  chain: null,
};

function PlainLink({ children, ...rest }: UiLinkProps) {
  return <a {...rest}>{children}</a>;
}

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    <UiLinkProvider link={PlainLink}>
      <ToastProvider>{node}</ToastProvider>
    </UiLinkProvider>
  );
}

function drawerHtml(milestoneId: string, permissions: TimelinePermissions) {
  const detail = buildMilestoneDetail({
    snapshot,
    ctx,
    assessments,
    milestoneId,
  });
  if (detail === null) throw new Error(`no fixture milestone ${milestoneId}`);
  const model = buildMilestoneDrawer({
    detail,
    today: TODAY,
    permissions,
    users: snapshot.data.users,
    issues: snapshot.issues,
    view,
    limits: { doneMeansMax: 280, weightMin: -1000, weightMax: 1000 },
  });
  return render(
    <MilestoneDrawer
      open
      milestoneId={milestoneId}
      loading={false}
      model={model}
      fallbackTitle=""
      fallbackCrumb=""
      hrefFor={(id) => `/timeline?milestone=${id}`}
      onClose={() => {}}
    />
  );
}

describe('the milestone drawer', () => {
  test('a guest: plain values, the read-only notice, no controls', () => {
    // The overdue Atlas milestone has an alert strip whose Reschedule
    // action needs the date field.
    for (const id of ['ms-compass-1', 'ms-atlas-2']) {
      const html = drawerHtml(id, GUEST);
      expect(html).toContain(READ_ONLY_NOTICE);
      expect(html).not.toContain('<input');
      expect(html).not.toContain('<textarea');
      expect(html).not.toContain('<select');
      expect(html).not.toContain('>Save<');
      expect(html).not.toContain('Reschedule');
      expect(html).not.toContain('Allow edits in Linear');
      expect(html).not.toContain('intent=grant_write');
    }
  });

  // The graph only reads, so a guest keeps its links (graphs at every
  // level, owner decision 2026-10-22).
  test('a guest keeps the graph links', () => {
    const html = drawerHtml('ms-beacon-1', GUEST);
    expect(html).toContain('href="/graph?node=ms-beacon-1"');
    expect(html).toContain('What it waits on');
    expect(html).toContain('href="/graph?milestone=ms-beacon-1"');
    expect(html).toContain('Its issues');
  });

  test('a member keeps the weight and "done means…" fields', () => {
    const html = drawerHtml('ms-compass-1', MEMBER);
    expect(html).toContain('<textarea');
    expect(html).toContain('Weight override');
    expect(html).not.toContain(READ_ONLY_NOTICE);
  });
});

describe('the timeline', () => {
  function screenHtml(permissions: TimelinePermissions): string {
    return render(
      <TimelineScreen
        model={buildTimelinePage({
          view,
          graph,
          permissions,
          issues: snapshot.issues,
        })}
        urlState={{
          query: '',
          initiative: 'all',
          activeOnly: false,
          riskOnly: false,
          zoom: 'weeks',
          showDependencies: false,
        }}
        focusProjectId={null}
        drawer={null}
        missingMilestoneId={null}
        issueDrawer={{ param: null, model: null }}
      />
    );
  }

  test('a guest gets no drag handles, no grant notice, one read-only notice', () => {
    const html = screenHtml(GUEST);
    expect(html).toContain(READ_ONLY_NOTICE);
    expect(html).not.toContain('role="slider"');
    expect(html).not.toContain('Allow edits in Linear');
    // Navigation stays: "Open as graph" and each group's Graph link.
    expect(html).toContain('>Open as graph<');
    expect(html).toContain(
      'aria-label="Dependency graph of Platform reliability"'
    );
  });

  test('a member with the grant gets the handles', () => {
    const html = screenHtml(MEMBER);
    expect(html).toContain('role="slider"');
    expect(html).not.toContain(READ_ONLY_NOTICE);
  });
});

describe('the issue page, read only', () => {
  test('a guest keeps the Blocked-by Graph link, alone', () => {
    const html = render(
      <IssuePageView
        model={modelFor('ENG-23', { canEdit: false, readOnly: true })}
      />
    );
    expect(html).toContain(READ_ONLY_NOTICE);
    expect(html).toMatch(
      /<a href="\/graph\?chain=ENG-23"[^>]*aria-label="Blocking chain of ENG-23 as a graph">Graph<\/a>/
    );
    expect(html).not.toContain('aria-label="Add blocked by"');
    expect(html).not.toContain('<input');
  });
});

// The Issues page (owner request 2026-10-22, "every issue in one list"):
// a guest reads it with one read-only notice and no grant link; a member
// without the write grant gets the "Allow edits in Linear" notice. Either
// way the list, its filters and "Open as graph" stay.
describe('the Issues page', () => {
  function issuesHtml(who: {
    viewerId: string;
    readOnly: boolean;
    canWriteLinear: boolean;
  }): string {
    const query = parseIssueListParams({});
    const issueView = buildIssueList({
      snapshot,
      ctx,
      assessments,
      allocationPlan,
      query,
      viewerId: who.viewerId,
    });
    const page = buildIssueListPage({
      view: issueView,
      query,
      viewerId: who.viewerId,
      readOnly: who.readOnly,
      readOnlyReason: who.readOnly ? 'guest' : undefined,
      canWriteLinear: who.canWriteLinear,
      canMove: who.canWriteLinear && !who.readOnly,
    });
    return render(
      <IssuesScreen
        page={page}
        urlQuery={query}
        counts={issueView.counts}
        filterNames={filterValueNames(issueView)}
        today={TODAY}
        viewerId={who.viewerId}
        mirrorVersion={1}
        facts={{ hasInitiatives: !who.readOnly, teamCount: 2 }}
        drawer={{ param: null, model: null }}
        permissions={{
          canMove: who.canWriteLinear && !who.readOnly,
          canEditWeight: !who.readOnly,
          canWriteLinear: who.canWriteLinear,
          readOnly: who.readOnly,
        }}
        weightBounds={{ min: -1000, max: 1000 }}
      />
    );
  }

  test('a guest: the read-only notice once, no grant link, no edit controls', () => {
    const html = issuesHtml({
      viewerId: 'user-gus',
      readOnly: true,
      canWriteLinear: false,
    });
    expect(html.split(READ_ONLY_NOTICE)).toHaveLength(2);
    expect(html).not.toContain('Allow edits in Linear');
    expect(html).not.toContain('intent=grant_write');
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('draggable');
    expect(html).not.toContain('data-draggable');
    // No cell pickers (their accessible names) and no weight menu.
    expect(html).not.toContain('aria-label="ENG-');
    expect(html).not.toContain('aria-label="OPS-');
    expect(html).not.toContain('Actions for Dual-write');
    // The row menu stays, with its read-only items only.
    expect(html).toContain('aria-label="Actions for OPS-');
    expect(html).toContain('Open as graph');
    expect(html).toContain('Search issues');
  });

  test('a member without the grant: one "Allow edits in Linear" notice', () => {
    const html = issuesHtml({
      viewerId: 'user-chloe',
      readOnly: false,
      canWriteLinear: false,
    });
    expect(html).not.toContain(READ_ONLY_NOTICE);
    expect(
      html.split('Allow edits in Linear to change issues here.')
    ).toHaveLength(2);
    expect(html).toContain(
      `href="/api/auth/linear?intent=grant_write&amp;returnTo=${encodeURIComponent('/issues')}"`
    );
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('data-draggable');
    expect(html).not.toContain('aria-label="ENG-10 assignee');
    // The milestone weight is the planner's own: its menu stays.
    expect(html).toContain('aria-label="Actions for Dual-write"');
    expect(html).toContain('Open as graph');
  });

  test('a member with the grant gets neither notice, and every control', () => {
    const html = issuesHtml({
      viewerId: 'user-chloe',
      readOnly: false,
      canWriteLinear: true,
    });
    expect(html).not.toContain(READ_ONLY_NOTICE);
    expect(html).not.toContain('Allow edits in Linear');
    expect(html).toContain('Dual-write');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('>Select ENG-10</span>');
    expect(html).toContain('aria-label="ENG-10 assignee: Chloe Diaz"');
    expect(html).toContain('aria-label="Actions for Dual-write"');
    expect(html).toContain('aria-label="Actions for ENG-10"');
  });
});

describe('settings, read only', () => {
  const settings = {
    ...defaultSettings('org-northwind', 'Europe/Oslo'),
    watcherUserIds: ['user-ana'],
  };

  test('modes and schedule are plain values: no switch, box, input or Save', () => {
    const html = render(
      <>
        <ReadOnlySettings label="Modes" rows={modesReadOnlyRows(settings)} />
        <ReadOnlySettings
          label="Schedule"
          rows={scheduleReadOnlyRows(settings)}
        />
      </>
    );
    expect(html).toContain('Dry run');
    expect(html).toContain('Preview');
    expect(html).toContain('Europe/Oslo');
    expect(html).toContain('7 days');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('role="switch"');
  });

  test('watchers are listed without boxes', () => {
    const html = render(
      <ReadOnlyWatchers
        rows={watcherRows(snapshot.data.users, settings)}
        watcherUserIds={settings.watcherUserIds}
        hint={watchersHint(settings.watcherUserIds.length)}
      />
    );
    expect(html).toContain('Ana Moreno');
    expect(html).toContain('Watcher');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<button');
  });

  test('the rows say what each setting is, in words', () => {
    expect(modesReadOnlyRows(settings).map((r) => [r.label, r.value])).toEqual([
      ['Allocation', 'Dry run'],
      ['Warnings', 'Preview'],
    ]);
    const schedule = scheduleReadOnlyRows(settings);
    expect(schedule[0]).toMatchObject({
      label: 'Timezone',
      value: 'Europe/Oslo',
    });
    expect(schedule.at(-1)?.label).toBe('Active project statuses');
  });
});

// Someone read-only for another reason than being a Linear guest is told
// what is going on instead of being called a guest: the shell provides
// the reason (Actor.readOnlyReason) to every notice below it.
describe('the read-only notice', () => {
  test('says why, from the reason the shell provides', () => {
    const notice = (reason?: 'guest' | 'unknown' | 'not_synced') =>
      renderToStaticMarkup(
        <ReadOnlyReasonProvider reason={reason}>
          <ReadOnlyNotice />
        </ReadOnlyReasonProvider>
      );
    expect(notice()).toContain(READ_ONLY_NOTICE);
    expect(notice('guest')).toContain(READ_ONLY_NOTICE);
    expect(notice('not_synced')).toContain(readOnlyNotice('not_synced'));
    expect(notice('not_synced')).not.toContain('guest');
    expect(notice('unknown')).toContain(readOnlyNotice('unknown'));
    expect(notice('unknown')).not.toContain('guest');
    // Without a provider (one screen rendered alone) it reads as a guest's.
    expect(renderToStaticMarkup(<ReadOnlyNotice />)).toContain(
      READ_ONLY_NOTICE
    );
  });
});

// While the first sync has not landed every mirror-backed page fails, so
// the (app) error page says that and points at Setup (where a reinstall
// stays open) instead of blaming Linear or the database.
describe('the (app) error page', () => {
  const page = (reason?: 'guest' | 'not_synced') =>
    renderToStaticMarkup(
      <ReadOnlyReasonProvider reason={reason}>
        <AppError error={new Error('No mirror')} retry={() => {}} />
      </ReadOnlyReasonProvider>
    );

  test('says the first sync is pending and links to Setup', () => {
    const html = page('not_synced');
    expect(html).toContain(FIRST_SYNC_PENDING_HEADLINE);
    expect(html).toContain('href="/setup"');
    expect(html).not.toContain('This page could not load.');
  });

  test('otherwise reads as a plain failure', () => {
    for (const reason of [undefined, 'guest'] as const) {
      const html = page(reason);
      expect(html).toContain('This page could not load.');
      expect(html).not.toContain(FIRST_SYNC_PENDING_HEADLINE);
    }
  });
});
