import type { ApiResult } from './api-client';

// How the issue view reads the answer to one of its writes (architecture
// §8.5): pure, so the browser-only hook in components/issue-task.tsx stays
// thin and this stays unit-tested.

/** The issue view's writes. */
export type IssueWriteKind =
  | 'patch'
  | 'comment'
  | 'addBlocker'
  | 'removeRelation';

export type IssueWriteOutcome =
  /** Stored: refresh so the view shows what Linear now holds. */
  | { kind: 'saved' }
  /**
   * Refused, but what the person asked for already holds (the relation
   * is gone, or the pair is already linked): refresh, keep the control
   * free of "Not saved", and say so quietly when `note` is set.
   */
  | { kind: 'already'; note: string | null }
  /**
   * Not saved: the control rolls back and the message is toasted.
   * `refresh` when the refusal says this view is stale (the issue or
   * relation is gone, the pair already exists).
   */
  | { kind: 'failed'; refresh: boolean };

/**
 * Classifies a write's answer. A relation removal answered 404 means the
 * relation is no longer in the planner (someone removed it in Linear or
 * in another tab), and a blocker answered 409 means that issue already
 * blocks this one: both are the state the person wanted, so neither reads
 * as a failed save. A 409 workspace_changed (this tab shows a workspace
 * the browser switched away from in another tab) is a failure that never
 * refreshes: a refresh would render the other workspace's page and shell
 * in this tab at the same address (Globex's ENG-1 where Acme's was), so
 * the next edit would land there; the toast offers Reload instead.
 */
export function issueWriteOutcome(
  write: IssueWriteKind,
  result: ApiResult<unknown>
): IssueWriteOutcome {
  if (result.ok) return { kind: 'saved' };
  if (result.code === 'workspace_changed') {
    return { kind: 'failed', refresh: false };
  }
  if (write === 'removeRelation' && result.status === 404) {
    return { kind: 'already', note: null };
  }
  if (write === 'addBlocker' && result.status === 409) {
    return { kind: 'already', note: result.message };
  }
  return {
    kind: 'failed',
    refresh: result.status === 404 || result.status === 409,
  };
}
