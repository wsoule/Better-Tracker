// getIssueDetail (owner decision 2026-10-21): the issue page's data. The view
// model comes from the mirror (core's buildIssueDetail); the fields the
// mirror does not keep (description, labels, estimate, due date, comments)
// and the team's labels and estimate scale are read live with the viewer's
// own token, so Linear's permissions decide what they see. When their token
// cannot be refreshed right now (a transient failure) the app's reads
// instead; a grant Linear rejected for good is never bridged that way. When
// the live read fails the page still renders from the mirror, with `extra`
// null and the reason.

import {
  buildIssueDetail,
  estimateOptions,
  type IssueExtras,
  type IssueLabel,
} from '@better-tracker/core';
import type { LinearGateway } from '@better-tracker/linear';
import type { Logger } from '@better-tracker/logger';

import { isLinearApiError } from './linear-errors';
import { loadWorkspace } from './load';
import { type EngineRuntime, errorMessage } from './runtime';
import {
  type Actor,
  EngineAuthError,
  EngineInputError,
  type IssueDetailResult,
} from './types';

/** How many allocation run entries the issue page lists (newest first). */
export const ISSUE_HISTORY_LIMIT = 20;

/** The live part of the page, or why it is missing. */
interface LiveRead {
  extra: IssueExtras | null;
  labels: IssueLabel[];
  error: string | null;
  source: 'actor' | 'app' | null;
}

/** Thrown by readerFor when Linear rejected the viewer's grant for good. */
class DeadGrant extends Error {}

const DEAD_GRANT_MESSAGE =
  'Linear no longer accepts your sign-in; sign in again to see the description, labels and comments.';

// The viewer's gateway, else the app's: a session whose token cannot be
// refreshed right now (Linear's token endpoint unreachable) still gets the
// page, read as the app. A grant Linear rejected for good (invalid_grant:
// the person revoked the planner or lost access, EngineAuthError
// 'not_signed_in') is not bridged with the app's token: Linear has said
// this person may no longer read through the planner.
async function readerFor(
  rt: EngineRuntime,
  actor: Actor,
  log: Logger
): Promise<{ gateway: LinearGateway; source: 'actor' | 'app' }> {
  try {
    return {
      gateway: await rt.linear.forSession(actor.session),
      source: 'actor',
    };
  } catch (error) {
    if (error instanceof EngineAuthError && error.code === 'not_signed_in') {
      log.warn("the viewer's Linear grant is dead; showing the mirror only");
      throw new DeadGrant(DEAD_GRANT_MESSAGE);
    }
    log.warn('cannot read Linear as the viewer; reading as the app', {
      error,
    });
    return {
      gateway: await rt.linear.forApp(actor.session.workspaceId),
      source: 'app',
    };
  }
}

// A sentence for a failed live read (never a stack).
function liveReadError(error: unknown): string {
  if (isLinearApiError(error)) {
    switch (error.kind) {
      case 'forbidden':
        return 'Linear does not let your account read this issue.';
      case 'rate_limited':
        return "Linear's rate limit was reached; the description, labels and comments will show again in a minute.";
      case 'network':
      case 'server':
        return 'Linear did not answer; the description, labels and comments could not be loaded.';
      default:
        return `Linear could not load the issue's details: ${error.message}`;
    }
  }
  return `The issue's details could not be loaded: ${errorMessage(error)}`;
}

// Reads the extras and the team's labels in parallel. Never throws: any
// failure becomes `error`.
async function readLive(
  rt: EngineRuntime,
  actor: Actor,
  issueId: string,
  teamId: string,
  log: Logger
): Promise<LiveRead> {
  let source: 'actor' | 'app' | null = null;
  try {
    const reader = await readerFor(rt, actor, log);
    source = reader.source;
    const [extra, labels] = await Promise.all([
      reader.gateway.fetchIssueDetail(issueId),
      reader.gateway.listIssueLabels(teamId),
    ]);
    if (extra === null) {
      return {
        extra: null,
        labels,
        source,
        // Linear answers "not found" for an issue the token may not see
        // (a private team) as well as for one that is gone.
        error:
          source === 'actor'
            ? 'Linear does not show this issue to your account: it is in a team you cannot see, or it was deleted or archived.'
            : 'Linear no longer has this issue (deleted or archived); the next sync removes it here.',
      };
    }
    return { extra, labels, source, error: null };
  } catch (error) {
    if (error instanceof DeadGrant) {
      return { extra: null, labels: [], source: null, error: error.message };
    }
    log.warn('live issue read failed; showing the mirror only', { error });
    return { extra: null, labels: [], source, error: liveReadError(error) };
  }
}

/**
 * The issue page for any signed-in person. Unknown issue ids are
 * EngineInputError('not_found'); a failed live read is reported in the
 * result, never thrown.
 */
export async function getIssueDetail(
  rt: EngineRuntime,
  actor: Actor,
  issueId: string
): Promise<IssueDetailResult> {
  const workspaceId = actor.session.workspaceId;
  const loaded = await loadWorkspace(rt, workspaceId);
  const detail =
    typeof issueId === 'string'
      ? buildIssueDetail({
          snapshot: loaded.snapshot,
          ctx: loaded.ctx,
          assessments: loaded.assessments,
          issueId,
        })
      : null;
  if (detail === null) {
    throw new EngineInputError(
      'not_found',
      'That issue is not in the planner (it may be in a closed project, or in a team the app cannot see).'
    );
  }
  const log = rt.logger.child({
    workspaceId,
    userId: actor.session.userId,
    issueId,
    op: 'issue_detail',
  });
  const [live, allocationHistory] = await Promise.all([
    readLive(rt, actor, issueId, detail.issue.teamId, log),
    rt.store.listRunEntriesForIssue(workspaceId, issueId, ISSUE_HISTORY_LIMIT),
  ]);
  const estimateScale = live.extra?.estimateScale ?? null;
  return {
    detail,
    extra: live.extra,
    extraError: live.error,
    extraSource: live.source,
    labels: live.labels,
    estimateScale,
    estimateOptions:
      estimateScale === null ? [] : estimateOptions(estimateScale),
    allocationHistory,
    canEdit: actor.canWriteLinear,
  };
}
