import {
  defaultSettings,
  type Issue,
  type Milestone,
  type Project,
  type User,
  type WorkflowState,
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
  modesSavedMessage,
  noticeTone,
  type NotificationRecord,
  notificationRows,
  parseScheduleForm,
  parseSettingsSection,
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
  watcherRows,
  watchersHint,
  watchersSavedMessage,
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
    watcherUserIds: ['u-ana', 'u-hugo'],
    ...overrides,
  };
}

describe('sections', () => {
  test('unknown or missing ?section= is Modes', () => {
    expect(parseSettingsSection({}).id).toBe('modes');
    expect(parseSettingsSection({ section: 'nope' }).id).toBe('modes');
    expect(parseSettingsSection({ section: ['audit', 'x'] }).id).toBe('audit');
  });

  test('People became Watchers; old ?section=people links still open it', () => {
    expect(parseSettingsSection({ section: 'watchers' }).id).toBe('watchers');
    expect(parseSettingsSection({ section: 'people' }).id).toBe('watchers');
    expect(settingsHref('watchers')).toBe('/settings?section=watchers');
  });

  // Owner decision 2026-10-22: no PM role. No section describes a role or
  // a read-only mode; every one is editable by everyone signed in.
  test('no section copy names a PM role', () => {
    for (const tab of sectionTabs('modes')) {
      const section = parseSettingsSection({ section: tab.id });
      expect(`${section.label} ${section.description}`).not.toMatch(
        /\bPMs?\b|read only/i
      );
    }
  });

  test('tabs mark the current section; Modes lives at /settings', () => {
    const tabs = sectionTabs('watchers');
    expect(tabs.map((t) => t.label)).toEqual([
      'Modes',
      'Watchers',
      'Schedule',
      'Status',
      'Notifications',
      'Audit',
    ]);
    expect(tabs.filter((t) => t.current === true).map((t) => t.id)).toEqual([
      'watchers',
    ]);
    expect(settingsHref('modes')).toBe('/settings');
    expect(settingsHref('audit')).toBe('/settings?section=audit');
  });

  test('modes toast names both modes', () => {
    expect(
      modesSavedMessage({ allocationMode: 'live', warningsMode: 'preview' })
    ).toBe('Saved: allocation writes to Linear and warnings stay in preview.');
  });
});

describe('watchers', () => {
  test('active people plus deactivated watchers, never apps, by name', () => {
    const rows = watcherRows(USERS, settings());
    expect(rows.map((r) => r.name)).toEqual([
      'Ana Moreno',
      'Ben Carter',
      'Hugo Laurent',
    ]);
    expect(rows.find((r) => r.id === 'u-hugo')?.note).toBe(
      'Deactivated in Linear'
    );
  });

  test('the list may be empty: then only leads are warned', () => {
    // No locked box and no "last one" rule: every row can be unchecked.
    const rows = watcherRows(USERS, settings({ watcherUserIds: [] }));
    expect(rows.map((r) => r.name)).toEqual(['Ana Moreno', 'Ben Carter']);
    expect(watchersSavedMessage(0)).toBe(
      'Saved: no watchers. Only each project’s lead is warned now.'
    );
    expect(watchersSavedMessage(2)).toBe('Saved: 2 watchers.');
    expect(watchersHint(0)).toBe(
      'No watchers: only each project’s lead hears about its milestones at risk.'
    );
    expect(watchersHint(1)).toBe(
      '1 watcher hears about every milestone at risk, besides each project’s lead.'
    );
    expect(watchersHint(3)).toBe(
      '3 watchers hear about every milestone at risk, besides each project’s lead.'
    );
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
        message: 'watcherUserIds names someone not in the mirror: u-x.',
      })
    ).toBeNull();
    expect(
      scheduleFieldError({
        code: 'not_signed_in',
        message: 'timezone is yours',
      })
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
    // Working is green, a failed sync red, no webhook yet grey
    // (architecture §8.2 "settings status").
    expect(byId.get('access')).toMatchObject({
      value: 'Working',
      tone: 'success',
    });
    expect(byId.get('sync')).toMatchObject({
      value: 'Oct 21, 2:00 PM UTC · failed',
      sub: 'Linear answered 503',
      tone: 'danger',
    });
    expect(byId.get('webhook')).toMatchObject({
      value: 'None received yet',
      tone: 'muted',
    });
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
    expect(byId.get('source')).toMatchObject({
      value: 'Demo workspace',
      tone: 'muted',
    });
    // Revoked is red; never synced is a warning.
    expect(byId.get('access')).toMatchObject({
      value: 'Revoked: reinstall from Setup',
      tone: 'danger',
    });
    expect(byId.get('sync')).toMatchObject({ value: 'Never', tone: 'warning' });
    // Not installed is a warning too.
    const none = statusRows({
      installation: null,
      syncState: null,
      users: USER_MAP,
      timeZone: 'UTC',
      demo: false,
    });
    expect(none.find((r) => r.id === 'installation')).toMatchObject({
      value: 'Not installed',
      tone: 'warning',
    });
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
      tone: 'warning',
      chipFilled: true,
      rowTone: 'warning',
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

  test('overdue is danger; at risk, invalid due soon and stopped are warnings', () => {
    expect(noticeTone('overdue')).toBe('danger');
    expect(noticeTone('invalid_due_soon')).toBe('warning');
    expect(noticeTone('allocation_blocked')).toBe('warning');
    expect(noticeTone('at_risk')).toBe('warning');
  });

  test('at risk keeps its row plain; overdue rules its row in red', () => {
    const notice = {
      kind: 'overdue' as const,
      subjectKind: 'milestone' as const,
      subjectId: 'm1',
      projectId: 'p1',
      milestoneId: 'm1',
      key: 'overdue:m1',
      targetDate: '2026-10-18',
      daysLeft: -3,
      reasons: [],
      gaps: [],
      blockReason: null,
      openIssueIds: ['i1'],
      unassignedIssueIds: [],
      recipientIds: ['u-ana'],
      occurrence: 1,
    };
    const item = {
      projectName: 'Atlas',
      milestoneName: 'Dual-write',
      leadName: 'Ana Moreno',
      openCount: 1,
      unassignedCount: 0,
      lines: [],
      url: 'https://planner.example/timeline?milestone=m1',
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
            { ...item, notice },
            {
              ...item,
              notice: {
                ...notice,
                kind: 'at_risk' as const,
                key: 'at_risk:m1',
                targetDate: '2026-10-24',
                daysLeft: 3,
              },
            },
          ],
        },
      ],
    });
    expect(
      model.digests[0]?.items.map((i) => [i.kindLabel, i.tone, i.rowTone])
    ).toEqual([
      ['Overdue', 'danger', 'danger'],
      ['At risk', 'warning', 'default'],
    ]);
    // The chips keep their shapes: overdue the filled chip (a red slab),
    // at risk the outline (now amber).
    expect(model.digests[0]?.items.map((i) => i.chipFilled)).toEqual([
      true,
      false,
    ]);
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
      ['Sent', 'success', 'Slack DM'],
      ['Preview', 'muted', 'Outbox'],
      ['Undeliverable', 'danger', 'Slack DM'],
    ]);
    // Sent and undeliverable keep their filled chips (green and red
    // slabs); a preview stays the outline.
    expect(rows.map((r) => r.statusFilled)).toEqual([true, false, true]);
    expect(rows[0]).toMatchObject({
      recipient: 'Ben Carter',
      day: 'Oct 21, 2026',
      items: '0 items',
    });
    expect(rows.map((r) => r.rowTone)).toEqual([
      'default',
      'default',
      'danger',
    ]);
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

  test('milestone and lead edits read as "before → after"', () => {
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

  test('issue edits name the issue and read as "before → after"', () => {
    const withIssues = {
      ...snapshot,
      issues: new Map([['i1', { id: 'i1', identifier: 'ENG-24' } as Issue]]),
      states: new Map([
        ['s-todo', { id: 's-todo', name: 'Todo' } as WorkflowState],
        ['s-doing', { id: 's-doing', name: 'In Progress' } as WorkflowState],
      ]),
    };
    const rows = auditRows(
      [
        audit({
          action: 'issue.state',
          subjectId: 'i1',
          before: 's-todo',
          after: 's-doing',
        }),
        audit({
          action: 'issue.assignee',
          subjectId: 'i1',
          before: null,
          after: 'u-ben',
        }),
        audit({
          action: 'issue.priority',
          subjectId: 'i1',
          before: 3,
          after: 1,
        }),
        audit({
          action: 'issue.milestone',
          subjectId: 'i1',
          before: 'm1',
          after: null,
        }),
        audit({
          action: 'issue.labels',
          subjectId: 'i1',
          before: [],
          after: [
            { id: 'l1', name: 'Bug' },
            { id: 'l2', name: 'Search' },
          ],
        }),
        audit({
          action: 'issue.description',
          subjectId: 'i1',
          before: null,
          after: { length: 120 },
        }),
        audit({
          action: 'issue.comment',
          subjectId: 'i1',
          before: null,
          after: { commentId: 'c1', length: 5 },
        }),
        // An entry from before texts were logged as their length only:
        // its excerpt is never shown (Settings → Audit is open to every
        // signed-in person, the text only to those Linear lets read it).
        audit({
          action: 'issue.comment',
          subjectId: 'i1',
          before: null,
          after: { commentId: 'c0', length: 1, excerpt: 'Y' },
        }),
        audit({
          action: 'issue.blocker_added',
          subjectId: 'i1',
          before: null,
          after: { blockerIdentifier: 'ENG-23', blockedIdentifier: 'ENG-24' },
        }),
        audit({
          action: 'issue.relation_removed',
          subjectId: 'gone',
          before: { blockerIdentifier: 'ENG-12', blockedIdentifier: 'ENG-30' },
          after: null,
        }),
        audit({
          action: 'issue.due_date',
          subjectId: 'gone',
          before: '2026-10-30',
          after: null,
        }),
      ],
      withIssues,
      'UTC'
    );
    expect(rows.map((r) => [r.what, r.changes])).toEqual([
      ['ENG-24 · status', ['Todo → In Progress']],
      ['ENG-24 · assignee', ['unassigned → Ben Carter']],
      ['ENG-24 · priority', ['Medium → Urgent']],
      ['ENG-24 · milestone', ['Dual-write → no milestone']],
      ['ENG-24 · labels', ['none → Bug, Search']],
      ['ENG-24 · description', ['none → 120 characters']],
      ['ENG-24 · comment', ['Added a comment (5 characters)']],
      ['ENG-24 · comment', ['Added a comment (1 character)']],
      ['ENG-24 · blocked by', ['Added ENG-23']],
      ['ENG-30 · blocked by', ['Removed ENG-12']],
      ['A removed issue · due date', ['Oct 30, 2026 → none']],
    ]);
  });

  test('settings updates list only what changed', () => {
    const before = settings();
    const after = {
      ...before,
      allocationMode: 'live',
      watcherUserIds: [],
      tuning: {
        ...before.tuning,
        stallDays: 9,
        activeProjectStatuses: ['started'],
      },
    };
    expect(settingsChanges(before, after, USER_MAP)).toEqual([
      'Allocation: Dry run → Live',
      'Watchers: Ana Moreno, Hugo Laurent → nobody',
      'Stalled after: 7 → 9',
      'Active project statuses: planned, started → started',
    ]);
    expect(settingsChanges(before, before, USER_MAP)).toEqual([
      'Saved without changes',
    ]);
    expect(settingsChanges('x', null, USER_MAP)).toEqual(['Settings changed']);
  });

  test('entries saved before the PM list was retired keep reading as saved', () => {
    // Audit entries are kept as written (owner decision 2026-10-22).
    const before = { ...settings(), pmUserIds: ['u-ana', 'u-hugo'] };
    const after = { ...before, pmUserIds: ['u-ana', 'u-ben'] };
    expect(settingsChanges(before, after, USER_MAP)).toEqual([
      'PM list (retired): Ana Moreno, Hugo Laurent → Ana Moreno, Ben Carter',
    ]);
    // The first save after the decision drops the field: that is not
    // everyone being removed from a list, so it is not reported.
    const { pmUserIds: _dropped, ...withoutList } = before;
    expect(settingsChanges(before, withoutList, USER_MAP)).toEqual([
      'Saved without changes',
    ]);
  });
});
