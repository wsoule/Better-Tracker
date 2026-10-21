import {
  defaultSettings,
  type Milestone,
  type Project,
  type User,
  type WorkspaceSettings,
} from '@better-tracker/core';
import { describe, expect, test } from 'bun:test';

import {
  type AuditEntry,
  auditRows,
  digestPreview,
  formStatusText,
  type Installation,
  isDigestPreviewModel,
  lockedPmIds,
  modesSavedMessage,
  noticeTone,
  type NotificationRecord,
  notificationRows,
  parseScheduleForm,
  parseSettingsSection,
  peopleRows,
  readOnlyNote,
  RESET_OUTCOME,
  sameIds,
  scheduleFieldError,
  scheduleForm,
  scheduleSavedMessage,
  sectionTabs,
  sentenceCase,
  settingsChanges,
  settingsHref,
  statusRows,
  toggleId,
} from '../lib/adapters/settings';

function user(id: string, name: string, extra: Partial<User> = {}): User {
  return {
    id,
    name,
    displayName: name.toLowerCase(),
    email: `${id}@example.com`,
    avatarUrl: null,
    active: true,
    app: false,
    ...extra,
  };
}

const USERS: User[] = [
  user('u-ben', 'Ben Carter'),
  user('u-ana', 'Ana Moreno'),
  user('u-hugo', 'Hugo Laurent', { active: false }),
  user('u-gone', 'Gone Person', { active: false }),
  user('u-app', 'Milestone Planner', { app: true, email: null }),
];
const USER_MAP = new Map(USERS.map((u) => [u.id, u]));

function settings(overrides: Partial<WorkspaceSettings> = {}) {
  return {
    ...defaultSettings('org-1', 'UTC'),
    pmUserIds: ['u-ana', 'u-hugo'],
    watcherUserIds: ['u-ana'],
    ...overrides,
  };
}

describe('sections', () => {
  test('unknown or missing ?section= is Modes', () => {
    expect(parseSettingsSection({}).id).toBe('modes');
    expect(parseSettingsSection({ section: 'nope' }).id).toBe('modes');
    expect(parseSettingsSection({ section: ['audit', 'x'] }).id).toBe('audit');
  });

  test('tabs mark the current section; Modes lives at /settings', () => {
    const tabs = sectionTabs('people');
    expect(tabs.map((t) => t.label)).toEqual([
      'Modes',
      'People',
      'Schedule',
      'Status',
      'Notifications',
      'Audit',
    ]);
    expect(tabs.filter((t) => t.current === true).map((t) => t.id)).toEqual([
      'people',
    ]);
    expect(settingsHref('modes')).toBe('/settings');
    expect(settingsHref('audit')).toBe('/settings?section=audit');
  });

  test('read-only note names the active PMs', () => {
    expect(readOnlyNote(settings(), USER_MAP)).toBe(
      'Only PMs can change settings. Ask Ana Moreno if something here should change.'
    );
    expect(
      readOnlyNote(settings({ pmUserIds: ['u-ana', 'u-ben'] }), USER_MAP)
    ).toContain('Ask Ana Moreno or Ben Carter if');
    expect(readOnlyNote(settings({ pmUserIds: [] }), USER_MAP)).toContain(
      'Ask a PM'
    );
  });

  test('modes toast names both modes', () => {
    expect(
      modesSavedMessage({ allocationMode: 'live', warningsMode: 'preview' })
    ).toBe('Saved: allocation writes to Linear and warnings stay in preview.');
  });
});

describe('people', () => {
  test('active people plus deactivated list members, never apps, by name', () => {
    const rows = peopleRows(USERS, settings());
    expect(rows.map((r) => r.name)).toEqual([
      'Ana Moreno',
      'Ben Carter',
      'Hugo Laurent',
    ]);
    expect(rows.find((r) => r.id === 'u-hugo')?.note).toBe(
      'Deactivated in Linear'
    );
  });

  test('the last active PM is locked on', () => {
    const rows = peopleRows(USERS, settings());
    // Hugo is a PM but deactivated, so Ana is the only active one.
    expect([...lockedPmIds(['u-ana', 'u-hugo'], rows)]).toEqual(['u-ana']);
    expect(lockedPmIds(['u-ana', 'u-ben'], rows).size).toBe(0);
    expect(lockedPmIds([], rows).size).toBe(0);
  });

  test('list helpers', () => {
    expect(toggleId(['a', 'b'], 'c', true)).toEqual(['a', 'b', 'c']);
    expect(toggleId(['a', 'b'], 'a', false)).toEqual(['b']);
    expect(toggleId(['a'], 'a', true)).toEqual(['a']);
    expect(sameIds(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameIds(['a'], ['a', 'b'])).toBe(false);
  });
});

describe('schedule', () => {
  test('round trip: the saved settings parse back to the same tuning', () => {
    const form = scheduleForm(settings());
    const parsed = parseScheduleForm(form);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.patch.timezone).toBe('UTC');
    expect(parsed.patch.tuning.warnLeadDays).toBe(7);
    expect(parsed.patch.tuning.activeProjectStatuses).toEqual([
      'planned',
      'started',
    ]);
  });

  test('ranges, whole numbers, a timezone and one status are required', () => {
    const form = scheduleForm(settings());
    const parsed = parseScheduleForm({
      timezone: '  ',
      values: { ...form.values, stallDays: '0', paceWindowDays: '2.5' },
      statuses: [],
    });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(Object.keys(parsed.errors).sort()).toEqual([
      'paceWindowDays',
      'stallDays',
      'statuses',
      'timezone',
    ]);
    expect(parsed.errors.stallDays).toBe('Whole number of days from 1 to 90.');
  });

  test('the saved toast names what changed', () => {
    const form = scheduleForm(settings());
    const parse = (next: typeof form) => {
      const parsed = parseScheduleForm(next);
      if (!parsed.ok) throw new Error('expected a valid form');
      return parsed.patch;
    };
    expect(scheduleSavedMessage(form, parse(form))).toBe('Saved the schedule.');
    expect(
      scheduleSavedMessage(
        form,
        parse({
          timezone: ' America/Chicago ',
          values: { ...form.values, warnLeadDays: '6', overdueRepeatDays: '1' },
          statuses: [...form.statuses, 'paused'],
        })
      )
    ).toBe(
      'Saved: timezone America/Chicago, warn ahead 6 days, active project statuses.'
    );
  });

  test('statuses are sent in Linear’s order', () => {
    const form = scheduleForm(settings());
    const parsed = parseScheduleForm({
      ...form,
      statuses: ['paused', 'backlog'],
    });
    expect(parsed.ok && parsed.patch.tuning.activeProjectStatuses).toEqual([
      'backlog',
      'paused',
    ]);
  });
});

describe('saving a section', () => {
  const idle = { dirty: false, saving: false, blocked: null, outcome: null };

  test('the status line: saving, blocked, unsaved, then the last outcome', () => {
    expect(formStatusText(idle)).toBe('No changes');
    expect(formStatusText({ ...idle, dirty: true })).toBe('Unsaved changes');
    expect(formStatusText({ ...idle, dirty: true, saving: true })).toBe(
      'Saving…'
    );
    expect(
      formStatusText({ ...idle, dirty: true, blocked: 'Fix the field' })
    ).toBe('Fix the field');
    const saved = { kind: 'saved' as const, text: 'Saved' };
    const failed = { kind: 'error' as const, text: 'Not saved: no network' };
    // After a save the form is clean again and says so, until it changes.
    expect(formStatusText({ ...idle, outcome: saved })).toBe('Saved');
    expect(formStatusText({ ...idle, dirty: true, outcome: saved })).toBe(
      'Unsaved changes'
    );
    // A failed save keeps its changes and says why.
    expect(formStatusText({ ...idle, dirty: true, outcome: failed })).toBe(
      'Not saved: no network'
    );
    expect(formStatusText({ ...idle, outcome: failed })).toBe('No changes');
    // Reset after a save focuses the line: it must not say "Saved".
    expect(formStatusText({ ...idle, outcome: RESET_OUTCOME })).toBe(
      'Changes discarded'
    );
    expect(
      formStatusText({ ...idle, dirty: true, outcome: RESET_OUTCOME })
    ).toBe('Unsaved changes');
  });

  test('the timezone refusal belongs to the timezone field, capitalised', () => {
    expect(
      scheduleFieldError({
        code: 'invalid',
        message: 'timezone must be an IANA timezone such as Europe/Oslo.',
      })
    ).toEqual({
      field: 'timezone',
      message: 'Timezone must be an IANA timezone such as Europe/Oslo.',
    });
    expect(
      scheduleFieldError({ code: 'invalid', message: 'timezone: Too big' })
    ).toEqual({ field: 'timezone', message: 'Timezone: Too big' });
    // Everything else stays a toast.
    expect(
      scheduleFieldError({
        code: 'invalid',
        message: 'At least one active PM must remain.',
      })
    ).toBeNull();
    expect(
      scheduleFieldError({ code: 'not_pm', message: 'timezone is yours' })
    ).toBeNull();
    expect(
      scheduleFieldError({ code: 'invalid', message: 'timezones: nope' })
    ).toBeNull();
  });

  test('sentenceCase', () => {
    expect(sentenceCase('timezone must be')).toBe('Timezone must be');
    expect(sentenceCase('  ok ')).toBe('Ok');
    expect(sentenceCase('')).toBe('');
  });
});

describe('status', () => {
  const installation: Installation = {
    workspaceId: 'org-1',
    workspaceName: 'Northwind Labs',
    urlKey: 'northwind',
    appUserId: 'u-app',
    installedByUserId: 'u-ana',
    revokedAt: null,
    tokens: {
      accessToken: '',
      refreshToken: null,
      expiresAt: null,
      scopes: [],
    },
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
  };

  test('a working installation and a failed sync', () => {
    const rows = statusRows({
      installation,
      syncState: {
        workspaceId: 'org-1',
        version: 3,
        lastFullSyncAt: '2026-10-21T14:00:00.000Z',
        lastFullSyncStatus: 'failed',
        lastFullSyncError: 'Linear answered 503',
        lastWebhookAt: null,
      },
      users: USER_MAP,
      timeZone: 'UTC',
      demo: false,
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.has('source')).toBe(false);
    expect(byId.get('installed')?.value).toBe('Ana Moreno');
    expect(byId.get('access')?.value).toBe('Working');
    expect(byId.get('sync')).toMatchObject({
      value: 'Oct 21, 2:00 PM UTC · failed',
      sub: 'Linear answered 503',
      tone: 'accent',
    });
    expect(byId.get('webhook')?.value).toBe('None received yet');
  });

  test('a revoked installation and no sync are loud; demo says so', () => {
    const rows = statusRows({
      installation: { ...installation, revokedAt: '2026-10-20T08:00:00.000Z' },
      syncState: null,
      users: USER_MAP,
      timeZone: 'UTC',
      demo: true,
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('source')?.value).toBe('Demo workspace');
    expect(byId.get('access')).toMatchObject({
      value: 'Revoked: reinstall from Setup',
      tone: 'accent',
    });
    expect(byId.get('sync')).toMatchObject({ value: 'Never', tone: 'accent' });
  });
});

describe('digest preview', () => {
  test('maps digests to rows with app-relative links', () => {
    const model = digestPreview({
      day: '2026-10-21',
      mode: 'preview',
      digests: [
        {
          recipientId: 'u-ana',
          recipientName: 'Ana Moreno',
          recipientEmail: null,
          day: '2026-10-21',
          items: [
            {
              notice: {
                kind: 'allocation_blocked',
                subjectKind: 'project',
                subjectId: 'p1',
                projectId: 'p1',
                milestoneId: null,
                key: 'blocked:no_lead:m1:',
                targetDate: null,
                daysLeft: null,
                reasons: [],
                gaps: [],
                blockReason: 'no_lead',
                openIssueIds: [],
                unassignedIssueIds: [],
                recipientIds: ['u-ana'],
                occurrence: 1,
              },
              projectName: 'Delta',
              milestoneName: null,
              leadName: null,
              openCount: 0,
              unassignedCount: 0,
              lines: ['no project lead, so nothing is being assigned'],
              url: 'https://planner.example/timeline?project=p1',
            },
          ],
        },
      ],
    });
    expect(model.heading).toBe('Digests for Wednesday, October 21');
    expect(model.summary).toContain('1 person would get a digest today');
    expect(model.summary).toContain('in preview');
    expect(model.digests[0]?.items[0]).toMatchObject({
      kindLabel: 'Allocation stopped',
      title: 'Delta',
      due: null,
      dueNote: null,
      href: '/timeline?project=p1',
      tone: 'accent',
    });
    expect(isDigestPreviewModel(model)).toBe(true);
    expect(isDigestPreviewModel({ day: 1 })).toBe(false);
  });

  test('allocation stopped names the next milestone and its date', () => {
    const notice = {
      kind: 'allocation_blocked' as const,
      subjectKind: 'project' as const,
      subjectId: 'p1',
      projectId: 'p1',
      milestoneId: 'm1',
      key: 'blocked:next_milestone_invalid:m1:no_done_means',
      targetDate: '2026-10-25',
      daysLeft: 4,
      reasons: [],
      gaps: ['no_done_means' as const],
      blockReason: 'next_milestone_invalid' as const,
      openIssueIds: ['i1'],
      unassignedIssueIds: ['i1'],
      recipientIds: ['u-ana'],
      occurrence: 1,
    };
    const model = digestPreview({
      day: '2026-10-21',
      mode: 'preview',
      digests: [
        {
          recipientId: 'u-ana',
          recipientName: 'Ana Moreno',
          recipientEmail: null,
          day: '2026-10-21',
          items: [
            {
              notice,
              projectName: 'Harbor API v3',
              milestoneName: 'Public beta',
              leadName: 'Ana Moreno',
              openCount: 1,
              unassignedCount: 1,
              lines: ['next milestone Public beta is missing: done means…'],
              url: 'https://planner.example/timeline?project=p1',
            },
            {
              notice: { ...notice, targetDate: null, daysLeft: null },
              projectName: 'Delta exports',
              milestoneName: 'CSV exports',
              leadName: null,
              openCount: 1,
              unassignedCount: 1,
              lines: [],
              url: 'https://planner.example/timeline?project=p1',
            },
          ],
        },
      ],
    });
    const [dated, undated] = model.digests[0]?.items ?? [];
    // The project is the subject; the milestone is spelled out under Due.
    expect(dated).toMatchObject({
      title: 'Harbor API v3',
      due: 'Oct 25 · in 4 days',
      dueNote: 'Next milestone: Public beta',
      href: '/timeline?milestone=m1',
    });
    expect(undated).toMatchObject({
      due: 'No target date',
      dueNote: 'Next milestone: CSV exports',
    });
  });

  test('the accent marks what needs action; at risk stays ink', () => {
    expect(noticeTone('overdue')).toBe('accent');
    expect(noticeTone('invalid_due_soon')).toBe('accent');
    expect(noticeTone('allocation_blocked')).toBe('accent');
    expect(noticeTone('at_risk')).toBe('default');
  });

  test('nobody to tell is said plainly', () => {
    const model = digestPreview({
      day: '2026-10-21',
      mode: 'live',
      digests: [],
    });
    expect(model.summary).toMatch(/^Nobody would get a digest today/);
    expect(model.summary).toContain('Warnings are live');
  });
});

describe('notifications', () => {
  test('status chips, channel words and errors', () => {
    const record = (
      status: NotificationRecord['status'],
      error: string | null
    ): NotificationRecord => ({
      id: `n-${status}`,
      workspaceId: 'org-1',
      day: '2026-10-21',
      recipientId: 'u-ben',
      channel: status === 'preview' ? 'outbox' : 'slack',
      status,
      digest: {
        recipientId: 'u-ben',
        recipientName: 'Ben',
        recipientEmail: null,
        day: '2026-10-21',
        items: [],
      },
      error,
      createdAt: '2026-10-21T08:00:00.000Z',
    });
    const rows = notificationRows(
      [
        record('sent', null),
        record('preview', null),
        record('undeliverable', 'users_not_found'),
      ],
      USER_MAP
    );
    expect(rows.map((r) => [r.statusLabel, r.statusTone, r.channel])).toEqual([
      ['Sent', 'inverse', 'Slack DM'],
      ['Preview', 'muted', 'Outbox'],
      ['Undeliverable', 'accent', 'Slack DM'],
    ]);
    expect(rows[0]).toMatchObject({
      recipient: 'Ben Carter',
      day: 'Oct 21, 2026',
      items: '0 items',
    });
    expect(rows[2]?.rowTone).toBe('accent');
  });
});

describe('audit', () => {
  const snapshot = {
    users: USER_MAP,
    milestones: new Map<string, Milestone>([
      [
        'm1',
        {
          id: 'm1',
          projectId: 'p1',
          name: 'Dual-write',
          description: null,
          targetDate: '2026-10-28',
          sortOrder: 1,
        },
      ],
    ]),
    projects: new Map<string, Project>([
      ['p1', { id: 'p1', name: 'Atlas' } as Project],
    ]),
  };

  function audit(entry: Partial<AuditEntry>): AuditEntry {
    return {
      workspaceId: 'org-1',
      actorUserId: 'u-ana',
      action: 'settings.update',
      subjectId: 'org-1',
      before: null,
      after: null,
      at: '2026-10-21T15:04:00.000Z',
      ...entry,
    };
  }

  test('PM edits read as "before → after"', () => {
    const rows = auditRows(
      [
        audit({
          action: 'milestone.target_date',
          subjectId: 'm1',
          before: '2026-10-28',
          after: '2026-11-04',
        }),
        audit({
          action: 'milestone.weight',
          subjectId: 'm1',
          before: null,
          after: 2,
        }),
        audit({
          action: 'project.lead',
          subjectId: 'p1',
          before: 'u-ben',
          after: null,
        }),
        audit({
          action: 'milestone.done_means',
          subjectId: 'gone',
          before: 'Old',
          after: 'New',
        }),
      ],
      snapshot,
      'UTC'
    );
    expect(rows.map((r) => [r.what, r.changes])).toEqual([
      ['Dual-write · target date', ['Oct 28, 2026 → Nov 4, 2026']],
      ['Dual-write · weight', ['none → 2']],
      ['Atlas · lead', ['Ben Carter → no lead']],
      ['A removed milestone · done means…', ['Old → New']],
    ]);
    expect(rows[0]).toMatchObject({
      who: 'Ana Moreno',
      when: 'Oct 21, 3:04 PM UTC',
    });
  });

  test('settings updates list only what changed', () => {
    const before = settings();
    const after = {
      ...before,
      allocationMode: 'live',
      pmUserIds: ['u-ana', 'u-ben'],
      tuning: {
        ...before.tuning,
        stallDays: 9,
        activeProjectStatuses: ['started'],
      },
    };
    expect(settingsChanges(before, after, USER_MAP)).toEqual([
      'Allocation: Dry run → Live',
      'PMs: Ana Moreno, Hugo Laurent → Ana Moreno, Ben Carter',
      'Stalled after: 7 → 9',
      'Active project statuses: planned, started → started',
    ]);
    expect(settingsChanges(before, before, USER_MAP)).toEqual([
      'Saved without changes',
    ]);
    expect(settingsChanges('x', null, USER_MAP)).toEqual(['Settings changed']);
  });
});
