import {
  assessWorkspace,
  buildIssueDetail,
  DEFAULT_TUNING,
  estimateOptions,
  type EstimateScale,
  type EvalContext,
  indexWorkspace,
  type IssueDetail,
  type IssueExtras,
  type IssueLabel,
  type MilestoneMeta,
} from '@better-tracker/core';
import type { IssueDetailResult } from '@better-tracker/engine';
import {
  createFixtureWorkspace,
  FIXTURE_MILESTONE_META,
} from '@better-tracker/linear';

import {
  buildIssueTaskModel,
  findIssue,
  type IssueHistoryEntry,
  type IssueTaskModel,
} from '../lib/adapters/issue';

// Issue view fixtures for the planner's tests: the demo workspace (what
// LINEAR_FIXTURE=1 serves) on Wednesday, October 21, 2026. The mirror half
// of an IssueDetailResult comes from core's buildIssueDetail; the live half
// (description, labels, estimate, comments) is written here the way the
// engine returns it.

export const TODAY = '2026-10-21';
export const snapshot = indexWorkspace(createFixtureWorkspace(TODAY));
const meta = new Map<string, MilestoneMeta>(
  FIXTURE_MILESTONE_META.map((m) => [
    m.milestoneId,
    { ...m, updatedAt: '2026-10-01T00:00:00.000Z', updatedBy: null },
  ])
);
const ctx: EvalContext = {
  today: TODAY,
  now: '2026-10-21T12:00:00.000Z',
  tuning: DEFAULT_TUNING,
  meta,
};
const assessments = assessWorkspace(snapshot, ctx);
export const names = new Map(snapshot.data.users.map((u) => [u.id, u.name]));

export function detailOf(identifier: string): IssueDetail {
  const issue = findIssue(snapshot.issues, identifier);
  const detail =
    issue === undefined
      ? null
      : buildIssueDetail({ snapshot, ctx, assessments, issueId: issue.id });
  if (detail === null) throw new Error(`no ${identifier} in the fixture`);
  return detail;
}

export const FIBONACCI: EstimateScale = {
  type: 'fibonacci',
  allowZero: false,
  extended: false,
};

export const LABELS: IssueLabel[] = [
  {
    id: 'l-bug',
    name: 'Bug',
    color: '#eb5757',
    teamId: 'team-eng',
    group: null,
  },
  {
    id: 'l-s',
    name: 'S',
    color: '#bec2c8',
    teamId: 'team-eng',
    group: { id: 'g-size', name: 'Size', singleSelect: true },
  },
];

export function extrasFor(
  detail: IssueDetail,
  over: Partial<IssueExtras> = {}
): IssueExtras {
  return {
    issueId: detail.issue.id,
    description: 'Line one\nLine two',
    labels: LABELS.slice(0, 1),
    estimate: 3,
    dueDate: '2026-10-19',
    comments: [
      {
        id: 'c-1',
        body: 'Started on this.',
        createdAt: '2026-10-20T09:00:00.000Z',
        url: 'https://linear.app/northwind/issue/X#comment-c-1',
        parentId: null,
        author: { id: 'user-dev', name: 'Dev Patel' },
        externalAuthor: null,
      },
      {
        id: 'c-2',
        body: 'Synced from GitHub.',
        createdAt: '2026-10-21T08:00:00.000Z',
        url: null,
        parentId: null,
        author: null,
        externalAuthor: 'GitHub',
      },
    ],
    commentsTruncated: false,
    estimateScale: FIBONACCI,
    ...over,
  };
}

export function resultFor(
  identifier: string,
  over: Partial<IssueDetailResult> = {}
): IssueDetailResult {
  const detail = detailOf(identifier);
  return {
    detail,
    extra: extrasFor(detail),
    extraError: null,
    extraSource: 'actor',
    labels: LABELS,
    estimateScale: FIBONACCI,
    estimateOptions: estimateOptions(FIBONACCI),
    allocationHistory: [],
    canEdit: true,
    readOnly: false,
    ...over,
  };
}

export function modelFor(
  identifier: string,
  over: Partial<IssueDetailResult> = {},
  viewerId = 'user-chloe'
): IssueTaskModel {
  return buildIssueTaskModel({
    result: resultFor(identifier, over),
    today: TODAY,
    timeZone: 'UTC',
    viewerId,
    grantWriteHref: '/api/auth/linear?intent=grant_write&returnTo=%2Fx',
    names,
  });
}

export function history(entry: Partial<IssueHistoryEntry>): IssueHistoryEntry {
  return {
    runId: 'run-1',
    seq: 1,
    action: 'assign',
    outcome: 'applied',
    projectId: 'proj-atlas',
    milestoneId: 'ms-atlas-2',
    issueId: 'iss-eng-13',
    issueIdentifier: 'ENG-13',
    assigneeId: 'user-chloe',
    reason: 'comment-1',
    detail: {},
    error: null,
    createdAt: '2026-10-14T06:00:00.000Z',
    runMode: 'live',
    runTrigger: 'schedule',
    ...entry,
  };
}
