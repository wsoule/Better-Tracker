// handleWebhook (§7, §4.1): a verified Linear delivery is recorded (deduped
// by its Linear-Delivery id), then the touched entity is refetched through
// the app actor and patched into the mirror. Linear sends no webhooks for
// project milestones or issue relations, so an Issue event also replaces
// that issue's relations and an Issue/Project event refreshes the project's
// milestones; the periodic full sync heals anything still missed. Errors are
// recorded on the delivery and logged, never thrown to the route.

import {
  type BlockingRelation,
  elapsedMs,
  isOpenState,
  type IsoDateTime,
  type Issue,
  type Project,
  type Snapshot,
} from '@better-tracker/core';
import type { LinearGateway } from '@better-tracker/linear';
import type { Logger } from '@better-tracker/logger';
import type { MirrorEntity, MirrorRef } from '@better-tracker/store';

import { type EngineRuntime, errorMessage } from './runtime';
import { fullSync } from './sync';
import { EngineAuthError, type Engine } from './types';

export type WebhookEvent = Parameters<Engine['handleWebhook']>[0];
type WebhookOutcome = 'processed' | 'ignored';

/** Mirror writes for one webhook: removals run before upserts. */
interface MirrorChanges {
  upsert: MirrorEntity[];
  remove: MirrorRef[];
}

function isClosedProject(project: Project): boolean {
  return (
    project.statusType === 'completed' || project.statusType === 'canceled'
  );
}

// Whether the snapshot holds the entity a removal refers to.
function isMirrored(snapshot: Snapshot, ref: MirrorRef): boolean {
  switch (ref.kind) {
    case 'user':
      return snapshot.users.has(ref.id);
    case 'team':
      return snapshot.teams.has(ref.id);
    case 'state':
      return snapshot.states.has(ref.id);
    case 'initiative':
      return snapshot.initiatives.has(ref.id);
    case 'project':
      return snapshot.projects.has(ref.id);
    case 'milestone':
      return snapshot.milestones.has(ref.id);
    case 'issue':
      return snapshot.issues.has(ref.id);
    case 'relation':
      return snapshot.data.relations.some((r) => r.id === ref.id);
  }
}

/** Refs of every mirrored relation in which `issueId` blocks or is blocked. */
export function relationRefsTouching(
  snapshot: Snapshot,
  issueId: string
): MirrorRef[] {
  return snapshot.data.relations
    .filter((r) => r.blockerId === issueId || r.blockedId === issueId)
    .map((r) => ({ kind: 'relation', id: r.id }));
}

// An issue and its relations, as removals.
function issueRemoval(snapshot: Snapshot, issueId: string): MirrorChanges {
  return {
    upsert: [],
    remove: [
      { kind: 'issue', id: issueId },
      ...relationRefsTouching(snapshot, issueId),
    ],
  };
}

// A project with its milestones and issues, as removals. That matches what
// the next full sync produces for a deleted, archived or closed project
// (fetchWorkspace mirrors neither closed projects nor their issues).
function projectRemoval(snapshot: Snapshot, projectId: string): MirrorChanges {
  const remove: MirrorRef[] = [{ kind: 'project', id: projectId }];
  for (const milestone of snapshot.milestonesByProject.get(projectId) ?? []) {
    remove.push({ kind: 'milestone', id: milestone.id });
  }
  for (const issue of snapshot.issuesByProject.get(projectId) ?? []) {
    remove.push({ kind: 'issue', id: issue.id });
  }
  return { upsert: [], remove };
}

// Upserts the fetched project and all its milestones, and removes mirrored
// milestones of that project which Linear no longer returns.
async function projectRefresh(
  gateway: LinearGateway,
  snapshot: Snapshot,
  projectId: string
): Promise<MirrorChanges | null> {
  const fetched = await gateway.fetchProject(projectId);
  if (fetched === null || isClosedProject(fetched.project)) return null;
  const kept = new Set(fetched.milestones.map((m) => m.id));
  const remove: MirrorRef[] = [];
  for (const milestone of snapshot.milestonesByProject.get(projectId) ?? []) {
    if (!kept.has(milestone.id))
      remove.push({ kind: 'milestone', id: milestone.id });
  }
  return {
    upsert: [
      { kind: 'project', entity: fetched.project },
      ...fetched.milestones.map((entity): MirrorEntity => ({
        kind: 'milestone',
        entity,
      })),
    ],
    remove,
  };
}

// The later of two instants (the first when either does not parse).
function laterOf(a: IsoDateTime, b: IsoDateTime): IsoDateTime {
  return (elapsedMs(b, a) ?? 0) > 0 ? b : a;
}

/**
 * `fetched` (an issue as the gateway returned it, refetched or written)
 * keeping the mirror's lastStateChangeAt when that is later. Outside a
 * write that moved the state, the gateway only knows the timestamp
 * approximation (latest of created/started/completed/canceled), while the
 * mirror's value may be refined from issue history by the full sync; an
 * unrelated change must not make the issue look stalled (§7.2 applies the
 * same rule to people's edits). For an issue whose state did not move.
 */
export function withMirroredStateTime(
  fetched: Issue,
  mirrored: Issue | undefined
): Issue {
  if (mirrored === undefined) return fetched;
  const kept = laterOf(mirrored.lastStateChangeAt, fetched.lastStateChangeAt);
  return kept === fetched.lastStateChangeAt
    ? fetched
    : { ...fetched, lastStateChangeAt: kept };
}

// The refetched issue an Issue webhook writes to the mirror. A state move
// (Linear's updatedFrom names stateId, or the state differs from the
// mirror's) happened by the issue's updatedAt, which beats the
// approximation (a move between two started states leaves startedAt as it
// was); otherwise the mirror's possibly refined time is kept.
function refetchedIssue(
  event: WebhookEvent,
  fetched: Issue,
  mirrored: Issue | undefined
): Issue {
  const stateMoved =
    (event.updatedFrom !== null && 'stateId' in event.updatedFrom) ||
    (mirrored !== undefined && mirrored.stateId !== fetched.stateId);
  if (!stateMoved) return withMirroredStateTime(fetched, mirrored);
  return {
    ...fetched,
    lastStateChangeAt: laterOf(fetched.lastStateChangeAt, fetched.updatedAt),
  };
}

/**
 * Whether the mirror keeps an issue without a project: only open ones,
 * exactly the set fetchWorkspace mirrors (issues of mirrored projects are
 * kept open and closed, for progress).
 */
export function keepsLooseIssue(snapshot: Snapshot, issue: Issue): boolean {
  const type = snapshot.states.get(issue.stateId)?.type ?? 'backlog';
  return isOpenState(type);
}

/**
 * Every Issue key, so sameIssue compares them all (the Record type makes a
 * new Issue field a compile error here until it is listed).
 */
const ISSUE_KEYS: Readonly<Record<keyof Issue, true>> = {
  id: true,
  identifier: true,
  title: true,
  url: true,
  teamId: true,
  projectId: true,
  milestoneId: true,
  assigneeId: true,
  stateId: true,
  priority: true,
  createdAt: true,
  updatedAt: true,
  startedAt: true,
  completedAt: true,
  canceledAt: true,
  lastStateChangeAt: true,
  dueDate: true,
};

/**
 * True when two copies of an issue are the same mirror value: every Issue
 * key compared with === (all are scalars), an absent dueDate (a mirror
 * written before 2026-10-22) read as null. Used to skip writing a webhook
 * refetch, or a bulk edit's late mirror patch, that changes nothing.
 */
export function sameIssue(a: Issue, b: Issue): boolean {
  for (const key of Object.keys(ISSUE_KEYS) as (keyof Issue)[]) {
    const left = key === 'dueDate' ? (a.dueDate ?? null) : a[key];
    const right = key === 'dueDate' ? (b.dueDate ?? null) : b[key];
    if (left !== right) return false;
  }
  return true;
}

// Whether Linear's relations of an issue are exactly the mirrored ones
// touching it: the same ids with the same blocker and blocked ends.
function sameRelations(
  snapshot: Snapshot,
  issueId: string,
  fetched: readonly BlockingRelation[]
): boolean {
  const key = (r: BlockingRelation): string =>
    `${r.id}\u0000${r.blockerId}\u0000${r.blockedId}`;
  const mirrored = new Set(
    snapshot.data.relations
      .filter((r) => r.blockerId === issueId || r.blockedId === issueId)
      .map(key)
  );
  const seen = new Set(fetched.map(key));
  if (seen.size !== mirrored.size) return false;
  for (const entry of seen) if (!mirrored.has(entry)) return false;
  return true;
}

async function issueChanges(
  rt: EngineRuntime,
  event: WebhookEvent,
  issueId: string,
  snapshot: Snapshot,
  log: Logger
): Promise<MirrorChanges> {
  if (event.action === 'remove') return issueRemoval(snapshot, issueId);
  const gateway = await rt.linear.forApp(event.workspaceId);
  const issue = await gateway.fetchIssue(issueId);
  // null = deleted or archived (Linear sends archiving as an update).
  if (issue === null) return issueRemoval(snapshot, issueId);

  const changes: MirrorChanges = { upsert: [], remove: [] };
  if (issue.projectId === null) {
    if (!keepsLooseIssue(snapshot, issue))
      return issueRemoval(snapshot, issueId);
  } else {
    const projectMissing = !snapshot.projects.has(issue.projectId);
    const milestoneMissing =
      issue.milestoneId !== null && !snapshot.milestones.has(issue.milestoneId);
    if (projectMissing || milestoneMissing) {
      // A milestone created (or project newly visible) since the last sync.
      const project = await projectRefresh(gateway, snapshot, issue.projectId);
      if (project === null) {
        log.info('issue belongs to a project the mirror does not keep', {
          issueId,
          projectId: issue.projectId,
        });
        return issueRemoval(snapshot, issueId);
      }
      changes.upsert.push(...project.upsert);
      changes.remove.push(...project.remove);
    }
  }

  // Replace every relation touching the issue with Linear's current set.
  const relations = await gateway.fetchIssueRelations(issueId);
  const mirrored = snapshot.issues.get(issueId);
  const entity = refetchedIssue(event, issue, mirrored);
  // The echo of a change the mirror already holds (a person's edit or a
  // bulk move, patched at once): writing it again would only bump the
  // mirror version and make the next read re-index the whole mirror.
  if (
    changes.upsert.length === 0 &&
    changes.remove.length === 0 &&
    mirrored !== undefined &&
    sameIssue(mirrored, entity) &&
    sameRelations(snapshot, issueId, relations)
  ) {
    return { upsert: [], remove: [] };
  }
  changes.remove.push(...relationRefsTouching(snapshot, issueId));
  changes.upsert.push({ kind: 'issue', entity });
  for (const relation of relations) {
    changes.upsert.push({ kind: 'relation', entity: relation });
  }
  return changes;
}

async function projectChanges(
  rt: EngineRuntime,
  event: WebhookEvent,
  projectId: string,
  snapshot: Snapshot
): Promise<MirrorChanges> {
  if (event.action === 'remove') return projectRemoval(snapshot, projectId);
  const gateway = await rt.linear.forApp(event.workspaceId);
  const refreshed = await projectRefresh(gateway, snapshot, projectId);
  return refreshed ?? projectRemoval(snapshot, projectId);
}

// Initiatives and users: refetch and upsert, or delete when gone.
async function simpleChanges<K extends 'initiative' | 'user'>(
  rt: EngineRuntime,
  event: WebhookEvent,
  kind: K,
  id: string
): Promise<MirrorChanges> {
  const removal: MirrorChanges = { upsert: [], remove: [{ kind, id }] };
  if (event.action === 'remove') return removal;
  const gateway = await rt.linear.forApp(event.workspaceId);
  if (kind === 'initiative') {
    const entity = await gateway.fetchInitiative(id);
    return entity === null
      ? removal
      : { upsert: [{ kind: 'initiative', entity }], remove: [] };
  }
  const entity = await gateway.fetchUser(id);
  return entity === null
    ? removal
    : { upsert: [{ kind: 'user', entity }], remove: [] };
}

// Routes one recorded delivery. Returns 'ignored' for types and actions
// the mirror does not track.
async function applyWebhook(
  rt: EngineRuntime,
  event: WebhookEvent,
  log: Logger
): Promise<WebhookOutcome> {
  const { workspaceId } = event;
  if (event.type === 'OAuthApp') {
    if (event.action !== 'revoked') {
      log.warn('unexpected OAuthApp webhook action; ignored');
      return 'ignored';
    }
    await rt.store.markInstallationRevoked(workspaceId, rt.nowIso());
    rt.mirror.forget(workspaceId);
    log.error('the app was revoked for this workspace; it must be reinstalled');
    return 'processed';
  }
  if (event.type === 'OAuthAuthorization') {
    // A user's grant changed; a dead user token shows up as a failed
    // refresh and that person signs in again.
    log.info('user authorization changed; nothing to do');
    return 'ignored';
  }
  const tracked = ['Issue', 'Project', 'Initiative', 'User'];
  if (!tracked.includes(event.type)) return 'ignored';
  if (event.entityId === null) {
    log.warn('webhook without an entity id; ignored');
    return 'ignored';
  }
  const view = await rt.mirror.current(workspaceId);
  if (view === null) {
    log.info('no mirror yet; the first full sync will include this change');
    return 'ignored';
  }

  let changes: MirrorChanges;
  try {
    if (event.type === 'Issue') {
      changes = await issueChanges(
        rt,
        event,
        event.entityId,
        view.snapshot,
        log
      );
    } else if (event.type === 'Project') {
      changes = await projectChanges(rt, event, event.entityId, view.snapshot);
    } else if (event.type === 'Initiative') {
      changes = await simpleChanges(rt, event, 'initiative', event.entityId);
    } else {
      changes = await simpleChanges(rt, event, 'user', event.entityId);
    }
  } catch (error) {
    if (error instanceof EngineAuthError && error.code === 'not_installed') {
      log.warn('webhook for a workspace that is not installed; ignored');
      return 'ignored';
    }
    throw error;
  }
  // Removing what the mirror never had is a no-op; skipping it keeps the
  // mirror version (and every cached snapshot) unchanged.
  changes.remove = changes.remove.filter((ref) =>
    isMirrored(view.snapshot, ref)
  );
  if (changes.upsert.length === 0 && changes.remove.length === 0) {
    log.debug('webhook changed nothing the mirror keeps', {
      entityId: event.entityId,
    });
    return 'processed';
  }
  const version = await rt.store.applyMirrorChanges(workspaceId, changes);
  log.info('webhook applied to the mirror', {
    entityId: event.entityId,
    upserts: changes.upsert.length,
    removals: changes.remove.length,
    version,
  });
  await syncForNewProjects(rt, workspaceId, changes, view.snapshot, log);
  return 'processed';
}

// A project the mirror did not have (reopened, or newly visible to the
// app) arrives through projectRefresh with its milestones but none of its
// issues: there is no per-project issue read, and fetchWorkspace left the
// closed project's issues out. A full sync brings them in at once instead
// of leaving its milestones empty until the next periodic sync. Its
// failure is logged (fullSync records it on sync_state); the webhook's own
// change is already applied.
async function syncForNewProjects(
  rt: EngineRuntime,
  workspaceId: string,
  changes: MirrorChanges,
  snapshot: Snapshot,
  log: Logger
): Promise<void> {
  const added: string[] = [];
  for (const entry of changes.upsert) {
    if (entry.kind === 'project' && !snapshot.projects.has(entry.entity.id)) {
      added.push(entry.entity.id);
    }
  }
  if (added.length === 0) return;
  log.info('a project joined the mirror; syncing to bring its issues', {
    projectIds: added,
  });
  try {
    await fullSync(rt, workspaceId);
  } catch (error) {
    log.warn('the sync for a newly mirrored project failed', { error });
  }
}

/**
 * The engine's handleWebhook. Demo mode ignores webhooks. A delivery id
 * seen before returns 'duplicate' without doing anything. Processing errors
 * are recorded on the delivery (markWebhookProcessed) and logged; the call
 * then still resolves ('processed': the delivery was handled and its error
 * recorded), so the route never fails because of a webhook.
 */
export async function handleWebhook(
  rt: EngineRuntime,
  event: WebhookEvent
): Promise<'processed' | 'duplicate' | 'ignored'> {
  // A blank Linear-Delivery header is no id at all: deduping on '' would
  // drop every later delivery that also lacks one.
  const deliveryId =
    typeof event.deliveryId === 'string' && event.deliveryId.trim() !== ''
      ? event.deliveryId
      : null;
  const log = rt.logger.child({
    workspaceId: event.workspaceId,
    deliveryId,
    webhookType: event.type,
    action: event.action,
  });
  if (rt.linear.mode === 'fixture') {
    log.debug('webhook ignored in demo mode');
    return 'ignored';
  }
  // Personal API keys: no webhooks (the route answers 404 before this).
  if (rt.config.auth === 'api_key') {
    log.warn('webhook ignored: this planner uses personal API keys');
    return 'ignored';
  }

  if (deliveryId !== null) {
    try {
      const fresh = await rt.store.recordWebhookDelivery({
        deliveryId,
        workspaceId: event.workspaceId,
        type: event.type,
        action: event.action,
        entityId: event.entityId,
        receivedAt: rt.nowIso(),
      });
      if (!fresh) {
        log.info('duplicate webhook delivery; skipped');
        return 'duplicate';
      }
    } catch (error) {
      log.error('could not record the webhook delivery', { error });
      return 'ignored';
    }
  }

  let outcome: WebhookOutcome;
  let failure: string | null = null;
  try {
    outcome = await applyWebhook(rt, event, log);
  } catch (error) {
    failure = errorMessage(error);
    outcome = 'processed';
    log.error('webhook processing failed; the next full sync heals it', {
      error,
      entityId: event.entityId,
    });
  }
  if (deliveryId !== null) {
    try {
      await rt.store.markWebhookProcessed(deliveryId, {
        at: rt.nowIso(),
        error: failure,
      });
    } catch (error) {
      log.error('could not mark the webhook delivery processed', { error });
    }
  }
  return outcome;
}
