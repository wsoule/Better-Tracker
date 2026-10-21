// handleWebhook (§7, §4.1): a verified Linear delivery is recorded (deduped
// by its Linear-Delivery id), then the touched entity is refetched through
// the app actor and patched into the mirror. Linear sends no webhooks for
// project milestones or issue relations, so an Issue event also replaces
// that issue's relations and an Issue/Project event refreshes the project's
// milestones; the periodic full sync heals anything still missed. Errors are
// recorded on the delivery and logged, never thrown to the route.

import {
  isOpenState,
  type Issue,
  type Project,
  type Snapshot,
} from '@better-tracker/core';
import type { LinearGateway } from '@better-tracker/linear';
import type { Logger } from '@better-tracker/logger';
import type { MirrorEntity, MirrorRef } from '@better-tracker/store';

import { type EngineRuntime, errorMessage } from './runtime';
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

/**
 * Whether the mirror keeps an issue without a project: only open ones,
 * exactly the set fetchWorkspace mirrors (issues of mirrored projects are
 * kept open and closed, for progress).
 */
export function keepsLooseIssue(snapshot: Snapshot, issue: Issue): boolean {
  const type = snapshot.states.get(issue.stateId)?.type ?? 'backlog';
  return isOpenState(type);
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
  changes.remove.push(...relationRefsTouching(snapshot, issueId));
  changes.upsert.push({ kind: 'issue', entity: issue });
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
  return 'processed';
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
