// Maps Linear GraphQL nodes (as selected by queries.ts) into the core domain
// types. Every input is `unknown` and narrowed field by field; required
// fields that are missing raise LinearApiError('graphql') naming the field.
// Linear-specific quirks are normalised here, once:
// - Issue.priority is a Float → rounded and clamped to 0..4.
// - WorkflowState.type "duplicate" → canceled; unknown types → backlog.
// - Timestamps are normalised to `toISOString()` so string order is time
//   order; TimelessDate values are kept as `YYYY-MM-DD`.

import type {
  BlockingRelation,
  Initiative,
  IsoDate,
  IsoDateTime,
  Issue,
  Milestone,
  Priority,
  Project,
  ProjectStatusType,
  Team,
  User,
  WorkflowState,
  WorkflowStateType,
} from '@better-tracker/core';

import type { LinearLogger } from './client';
import { LinearApiError } from './gateway';
import {
  isRecord,
  type JsonObject,
  optionalNumber,
  optionalObject,
  optionalRefId,
  optionalString,
  readConnection,
  requireBoolean,
  requireRefId,
  requireString,
} from './json';

function asNode(value: unknown, entity: string): JsonObject {
  if (!isRecord(value)) {
    throw new LinearApiError(
      'graphql',
      `Malformed Linear response: ${entity} is not an object`
    );
  }
  return value;
}

/** Linear priority (Float on issues, Int elsewhere) → 0..4. */
export function mapPriority(value: unknown): Priority {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  const rounded = Math.round(value);
  if (rounded <= 0) return 0;
  if (rounded >= 4) return 4;
  return rounded as Priority;
}

const WORKFLOW_STATE_TYPES: ReadonlySet<string> = new Set<WorkflowStateType>([
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
]);

/**
 * WorkflowState.type is a free String in Linear's schema. "duplicate" is a
 * closed state (→ canceled); anything unknown becomes backlog (open, never
 * auto-started) and is logged so a schema change is noticed.
 */
export function mapWorkflowStateType(
  type: string,
  logger?: LinearLogger,
  stateId?: string
): WorkflowStateType {
  if (type === 'duplicate') return 'canceled';
  if (WORKFLOW_STATE_TYPES.has(type)) return type as WorkflowStateType;
  logger?.warn('unknown Linear workflow state type; treating as backlog', {
    type,
    stateId: stateId ?? null,
  });
  return 'backlog';
}

const PROJECT_STATUS_TYPES: ReadonlySet<string> = new Set<ProjectStatusType>([
  'backlog',
  'planned',
  'started',
  'paused',
  'completed',
  'canceled',
]);

/**
 * ProjectStatus.type (an enum in the SDL). An unknown future value maps to
 * backlog, which is not an active status, so the tool never writes to a
 * project it does not understand.
 */
export function mapProjectStatusType(
  type: string,
  logger?: LinearLogger,
  projectId?: string
): ProjectStatusType {
  if (PROJECT_STATUS_TYPES.has(type)) return type as ProjectStatusType;
  logger?.warn('unknown Linear project status type; treating as backlog', {
    type,
    projectId: projectId ?? null,
  });
  return 'backlog';
}

// Parses a DateTime string and re-serialises it so every timestamp in the
// mirror has the same format; null when absent or unparseable.
function optionalDateTime(obj: JsonObject, key: string): IsoDateTime | null {
  const raw = optionalString(obj, key);
  if (raw === null) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function requireDateTime(
  obj: JsonObject,
  key: string,
  entity: string
): IsoDateTime {
  const value = optionalDateTime(obj, key);
  if (value === null) {
    throw new LinearApiError(
      'graphql',
      `Malformed Linear response: ${entity}.${key} is not a timestamp`
    );
  }
  return value;
}

const TIMELESS_DATE = /^(\d{4}-\d{2}-\d{2})/;

/** A TimelessDate (`YYYY-MM-DD`), or null when absent or malformed. */
function optionalTimelessDate(obj: JsonObject, key: string): IsoDate | null {
  const raw = optionalString(obj, key);
  if (raw === null) return null;
  return TIMELESS_DATE.exec(raw)?.[1] ?? null;
}

// Ids of a nested `{ nodes { id } pageInfo { hasNextPage } }` connection.
// These lists are fetched with a small `first` (complexity budget), so a
// longer list is logged instead of being cut off silently.
function connectionIds(
  obj: JsonObject,
  key: string,
  entity: string,
  logger: LinearLogger | undefined,
  entityId: string
): string[] {
  const value = obj[key];
  if (value === undefined || value === null) return [];
  const page = readConnection(value, `${entity}.${key}`);
  const ids: string[] = [];
  for (const node of page.nodes) {
    const id = optionalString(node, 'id');
    if (id !== null) ids.push(id);
  }
  if (page.hasNextPage) {
    logger?.warn('linear id list truncated; only the first page is kept', {
      entity,
      field: key,
      id: entityId,
      kept: ids.length,
    });
  }
  return ids;
}

/**
 * The sync's fallback for Issue.lastStateChangeAt: the latest of the
 * lifecycle timestamps Linear always returns. It underestimates moves
 * between open states (e.g. Todo → In Review), which is why the engine
 * refines it with fetchLastStateChanges for milestones that matter.
 */
export function approximateLastStateChangeAt(issue: {
  createdAt: IsoDateTime;
  startedAt: IsoDateTime | null;
  completedAt: IsoDateTime | null;
  canceledAt: IsoDateTime | null;
}): IsoDateTime {
  let latest = issue.createdAt;
  let latestMs = Date.parse(latest);
  for (const candidate of [
    issue.startedAt,
    issue.completedAt,
    issue.canceledAt,
  ]) {
    if (candidate === null) continue;
    const ms = Date.parse(candidate);
    if (ms > latestMs) {
      latest = candidate;
      latestMs = ms;
    }
  }
  return latest;
}

export function mapUser(value: unknown): User {
  const node = asNode(value, 'User');
  const email = optionalString(node, 'email');
  return {
    id: requireString(node, 'id', 'User'),
    name: requireString(node, 'name', 'User'),
    displayName:
      optionalString(node, 'displayName') ??
      requireString(node, 'name', 'User'),
    email: email === null || email.trim() === '' ? null : email,
    avatarUrl: optionalString(node, 'avatarUrl'),
    active: requireBoolean(node, 'active', 'User'),
    app: requireBoolean(node, 'app', 'User'),
  };
}

export function mapTeam(value: unknown): Team {
  const node = asNode(value, 'Team');
  return {
    id: requireString(node, 'id', 'Team'),
    key: requireString(node, 'key', 'Team'),
    name: requireString(node, 'name', 'Team'),
  };
}

export function mapWorkflowState(
  value: unknown,
  logger?: LinearLogger
): WorkflowState {
  const node = asNode(value, 'WorkflowState');
  const id = requireString(node, 'id', 'WorkflowState');
  return {
    id,
    teamId: requireRefId(node, 'team', 'WorkflowState'),
    name: requireString(node, 'name', 'WorkflowState'),
    type: mapWorkflowStateType(
      requireString(node, 'type', 'WorkflowState'),
      logger,
      id
    ),
    position: optionalNumber(node, 'position') ?? 0,
  };
}

export function mapInitiative(value: unknown): Initiative {
  const node = asNode(value, 'Initiative');
  return {
    id: requireString(node, 'id', 'Initiative'),
    name: requireString(node, 'name', 'Initiative'),
    sortOrder: optionalNumber(node, 'sortOrder') ?? 0,
    priority: mapPriority(node['priority']),
    targetDate: optionalTimelessDate(node, 'targetDate'),
  };
}

export function mapProject(value: unknown, logger?: LinearLogger): Project {
  const node = asNode(value, 'Project');
  const id = requireString(node, 'id', 'Project');
  const status = optionalObject(node, 'status');
  const statusType = status === null ? null : optionalString(status, 'type');
  if (status === null || statusType === null) {
    throw new LinearApiError(
      'graphql',
      'Malformed Linear response: Project.status.type is missing'
    );
  }
  return {
    id,
    name: requireString(node, 'name', 'Project'),
    url: requireString(node, 'url', 'Project'),
    leadId: optionalRefId(node, 'lead'),
    priority: mapPriority(node['priority']),
    sortOrder: optionalNumber(node, 'sortOrder') ?? 0,
    statusType: mapProjectStatusType(statusType, logger, id),
    statusName: optionalString(status, 'name') ?? statusType,
    initiativeIds: connectionIds(node, 'initiatives', 'Project', logger, id),
    teamIds: connectionIds(node, 'teams', 'Project', logger, id),
    startDate: optionalTimelessDate(node, 'startDate'),
    targetDate: optionalTimelessDate(node, 'targetDate'),
  };
}

export function mapMilestone(value: unknown): Milestone {
  const node = asNode(value, 'ProjectMilestone');
  return {
    id: requireString(node, 'id', 'ProjectMilestone'),
    projectId: requireRefId(node, 'project', 'ProjectMilestone'),
    name: requireString(node, 'name', 'ProjectMilestone'),
    description: optionalString(node, 'description'),
    targetDate: optionalTimelessDate(node, 'targetDate'),
    sortOrder: optionalNumber(node, 'sortOrder') ?? 0,
  };
}

export function mapIssue(value: unknown): Issue {
  const node = asNode(value, 'Issue');
  const createdAt = requireDateTime(node, 'createdAt', 'Issue');
  const startedAt = optionalDateTime(node, 'startedAt');
  const completedAt = optionalDateTime(node, 'completedAt');
  const canceledAt = optionalDateTime(node, 'canceledAt');
  return {
    id: requireString(node, 'id', 'Issue'),
    identifier: requireString(node, 'identifier', 'Issue'),
    title: requireString(node, 'title', 'Issue'),
    url: requireString(node, 'url', 'Issue'),
    teamId: requireRefId(node, 'team', 'Issue'),
    projectId: optionalRefId(node, 'project'),
    milestoneId: optionalRefId(node, 'projectMilestone'),
    assigneeId: optionalRefId(node, 'assignee'),
    stateId: requireRefId(node, 'state', 'Issue'),
    priority: mapPriority(node['priority']),
    createdAt,
    updatedAt: optionalDateTime(node, 'updatedAt') ?? createdAt,
    startedAt,
    completedAt,
    canceledAt,
    lastStateChangeAt: approximateLastStateChangeAt({
      createdAt,
      startedAt,
      completedAt,
      canceledAt,
    }),
  };
}

/**
 * A Linear IssueRelation as a BlockingRelation, or null for every type
 * other than "blocks" (related, duplicate, similar…). For "blocks", `issue`
 * is the blocker and `relatedIssue` the blocked one.
 */
export function mapBlockingRelation(value: unknown): BlockingRelation | null {
  const node = asNode(value, 'IssueRelation');
  if (optionalString(node, 'type') !== 'blocks') return null;
  return {
    id: requireString(node, 'id', 'IssueRelation'),
    blockerId: requireRefId(node, 'issue', 'IssueRelation'),
    blockedId: requireRefId(node, 'relatedIssue', 'IssueRelation'),
  };
}

/** True when a single-entity node is archived (or trashed, for issues). */
export function isArchivedNode(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    optionalString(value, 'archivedAt') !== null || value['trashed'] === true
  );
}
