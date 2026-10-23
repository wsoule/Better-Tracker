import {
  assessWorkspace,
  buildMilestoneDetail,
  buildTimelineView,
  DEFAULT_TUNING,
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
  buildMilestoneDrawer,
  buildTimelineBanners,
  type TimelinePermissions,
} from '../lib/adapters/timeline';

// Status colours on the timeline page's own islands (owner decision
// 2026-10-22, docs/architecture.md §8.2 "Status colours"), rendered to
// HTML over the demo workspace: the banner rows and the milestone drawer
// say status through data-tone (danger red, warning amber, info blue),
// never through the purple accent, which stays for links and focus.
// next/navigation's hooks need a mounted app router, so they are replaced
// here (the rest of the module stays real).

const realNavigation = await import('next/navigation');
void mock.module('next/navigation', () => ({
  ...realNavigation,
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => '/timeline',
  useSearchParams: () => new URLSearchParams(''),
}));

const { default: MilestoneDrawer } =
  await import('../app/(app)/timeline/milestone-drawer');
const { default: TimelineBanners } =
  await import('../app/(app)/timeline/timeline-banners');

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

/** Text as a literal inside a RegExp. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The data-tone of every element whose own text starts with `text` (the
    markup is static HTML: no DOM in this test runner). */
function tonesOf(html: string, text: string): string[] {
  const pattern = new RegExp(`data-tone="([a-z]+)"[^>]*>${literal(text)}`, 'g');
  return [...html.matchAll(pattern)].map((match) => match[1] ?? '');
}

describe('the banner rows', () => {
  test('each row carries its status tone: every banner is amber', () => {
    const banners = buildTimelineBanners(view, snapshot.issues);
    const html = render(
      <TimelineBanners banners={banners} hrefFor={() => '/timeline'} />
    );
    const rows = [
      ...html.matchAll(/data-banner-id="([a-z_]+)" data-tone="([a-z]+)"/g),
    ].map((match) => [match[1], match[2]]);
    expect(rows).toEqual([
      ['no_lead', 'warning'],
      ['no_date', 'warning'],
      ['unplanned', 'warning'],
      ['blocked', 'warning'],
    ]);
  });
});

describe('the milestone drawer', () => {
  test('an overdue milestone: red strip and date, amber risk words', () => {
    // Atlas dual-write is overdue with two unassigned open issues.
    const html = drawerHtml('ms-atlas-2', GUEST);
    // The strip's frame and key (AlertStrip emits its tone on the frame).
    expect(html).toMatch(/data-tone="danger"><span[^>]*>Overdue<\/span>/);
    // The read-only due date and the progress are red.
    expect(tonesOf(html, 'Oct')).toEqual(['danger']);
    expect(html).toMatch(
      /data-tone="danger"[^>]*><span[^>]*role="progressbar"/
    );
    // Unassigned open issues are warnings.
    expect(tonesOf(html, 'Unassigned')).toEqual(['warning', 'warning']);
    // No status word is purple.
    expect(html).not.toContain('data-tone="accent"');
  });

  test('a project without a lead: the missing lead is a warning', () => {
    // Delta exports has no lead (and its milestone is missing input).
    const guest = drawerHtml('ms-delta-1', GUEST);
    expect(tonesOf(guest, 'No lead')).toEqual(['warning']);
    const member = drawerHtml('ms-delta-1', MEMBER);
    expect(tonesOf(member, 'No lead: nothing in this project')).toEqual([
      'warning',
    ]);
    expect(member).not.toContain('data-tone="accent"');
  });
});
