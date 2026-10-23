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
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  buildMilestoneDrawer,
  buildTimelineBanners,
  type TimelinePermissions,
} from '../lib/adapters/timeline';
import { RETIRED_TOKENS } from './retired-tokens';

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

describe('the banner panel (Gr8r look)', () => {
  test('one labelled panel, lead-ins in sentence case, every row on every width', () => {
    const banners = buildTimelineBanners(view, snapshot.issues);
    const html = render(
      <TimelineBanners banners={banners} hrefFor={() => '/timeline'} />
    );
    // One panel, not a stack of boxes: a single labelled section.
    expect(html.match(/aria-label="Missing inputs"/g)).toHaveLength(1);
    // The lead-ins are the sentence-case words (the old mono caps key
    // carried "· <count>"; the sentence says the count).
    for (const label of ['No lead', 'No date', 'Unplanned', 'Blocked']) {
      expect(html).toContain(`>${label}</span>`);
    }
    expect(html).not.toMatch(/>No lead · \d/);
    // Every banner is its own row with its own Show button, on a phone
    // too: no folded summary row and nothing collapsed (main's
    // behaviour; the stylesheet only wraps the sentence when narrow).
    expect(html).not.toContain('missing inputs</span>');
    expect(html).not.toContain('data-collapsed');
    expect(html.match(/>Show \d+ items?</g)).toHaveLength(banners.length);
    expect(banners).toHaveLength(4);
    const css = readFileSync(
      path.join(
        import.meta.dir,
        '..',
        'app',
        '(app)',
        'timeline',
        'page.module.css'
      ),
      'utf8'
    );
    expect(css).not.toContain('bannerSummary');
    expect(css).not.toMatch(/\.bannerRows\s*\{[^}]*display:\s*none/);
  });
});

describe('the milestone drawer', () => {
  test('an overdue milestone: red strip and date, amber risk words', () => {
    // Atlas dual-write is overdue with two unassigned open issues.
    const html = drawerHtml('ms-atlas-2', GUEST);
    // The strip's tint, icon and lead-in (AlertStrip emits its tone on the
    // box; its lead is the tone's icon, then the word).
    expect(html).toMatch(
      /data-tone="danger"><span[^>]*><svg[\s\S]*?<\/svg><span[^>]*>Overdue<\/span>/
    );
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

  test('the risk lines are warnings, and quiet in an inactive project', () => {
    // Atlas dual-write has open issues nobody is assigned to.
    expect(
      tonesOf(drawerHtml('ms-atlas-2', GUEST), 'Open issues unassigned')
    ).toEqual(['warning']);
    // Fjord is paused: its milestone's lines carry no tone (§2.8).
    const fjord = drawerHtml('ms-fjord-1', GUEST);
    expect(fjord).not.toContain('data-tone="warning"');
    expect(fjord).not.toContain('data-tone="danger"');
  });

  test('the checklist heading counts what is met, outside its name', () => {
    // The heading's name stays "Checklist" (main's); the count sits
    // beside it in the same row.
    expect(drawerHtml('ms-atlas-2', GUEST)).toMatch(
      /<h3[^>]*>Checklist<\/h3><span[^>]*>\d+\/\d+ met<\/span>/
    );
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

// The timeline page, its drawer and the timeline gallery are migrated to
// the Gr8r token names: none reads one of the old Analytics names (the
// migration aliases tokens.css declared until every sheet had moved;
// test/retired-tokens.ts, docs/architecture.md §8.2).
describe('the timeline page sheets are migrated', () => {
  const retired: readonly string[] = RETIRED_TOKENS;

  test('no timeline page or gallery file reads a retired name', () => {
    const dirs = [
      path.join(import.meta.dir, '..', 'app', '(app)', 'timeline'),
      path.join(
        import.meta.dir,
        '..',
        'app',
        '(gallery)',
        'ui-gallery',
        'timeline'
      ),
    ];
    const found: string[] = [];
    for (const dir of dirs) {
      for (const name of readdirSync(dir)) {
        if (!/\.(css|tsx?)$/.test(name)) continue;
        const source = readFileSync(path.join(dir, name), 'utf8').replace(
          /\/\*[\s\S]*?\*\//g,
          ''
        );
        for (const token of retired) {
          if (new RegExp(`${token}(?![\\w-])`).test(source)) {
            found.push(`${path.basename(dir)}/${name}: ${token}`);
          }
        }
      }
    }
    expect(found).toEqual([]);
  });
});
