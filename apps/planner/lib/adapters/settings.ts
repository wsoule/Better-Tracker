import {
  type AllocationMode,
  type Digest,
  type IsoDate,
  NOTICE_KIND_LABEL,
  type NoticeKind,
  type ProjectStatusType,
  type Snapshot,
  type Tuning,
  type User,
  type WarningsMode,
  type WorkspaceSettings,
} from '@better-tracker/core';
import type { Engine, WarningRunResult } from '@better-tracker/engine';
import type { ChipTone, NavTabItem } from '@better-tracker/ui';

import {
  dueLabel,
  formatDate,
  formatInstant,
  formatLongDate,
  plural,
} from '../format';

// /settings (architecture §8.4 "Settings", §7.1 validation): the section
// sub-nav, each section's rows, and the bodies its form PATCHes. Everyone
// reads; PMs edit, one form per section, each sending only that
// section's fields to PATCH /api/settings (the engine re-validates all of
// it). Also the inline digest preview (POST /api/warnings/preview) and the
// audit log's "before → after" wording. Pure functions over engine data.

export type Installation = NonNullable<
  Awaited<ReturnType<Engine['getInstallation']>>
>;
export type NotificationRecord = Awaited<
  ReturnType<Engine['listNotifications']>
>[number];
export type AuditEntry = Awaited<ReturnType<Engine['listAudit']>>[number];
export type SyncState = Awaited<ReturnType<Engine['load']>>['syncState'];

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export type SettingsSectionId =
  | 'modes'
  | 'people'
  | 'schedule'
  | 'status'
  | 'notifications'
  | 'audit';

export interface SettingsSection {
  id: SettingsSectionId;
  label: string;
  /** One sentence under the section title. */
  description: string;
}

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: 'modes',
    label: 'Modes',
    description:
      'Whether allocation writes to Linear and whether warnings are sent.',
  },
  {
    id: 'people',
    label: 'People',
    description:
      'Who may edit (PMs) and who hears about every at-risk milestone (watchers).',
  },
  {
    id: 'schedule',
    label: 'Schedule',
    description:
      'The timezone that decides what “today” is, and the thresholds behind risk and warnings.',
  },
  {
    id: 'status',
    label: 'Status',
    description:
      'The Linear installation, the last sync and webhook, and today’s digests.',
  },
  {
    id: 'notifications',
    label: 'Notifications',
    description: 'Recent warning digests: who got one, and what happened.',
  },
  {
    id: 'audit',
    label: 'Audit',
    description: 'Recent PM edits, newest first, with what changed.',
  },
];

export function settingsHref(section: SettingsSectionId): string {
  return section === 'modes' ? '/settings' : `/settings?section=${section}`;
}

/** ?section=… → a known section; anything else is Modes. */
export function parseSettingsSection(
  params: Record<string, string | string[] | undefined>
): SettingsSection {
  const raw = Array.isArray(params.section)
    ? params.section[0]
    : params.section;
  return (
    SETTINGS_SECTIONS.find((section) => section.id === raw) ??
    SETTINGS_SECTIONS[0]
  );
}

/** The vertical sub-nav, with the current section marked. */
export function sectionTabs(current: SettingsSectionId): NavTabItem[] {
  return SETTINGS_SECTIONS.map((section) => ({
    id: section.id,
    label: section.label,
    href: settingsHref(section.id),
    current: section.id === current,
  }));
}

function nameOf(users: ReadonlyMap<string, User>, id: string): string {
  return users.get(id)?.name ?? 'Someone no longer in Linear';
}

function namesOf(users: ReadonlyMap<string, User>, ids: readonly string[]) {
  return ids.length === 0
    ? 'nobody'
    : ids.map((id) => nameOf(users, id)).join(', ');
}

/** The read-only note non-PMs see at the top of every section. */
export function readOnlyNote(
  settings: Pick<WorkspaceSettings, 'pmUserIds'>,
  users: ReadonlyMap<string, User>
): string {
  const pms = settings.pmUserIds.filter((id) => users.get(id)?.active === true);
  const names = pms.map((id) => nameOf(users, id));
  const who =
    names.length <= 1
      ? (names[0] ?? 'a PM')
      : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
  return `Only PMs can change settings. Ask ${who} if something here should change.`;
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

export interface ModesState {
  allocationMode: AllocationMode;
  warningsMode: WarningsMode;
}

/** What each mode does, in the words the Modes rows use. */
export const MODE_CONSEQUENCE = {
  allocation: {
    live: 'Live: the daily run (and Run now) assigns each project’s next-milestone issues to its lead in Linear, moves them Backlog → Todo and comments why.',
    dry_run:
      'Dry run: runs record what they would assign; nothing is written to Linear.',
  },
  warnings: {
    live: 'Live: each person gets at most one Slack DM a day about milestones at risk, overdue or missing details.',
    preview:
      'Preview: digests are built and kept in the planner’s outbox; nobody is messaged.',
  },
} as const;

/** The note under the warnings switch while it would go live. */
export const WARNINGS_GO_LIVE_NOTE =
  'Going live forgets what preview runs remembered, so the first live run announces everything notable at that moment (starting the next day if today’s preview digests were already recorded).';

/** PATCH body for the Modes form: both of its fields. */
export function modesPatch(state: ModesState): ModesState {
  return {
    allocationMode: state.allocationMode,
    warningsMode: state.warningsMode,
  };
}

/** The toast after a Modes save, naming what is on now. */
export function modesSavedMessage(state: ModesState): string {
  const allocation =
    state.allocationMode === 'live'
      ? 'allocation writes to Linear'
      : 'allocation is a dry run';
  const warnings =
    state.warningsMode === 'live'
      ? 'warnings are sent'
      : 'warnings stay in preview';
  return `Saved: ${allocation} and ${warnings}.`;
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export interface PersonRow {
  id: string;
  name: string;
  email: string | null;
  active: boolean;
  /** Deactivated in Linear but still on a list. */
  note: string | null;
}

/**
 * The people register: every active person in the mirror (app users are
 * never people), plus anyone deactivated who is still a PM or watcher, so
 * a PM can see and remove them. Sorted by name.
 */
export function peopleRows(
  users: readonly User[],
  settings: Pick<WorkspaceSettings, 'pmUserIds' | 'watcherUserIds'>
): PersonRow[] {
  const listed = new Set([...settings.pmUserIds, ...settings.watcherUserIds]);
  return users
    .filter((user) => !user.app && (user.active || listed.has(user.id)))
    .map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      active: user.active,
      note: user.active ? null : 'Deactivated in Linear',
    }))
    .sort((a, b) => {
      const byName = a.name.localeCompare(b.name);
      return byName !== 0 ? byName : a.id.localeCompare(b.id);
    });
}

/**
 * PM boxes that may not be unchecked: when exactly one active person is
 * still a PM, removing them would lock everyone out of settings (the
 * engine refuses that too).
 */
export function lockedPmIds(
  pmIds: readonly string[],
  rows: readonly PersonRow[]
): Set<string> {
  const active = new Set(rows.filter((r) => r.active).map((r) => r.id));
  const activePms = pmIds.filter((id) => active.has(id));
  return new Set(activePms.length === 1 ? activePms : []);
}

/** Toggles `id` in a list, keeping the list's order (new ids at the end). */
export function toggleId(
  ids: readonly string[],
  id: string,
  on: boolean
): string[] {
  const without = ids.filter((existing) => existing !== id);
  return on ? [...without, id] : without;
}

/** True when two id lists hold the same people (order ignored). */
export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

export function peopleSavedMessage(pmCount: number, watcherCount: number) {
  return `Saved: ${plural(pmCount, 'PM')} and ${plural(watcherCount, 'watcher')}.`;
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

export type TuningNumberKey = Exclude<keyof Tuning, 'activeProjectStatuses'>;

export interface TuningField {
  key: TuningNumberKey;
  label: string;
  /** One line: what the number changes. */
  help: string;
  min: number;
  max: number;
}

/** The tuning numbers, in the order the Schedule rows show them (§7.1: 1–90 days). */
export const TUNING_FIELDS: readonly TuningField[] = [
  {
    key: 'warnLeadDays',
    label: 'Warn ahead',
    help: 'Days before a milestone’s due date that it can count as at risk and be warned about.',
    min: 1,
    max: 90,
  },
  {
    key: 'stallDays',
    label: 'Stalled after',
    help: 'Days with no state change among a milestone’s issues before it counts as stalled.',
    min: 1,
    max: 90,
  },
  {
    key: 'paceWindowDays',
    label: 'Pace window',
    help: 'Days of runway the share of open work is compared with (“more work left than time left”).',
    min: 1,
    max: 90,
  },
  {
    key: 'overdueRepeatDays',
    label: 'Repeat overdue every',
    help: 'Days between repeated warnings while a milestone stays overdue.',
    min: 1,
    max: 90,
  },
  {
    key: 'newBadgeDays',
    label: 'New mark lasts',
    help: 'Days an auto-assigned issue keeps its “new” mark in My week.',
    min: 1,
    max: 90,
  },
  {
    key: 'timelineDaysBack',
    label: 'Timeline looks back',
    help: 'Days before today the timeline starts.',
    min: 1,
    max: 90,
  },
  {
    key: 'timelineDaysAhead',
    label: 'Timeline looks ahead',
    help: 'Days after today the timeline ends.',
    min: 1,
    max: 90,
  },
];

/** Linear's project status categories, as the Schedule checkboxes name them. */
export const PROJECT_STATUS_OPTIONS: readonly {
  id: ProjectStatusType;
  label: string;
}[] = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'planned', label: 'Planned' },
  { id: 'started', label: 'In progress' },
  { id: 'paused', label: 'Paused' },
  { id: 'completed', label: 'Completed' },
  { id: 'canceled', label: 'Canceled' },
];

export interface ScheduleForm {
  timezone: string;
  /** The number inputs as typed. */
  values: Record<TuningNumberKey, string>;
  statuses: ProjectStatusType[];
}

export interface SchedulePatch {
  timezone: string;
  tuning: Partial<Tuning>;
}

export function scheduleForm(settings: WorkspaceSettings): ScheduleForm {
  const values = {} as Record<TuningNumberKey, string>;
  for (const field of TUNING_FIELDS) {
    values[field.key] = String(settings.tuning[field.key]);
  }
  return {
    timezone: settings.timezone,
    values,
    statuses: [...settings.tuning.activeProjectStatuses],
  };
}

/**
 * Checks the Schedule form before sending: whole numbers in range, a
 * timezone, at least one project status. The engine validates again (the
 * timezone against the IANA database); this only spares a round trip.
 */
export function parseScheduleForm(
  form: ScheduleForm
):
  | { ok: true; patch: SchedulePatch }
  | { ok: false; errors: Partial<Record<string, string>> } {
  const errors: Partial<Record<string, string>> = {};
  const timezone = form.timezone.trim();
  if (timezone === '') errors.timezone = 'Enter an IANA timezone.';
  const tuning: Partial<Tuning> = {};
  for (const field of TUNING_FIELDS) {
    const raw = form.values[field.key].trim();
    const value = Number(raw);
    if (
      !/^\d+$/.test(raw) ||
      !Number.isInteger(value) ||
      value < field.min ||
      value > field.max
    ) {
      errors[field.key] =
        `Whole number of days from ${field.min} to ${field.max}.`;
    } else {
      tuning[field.key] = value;
    }
  }
  if (form.statuses.length === 0) {
    errors.statuses = 'Pick at least one project status.';
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  tuning.activeProjectStatuses = PROJECT_STATUS_OPTIONS.map((o) => o.id).filter(
    (id) => form.statuses.includes(id)
  );
  return { ok: true, patch: { timezone, tuning } };
}

/**
 * The toast after a Schedule save, naming what changed in the rows' own
 * words: "Saved: timezone America/Chicago, warn ahead 6 days."
 */
export function scheduleSavedMessage(
  before: ScheduleForm,
  patch: SchedulePatch
): string {
  const parts: string[] = [];
  if (patch.timezone !== before.timezone.trim()) {
    parts.push(`timezone ${patch.timezone}`);
  }
  for (const field of TUNING_FIELDS) {
    const value = patch.tuning[field.key];
    if (value !== undefined && String(value) !== before.values[field.key]) {
      parts.push(`${field.label.toLowerCase()} ${plural(value, 'day')}`);
    }
  }
  const statuses = patch.tuning.activeProjectStatuses;
  if (statuses !== undefined && !sameIds(statuses, before.statuses)) {
    parts.push('active project statuses');
  }
  return parts.length === 0
    ? 'Saved the schedule.'
    : `Saved: ${parts.join(', ')}.`;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface StatusRow {
  id: string;
  label: string;
  value: string;
  /** Mono line under the value. */
  sub?: string;
  tone: 'default' | 'muted' | 'accent';
}

export function statusRows(input: {
  installation: Installation | null;
  syncState: SyncState;
  users: ReadonlyMap<string, User>;
  timeZone: string;
  demo: boolean;
}): StatusRow[] {
  const { installation, syncState, users, timeZone } = input;
  const rows: StatusRow[] = [];
  if (input.demo) {
    rows.push({
      id: 'source',
      label: 'Data source',
      value: 'Demo workspace',
      sub: 'LINEAR_FIXTURE=1 · nothing reaches Linear',
      tone: 'muted',
    });
  }
  if (installation === null) {
    rows.push({
      id: 'installation',
      label: 'Installation',
      value: 'Not installed',
      sub: 'A Linear admin installs the app from Setup',
      tone: 'accent',
    });
  } else {
    rows.push(
      {
        id: 'workspace',
        label: 'Workspace',
        value: installation.workspaceName,
        sub: `linear.app/${installation.urlKey}`,
        tone: 'default',
      },
      {
        id: 'installed',
        label: 'Installed by',
        value: nameOf(users, installation.installedByUserId),
        sub: formatInstant(installation.createdAt, timeZone),
        tone: 'default',
      },
      installation.revokedAt === null
        ? {
            id: 'access',
            label: 'Linear access',
            value: 'Working',
            sub: 'The app can read and write as itself',
            tone: 'default',
          }
        : {
            id: 'access',
            label: 'Linear access',
            value: 'Revoked: reinstall from Setup',
            sub: `Since ${formatInstant(installation.revokedAt, timeZone)}`,
            tone: 'accent',
          }
    );
  }
  if (syncState === null || syncState.lastFullSyncAt === null) {
    rows.push({
      id: 'sync',
      label: 'Last full sync',
      value: 'Never',
      sub: 'Runs every 15 minutes from the worker, or Resync now',
      tone: 'accent',
    });
  } else {
    const failed = syncState.lastFullSyncStatus === 'failed';
    rows.push({
      id: 'sync',
      label: 'Last full sync',
      value: `${formatInstant(syncState.lastFullSyncAt, timeZone)} · ${failed ? 'failed' : 'ok'}`,
      sub: failed
        ? (syncState.lastFullSyncError ?? 'No error was recorded')
        : undefined,
      tone: failed ? 'accent' : 'default',
    });
  }
  rows.push({
    id: 'webhook',
    label: 'Last webhook',
    value:
      syncState?.lastWebhookAt == null
        ? 'None received yet'
        : formatInstant(syncState.lastWebhookAt, timeZone),
    sub: input.demo ? 'Demo mode ignores webhooks' : undefined,
    tone: syncState?.lastWebhookAt == null ? 'muted' : 'default',
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Digest preview (POST /api/warnings/preview)
// ---------------------------------------------------------------------------

export interface DigestItemPreview {
  id: string;
  kind: NoticeKind;
  kindLabel: string;
  /** "Atlas billing migration › Dual-write". */
  title: string;
  /** "Oct 18 · 3 days overdue", or null for a project notice. */
  due: string | null;
  lines: string[];
  href: string;
  tone: 'default' | 'accent';
}

export interface DigestPreview {
  recipientId: string;
  recipient: string;
  email: string | null;
  items: DigestItemPreview[];
}

export interface DigestPreviewModel {
  day: IsoDate;
  heading: string;
  summary: string;
  digests: DigestPreview[];
}

/**
 * The accent marks what needs action (§8.2: overdue, blocked, missing
 * input): an overdue milestone, one due soon without what the rubric
 * needs, a project whose allocation stopped. At risk stays ink: it is a
 * warning, not yet a missed date or a missing input.
 */
export function noticeTone(kind: NoticeKind): 'default' | 'accent' {
  return kind === 'at_risk' ? 'default' : 'accent';
}

function previewItem(
  digest: Digest,
  index: number,
  today: IsoDate
): DigestItemPreview[] {
  return digest.items.map((item, i) => {
    const notice = item.notice;
    const title =
      item.milestoneName === null
        ? item.projectName
        : `${item.projectName} › ${item.milestoneName}`;
    const href =
      notice.milestoneId !== null
        ? `/timeline?milestone=${encodeURIComponent(notice.milestoneId)}`
        : `/timeline?project=${encodeURIComponent(notice.projectId)}`;
    return {
      id: `${index}:${i}:${notice.key}`,
      kind: notice.kind,
      kindLabel: NOTICE_KIND_LABEL[notice.kind],
      title,
      due:
        notice.subjectKind === 'project'
          ? null
          : dueLabel(notice.targetDate, notice.daysLeft, today),
      lines: item.lines,
      href,
      tone: noticeTone(notice.kind),
    };
  });
}

/** Today's digests as the Status section shows them inline. */
export function digestPreview(
  result: Pick<WarningRunResult, 'day' | 'mode' | 'digests'>
): DigestPreviewModel {
  const digests = result.digests.map((digest, index): DigestPreview => ({
    recipientId: digest.recipientId,
    recipient: digest.recipientName,
    email: digest.recipientEmail,
    items: previewItem(digest, index, result.day),
  }));
  const items = digests.reduce((sum, d) => sum + d.items.length, 0);
  const delivery =
    result.mode === 'live'
      ? 'Warnings are live, so the daily run sends these as Slack DMs.'
      : 'Warnings are in preview, so the daily run only records them.';
  return {
    day: result.day,
    heading: `Digests for ${formatLongDate(result.day)}`,
    summary:
      digests.length === 0
        ? `Nobody would get a digest today: no milestone changed status since it was last announced. ${delivery} Nothing was recorded by this preview.`
        : `${plural(digests.length, 'person', 'people')} would get a digest today, ${plural(items, 'item')} in all. ${delivery} Nothing was recorded or sent by this preview.`,
    digests,
  };
}

/** Shape check for the preview route's answer before the client renders it. */
export function isDigestPreviewModel(
  value: unknown
): value is DigestPreviewModel {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.day === 'string' &&
    typeof v.heading === 'string' &&
    typeof v.summary === 'string' &&
    Array.isArray(v.digests)
  );
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

const NOTIFICATION_STATUS: Record<
  NotificationRecord['status'],
  { label: string; tone: ChipTone }
> = {
  sent: { label: 'Sent', tone: 'inverse' },
  preview: { label: 'Preview', tone: 'muted' },
  pending: { label: 'Sending', tone: 'muted' },
  failed: { label: 'Failed', tone: 'accent' },
  undeliverable: { label: 'Undeliverable', tone: 'accent' },
};

export interface NotificationRow {
  id: string;
  day: string;
  recipient: string;
  channel: string;
  statusLabel: string;
  statusTone: ChipTone;
  items: string;
  error: string | null;
  rowTone: 'default' | 'accent';
}

export function notificationRows(
  records: readonly NotificationRecord[],
  users: ReadonlyMap<string, User>
): NotificationRow[] {
  return records.map((record) => {
    const status = NOTIFICATION_STATUS[record.status];
    const failed =
      record.status === 'failed' || record.status === 'undeliverable';
    return {
      id: record.id,
      day: formatDate(record.day),
      recipient:
        users.get(record.recipientId)?.name ?? record.digest.recipientName,
      channel: record.channel === 'slack' ? 'Slack DM' : 'Outbox',
      statusLabel: status.label,
      statusTone: status.tone,
      items: plural(record.digest.items.length, 'item'),
      error: record.error,
      rowTone: failed ? 'accent' : 'default',
    };
  });
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface AuditRow {
  id: string;
  who: string;
  /** "Settings", "Dual-write · target date". */
  what: string;
  /** One "before → after" line per changed field. */
  changes: string[];
  when: string;
}

const MODE_WORD: Record<string, string> = {
  dry_run: 'Dry run',
  live: 'Live',
  preview: 'Preview',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function plainValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'none';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

const TUNING_LABEL: Record<string, string> = {
  ...Object.fromEntries(TUNING_FIELDS.map((f) => [f.key, f.label])),
  activeProjectStatuses: 'Active project statuses',
};

/**
 * The changed fields of a settings.update audit entry (whole settings
 * before and after), one plain line each: "Allocation: Dry run → Live",
 * "PMs: Ana Moreno, Ben Carter → Ana Moreno".
 */
export function settingsChanges(
  before: unknown,
  after: unknown,
  users: ReadonlyMap<string, User>
): string[] {
  if (!isRecord(before) || !isRecord(after)) return ['Settings changed'];
  const lines: string[] = [];
  const mode = (key: string, label: string) => {
    if (before[key] !== after[key]) {
      lines.push(
        `${label}: ${MODE_WORD[String(before[key])] ?? plainValue(before[key])} → ${MODE_WORD[String(after[key])] ?? plainValue(after[key])}`
      );
    }
  };
  mode('allocationMode', 'Allocation');
  mode('warningsMode', 'Warnings');
  if (before.timezone !== after.timezone) {
    lines.push(
      `Timezone: ${plainValue(before.timezone)} → ${plainValue(after.timezone)}`
    );
  }
  for (const [key, label] of [
    ['pmUserIds', 'PMs'],
    ['watcherUserIds', 'Watchers'],
  ] as const) {
    const a = stringList(before[key]);
    const b = stringList(after[key]);
    if (!sameIds(a, b)) {
      lines.push(`${label}: ${namesOf(users, a)} → ${namesOf(users, b)}`);
    }
  }
  const tb = isRecord(before.tuning) ? before.tuning : {};
  const ta = isRecord(after.tuning) ? after.tuning : {};
  for (const key of Object.keys(TUNING_LABEL)) {
    const x = tb[key];
    const y = ta[key];
    const changed = Array.isArray(x)
      ? !sameIds(stringList(x), stringList(y))
      : x !== y;
    if (changed) {
      const show = (v: unknown) => {
        if (!Array.isArray(v)) return plainValue(v);
        const list = stringList(v);
        return list.length === 0 ? 'none' : list.join(', ');
      };
      lines.push(`${TUNING_LABEL[key]}: ${show(x)} → ${show(y)}`);
    }
  }
  return lines.length === 0 ? ['Saved without changes'] : lines;
}

function dateValue(value: unknown): string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? formatDate(value)
    : 'none';
}

export function auditRows(
  entries: readonly AuditEntry[],
  snapshot: Pick<Snapshot, 'users' | 'milestones' | 'projects'>,
  timeZone: string
): AuditRow[] {
  return entries.map((entry, index) => {
    const who = nameOf(snapshot.users, entry.actorUserId);
    const milestone =
      snapshot.milestones.get(entry.subjectId)?.name ?? 'A removed milestone';
    const project =
      snapshot.projects.get(entry.subjectId)?.name ?? 'A removed project';
    let what: string;
    let changes: string[];
    switch (entry.action) {
      case 'milestone.target_date':
        what = `${milestone} · target date`;
        changes = [`${dateValue(entry.before)} → ${dateValue(entry.after)}`];
        break;
      case 'milestone.weight':
        what = `${milestone} · weight`;
        changes = [`${plainValue(entry.before)} → ${plainValue(entry.after)}`];
        break;
      case 'milestone.done_means':
        what = `${milestone} · done means…`;
        changes = [`${plainValue(entry.before)} → ${plainValue(entry.after)}`];
        break;
      case 'project.lead': {
        const lead = (v: unknown) =>
          typeof v === 'string' ? nameOf(snapshot.users, v) : 'no lead';
        what = `${project} · lead`;
        changes = [`${lead(entry.before)} → ${lead(entry.after)}`];
        break;
      }
      default:
        what = 'Settings';
        changes = settingsChanges(entry.before, entry.after, snapshot.users);
    }
    return {
      id: `${entry.at}:${index}`,
      who,
      what,
      changes,
      when: formatInstant(entry.at, timeZone),
    };
  });
}
