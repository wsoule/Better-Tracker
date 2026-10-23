import {
  type AllocationMode,
  type Digest,
  type IsoDate,
  NOTICE_KIND_LABEL,
  type NoticeKind,
  type Priority,
  PRIORITY_LABEL,
  type ProjectStatusType,
  type Snapshot,
  type Tuning,
  type User,
  type WarningsMode,
  type WorkspaceSettings,
} from '@better-tracker/core';
import type { Engine, WarningRunResult } from '@better-tracker/engine';
import type { ChipTone, NavTabItem, UiTone } from '@better-tracker/ui';

import {
  dueLabel,
  formatDate,
  formatInstant,
  formatLongDate,
  plural,
} from '../format';
import { dueTone } from './projects';

// /settings (architecture §8.4 "Settings", §7.1 validation): the section
// sub-nav, each section's rows, and the bodies its form PATCHes. Everyone
// signed in reads and edits every section (owner decision 2026-10-22: no
// roles), one form per section, each sending only that section's fields
// to PATCH /api/settings (the engine re-validates all of it and audits
// the save). Also the inline digest preview (POST /api/warnings/preview) and the
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
  | 'watchers'
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
    id: 'watchers',
    label: 'Watchers',
    description:
      'Who hears about every at-risk milestone besides its project’s lead; anyone signed in but a Linear guest can change the list, and it may be empty.',
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
    description:
      'Recent edits made in the planner, newest first: who changed which milestone, lead, issue or setting, and how.',
  },
];

export function settingsHref(section: SettingsSectionId): string {
  return section === 'modes' ? '/settings' : `/settings?section=${section}`;
}

/** Old section ids that still open their successor (bookmarks, links). */
const SECTION_ALIASES: Readonly<Record<string, SettingsSectionId>> = {
  // People (PMs and watchers) became Watchers on 2026-10-22.
  people: 'watchers',
};

/** ?section=… → a known section (or its alias); anything else is Modes. */
export function parseSettingsSection(
  params: Record<string, string | string[] | undefined>
): SettingsSection {
  const raw = Array.isArray(params.section)
    ? params.section[0]
    : params.section;
  const id = (raw === undefined ? undefined : SECTION_ALIASES[raw]) ?? raw;
  return (
    SETTINGS_SECTIONS.find((section) => section.id === id) ??
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
// Watchers
// ---------------------------------------------------------------------------

export interface PersonRow {
  id: string;
  name: string;
  email: string | null;
  active: boolean;
  /** Deactivated in Linear but still a watcher. */
  note: string | null;
}

/**
 * The Watchers register: every active person in the mirror (app users are
 * never people), plus anyone deactivated who is still a watcher, so they
 * can be seen and removed. Sorted by name.
 */
export function watcherRows(
  users: readonly User[],
  settings: Pick<WorkspaceSettings, 'watcherUserIds'>
): PersonRow[] {
  const listed = new Set(settings.watcherUserIds);
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

/** The toast after a Watchers save; an empty list says who is warned then. */
export function watchersSavedMessage(watcherCount: number) {
  return watcherCount === 0
    ? 'Saved: no watchers. Only each project’s lead is warned now.'
    : `Saved: ${plural(watcherCount, 'watcher')}.`;
}

/** The line under the Watchers register, for the list as it stands. */
export function watchersHint(watcherCount: number): string {
  return watcherCount === 0
    ? 'No watchers: only each project’s lead hears about its milestones at risk.'
    : `${plural(watcherCount, 'watcher')} ${watcherCount === 1 ? 'hears' : 'hear'} about every milestone at risk, besides each project’s lead.`;
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

// ---------------------------------------------------------------------------
// Read only (owner decision 2026-10-22, "Guests limited to read only")
// ---------------------------------------------------------------------------

/** One setting as plain text, for a Linear guest's read-only sections. */
export interface ReadOnlySettingRow {
  id: string;
  label: string;
  value: string;
  /** What the setting does (the editable row's help line). */
  sub: string;
}

/** Settings → Modes for a Linear guest: each mode and what it does now. */
export function modesReadOnlyRows(
  settings: Pick<WorkspaceSettings, 'allocationMode' | 'warningsMode'>
): ReadOnlySettingRow[] {
  return [
    {
      id: 'allocation',
      label: 'Allocation',
      value: settings.allocationMode === 'live' ? 'Live' : 'Dry run',
      sub: MODE_CONSEQUENCE.allocation[settings.allocationMode],
    },
    {
      id: 'warnings',
      label: 'Warnings',
      value: settings.warningsMode === 'live' ? 'Live' : 'Preview',
      sub: MODE_CONSEQUENCE.warnings[settings.warningsMode],
    },
  ];
}

/**
 * Settings → Schedule for a Linear guest: the timezone, each tuning number
 * in days and the active project statuses, with the editable rows' help.
 */
export function scheduleReadOnlyRows(
  settings: Pick<WorkspaceSettings, 'timezone' | 'tuning'>
): ReadOnlySettingRow[] {
  const statuses = PROJECT_STATUS_OPTIONS.filter((option) =>
    settings.tuning.activeProjectStatuses.includes(option.id)
  ).map((option) => option.label);
  return [
    {
      id: 'timezone',
      label: 'Timezone',
      value: settings.timezone,
      sub: 'Decides what “today” is for due dates, the daily run and digests.',
    },
    ...TUNING_FIELDS.map((field) => ({
      id: field.key,
      label: field.label,
      value: plural(settings.tuning[field.key], 'day'),
      sub: field.help,
    })),
    {
      id: 'statuses',
      label: 'Active project statuses',
      value: statuses.length === 0 ? 'None' : statuses.join(', '),
      sub: 'Projects in these Linear statuses get allocation and warnings; the rest are shown but left alone.',
    },
  ];
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

// ---------------------------------------------------------------------------
// Saving a section
// ---------------------------------------------------------------------------

/** How the last save of a section went, for the form's status line; a
 * `reset` once Reset has put the saved values back. */
export interface SaveOutcome {
  kind: 'saved' | 'error' | 'reset';
  text: string;
}

/** The status line after Reset: nothing was saved, the edits are gone. */
export const RESET_OUTCOME: SaveOutcome = {
  kind: 'reset',
  text: 'Changes discarded',
};

/**
 * The words on a section form's status line (beside Save and Reset): what
 * is happening, else what needs fixing, else whether anything is unsaved
 * (a failed save says why while its changes are still unsaved), else how
 * the last save or reset went. The line takes focus after a save or a
 * reset, so this is what a screen reader hears then; a reset after a save
 * must not read "Saved".
 */
export function formStatusText(input: {
  dirty: boolean;
  saving: boolean;
  blocked: string | null;
  outcome: SaveOutcome | null;
}): string {
  const { dirty, saving, blocked, outcome } = input;
  if (saving) return 'Saving…';
  if (blocked !== null && blocked !== '') return blocked;
  if (dirty) {
    return outcome?.kind === 'error' ? outcome.text : 'Unsaved changes';
  }
  return outcome === null || outcome.kind === 'error'
    ? 'No changes'
    : outcome.text;
}

/** "timezone must be…" → "Timezone must be…": a sentence for the UI. */
export function sentenceCase(text: string): string {
  const trimmed = text.trim();
  return trimmed === ''
    ? trimmed
    : `${trimmed[0]?.toUpperCase() ?? ''}${trimmed.slice(1)}`;
}

/**
 * Which Schedule field a refused save belongs to, so the form can show it
 * beside that field instead of in a toast. Only the timezone is checked
 * on the server alone (the IANA database), so it is the one refusal the
 * form cannot catch first: the engine's "timezone must be an IANA
 * timezone…" or the route's "timezone: …" (code `invalid`). Anything else
 * is null and stays a toast.
 */
export function scheduleFieldError(error: {
  code: string;
  message: string;
}): { field: 'timezone'; message: string } | null {
  if (error.code !== 'invalid') return null;
  if (!/^timezone\b/i.test(error.message.trim())) return null;
  return { field: 'timezone', message: sentenceCase(error.message) };
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

/**
 * One Status row. `tone` colours the value (architecture §8.2 "settings
 * status"): success = working access or a sync that went through,
 * warning = not installed or never synced, danger = revoked or a failed
 * sync, muted = demo data or no webhook yet. The mono line under it stays
 * muted, except a failed sync's error (`toneDetail`).
 */
export interface StatusRow {
  id: string;
  label: string;
  value: string;
  /** Mono line under the value. */
  sub?: string;
  tone: UiTone;
  /** The `sub` line takes the tone too (RegisterCell `toneSub`): set for
      a failed sync, whose error is why the row is red, as a failed
      digest's error is red text and a BLOCKED project's reason amber.
      A date or a hint ("Since …") stays muted. */
  toneDetail?: true;
}

export function statusRows(input: {
  installation: Installation | null;
  syncState: SyncState;
  users: ReadonlyMap<string, User>;
  timeZone: string;
  demo: boolean;
  /** Which demo workspace LINEAR_FIXTURE chose (the base one if unset). */
  demoWorkspace?: 'base' | 'showcase' | null;
}): StatusRow[] {
  const { installation, syncState, users, timeZone } = input;
  const rows: StatusRow[] = [];
  if (input.demo) {
    const showcase = input.demoWorkspace === 'showcase';
    rows.push({
      id: 'source',
      label: 'Data source',
      value: showcase ? 'Showcase demo workspace' : 'Demo workspace',
      sub: `LINEAR_FIXTURE=${showcase ? 'showcase' : '1'} · nothing reaches Linear`,
      tone: 'muted',
    });
  }
  if (installation === null) {
    rows.push({
      id: 'installation',
      label: 'Installation',
      value: 'Not installed',
      sub: 'A Linear admin installs the app from Setup',
      tone: 'warning',
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
            tone: 'success',
          }
        : {
            id: 'access',
            label: 'Linear access',
            value: 'Revoked: reinstall from Setup',
            sub: `Since ${formatInstant(installation.revokedAt, timeZone)}`,
            tone: 'danger',
          }
    );
  }
  if (syncState === null || syncState.lastFullSyncAt === null) {
    rows.push({
      id: 'sync',
      label: 'Last full sync',
      value: 'Never',
      sub: 'Runs every 15 minutes from the worker, or Resync now',
      tone: 'warning',
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
      // A sync that went through is working, like Linear access above.
      tone: failed ? 'danger' : 'success',
      ...(failed ? { toneDetail: true as const } : {}),
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
  /** "Atlas billing migration › Dual-write"; just the project for a
   * project notice (allocation stopped), whose milestone is in `due`. */
  title: string;
  /** "Oct 18 · 3 days overdue"; for a project notice its next
   * milestone's date, or null when it has no next milestone. */
  due: string | null;
  /** Under the date of a project notice: "Next milestone: Public beta". */
  dueNote: string | null;
  lines: string[];
  href: string;
  /** The "Why" chip's colour (noticeTone): danger overdue, warning the
      rest. */
  tone: DigestTone;
  /** The chip keeps the shape it had before the status hues: filled for
      what needs action now (the same items as rowTone), outlined for at
      risk. */
  chipFilled: boolean;
  /** The row's 2px rule: the item's tone for what needs action now
      (overdue, due soon without what the rubric needs, allocation
      stopped); default for at risk, which is a warning but not yet a
      missed date or a missing input. */
  rowTone: 'default' | DigestTone;
  /** The Due column's colour, by the date alone as wherever a date is
      coloured (dueTone, architecture §8.2 "due date"; My week's Upcoming
      deadlines colours its group labels instead): danger overdue, warning due
      today or tomorrow or undated, default later ("Oct 31 · in 9 days"
      stays ink under an amber rule). */
  dueTone: 'default' | DigestTone;
}

/** A digest item's colour (architecture §8.2 "warning kind"). */
export type DigestTone = Extract<UiTone, 'danger' | 'warning'>;

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
 * A digest item's tone (architecture §8.2 "warning kind"): an overdue
 * milestone is danger (red); at risk, due soon without what the rubric
 * needs, and a project whose allocation stopped are warnings (amber).
 */
export function noticeTone(kind: NoticeKind): DigestTone {
  return kind === 'overdue' ? 'danger' : 'warning';
}

/**
 * A digest item's due date colour through the one dueTone. A notice does
 * not carry its milestone's status, so overdue is the overdue notice, or a
 * project notice whose next milestone is past its date (its label reads
 * "N days overdue"); undated is a missing input; a project notice with no
 * next milestone ("Whole project") has no date to colour.
 */
function digestDueTone(
  notice: Digest['items'][number]['notice'],
  hasDue: boolean
): 'default' | DigestTone {
  if (!hasDue) return 'default';
  const overdue =
    notice.kind === 'overdue' ||
    (notice.daysLeft !== null && notice.daysLeft < 0);
  return dueTone(
    overdue ? 'overdue' : null,
    notice.daysLeft,
    notice.targetDate === null
  );
}

function previewItem(
  digest: Digest,
  index: number,
  today: IsoDate
): DigestItemPreview[] {
  return digest.items.map((item, i) => {
    const notice = item.notice;
    const project = notice.subjectKind === 'project';
    // A project notice is about the whole project; the milestone it names
    // is the next one, which the Due column spells out.
    const title =
      item.milestoneName === null || project
        ? item.projectName
        : `${item.projectName} › ${item.milestoneName}`;
    const href =
      notice.milestoneId !== null
        ? `/timeline?milestone=${encodeURIComponent(notice.milestoneId)}`
        : `/timeline?project=${encodeURIComponent(notice.projectId)}`;
    const due =
      project && item.milestoneName === null
        ? null
        : dueLabel(notice.targetDate, notice.daysLeft, today);
    return {
      id: `${index}:${i}:${notice.key}`,
      kind: notice.kind,
      kindLabel: NOTICE_KIND_LABEL[notice.kind],
      title,
      due,
      dueNote:
        project && item.milestoneName !== null
          ? `Next milestone: ${item.milestoneName}`
          : null,
      lines: item.lines,
      href,
      tone: noticeTone(notice.kind),
      chipFilled: notice.kind !== 'at_risk',
      rowTone: notice.kind === 'at_risk' ? 'default' : noticeTone(notice.kind),
      dueTone: digestDueTone(notice, due !== null),
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

/** A digest's delivery status as a chip (architecture §8.2 "digest
    status"). Sent, failed and undeliverable keep the filled chips they had
    before the status hues (green and red slabs); preview and sending stay
    outlined. */
const NOTIFICATION_STATUS: Record<
  NotificationRecord['status'],
  { label: string; tone: ChipTone; filled: boolean }
> = {
  sent: { label: 'Sent', tone: 'success', filled: true },
  preview: { label: 'Preview', tone: 'muted', filled: false },
  pending: { label: 'Sending', tone: 'info', filled: false },
  failed: { label: 'Failed', tone: 'danger', filled: true },
  undeliverable: { label: 'Undeliverable', tone: 'danger', filled: true },
};

export interface NotificationRow {
  id: string;
  day: string;
  recipient: string;
  channel: string;
  statusLabel: string;
  statusTone: ChipTone;
  /** Sent, failed and undeliverable are filled chips. */
  statusFilled: boolean;
  items: string;
  error: string | null;
  /** danger when the digest did not reach its recipient. */
  rowTone: 'default' | 'danger';
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
      statusFilled: status.filled,
      items: plural(record.digest.items.length, 'item'),
      error: record.error,
      rowTone: failed ? 'danger' : 'default',
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
 * "Watchers: Ana Moreno, Ben Carter → Ana Moreno". Entries saved before
 * the owner decision of 2026-10-22 may also carry the retired PM list;
 * they keep reading as they were saved ("PM list (retired): …"), but only
 * when both sides hold it, so the save that dropped the field does not
 * read as everyone being removed.
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
    ['pmUserIds', 'PM list (retired)'],
    ['watcherUserIds', 'Watchers'],
  ] as const) {
    if (key === 'pmUserIds' && !(key in before && key in after)) continue;
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

/** The parts of the mirror the audit log names things with. */
type AuditSnapshot = Pick<Snapshot, 'users' | 'milestones' | 'projects'> &
  Partial<Pick<Snapshot, 'issues' | 'states'>>;

/**
 * A description or comment as the audit log keeps it: { length } only.
 * Settings → Audit is open to every signed-in person, while those texts
 * are read with each person's own Linear token, so no words are shown
 * here even when an older entry carries an excerpt.
 */
function textLength(value: unknown): number | null {
  if (typeof value !== 'object' || value === null) return null;
  const { length } = value as { length?: unknown };
  return typeof length === 'number' ? length : null;
}

function textValue(value: unknown): string {
  const length = textLength(value);
  return length === null ? 'none' : plural(length, 'character');
}

/** A label set logged as [{ id, name }]. */
function labelsValue(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0) return 'none';
  return value
    .map((label: unknown) =>
      typeof label === 'object' &&
      label !== null &&
      typeof (label as { name?: unknown }).name === 'string'
        ? (label as { name: string }).name
        : 'a removed label'
    )
    .join(', ');
}

/** A string field of a logged object, or null. */
function loggedString(value: unknown, name: string): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const found = (value as Record<string, unknown>)[name];
  return typeof found === 'string' ? found : null;
}

/**
 * How an issue field's logged value reads, for the audit log's "before →
 * after" lines: the field's name ("status") and the value in the names
 * the mirror has now (ids it no longer knows read as removed). Null for
 * an action that is not a one-field issue edit (comments, relations).
 */
function issueFieldReader(
  action: AuditEntry['action'],
  snapshot: AuditSnapshot
): { label: string; show: (value: unknown) => string } | null {
  const person = (v: unknown) =>
    typeof v === 'string' ? nameOf(snapshot.users, v) : 'unassigned';
  const state = (v: unknown) =>
    typeof v === 'string'
      ? (snapshot.states?.get(v)?.name ?? 'a removed state')
      : 'none';
  const project = (v: unknown) =>
    typeof v === 'string'
      ? (snapshot.projects.get(v)?.name ?? 'a removed project')
      : 'no project';
  const milestone = (v: unknown) =>
    typeof v === 'string'
      ? (snapshot.milestones.get(v)?.name ?? 'a removed milestone')
      : 'no milestone';
  const priority = (v: unknown) =>
    typeof v === 'number' && Object.hasOwn(PRIORITY_LABEL, v)
      ? PRIORITY_LABEL[v as Priority]
      : 'none';
  switch (action) {
    case 'issue.title':
      return { label: 'title', show: plainValue };
    case 'issue.description':
      return { label: 'description', show: textValue };
    case 'issue.state':
      return { label: 'status', show: state };
    case 'issue.assignee':
      return { label: 'assignee', show: person };
    case 'issue.priority':
      return { label: 'priority', show: priority };
    case 'issue.project':
      return { label: 'project', show: project };
    case 'issue.milestone':
      return { label: 'milestone', show: milestone };
    case 'issue.due_date':
      return { label: 'due date', show: dateValue };
    case 'issue.estimate':
      return { label: 'estimate', show: plainValue };
    case 'issue.labels':
      return { label: 'labels', show: labelsValue };
    default:
      return null;
  }
}

/**
 * One audit row of a person's issue edit (owner decision 2026-10-21):
 * "ENG-24 · assignee" with "Ana Moreno → Dev Patel", in the names the
 * mirror has now (ids it no longer knows read as removed).
 */
export function issueAuditRow(
  entry: AuditEntry,
  snapshot: AuditSnapshot
): { what: string; changes: string[] } {
  const key =
    snapshot.issues?.get(entry.subjectId)?.identifier ?? 'A removed issue';
  const field = issueFieldReader(entry.action, snapshot);
  if (field !== null) {
    return {
      what: `${key} · ${field.label}`,
      changes: [`${field.show(entry.before)} → ${field.show(entry.after)}`],
    };
  }
  switch (entry.action) {
    case 'issue.comment':
      return {
        what: `${key} · comment`,
        changes: [
          textLength(entry.after) === null
            ? 'Added a comment'
            : `Added a comment (${textValue(entry.after)})`,
        ],
      };
    case 'issue.blocker_added':
      return {
        what: `${loggedString(entry.after, 'blockedIdentifier') ?? key} · blocked by`,
        changes: [
          `Added ${loggedString(entry.after, 'blockerIdentifier') ?? 'an issue'}`,
        ],
      };
    case 'issue.relation_removed':
      return {
        what: `${loggedString(entry.before, 'blockedIdentifier') ?? key} · blocked by`,
        changes: [
          `Removed ${loggedString(entry.before, 'blockerIdentifier') ?? 'an issue'}`,
        ],
      };
    default:
      return { what: `${key} · edit`, changes: ['Changed'] };
  }
}

export function auditRows(
  entries: readonly AuditEntry[],
  snapshot: AuditSnapshot,
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
        if (entry.action.startsWith('issue.')) {
          ({ what, changes } = issueAuditRow(entry, snapshot));
          break;
        }
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

/** At most this many issue keys are named in a folded row. */
const FOLD_KEYS_SHOWN = 3;

// "ENG-12, ENG-14, ENG-15 and 4 more".
function keyList(keys: readonly string[]): string {
  const shown = keys.slice(0, FOLD_KEYS_SHOWN).join(', ');
  const rest = keys.length - FOLD_KEYS_SHOWN;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

/**
 * Settings → Audit with bulk issue edits folded (architecture §5, §7.3):
 * a bulk change writes one entry per changed field per issue, all with
 * one shared `at`. Inside each run of entries sharing an `at` (one call),
 * issue entries with the same person, action and value after become one
 * row, "2 issues · milestone", with "→ Push notifications" and the keys
 * ("ENG-54, ENG-55", "… and 4 more"); they need not be next to each
 * other, so a cross-project move reads as exactly two rows (project,
 * milestone). A single edit, settings and milestone entries stay one row
 * each, and entries with different values after never fold. At most
 * `limit` rows, newest first, as the entries come.
 */
export function foldAuditEntries(
  entries: readonly AuditEntry[],
  snapshot: AuditSnapshot,
  timeZone: string,
  limit: number = Number.POSITIVE_INFINITY
): AuditRow[] {
  const plain = auditRows(entries, snapshot, timeZone);
  const rows: AuditRow[] = [];
  let start = 0;
  while (start < entries.length && rows.length < limit) {
    const at = entries[start]?.at;
    let end = start;
    while (end < entries.length && entries[end]?.at === at) end += 1;
    // Within the run: fold groups of equal issue edits, keep the rest.
    const groups = new Map<string, number[]>();
    for (let i = start; i < end; i += 1) {
      const entry = entries[i];
      if (entry === undefined || !entry.action.startsWith('issue.')) continue;
      if (issueFieldReader(entry.action, snapshot) === null) continue;
      const key = JSON.stringify([
        entry.actorUserId,
        entry.action,
        entry.after ?? null,
      ]);
      const list = groups.get(key);
      if (list === undefined) groups.set(key, [i]);
      else list.push(i);
    }
    const folded = new Map<number, number[]>();
    const skip = new Set<number>();
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const [first, ...rest] = list;
      if (first === undefined) continue;
      folded.set(first, list);
      for (const index of rest) skip.add(index);
    }
    for (let i = start; i < end && rows.length < limit; i += 1) {
      if (skip.has(i)) continue;
      const members = folded.get(i);
      const row = plain[i];
      const entry = entries[i];
      if (row === undefined || entry === undefined) continue;
      if (members === undefined) {
        rows.push(row);
        continue;
      }
      const field = issueFieldReader(entry.action, snapshot);
      const keys = members
        .map(
          (index) =>
            snapshot.issues?.get(entries[index]?.subjectId ?? '')?.identifier ??
            'a removed issue'
        )
        .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
      rows.push({
        ...row,
        what: `${members.length} issues · ${field?.label ?? 'edit'}`,
        changes: [
          `→ ${field?.show(entry.after) ?? plainValue(entry.after)}`,
          keyList(keys),
        ],
      });
    }
    start = end;
  }
  return rows;
}
