// getIssueDetail (owner decision 2026-10-21): the issue page's data. The view
// model comes from the mirror (core's buildIssueDetail); the fields the
// mirror does not keep (description, labels, estimate, due date, comments)
// and the team's labels and estimate scale are read live with the viewer's
// own token, so Linear's permissions decide what they see. When their token
// cannot be refreshed right now (a transient failure) the app's reads
// instead; a grant Linear rejected for good, or any failure that is not
// transient, is never bridged that way. When
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

/**
 * Thrown by readerFor when the viewer's own token cannot be had and the
 * failure is not one the app's token may bridge (§7.2).
 */
class NoViewerReader extends Error {}

const DEAD_GRANT_MESSAGE =
  'Linear no longer accepts your sign-in; sign in again to see the description, labels and comments.';
const NOT_AS_YOU_MESSAGE =
  'The planner could not read Linear as you right now (its Linear sign-in for you failed); the description, labels and comments could not be loaded.';
/**
 * api_key mode: the viewer's own key failed transiently. Another person's
 * key never stands in (architecture §7 "API-key mode").
 */
export const KEY_UNANSWERED_MESSAGE =
  "Linear did not answer for your key just now; showing the planner's copy only.";

/**
 * True when getting the viewer's gateway failed for a transient reason,
 * the only case the app's token may stand in (§7.2): the token endpoint
 * could not be reached or timed out (OAuthError `network_error`), answered
 * 5xx or 429, or a transport/server failure. Any other OAuth `error` code
 * (`invalid_client` after a secret rotation, `invalid_request`,
 * `unauthorized_client`, …) and any other error (the store) is not
 * transient, so Linear's per-person permissions are never bypassed for it.
 * Checked by name as well, since another bundled copy of the linear
 * package fails instanceof.
 */
function isTransientViewerFailure(error: unknown): boolean {
  if (isLinearApiError(error)) {
    return (
      error.kind === 'network' ||
      error.kind === 'server' ||
      error.kind === 'rate_limited'
    );
  }
  if (!(error instanceof Error) || error.name !== 'OAuthError') return false;
  const { code, status } = error as { code?: unknown; status?: unknown };
  if (code === 'network_error') return true;
  return typeof status === 'number' && (status >= 500 || status === 429);
}

// The viewer's gateway, else the app's: a session whose token cannot be
// refreshed right now for a transient reason (Linear's token endpoint
// unreachable or failing) still gets the page, read as the app. A grant
// Linear rejected for good (invalid_grant: the person revoked the planner
// or lost access, EngineAuthError 'not_signed_in') and every other
// failure is not bridged with the app's token.
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
      throw new NoViewerReader(
        rt.config.auth === 'api_key' ? error.message : DEAD_GRANT_MESSAGE
      );
    }
    // With personal keys, nobody else's key ever reads for the viewer.
    if (rt.config.auth === 'api_key') {
      log.warn(
        "cannot read Linear with the viewer's key; showing the mirror only",
        {
          error,
        }
      );
      throw new NoViewerReader(KEY_UNANSWERED_MESSAGE);
    }
    if (!isTransientViewerFailure(error)) {
      log.error(
        'cannot read Linear as the viewer, and the failure is not transient; showing the mirror only',
        { error }
      );
      throw new NoViewerReader(NOT_AS_YOU_MESSAGE);
    }
    log.warn('cannot read Linear as the viewer right now; reading as the app', {
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
    if (error instanceof NoViewerReader) {
      return { extra: null, labels: [], source: null, error: error.message };
    }
    log.warn('live issue read failed; showing the mirror only', { error });
    const transient =
      isLinearApiError(error) &&
      (error.kind === 'network' ||
        error.kind === 'server' ||
        error.kind === 'rate_limited');
    if (rt.config.auth === 'api_key' && transient) {
      return { extra: null, labels: [], source, error: KEY_UNANSWERED_MESSAGE };
    }
    if (error instanceof EngineAuthError) {
      return { extra: null, labels: [], source, error: error.message };
    }
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
  // Narrowed to what the viewer may see (§2.13): an issue of a team they
  // cannot see reads as not found, as an unknown one does.
  const loaded = await loadWorkspace(rt, workspaceId, { viewer: actor });
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
    // A read-only person (a Linear guest) gets no edit controls and no
    // write grant to offer (owner decision 2026-10-22).
    canEdit: actor.canWriteLinear && !actor.readOnly,
    readOnly: actor.readOnly,
  };
}
