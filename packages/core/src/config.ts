import type { Tuning, WorkspaceSettings } from './types';

/**
 * Defaults for every tunable threshold. The design doc fixes the one-week
 * warning horizon; the rest are builder's calls documented in
 * docs/architecture.md and editable per workspace in Settings.
 */
export const DEFAULT_TUNING: Tuning = {
  warnLeadDays: 7,
  paceWindowDays: 7,
  stallDays: 7,
  overdueRepeatDays: 1,
  newBadgeDays: 7,
  activeProjectStatuses: ['planned', 'started'],
  timelineDaysBack: 14,
  timelineDaysAhead: 70,
};

/** Settings for a workspace that has never been configured. */
export function defaultSettings(
  workspaceId: string,
  timezone: string
): WorkspaceSettings {
  return {
    workspaceId,
    pmUserIds: [],
    watcherUserIds: [],
    allocationMode: 'dry_run',
    warningsMode: 'preview',
    timezone,
    tuning: { ...DEFAULT_TUNING },
  };
}
