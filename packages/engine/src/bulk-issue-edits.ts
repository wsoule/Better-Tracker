// Bulk issue edits (owner request 2026-10-22, "every issue in one list";
// architecture §7.3): the issue list's moves, drops and Undo. Each issue
// gets exactly the single edit's write (issue-edits.ts): project and
// milestone, assignee, status and priority, sent with the person's own
// token through updateIssueFields, at most ISSUE_BULK_CONCURRENCY at a
// time. A read-only person (a Linear guest) is refused first, in
// engine.ts; then write scope is needed. The whole request is validated
// before anything is read from or written to Linear, every issue is
// locked like a single edit locks it, the mirror is patched once for the
// call, and every changed field is audited with one shared `at`.

import {
  type AllocationPlan,
  elapsedMs,
  type Issue,
  type IssueBulkPatch,
  type IssuePatch,
  type IssuePatchField,
  issueStateType,
  type IsoDateTime,
  type Snapshot,
  stateNameKey,
  type WorkflowState,
  type WorkflowStateType,
} from '@better-tracker/core';
import type { Logger } from '@better-tracker/logger';
import type {
  AuditEntry,
  MirrorEntity,
  MirrorRef,
} from '@better-tracker/store';

import {
  AUDIT_ACTION,
  checkAgainstMirror,
  issueMirrorChanges,
  laterOf,
  PATCH_FIELDS,
  patchMirror,
} from './issue-edits';
import { engineErrorFromLinear, isLinearApiError } from './linear-errors';
import { loadWorkspace } from './load';
import { hasControlCharacter } from './milestone-edits';
import { requireWriteScope } from './permissions';
import { type EngineRuntime, errorMessage } from './runtime';
import {
  type Actor,
  EngineAuthError,
  EngineInputError,
  type IssueBulkBefore,
  type IssueBulkOutcome,
  type IssueBulkResult,
} from './types';
import { sameIssue } from './webhooks';

/** Issues one bulk edit may change (about 10 s of writes at the concurrency below). */
export const ISSUE_BULK_MAX: number = 100;
/** Linear writes in flight at once during a bulk edit. */
export const ISSUE_BULK_CONCURRENCY: number = 4;
/** Longest status name a bulk status change may name. */
const STATE_NAME_MAX_LENGTH = 100;

const STATE_TYPES: readonly WorkflowStateType[] = [
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
];
const PATCH_KEYS: ReadonlySet<string> = new Set([
  'move',
  'assigneeId',
  'priority',
  'state',
]);

function invalid(message: string): EngineInputError {
  return new EngineInputError('invalid', message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A non-empty id, or null.
function idOrNull(value: unknown, label: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value === '') {
    throw invalid(`${label} must be an id, or empty.`);
  }
  return value;
}

/**
 * Checks a bulk patch's shape before anything is read: a plain object with
 * only `move`, `assigneeId`, `priority` and `state`, at least one of them;
 * `move` exactly { projectId, milestoneId }, each an id or null, and a
 * milestone only with a project; `priority` an integer 0–4; `state` exactly
 * { type, name } with one of the six types and a name of 1–100
 * characters (trimmed, no control characters). Returns the normalised
 * patch; throws EngineInputError('invalid').
 */
export function normalizeIssueBulkPatch(raw: unknown): IssueBulkPatch {
  if (!isPlainObject(raw)) throw invalid('The change must be an object.');
  for (const key of Object.keys(raw)) {
    if (!PATCH_KEYS.has(key)) throw invalid(`Unknown bulk field: ${key}.`);
  }
  const patch: IssueBulkPatch = {};
  if (raw['move'] !== undefined) {
    const move = raw['move'];
    if (
      !isPlainObject(move) ||
      Object.keys(move).length !== 2 ||
      !Object.hasOwn(move, 'projectId') ||
      !Object.hasOwn(move, 'milestoneId')
    ) {
      throw invalid(
        'A move needs exactly a project and a milestone (either may be empty).'
      );
    }
    const projectId = idOrNull(move['projectId'], 'The project');
    const milestoneId = idOrNull(move['milestoneId'], 'The milestone');
    if (milestoneId !== null && projectId === null) {
      throw invalid('An issue without a project cannot have a milestone.');
    }
    patch.move = { projectId, milestoneId };
  }
  if (raw['assigneeId'] !== undefined) {
    patch.assigneeId = idOrNull(raw['assigneeId'], 'The assignee');
  }
  if (raw['priority'] !== undefined) {
    const priority = raw['priority'];
    if (
      typeof priority !== 'number' ||
      !Number.isInteger(priority) ||
      priority < 0 ||
      priority > 4
    ) {
      throw invalid(
        'Priority must be 0 (none), 1 (urgent), 2 (high), 3 (medium) or 4 (low).'
      );
    }
    patch.priority = priority as IssueBulkPatch['priority'];
  }
  if (raw['state'] !== undefined) {
    const state = raw['state'];
    if (
      !isPlainObject(state) ||
      Object.keys(state).length !== 2 ||
      !Object.hasOwn(state, 'type') ||
      !Object.hasOwn(state, 'name')
    ) {
      throw invalid('A status needs exactly a type and a name.');
    }
    const type = state['type'];
    if (
      typeof type !== 'string' ||
      !(STATE_TYPES as readonly string[]).includes(type)
    ) {
      throw invalid(`Unknown status type: ${String(type)}.`);
    }
    const name = typeof state['name'] === 'string' ? state['name'].trim() : '';
    if (
      name === '' ||
      name.length > STATE_NAME_MAX_LENGTH ||
      hasControlCharacter(name)
    ) {
      throw invalid(
        `A status name is 1 to ${STATE_NAME_MAX_LENGTH} characters of plain text.`
      );
    }
    patch.state = { type: type as WorkflowStateType, name };
  }
  if (Object.keys(patch).length === 0) throw invalid('Nothing to change.');
  return patch;
}

// The requested ids: 1 to ISSUE_BULK_MAX non-empty strings, repeats
// dropped (the first keeps its place).
function normalizeIssueIds(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw invalid('Choose at least one issue.');
  }
  if (raw.length > ISSUE_BULK_MAX) {
    throw invalid(`At most ${ISSUE_BULK_MAX} issues can be changed at a time.`);
  }
  if (!raw.every((id): id is string => typeof id === 'string' && id !== '')) {
    throw invalid('Issues are named by their ids.');
  }
  return [...new Set(raw)];
}

/**
 * Runs `fn` while holding every key of `keys` in rt.serialize, taken one
 * after another in sorted order (repeats once). A single edit holds one of
 * these keys, so it never interleaves with a bulk edit of the same issue;
 * the sorted order means two overlapping bulk edits can never wait on
 * each other in a cycle.
 */
export function serializeAll<T>(
  rt: EngineRuntime,
  keys: readonly string[],
  fn: () => Promise<T>
): Promise<T> {
  const sorted = [...new Set(keys)].sort();
  const hold = (index: number): Promise<T> => {
    const key = sorted[index];
    return key === undefined ? fn() : rt.serialize(key, () => hold(index + 1));
  };
  return hold(0);
}

// The issue's team's state of that type whose name matches (stateNameKey:
// trimmed, case-insensitive); the lowest position when several do.
function resolveState(
  snapshot: Snapshot,
  teamId: string,
  wanted: { type: WorkflowStateType; name: string }
): WorkflowState | undefined {
  const key = stateNameKey(wanted.name);
  let found: WorkflowState | undefined;
  for (const state of snapshot.data.states) {
    if (
      state.teamId !== teamId ||
      state.type !== wanted.type ||
      stateNameKey(state.name) !== key
    )
      continue;
    if (found === undefined || state.position < found.position) found = state;
  }
  return found;
}

// Request-level targets must be visible to the person (an unknown and a
// hidden one get the same not_found), and an assignee must be an active
// person. Nothing is written when one fails.
function checkTargets(snapshot: Snapshot, patch: IssueBulkPatch): void {
  if (patch.move !== undefined) {
    const { projectId, milestoneId } = patch.move;
    if (projectId !== null && !snapshot.projects.has(projectId)) {
      throw new EngineInputError(
        'not_found',
        'That project is not in the planner.'
      );
    }
    if (milestoneId !== null) {
      const milestone = snapshot.milestones.get(milestoneId);
      if (milestone === undefined) {
        throw new EngineInputError(
          'not_found',
          'That milestone is not in the planner.'
        );
      }
      if (milestone.projectId !== projectId) {
        const project =
          projectId === null ? undefined : snapshot.projects.get(projectId);
        throw invalid(
          `${milestone.name} is not a milestone of ${project?.name ?? 'that project'}.`
        );
      }
    }
  }
  if (patch.assigneeId !== undefined && patch.assigneeId !== null) {
    const person = snapshot.users.get(patch.assigneeId);
    if (person === undefined) {
      throw new EngineInputError(
        'not_found',
        'That person is not in the planner.'
      );
    }
    if (person.app) throw invalid(`${person.name} is an app, not a person.`);
    if (!person.active)
      throw invalid(`${person.name} is deactivated in Linear.`);
  }
}

/** One issue the run will write: what it sends and what it was before. */
interface Candidate {
  index: number;
  issue: Issue;
  send: IssuePatch;
  fields: IssuePatchField[];
  before: IssueBulkBefore;
  written?: Issue;
}

// Mirror and audit values of one changed field before the write.
function beforeValue(issue: Issue, field: IssuePatchField): unknown {
  switch (field) {
    case 'stateId':
      return issue.stateId;
    case 'assigneeId':
      return issue.assigneeId;
    case 'priority':
      return issue.priority;
    case 'projectId':
      return issue.projectId;
    case 'projectMilestoneId':
      return issue.milestoneId;
    default:
      return null;
  }
}

// What the bulk patch asks of one issue, with only the fields that differ
// from the mirror; a state name its team lacks skips the whole issue.
function plan(
  snapshot: Snapshot,
  issue: Issue,
  patch: IssueBulkPatch
): { send: IssuePatch } | { skip: string } {
  const send: IssuePatch = {};
  if (patch.state !== undefined) {
    const state = resolveState(snapshot, issue.teamId, patch.state);
    if (state === undefined) {
      const team = snapshot.teams.get(issue.teamId)?.name ?? 'Its team';
      return {
        skip: `${team} has no ${patch.state.name} status; ${issue.identifier} was left as it was.`,
      };
    }
    if (state.id !== issue.stateId) send.stateId = state.id;
  }
  if (patch.assigneeId !== undefined && patch.assigneeId !== issue.assigneeId) {
    send.assigneeId = patch.assigneeId;
  }
  if (patch.priority !== undefined && patch.priority !== issue.priority) {
    send.priority = patch.priority;
  }
  if (patch.move !== undefined) {
    if (patch.move.projectId !== issue.projectId)
      send.projectId = patch.move.projectId;
    if (patch.move.milestoneId !== issue.milestoneId) {
      send.projectMilestoneId = patch.move.milestoneId;
    }
  }
  return { send };
}

const NOT_ATTEMPTED: Record<
  'rate_limited' | 'not_signed_in' | 'read_only',
  string
> = {
  rate_limited: "Not attempted: Linear's rate limit was reached.",
  not_signed_in: 'Not attempted: Linear stopped accepting your sign-in.',
  // api_key mode: the key turned out to be read-only (key-provider.ts).
  read_only: 'Not attempted: your Linear API key only allows reading.',
};

// Changed issues the new plan gives to a lead that the old plan did not,
// and touched projects whose allocation is newly blocked.
function allocationEffects(
  snapshot: Snapshot,
  before: AllocationPlan,
  after: AllocationPlan,
  changed: readonly Candidate[],
  live: boolean
): IssueBulkResult['allocation'] {
  const changedIds = new Set(changed.map((candidate) => candidate.issue.id));
  const plannedBefore = new Set(
    before.projects.flatMap((project) =>
      project.actions.map((action) => action.issueId)
    )
  );
  const handedOver: IssueBulkResult['allocation']['handedOver'] = [];
  for (const project of after.projects) {
    const issueIds = project.actions
      .filter(
        (action) =>
          changedIds.has(action.issueId) && !plannedBefore.has(action.issueId)
      )
      .map((action) => action.issueId);
    if (issueIds.length === 0) continue;
    const info = snapshot.projects.get(project.projectId);
    const leadId = info?.leadId ?? null;
    handedOver.push({
      projectId: project.projectId,
      projectName: info?.name ?? '',
      leadName: leadId === null ? '' : (snapshot.users.get(leadId)?.name ?? ''),
      issueIds,
      live,
    });
  }
  const touched = new Set<string>();
  for (const candidate of changed) {
    if (candidate.before.projectId !== null)
      touched.add(candidate.before.projectId);
    const now = candidate.written?.projectId ?? null;
    if (now !== null) touched.add(now);
  }
  const outcomeBefore = new Map(
    before.projects.map((project) => [project.projectId, project.outcome])
  );
  const stopped: IssueBulkResult['allocation']['stopped'] = [];
  for (const project of after.projects) {
    if (
      !touched.has(project.projectId) ||
      project.outcome !== 'blocked' ||
      project.blockReason === null
    )
      continue;
    if (outcomeBefore.get(project.projectId) === 'blocked') continue;
    stopped.push({
      projectId: project.projectId,
      projectName: snapshot.projects.get(project.projectId)?.name ?? '',
      reason: project.blockReason,
      gaps: [...project.gaps],
    });
  }
  return { handedOver, stopped };
}

/**
 * The sentence a failed write's outcome carries. Linear's own words for
 * what Linear refused (forbidden, not found, invalid) and for a transport
 * or server failure (a LinearApiError, as the single edit's 502 answers);
 * anything else (a bug, a token that would not decrypt) is a fixed
 * sentence, because its text can name internals and the outcome goes to
 * the browser. The raw error is logged by the caller.
 */
function failureMessage(
  code: 'not_found' | 'invalid' | 'linear_forbidden' | 'linear_error',
  mapped: unknown,
  identifier: string
): string {
  if (code !== 'linear_error') return errorMessage(mapped);
  return isLinearApiError(mapped)
    ? `Linear could not update ${identifier}: ${mapped.message}`
    : `Linear could not update ${identifier}. It was logged.`;
}

/**
 * The call's one mirror patch (§9.7 step 7), built against the mirror as
 * it is after the last write, not the copy loaded before the writes: the
 * run takes seconds, and Issue webhooks land meanwhile without any issue
 * lock. A write response is left out when the current mirror already has
 * a newer copy or this very one (its echo), or no longer holds the issue
 * at all (every candidate was in `before`, so a webhook found it deleted,
 * archived or moved out of the kept projects; writing the older response
 * would bring it back until the next full sync). Linear already has every
 * change, so a failure to read or patch the mirror is logged, not thrown:
 * the audit and the result still follow, and webhooks or the next sync
 * heal the mirror.
 */
async function patchMirrorAfterBulk(
  rt: EngineRuntime,
  workspaceId: string,
  before: Snapshot,
  written: readonly Candidate[],
  log: Logger
): Promise<void> {
  let current: Snapshot;
  try {
    current = (await rt.mirror.current(workspaceId))?.snapshot ?? before;
  } catch (error) {
    log.warn(
      'could not re-read the mirror after a bulk issue edit; webhooks and the next sync bring the changes',
      { error }
    );
    return;
  }
  const upsert = new Map<string, MirrorEntity>();
  const remove = new Map<string, MirrorRef>();
  for (const candidate of written) {
    const response = candidate.written as Issue;
    // The mirror's lastStateChangeAt may be history-refined; a write
    // that did not move the state keeps the later one (as updateIssue).
    const updated: Issue =
      candidate.send.stateId === undefined
        ? {
            ...response,
            lastStateChangeAt: laterOf(
              candidate.issue.lastStateChangeAt,
              response.lastStateChangeAt
            ),
          }
        : response;
    const mirrored = current.issues.get(updated.id);
    if (
      mirrored === undefined ||
      (elapsedMs(mirrored.updatedAt, updated.updatedAt) ?? 0) > 0 ||
      sameIssue(mirrored, updated)
    ) {
      continue;
    }
    const changes = issueMirrorChanges(current, updated);
    for (const entry of changes.upsert)
      upsert.set(`${entry.kind}\u0000${entry.entity.id}`, entry);
    for (const ref of changes.remove)
      remove.set(`${ref.kind}\u0000${ref.id}`, ref);
  }
  if (upsert.size > 0 || remove.size > 0) {
    await patchMirror(
      rt,
      workspaceId,
      { upsert: [...upsert.values()], remove: [...remove.values()] },
      log
    );
  }
}

/**
 * Changes up to ISSUE_BULK_MAX issues as the person (see the file
 * comment). Outcomes come back in request order; a Linear refusal fails
 * only its issue. A rate limit, a rejected sign-in or (api_key mode) a key
 * that may only read stops new writes (the rest are not attempted); when
 * that happens before anything changed, it throws like a single edit
 * (not_signed_in, rate_limited, read_only).
 */
export async function updateIssues(
  rt: EngineRuntime,
  actor: Actor,
  rawIds: readonly string[],
  rawPatch: IssueBulkPatch
): Promise<IssueBulkResult> {
  requireWriteScope(actor);
  const issueIds = normalizeIssueIds(rawIds);
  const patch = normalizeIssueBulkPatch(rawPatch);
  const workspaceId = actor.session.workspaceId;
  const log = rt.logger.child({
    workspaceId,
    userId: actor.session.userId,
    op: 'issues_bulk_update',
  });
  const keys = issueIds.map((id) => `issue\u0000${workspaceId}\u0000${id}`);
  return serializeAll(rt, keys, async () => {
    const at: IsoDateTime = rt.nowIso();
    const loaded = await loadWorkspace(rt, workspaceId, { viewer: actor });
    const { snapshot } = loaded;
    checkTargets(snapshot, patch);

    const outcomes: (IssueBulkOutcome | undefined)[] = Array.from({
      length: issueIds.length,
    });
    const candidates: Candidate[] = [];
    issueIds.forEach((issueId, index) => {
      const issue = snapshot.issues.get(issueId);
      if (issue === undefined) {
        outcomes[index] = {
          status: 'failed',
          issueId,
          identifier: null,
          code: 'not_found',
          message: `${issueId} is not in the planner any more.`,
        };
        return;
      }
      const planned = plan(snapshot, issue, patch);
      if ('skip' in planned) {
        outcomes[index] = {
          status: 'skipped',
          issueId,
          identifier: issue.identifier,
          reason: 'state_not_in_team',
          message: planned.skip,
        };
        return;
      }
      if (Object.keys(planned.send).length === 0) {
        outcomes[index] = {
          status: 'unchanged',
          issueId,
          identifier: issue.identifier,
        };
        return;
      }
      let send: IssuePatch;
      try {
        send = checkAgainstMirror(snapshot, issue, planned.send);
      } catch (error) {
        outcomes[index] = {
          status: 'failed',
          issueId,
          identifier: issue.identifier,
          code: 'invalid',
          message: errorMessage(error),
        };
        return;
      }
      const state = snapshot.states.get(issue.stateId);
      candidates.push({
        index,
        issue,
        send,
        fields: PATCH_FIELDS.filter((field) => send[field] !== undefined),
        before: {
          projectId: issue.projectId,
          milestoneId: issue.milestoneId,
          assigneeId: issue.assigneeId,
          priority: issue.priority,
          stateType: issueStateType(snapshot, issue),
          stateName: state?.name ?? '',
        },
      });
    });

    // --- write, ISSUE_BULK_CONCURRENCY at a time ------------------------------
    const gateway =
      candidates.length === 0
        ? null
        : await rt.linear.forSession(actor.session);
    let stopped: IssueBulkResult['stopped'] = null;
    let stopError: unknown = null;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (stopped === null && gateway !== null) {
        const candidate = candidates[next];
        next += 1;
        if (candidate === undefined) return;
        const { issue } = candidate;
        try {
          candidate.written = await gateway.updateIssueFields(
            issue.id,
            candidate.send
          );
          outcomes[candidate.index] = {
            status: 'changed',
            issueId: issue.id,
            identifier: issue.identifier,
            changed: candidate.fields,
            before: candidate.before,
          };
        } catch (error) {
          const mapped = engineErrorFromLinear(
            error,
            `update ${issue.identifier}`
          );
          const stopCode =
            mapped instanceof EngineInputError && mapped.code === 'rate_limited'
              ? 'rate_limited'
              : mapped instanceof EngineAuthError &&
                  (mapped.code === 'not_signed_in' ||
                    mapped.code === 'read_only')
                ? mapped.code
                : null;
          if (stopCode !== null) {
            if (stopped === null) {
              stopped = {
                code: stopCode,
                retryAt:
                  mapped instanceof EngineInputError ? mapped.retryAt : null,
              };
              stopError = mapped;
            }
            outcomes[candidate.index] = {
              status: 'skipped',
              issueId: issue.id,
              identifier: issue.identifier,
              reason: 'not_attempted',
              message: NOT_ATTEMPTED[stopCode],
            };
            continue;
          }
          let code:
            | 'not_found'
            | 'invalid'
            | 'linear_forbidden'
            | 'linear_error' = 'linear_error';
          if (
            mapped instanceof EngineAuthError &&
            mapped.code === 'linear_forbidden'
          )
            code = 'linear_forbidden';
          else if (
            mapped instanceof EngineInputError &&
            (mapped.code === 'not_found' || mapped.code === 'invalid')
          ) {
            code = mapped.code;
          } else {
            log.warn('a bulk issue write failed', {
              identifier: issue.identifier,
              error,
            });
          }
          outcomes[candidate.index] = {
            status: 'failed',
            issueId: issue.id,
            identifier: issue.identifier,
            code,
            message: failureMessage(code, mapped, issue.identifier),
          };
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(ISSUE_BULK_CONCURRENCY, candidates.length) },
        worker
      )
    );
    const stop = stopped as IssueBulkResult['stopped'];
    for (const candidate of candidates) {
      if (outcomes[candidate.index] !== undefined) continue;
      outcomes[candidate.index] = {
        status: 'skipped',
        issueId: candidate.issue.id,
        identifier: candidate.issue.identifier,
        reason: 'not_attempted',
        message: NOT_ATTEMPTED[stop?.code ?? 'rate_limited'],
      };
    }
    const written = candidates.filter(
      (candidate) => candidate.written !== undefined
    );
    if (written.length === 0 && stop !== null) throw stopError;

    // --- the mirror: one patch for the call, against the mirror as it is now -------
    if (written.length > 0) {
      await patchMirrorAfterBulk(
        rt,
        workspaceId,
        loaded.fullSnapshot,
        written,
        log
      );
    }

    // --- audit: field order, then request order; one shared `at` ----------------
    const entries: AuditEntry[] = [];
    for (const field of PATCH_FIELDS) {
      for (const candidate of written) {
        if (candidate.send[field] === undefined) continue;
        entries.push({
          workspaceId,
          actorUserId: actor.session.userId,
          action: AUDIT_ACTION[field],
          subjectId: candidate.issue.id,
          before: beforeValue(candidate.issue, field),
          after: candidate.send[field],
          at,
        });
      }
    }
    try {
      await rt.store.appendAuditEntries(entries);
    } catch (error) {
      log.error('could not write the audit entries of a bulk issue edit', {
        error,
        entries: entries.length,
      });
    }

    // --- allocation effects: the viewer's plan before and after ----------------
    let allocation: IssueBulkResult['allocation'] = {
      handedOver: [],
      stopped: [],
    };
    if (written.length > 0) {
      try {
        const after = await loadWorkspace(rt, workspaceId, { viewer: actor });
        allocation = allocationEffects(
          after.snapshot,
          loaded.allocationPlan,
          after.allocationPlan,
          written,
          after.settings.allocationMode === 'live'
        );
      } catch (error) {
        log.warn('could not compare allocation after a bulk issue edit', {
          error,
        });
      }
    }

    const done = outcomes as IssueBulkOutcome[];
    const counts = { changed: 0, unchanged: 0, skipped: 0, failed: 0 };
    for (const outcome of done) counts[outcome.status] += 1;
    log.info('issues edited in bulk', {
      requested: issueIds.length,
      ...counts,
      stopped: stop?.code ?? null,
    });
    return { at, outcomes: done, counts, stopped: stop, allocation };
  });
}
