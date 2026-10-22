// Workspace settings: the first-time bootstrap of the watchers, and the
// validation of a settings patch (architecture §7.1: "never trust the
// client"). Any signed-in person may change settings (owner decision
// 2026-10-22: there is no PM role); every change is audited. Settings decide
// who is warned, so every user id must be a real, mirrored person. The
// watcher list may be empty (then only project leads are warned).

import {
  isValidTimeZone,
  type ProjectStatusType,
  type Snapshot,
  type Tuning,
  type User,
  type WarningMemory,
  type WorkspaceData,
  type WorkspaceSettings,
} from '@better-tracker/core';
import type { Logger } from '@better-tracker/logger';

import {
  readSettings,
  requireInstallation,
  type EngineRuntime,
} from './runtime';
import { type Actor, EngineInputError } from './types';

// Unique ids in first-seen order.
function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Bootstrap the watchers (architecture §7): any existing list is kept, else
 * the people whose email is in `watcherEmails` (WATCHER_EMAILS), else the
 * installer, so a fresh workspace always warns somebody besides the leads.
 * App users are never watchers, and only mirrored people count. Emails
 * that match nobody are logged at warn (missing inputs are loud).
 */
export function bootstrapWatchers(input: {
  data: WorkspaceData;
  installerId: string | null;
  watcherEmails: readonly string[];
  existing: readonly string[] | null;
  log: Logger;
}): string[] {
  const people = new Map<string, User>();
  const byEmail = new Map<string, User>();
  for (const user of input.data.users) {
    if (user.app) continue;
    people.set(user.id, user);
    if (user.email !== null && user.active) {
      byEmail.set(user.email.trim().toLowerCase(), user);
    }
  }

  const existing = unique(input.existing ?? []).filter((id) => people.has(id));
  if (existing.length > 0) return existing;
  const fromEmails: string[] = [];
  for (const email of input.watcherEmails) {
    const user = byEmail.get(email.toLowerCase());
    if (user === undefined) {
      input.log.warn('bootstrap email matches no active Linear user', {
        variable: 'WATCHER_EMAILS',
        email,
      });
    } else if (!fromEmails.includes(user.id)) {
      fromEmails.push(user.id);
    }
  }
  if (fromEmails.length > 0) return fromEmails;
  if (input.installerId !== null && people.has(input.installerId)) {
    return [input.installerId];
  }
  return [];
}

// --- validation ---------------------------------------------------------------

const PROJECT_STATUSES: readonly ProjectStatusType[] = [
  'backlog',
  'planned',
  'started',
  'paused',
  'completed',
  'canceled',
];

/** Inclusive bounds for each tuning integer, in days (§7.1: 1–90). */
const TUNING_BOUNDS: Record<
  Exclude<keyof Tuning, 'activeProjectStatuses'>,
  { min: number; max: number }
> = {
  warnLeadDays: { min: 1, max: 90 },
  paceWindowDays: { min: 1, max: 90 },
  stallDays: { min: 1, max: 90 },
  overdueRepeatDays: { min: 1, max: 90 },
  newBadgeDays: { min: 1, max: 90 },
  timelineDaysBack: { min: 1, max: 90 },
  timelineDaysAhead: { min: 1, max: 90 },
};

const SETTINGS_KEYS: readonly string[] = [
  'watcherUserIds',
  'allocationMode',
  'warningsMode',
  'timezone',
  'tuning',
];

function invalid(message: string): EngineInputError {
  return new EngineInputError('invalid', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A list of unique ids of mirrored, non-app people.
function validatePeople(
  value: unknown,
  field: string,
  snapshot: Snapshot
): string[] {
  if (!Array.isArray(value))
    throw invalid(`${field} must be a list of user ids.`);
  const ids: string[] = [];
  for (const item of value as unknown[]) {
    if (typeof item !== 'string') {
      throw invalid(`${field} must contain user ids.`);
    }
    const user = snapshot.users.get(item);
    if (user === undefined) throw invalid(`${field}: unknown user ${item}.`);
    if (user.app)
      throw invalid(`${field}: ${user.name} is an app, not a person.`);
    if (!ids.includes(item)) ids.push(item);
  }
  return ids;
}

// Merges a (possibly partial) tuning patch over the current tuning,
// rejecting unknown keys, non-integers, out-of-range values and an empty or
// unknown project status list.
function validateTuning(value: unknown, current: Tuning): Tuning {
  if (!isRecord(value)) throw invalid('tuning must be an object.');
  const next: Tuning = {
    ...current,
    activeProjectStatuses: [...current.activeProjectStatuses],
  };
  for (const [key, raw] of Object.entries(value)) {
    if (key === 'activeProjectStatuses') {
      if (!Array.isArray(raw) || raw.length === 0) {
        throw invalid(
          'tuning.activeProjectStatuses must list at least one project status.'
        );
      }
      const statuses: ProjectStatusType[] = [];
      for (const status of raw as unknown[]) {
        const known = PROJECT_STATUSES.find((s) => s === status);
        if (known === undefined) {
          throw invalid(
            `tuning.activeProjectStatuses: unknown status ${String(status)}.`
          );
        }
        if (!statuses.includes(known)) statuses.push(known);
      }
      next.activeProjectStatuses = statuses;
      continue;
    }
    const bounds = (
      TUNING_BOUNDS as Record<string, { min: number; max: number }>
    )[key];
    if (bounds === undefined) throw invalid(`tuning.${key} is not a setting.`);
    if (
      typeof raw !== 'number' ||
      !Number.isInteger(raw) ||
      raw < bounds.min ||
      raw > bounds.max
    ) {
      throw invalid(
        `tuning.${key} must be a whole number from ${bounds.min} to ${bounds.max}.`
      );
    }
    (next as unknown as Record<string, number>)[key] = raw;
  }
  return next;
}

/**
 * Applies a settings patch to `current` after validating every field:
 * unknown keys are rejected (the retired PM list included, with a sentence
 * saying so); watchers must be mirrored non-app users, and the list may be
 * empty; modes must be known; the timezone must be a real IANA zone;
 * tuning integers stay within their ranges.
 */
export function applySettingsPatch(
  current: WorkspaceSettings,
  patch: unknown,
  snapshot: Snapshot
): WorkspaceSettings {
  if (!isRecord(patch)) throw invalid('Settings patch must be an object.');
  const next: WorkspaceSettings = {
    ...current,
    watcherUserIds: [...current.watcherUserIds],
    tuning: {
      ...current.tuning,
      activeProjectStatuses: [...current.tuning.activeProjectStatuses],
    },
  };
  for (const key of Object.keys(patch)) {
    if (key === 'pmUserIds') {
      throw invalid(
        'pmUserIds is no longer a setting: there is no PM role, and everyone signed in can edit.'
      );
    }
    if (!SETTINGS_KEYS.includes(key)) {
      throw invalid(`${key} is not a setting that can be changed.`);
    }
  }
  if ('watcherUserIds' in patch) {
    next.watcherUserIds = validatePeople(
      patch['watcherUserIds'],
      'watcherUserIds',
      snapshot
    );
  }
  if ('allocationMode' in patch) {
    const mode = patch['allocationMode'];
    if (mode !== 'dry_run' && mode !== 'live') {
      throw invalid('allocationMode must be dry_run or live.');
    }
    next.allocationMode = mode;
  }
  if ('warningsMode' in patch) {
    const mode = patch['warningsMode'];
    if (mode !== 'preview' && mode !== 'live') {
      throw invalid('warningsMode must be preview or live.');
    }
    next.warningsMode = mode;
  }
  if ('timezone' in patch) {
    const timezone = patch['timezone'];
    if (typeof timezone !== 'string' || !isValidTimeZone(timezone)) {
      throw invalid('timezone must be an IANA timezone such as Europe/Oslo.');
    }
    next.timezone = timezone;
  }
  if ('tuning' in patch) {
    next.tuning = validateTuning(patch['tuning'], current.tuning);
  }
  return next;
}

/**
 * Warning memory with every subject forgotten: each row is kept but reads
 * as "never told", so the next warnings run announces whatever is notable
 * now. Used when warnings go live: preview runs remembered notices nobody
 * received, and without this an at-risk milestone or a blocked project
 * seen in preview would never be sent until its state changed.
 */
export function forgetWarningMemory(
  rows: readonly WarningMemory[]
): WarningMemory[] {
  return rows.map((row) => ({
    ...row,
    lastKey: null,
    lastNotifiedOn: null,
    occurrence: 0,
  }));
}

/**
 * updateSettings (§7): any signed-in person of the workspace, validated
 * against the mirror, saved, and audited with the full before/after
 * settings (the audit is how everyone sees who changed a mode). Switching
 * warnings from preview to live forgets the warning memory (see
 * forgetWarningMemory).
 *
 * Saves of one workspace's settings run one at a time in this process.
 * Each Settings section saves only its own fields, but the store keeps the
 * settings as one document; with everyone able to edit (owner decision
 * 2026-10-22), two people saving different sections at once is ordinary,
 * and without the queue the later save would put back the earlier one's
 * fields as it read them (a lost change, and an audit entry that reads as
 * a revert).
 */
export async function updateSettings(
  rt: EngineRuntime,
  actor: Actor,
  patch: unknown
): Promise<WorkspaceSettings> {
  const workspaceId = actor.session.workspaceId;
  await requireInstallation(rt, workspaceId);
  const view = await rt.mirror.current(workspaceId);
  if (view === null) {
    throw new EngineInputError(
      'conflict',
      'The workspace has not been synced from Linear yet.'
    );
  }
  return rt.serialize(`settings\u0000${workspaceId}`, () =>
    saveSettingsPatch(rt, actor, patch, view.snapshot)
  );
}

// Reads the saved settings (the audit's "before"), applies the validated
// patch, saves, and appends the audit entry. Runs inside updateSettings'
// per-workspace queue, so "before" is always what the previous save left.
async function saveSettingsPatch(
  rt: EngineRuntime,
  actor: Actor,
  patch: unknown,
  snapshot: Snapshot
): Promise<WorkspaceSettings> {
  const workspaceId = actor.session.workspaceId;
  const { settings: before } = await readSettings(rt, workspaceId);
  const after = applySettingsPatch(before, patch, snapshot);
  await rt.store.saveSettings(after);
  if (before.warningsMode === 'preview' && after.warningsMode === 'live') {
    const memory = await rt.store.listWarningMemory(workspaceId);
    await rt.store.saveWarningMemory(workspaceId, forgetWarningMemory(memory));
    rt.logger.info('warnings went live; warning memory forgotten', {
      workspaceId,
      subjects: memory.length,
    });
  }
  await rt.store.appendAudit({
    workspaceId,
    actorUserId: actor.session.userId,
    action: 'settings.update',
    subjectId: workspaceId,
    before,
    after,
    at: rt.nowIso(),
  });
  rt.logger.info('settings updated', {
    workspaceId,
    userId: actor.session.userId,
    keys: Object.keys(patch as Record<string, unknown>),
  });
  return after;
}
