// Per-viewer visibility in the engine (architecture §2.13 and §7
// "Per-viewer visibility"): every view built for a person narrows the
// mirror to the teams they may see (core's visibleSnapshot) in one place,
// here; the worker's own jobs (sync, allocation, the warnings sent to
// leads and watchers) keep the whole mirror. Narrowed snapshots are cached
// per mirror snapshot and per set of visible teams, so the common case
// (every member sees every public team) costs one lookup.

import {
  type Snapshot,
  viewerScope,
  type ViewerScope,
  visibleSnapshot,
} from '@better-tracker/core';
import type { AuditEntry, RunEntry } from '@better-tracker/store';

import { type Actor, EngineAuthError } from './types';

/** A person's narrowed snapshot and the scope it was narrowed to. */
export interface ViewerSnapshot {
  scope: ViewerScope;
  snapshot: Snapshot;
}

// Per full snapshot (one per mirror version, so old ones are collected
// with it): narrowed snapshots by scope key.
const narrowed = new WeakMap<Snapshot, Map<string, Snapshot>>();
/** Distinct scopes kept per mirror version (a workspace has few). */
const MAX_SCOPES = 32;

function scopeKey(scope: ViewerScope): string {
  return `${scope.guest ? 'guest' : 'member'}:${[...scope.teamIds].sort().join(',')}`;
}

/**
 * The viewer's narrowed snapshot of `full` (the mirror). The viewer must
 * belong to `workspaceId` (EngineAuthError('wrong_workspace') otherwise).
 */
export function viewerSnapshot(
  full: Snapshot,
  workspaceId: string,
  viewer: Actor
): ViewerSnapshot {
  if (viewer.session.workspaceId !== workspaceId) {
    throw new EngineAuthError(
      'wrong_workspace',
      'You are signed in to another Linear workspace.'
    );
  }
  const scope = viewerScope(full, viewer.session.userId);
  if (scope.everything) return { scope, snapshot: full };
  let byScope = narrowed.get(full);
  if (byScope === undefined) {
    byScope = new Map();
    narrowed.set(full, byScope);
  }
  const key = scopeKey(scope);
  let snapshot = byScope.get(key);
  if (snapshot === undefined) {
    snapshot = visibleSnapshot(full, scope);
    if (byScope.size >= MAX_SCOPES) byScope.clear();
    byScope.set(key, snapshot);
  }
  return { scope, snapshot };
}

/**
 * How log filters treat what they cannot place (api_key mode passes
 * `failClosed`, architecture §7 "API-key mode"): the mirror there is the
 * reader key's view, which can lose a private team when the reader
 * changes, so nothing is shown that the mirror does not hold now.
 */
export interface LogVisibilityOptions {
  /**
   * No `everything` shortcut, and a subject the mirror does not hold is
   * hidden from everyone, members included.
   */
  failClosed?: boolean;
}

/**
 * Whether a viewer may see an entity a log entry is about. One the mirror
 * holds is visible when the narrowed snapshot holds it; one the mirror no
 * longer holds (a closed project, a deleted issue) cannot be placed in a
 * team, so members see it and guests do not (nobody, failing closed).
 */
function seesSubject(
  full: Snapshot,
  seen: ViewerSnapshot,
  kind: 'issue' | 'project' | 'milestone',
  id: string,
  failClosed: boolean
): boolean {
  const known =
    kind === 'issue'
      ? full.issues.has(id)
      : kind === 'project'
        ? full.projects.has(id)
        : full.milestones.has(id);
  if (!known) return !failClosed && !seen.scope.guest;
  return kind === 'issue'
    ? seen.snapshot.issues.has(id)
    : kind === 'project'
      ? seen.snapshot.projects.has(id)
      : seen.snapshot.milestones.has(id);
}

/** The run entries a viewer may see (§2.13): its project and issue visible. */
export function visibleRunEntries(
  full: Snapshot,
  seen: ViewerSnapshot,
  entries: readonly RunEntry[],
  options: LogVisibilityOptions = {}
): RunEntry[] {
  const failClosed = options.failClosed === true;
  if (seen.scope.everything && !failClosed) return [...entries];
  return entries.filter(
    (entry) =>
      seesSubject(full, seen, 'project', entry.projectId, failClosed) &&
      (entry.issueId === null ||
        seesSubject(full, seen, 'issue', entry.issueId, failClosed))
  );
}

/**
 * The audit entries a viewer may see (§2.13): issue, milestone and project
 * edits about what they can see, and every settings change.
 */
export function visibleAuditEntries(
  full: Snapshot,
  seen: ViewerSnapshot,
  entries: readonly AuditEntry[],
  options: LogVisibilityOptions = {}
): AuditEntry[] {
  const failClosed = options.failClosed === true;
  if (seen.scope.everything && !failClosed) return [...entries];
  return entries.filter((entry) => {
    const [kind] = entry.action.split('.');
    if (kind === 'issue' || kind === 'milestone' || kind === 'project') {
      return seesSubject(full, seen, kind, entry.subjectId, failClosed);
    }
    return true;
  });
}
