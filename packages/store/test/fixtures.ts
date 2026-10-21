import type { Digest, WorkspaceData } from '@better-tracker/core';
// Shared test data: a small but complete WorkspaceData (every mirrored
// entity kind, nullable fields both set and unset) and a realistic digest.
import { randomUUID } from 'node:crypto';

import type { Installation, StoredTokens } from '../src/types';

/**
 * A valid TOKEN_ENCRYPTION_KEY (32 bytes, base64). Fixed rather than random
 * so rows left in a shared DATABASE_URL by an earlier run still decrypt.
 */
export const TEST_KEY: string = Buffer.alloc(32, 7).toString('base64');

/** A unique workspace id per test, so tests never see each other's rows. */
export function newWorkspaceId(): string {
  return `ws-${randomUUID()}`;
}

export function tokens(suffix: string): StoredTokens {
  return {
    accessToken: `lin_oauth_access_${suffix}`,
    refreshToken: `lin_oauth_refresh_${suffix}`,
    expiresAt: '2026-10-22T08:00:00.000Z',
    scopes: ['read', 'write'],
  };
}

export function installation(workspaceId: string): Installation {
  return {
    workspaceId,
    workspaceName: 'Acme Robotics',
    urlKey: 'acme',
    appUserId: 'app-user',
    installedByUserId: 'u-ana',
    revokedAt: null,
    tokens: tokens('install'),
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
  };
}

export function workspaceData(workspaceId: string): WorkspaceData {
  return {
    workspaceId,
    users: [
      {
        id: 'u-ana',
        name: 'Ana Lead',
        displayName: 'ana',
        email: 'ana@example.com',
        avatarUrl: 'https://example.com/ana.png',
        active: true,
        app: false,
      },
      {
        id: 'u-bo',
        name: 'Bo Former',
        displayName: 'bo',
        email: null,
        avatarUrl: null,
        active: false,
        app: false,
      },
      {
        id: 'app-user',
        name: 'Milestone Planner',
        displayName: 'planner',
        email: null,
        avatarUrl: null,
        active: true,
        app: true,
      },
    ],
    teams: [
      { id: 't-eng', key: 'ENG', name: 'Engineering' },
      { id: 't-ops', key: 'OPS', name: 'Operations' },
    ],
    states: [
      {
        id: 's-triage',
        teamId: 't-eng',
        name: 'Triage',
        type: 'triage',
        position: 0,
      },
      {
        id: 's-backlog',
        teamId: 't-eng',
        name: 'Backlog',
        type: 'backlog',
        position: 1,
      },
      {
        id: 's-todo',
        teamId: 't-eng',
        name: 'Todo',
        type: 'unstarted',
        position: 2.5,
      },
      {
        id: 's-done',
        teamId: 't-eng',
        name: 'Done',
        type: 'completed',
        position: 4,
      },
    ],
    initiatives: [
      {
        id: 'i-launch',
        name: 'Launch',
        sortOrder: -12.75,
        priority: 1,
        targetDate: '2026-12-01',
      },
    ],
    projects: [
      {
        id: 'p-orion',
        name: 'Orion migration',
        url: 'https://linear.app/acme/project/orion',
        leadId: 'u-ana',
        priority: 2,
        sortOrder: 1,
        statusType: 'started',
        statusName: 'In Progress',
        initiativeIds: ['i-launch'],
        teamIds: ['t-eng', 't-ops'],
        startDate: '2026-10-01',
        targetDate: null,
      },
      {
        id: 'p-halo',
        name: 'Halo',
        url: 'https://linear.app/acme/project/halo',
        leadId: null,
        priority: 0,
        sortOrder: 2,
        statusType: 'paused',
        statusName: 'Paused',
        initiativeIds: [],
        teamIds: [],
        startDate: null,
        targetDate: '2027-01-15',
      },
    ],
    milestones: [
      {
        id: 'm-alpha',
        projectId: 'p-orion',
        name: 'Alpha',
        description: 'Done means: the old cluster is off',
        targetDate: '2026-10-28',
        sortOrder: 1,
      },
      {
        id: 'm-beta',
        projectId: 'p-orion',
        name: 'Beta',
        description: null,
        targetDate: null,
        sortOrder: 2,
      },
      {
        id: 'm-halo',
        projectId: 'p-halo',
        name: 'Halo v1',
        description: '',
        targetDate: '2026-11-11',
        sortOrder: 0,
      },
    ],
    issues: [
      {
        id: 'iss-1',
        identifier: 'ENG-1',
        title: 'Move "orders" table — with unicode ✓',
        url: 'https://linear.app/acme/issue/ENG-1',
        teamId: 't-eng',
        projectId: 'p-orion',
        milestoneId: 'm-alpha',
        assigneeId: null,
        stateId: 's-backlog',
        priority: 1,
        createdAt: '2026-09-01T10:00:00.000Z',
        updatedAt: '2026-10-20T10:00:00.000Z',
        startedAt: null,
        completedAt: null,
        canceledAt: null,
        lastStateChangeAt: '2026-09-01T10:00:00.000Z',
      },
      {
        id: 'iss-2',
        identifier: 'ENG-2',
        title: 'Cut over',
        url: 'https://linear.app/acme/issue/ENG-2',
        teamId: 't-eng',
        projectId: 'p-orion',
        milestoneId: 'm-alpha',
        assigneeId: 'u-ana',
        stateId: 's-done',
        priority: 0,
        createdAt: '2026-09-02T10:00:00.000Z',
        updatedAt: '2026-10-19T10:00:00.000Z',
        startedAt: '2026-10-01T10:00:00.000Z',
        completedAt: '2026-10-19T10:00:00.000Z',
        canceledAt: null,
        lastStateChangeAt: '2026-10-19T10:00:00.000Z',
      },
      {
        id: 'iss-3',
        identifier: 'ENG-3',
        title: 'Unplanned cleanup',
        url: 'https://linear.app/acme/issue/ENG-3',
        teamId: 't-eng',
        projectId: 'p-orion',
        milestoneId: null,
        assigneeId: null,
        stateId: 's-triage',
        priority: 4,
        createdAt: '2026-10-10T10:00:00.000Z',
        updatedAt: '2026-10-10T10:00:00.000Z',
        startedAt: null,
        completedAt: null,
        canceledAt: null,
        lastStateChangeAt: '2026-10-10T10:00:00.000Z',
      },
      {
        id: 'iss-4',
        identifier: 'OPS-9',
        title: 'No project at all',
        url: 'https://linear.app/acme/issue/OPS-9',
        teamId: 't-ops',
        projectId: null,
        milestoneId: null,
        assigneeId: 'u-bo',
        stateId: 's-todo',
        priority: 3,
        createdAt: '2026-10-11T10:00:00.000Z',
        updatedAt: '2026-10-11T10:00:00.000Z',
        startedAt: null,
        completedAt: null,
        canceledAt: '2026-10-12T10:00:00.000Z',
        lastStateChangeAt: '2026-10-12T10:00:00.000Z',
      },
    ],
    relations: [
      { id: 'rel-1', blockerId: 'iss-1', blockedId: 'iss-2' },
      { id: 'rel-2', blockerId: 'iss-4', blockedId: 'iss-1' },
    ],
  };
}

export function digest(recipientId: string, day: string): Digest {
  return {
    recipientId,
    recipientName: 'Ana Lead',
    recipientEmail: 'ana@example.com',
    day,
    items: [
      {
        notice: {
          kind: 'at_risk',
          subjectKind: 'milestone',
          subjectId: 'm-alpha',
          projectId: 'p-orion',
          milestoneId: 'm-alpha',
          key: 'at_risk:2026-10-28',
          targetDate: '2026-10-28',
          daysLeft: 7,
          reasons: ['unassigned_open', 'behind_pace'],
          gaps: [],
          blockReason: null,
          openIssueIds: ['iss-1'],
          unassignedIssueIds: ['iss-1'],
          recipientIds: [recipientId, 'u-watcher'],
          occurrence: 1,
        },
        projectName: 'Orion migration',
        milestoneName: 'Alpha',
        leadName: 'Ana Lead',
        openCount: 1,
        unassignedCount: 1,
        lines: ['1 open issue unassigned', '1/2 done with 7 days left'],
        url: 'https://planner.example.com/timeline?milestone=m-alpha',
      },
    ],
  };
}

/**
 * Awaits a promise that must reject and returns the Error it rejected with,
 * so tests can assert on the message (bun's `rejects` matchers are typed as
 * synchronous, which the type-aware linter rejects when awaited).
 */
export async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw new Error(`Rejected with a non-Error value: ${String(error)}`);
  }
  throw new Error('Expected the promise to reject, but it resolved');
}
