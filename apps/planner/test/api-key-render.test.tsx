// What api_key mode renders (architecture §8.4), as HTML without a
// browser: the connect form and its notices, Settings → Status's key rows
// and sign-out form, the read-only-key notice, and the refusal of
// key-shaped searches. Keys are obviously fake (TESTKEY).

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

import { parseIssueListParams } from '../lib/adapters/issue-list';
import { signedOutNotice } from '../lib/adapters/landing';
import {
  API_KEY_JOBS_OFF,
  API_KEY_STATUS_DESCRIPTION,
  parseSettingsSection,
  sectionDescription,
  statusRows,
} from '../lib/adapters/settings';
import { buildMilestoneDrawer } from '../lib/adapters/timeline';
import {
  KEY_TEXT_REFUSAL,
  refuseKeyText,
  urlWithoutKeys,
} from '../lib/key-text';
import { READ_ONLY_KEY_NOTICE, readOnlyNotice } from '../lib/read-only';

const realNavigation = await import('next/navigation');
void mock.module('next/navigation', () => ({
  ...realNavigation,
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => '/timeline',
  useSearchParams: () => new URLSearchParams(''),
}));

const { default: ConnectKeyBlock, ConnectNotices } =
  await import('../app/(app)/components/connect-key-block');
const { default: ForgetKeyForm } =
  await import('../app/(app)/settings/forget-key-form');
const { default: MilestoneDrawer } =
  await import('../app/(app)/timeline/milestone-drawer');
const { ReadOnlyReasonProvider } =
  await import('../app/(app)/components/read-only-notice');

const KEY = 'lin_api_TESTKEY_member_q7Wz3Kp9Vx2Lm8Rt5Yb1Nc';

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

// Every opening tag of `name` in the HTML, as attribute maps.
function tags(html: string, name: string): Map<string, string>[] {
  const found: Map<string, string>[] = [];
  for (const match of html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, 'g'))) {
    const attributes = new Map<string, string>();
    for (const attr of (match[1] ?? '').matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) {
      // HTML attribute names are case-insensitive (React writes autoComplete).
      attributes.set((attr[1] ?? '').toLowerCase(), attr[2] ?? '');
    }
    found.push(attributes);
  }
  return found;
}

describe('the connect form', () => {
  const html = render(
    <ConnectKeyBlock
      returnTo="/timeline"
      idleHours={2}
      maxHours={12}
      syncMinutes={15}
    />
  );

  test('a same-origin POST form to /api/auth/key with autocomplete off', () => {
    const [form] = tags(html, 'form');
    expect(form?.get('method')).toBe('post');
    expect(form?.get('action')).toBe('/api/auth/key');
    expect(form?.get('autocomplete')).toBe('off');
  });

  test('a password field with every ignore attribute and no value', () => {
    const inputs = tags(html, 'input');
    const visible = inputs.filter((input) => input.get('type') !== 'hidden');
    expect(visible).toHaveLength(1);
    const field = visible[0];
    expect(field?.get('type')).toBe('password');
    expect(field?.get('name')).toBe('apiKey');
    expect(field?.get('autocomplete')).toBe('off');
    expect(field?.get('spellcheck')).toBe('false');
    expect(field?.has('data-1p-ignore')).toBe(true);
    expect(field?.get('data-lpignore')).toBe('true');
    expect(field?.has('data-bwignore')).toBe(true);
    expect(field?.get('data-form-type')).toBe('other');
    expect(field?.has('value')).toBe(false);
    const hidden = inputs.filter((input) => input.get('type') === 'hidden');
    expect(hidden.map((input) => input.get('name'))).toEqual(['returnTo']);
  });

  test('the hint, the trust line, and no OAuth sign-in', () => {
    expect(html).toContain('If your browser offers to save it, choose Never.');
    expect(html).toContain(
      'Whoever runs this server could still capture a key, so connect only to a planner you trust.'
    );
    expect(html).toContain('after 2 hours idle, after 12 hours');
    expect(html).toContain('every 15 minutes');
    expect(html).not.toContain('Sign in with Linear');
    expect(html).not.toContain('/api/auth/linear');
  });

  test('the four notices', () => {
    const failed = render(
      <ConnectNotices
        errorMessage="Nope."
        signedOut={null}
        connectionEnded={false}
        idleHours={2}
        maxHours={12}
      />
    );
    expect(failed).toContain('COULD NOT CONNECT');
    expect(failed).toContain('data-tone="danger"');
    const signedOut = render(
      <ConnectNotices
        errorMessage={null}
        signedOut="everywhere"
        connectionEnded
        idleHours={2}
        maxHours={12}
      />
    );
    expect(signedOut).toContain('SIGNED OUT');
    expect(signedOut).toContain('in every browser you connected it from');
    expect(signedOut).not.toContain('CONNECTION ENDED');
    const unknown = render(
      <ConnectNotices
        errorMessage={null}
        signedOut="ended"
        connectionEnded
        idleHours={2}
        maxHours={12}
      />
    );
    expect(unknown).toContain('ALREADY DISCONNECTED');
    expect(unknown).toContain('it may still be connected there');
    expect(unknown).toContain('paste it here again, then sign out');
    expect(unknown).toContain('data-tone="warning"');
    expect(unknown).not.toContain('in every browser you connected it from');
    expect(unknown).not.toContain('CONNECTION ENDED');
    const ended = render(
      <ConnectNotices
        errorMessage={null}
        signedOut={null}
        connectionEnded
        idleHours={2}
        maxHours={12}
      />
    );
    expect(ended).toContain('CONNECTION ENDED');
    expect(ended).toContain('idle for 2 hours, connected 12 hours ago');
    expect(ended).toContain('data-tone="muted"');
  });

  test('?signed_out picks the notice', () => {
    expect(signedOutNotice('1')).toBe('everywhere');
    expect(signedOutNotice('ended')).toBe('ended');
    expect(signedOutNotice(undefined)).toBeNull();
    expect(signedOutNotice('yes')).toBeNull();
  });
});

describe('Settings → Status with personal API keys', () => {
  test('three key rows, no key in them', () => {
    const rows = statusRows({
      installation: null,
      syncState: {
        workspaceId: 'org-acme',
        version: 3,
        lastFullSyncAt: '2026-10-23T09:20:00.000Z',
        lastFullSyncStatus: 'ok',
        lastFullSyncError: null,
        lastWebhookAt: null,
      },
      users: new Map(),
      timeZone: 'UTC',
      demo: false,
      apiKey: {
        keyConnection: {
          connectedAt: '2026-10-23T09:12:00.000Z',
          expiresAt: '2026-10-23T21:12:00.000Z',
          idleMinutes: 120,
          reader: { userId: 'u-ana', userName: 'Ana Ruiz' },
        },
        syncMinutes: 15,
      },
    });
    expect(rows.map((row) => [row.label, row.value])).toEqual([
      [
        'Your key',
        'Connected 9:12 AM · forgotten by 9:12 PM, or after 2 h idle',
      ],
      ['Mirror read with', 'Ana Ruiz’s key'],
      ['Scheduled jobs', 'Off'],
    ]);
    expect(rows[1]?.sub).toContain(
      'Refreshed every 15 min while a member is connected'
    );
    expect(rows[2]?.sub).toBe(API_KEY_JOBS_OFF);
    const nobody = statusRows({
      installation: null,
      syncState: null,
      users: new Map(),
      timeZone: 'UTC',
      demo: false,
      apiKey: {
        keyConnection: {
          connectedAt: '2026-10-23T09:12:00.000Z',
          expiresAt: '2026-10-23T21:12:00.000Z',
          idleMinutes: 120,
          reader: null,
        },
        syncMinutes: 15,
      },
    });
    expect(nobody[1]?.value).toBe('Nobody’s');
    expect(nobody[1]?.sub).toContain(
      'no workspace member is connected; showing the last copy'.replace(
        'no',
        'No'
      )
    );
  });

  test('a limit after midnight says tomorrow; the sentence names no installation', () => {
    const rows = statusRows({
      installation: null,
      syncState: null,
      users: new Map(),
      timeZone: 'America/Chicago',
      demo: false,
      apiKey: {
        keyConnection: {
          connectedAt: '2026-10-23T20:05:00.000Z',
          expiresAt: '2026-10-24T08:05:00.000Z',
          idleMinutes: 120,
          reader: null,
        },
        syncMinutes: 15,
      },
    });
    expect(rows[0]?.value).toBe(
      'Connected 3:05 PM · forgotten by 3:05 AM tomorrow, or after 2 h idle'
    );
    const status = parseSettingsSection({ section: 'status' });
    expect(sectionDescription(status, { apiKeyMode: true })).toBe(
      API_KEY_STATUS_DESCRIPTION
    );
    expect(API_KEY_STATUS_DESCRIPTION).not.toMatch(/installation|webhook/);
    expect(sectionDescription(status, { apiKeyMode: false })).toBe(
      status.description
    );
  });

  test('the "Forget my key and sign out" form', () => {
    const html = render(<ForgetKeyForm />);
    const [form] = tags(html, 'form');
    expect(form?.get('method')).toBe('post');
    expect(form?.get('action')).toBe('/api/auth/logout');
    expect(html).toContain('Forget my key and sign out');
  });
});

describe('a read-only key', () => {
  test('the notice says so, and the drawer has no controls or grant links', () => {
    expect(readOnlyNotice('read_only_key', { apiKeyMode: true })).toBe(
      READ_ONLY_KEY_NOTICE
    );
    const today = '2026-10-21';
    const snapshot = indexWorkspace(createFixtureWorkspace(today));
    const ctx: EvalContext = {
      today,
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
    const view = buildTimelineView({
      snapshot,
      ctx,
      assessments,
      allocationPlan,
    });
    const detail = buildMilestoneDetail({
      snapshot,
      ctx,
      assessments,
      milestoneId: 'ms-atlas-2',
    });
    if (detail === null) throw new Error('fixture changed');
    const model = buildMilestoneDrawer({
      detail,
      today,
      permissions: { canWriteLinear: false, readOnly: true },
      users: snapshot.data.users,
      issues: snapshot.issues,
      view,
      limits: { doneMeansMax: 280, weightMin: -1000, weightMax: 1000 },
    });
    const html = render(
      <ReadOnlyReasonProvider reason="read_only_key" apiKeyMode>
        <MilestoneDrawer
          open
          milestoneId="ms-atlas-2"
          loading={false}
          model={model}
          fallbackTitle=""
          fallbackCrumb=""
          hrefFor={(id) => `/timeline?milestone=${id}`}
          onClose={() => {}}
        />
      </ReadOnlyReasonProvider>
    );
    expect(html).toContain('Your Linear API key only allows reading');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('intent=grant_write');
  });
});

describe('key-shaped searches', () => {
  test('the search box and palette refuse them; the list ignores one in the URL', () => {
    expect(refuseKeyText(`find ${KEY}`)).toBe(KEY_TEXT_REFUSAL);
    expect(KEY_TEXT_REFUSAL).toBe(
      'That looks like a Linear API key; it was not sent.'
    );
    expect(refuseKeyText('billing writes')).toBeNull();
    expect(refuseKeyText('they start with lin_api_')).toBeNull();
    expect(parseIssueListParams({ q: [KEY] }).filters.q).toBe('');
    expect(parseIssueListParams({ q: ['billing'] }).filters.q).toBe('billing');
  });

  test('urlWithoutKeys drops what holds a key from a page URL (proxy.ts)', () => {
    expect(urlWithoutKeys('/issues', '?q=billing&state=all')).toBeNull();
    expect(urlWithoutKeys('/issues', '')).toBeNull();
    expect(urlWithoutKeys('/issues', `?q=${KEY}&state=all`)).toBe(
      '/issues?state=all'
    );
    expect(urlWithoutKeys('/issues', `?q=${encodeURIComponent(KEY)}`)).toBe(
      '/issues'
    );
    // Percent-encoded underscores and a key nested in returnTo.
    expect(urlWithoutKeys('/', `?q=${KEY.replaceAll('_', '%5F')}&x=1`)).toBe(
      '/?x=1'
    );
    expect(
      urlWithoutKeys('/', `?returnTo=${encodeURIComponent(`/issues?q=${KEY}`)}`)
    ).toBe('/');
    expect(urlWithoutKeys(`/issues/${KEY}`, '?a=1')).toBe('/');
    expect(urlWithoutKeys(`/issues/${KEY.replaceAll('_', '%5F')}`, '')).toBe(
      '/'
    );
    // A parameter name may hold it too.
    expect(urlWithoutKeys('/week', `?${KEY}=1&b=2`)).toBe('/week?b=2');
  });
});
