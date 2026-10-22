// The issue page's gateway methods (owner decision 2026-10-21) against a
// fake fetch: fetchIssueDetail, listIssueLabels, updateIssueFields,
// createBlockingRelation and deleteRelation. Nothing reaches Linear.

import { describe, expect, test } from 'bun:test';

import { LinearApiError } from '../src/gateway';
import {
  createLinearGateway,
  issueUpdateInput,
  readableWriteError,
} from '../src/linear-gateway';
import { mapComment, mapEstimateScale, mapIssueLabel } from '../src/map';
import {
  ISSUE_COMMENTS_MAX,
  ISSUE_COMMENTS_MAX_PAGES,
  ISSUE_DETAIL_QUERY,
  PAGE_SIZE,
  TEAM_ANCESTOR_LEVELS,
} from '../src/queries';
import {
  caught,
  connection,
  dataResponse,
  graphqlFetch,
  type GraphqlHandler,
  issueNode,
  jsonResponse,
  noSleep,
  recordingLogger,
  relationNode,
} from './helpers';

function gatewayWith(handlers: Record<string, GraphqlHandler>) {
  const fake = graphqlFetch(handlers);
  const { logger, lines } = recordingLogger();
  const gateway = createLinearGateway({
    accessToken: 'token',
    fetch: fake.fetch,
    sleep: noSleep,
    logger,
  });
  return { gateway, calls: fake.calls, lines };
}

function labelNode(
  id: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    name: `Label ${id}`,
    color: '#5e6ad2',
    isGroup: false,
    team: { id: 'team-1' },
    parent: null,
    ...overrides,
  };
}

function commentNode(
  id: string,
  createdAt: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id,
    body: `Comment ${id}`,
    createdAt,
    url: `https://linear.app/acme/issue/ENG-1#comment-${id}`,
    parent: null,
    user: { id: 'user-1', name: 'Ana' },
    botActor: null,
    externalUser: null,
    ...overrides,
  };
}

function teamNode(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'team-1',
    issueEstimationType: 'fibonacci',
    issueEstimationAllowZero: false,
    issueEstimationExtended: true,
    inheritIssueEstimation: false,
    parent: null,
    ...overrides,
  };
}

function detailNode(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'issue-1',
    description: 'Fix **the** thing',
    estimate: 5,
    dueDate: '2026-11-02',
    archivedAt: null,
    trashed: null,
    team: teamNode(),
    labels: connection([
      labelNode('l-2', { name: 'Bug' }),
      labelNode('l-1', {
        name: 'Backend',
        parent: { id: 'g-area', name: 'Area', groupType: null },
      }),
    ]),
    comments: connection([
      commentNode('c-2', '2026-10-20T10:00:00.000Z'),
      commentNode('c-1', '2026-10-19T10:00:00.000Z'),
    ]),
    ...overrides,
  };
}

describe('fetchIssueDetail', () => {
  test('maps description, labels, estimate, due date, comments and scale', async () => {
    const { gateway, calls } = gatewayWith({
      IssueDetail: () => dataResponse({ issue: detailNode() }),
    });
    const detail = await gateway.fetchIssueDetail('issue-1');
    expect(calls.map((c) => [c.operation, c.variables])).toEqual([
      ['IssueDetail', { id: 'issue-1' }],
    ]);
    expect(detail).toEqual({
      issueId: 'issue-1',
      description: 'Fix **the** thing',
      labels: [
        {
          id: 'l-2',
          name: 'Bug',
          color: '#5e6ad2',
          teamId: 'team-1',
          group: null,
        },
        {
          id: 'l-1',
          name: 'Backend',
          color: '#5e6ad2',
          teamId: 'team-1',
          // A group without a groupType is single-select.
          group: { id: 'g-area', name: 'Area', singleSelect: true },
        },
      ],
      estimate: 5,
      dueDate: '2026-11-02',
      // Oldest first, whatever order Linear sent.
      comments: [
        {
          id: 'c-1',
          body: 'Comment c-1',
          createdAt: '2026-10-19T10:00:00.000Z',
          url: 'https://linear.app/acme/issue/ENG-1#comment-c-1',
          parentId: null,
          author: { id: 'user-1', name: 'Ana' },
          externalAuthor: null,
        },
        {
          id: 'c-2',
          body: 'Comment c-2',
          createdAt: '2026-10-20T10:00:00.000Z',
          url: 'https://linear.app/acme/issue/ENG-1#comment-c-2',
          parentId: null,
          author: { id: 'user-1', name: 'Ana' },
          externalAuthor: null,
        },
      ],
      commentsTruncated: false,
      estimateScale: { type: 'fibonacci', allowZero: false, extended: true },
    });
  });

  test('a blank description, no estimate and no due date read as null', async () => {
    const { gateway } = gatewayWith({
      IssueDetail: () =>
        dataResponse({
          issue: detailNode({
            description: '  \n',
            estimate: null,
            dueDate: null,
          }),
        }),
    });
    expect(await gateway.fetchIssueDetail('issue-1')).toMatchObject({
      description: null,
      estimate: null,
      dueDate: null,
    });
  });

  test('null for an archived, trashed or missing issue', async () => {
    for (const handler of [
      () =>
        dataResponse({
          issue: detailNode({ archivedAt: '2026-10-01T00:00:00Z' }),
        }),
      () => dataResponse({ issue: detailNode({ trashed: true }) }),
      () =>
        jsonResponse({
          data: null,
          errors: [
            {
              message: 'Entity not found: Issue',
              path: ['issue'],
              extensions: { code: 'INPUT_ERROR' },
            },
          ],
        }),
    ]) {
      const { gateway } = gatewayWith({ IssueDetail: handler });
      expect(await gateway.fetchIssueDetail('issue-1')).toBeNull();
    }
  });

  test('reads every label page and pages comments up to the cap', async () => {
    const commentPage = (page: number): unknown[] =>
      Array.from({ length: 50 }, (_, i) =>
        commentNode(
          `c-${page}-${i}`,
          new Date(Date.UTC(2026, 9, 1, page, i)).toISOString()
        )
      );
    const { gateway, calls } = gatewayWith({
      IssueDetail: () =>
        dataResponse({
          issue: detailNode({
            labels: connection([labelNode('l-1')], 'L1'),
            comments: connection(commentPage(0), 'C1'),
          }),
        }),
      IssueLabelsPage: () =>
        dataResponse({
          issue: { id: 'issue-1', labels: connection([labelNode('l-2')]) },
        }),
      IssueCommentsPage: (variables) => {
        const page = Number(String(variables['after']).slice(1));
        // Linear always says more follow: the cap must stop the reads.
        return dataResponse({
          issue: {
            id: 'issue-1',
            comments: connection(commentPage(page), `C${page + 1}`),
          },
        });
      },
    });
    const detail = await gateway.fetchIssueDetail('issue-1');
    expect(detail?.labels.map((l) => l.id)).toEqual(['l-1', 'l-2']);
    expect(detail?.comments).toHaveLength(ISSUE_COMMENTS_MAX);
    expect(detail?.commentsTruncated).toBe(true);
    expect(
      calls.filter((c) => c.operation === 'IssueCommentsPage')
    ).toHaveLength(ISSUE_COMMENTS_MAX_PAGES - 1);
    const times = (detail?.comments ?? []).map((c) => c.createdAt);
    expect([...times].sort()).toEqual(times);
  });

  test('bot and integration comments name their source', () => {
    expect(
      mapComment(
        commentNode('c', '2026-10-01T00:00:00Z', {
          user: null,
          botActor: { name: 'GitHub' },
        })
      )
    ).toMatchObject({ author: null, externalAuthor: 'GitHub' });
    expect(
      mapComment(
        commentNode('c', '2026-10-01T00:00:00Z', {
          user: null,
          externalUser: { name: 'Sam (Slack)' },
          parent: { id: 'c-0' },
        })
      )
    ).toMatchObject({
      author: null,
      externalAuthor: 'Sam (Slack)',
      parentId: 'c-0',
    });
  });
});

describe('estimate scale mapping', () => {
  test('a sub-team that inherits takes its parent’s settings', () => {
    expect(
      mapEstimateScale(
        teamNode({
          issueEstimationType: 'notUsed',
          inheritIssueEstimation: true,
          parent: teamNode({
            id: 'parent',
            issueEstimationType: 'tShirt',
            issueEstimationAllowZero: true,
            issueEstimationExtended: false,
          }),
        })
      )
    ).toEqual({ type: 'tShirt', allowZero: true, extended: false });
  });

  test('inheritance follows every level up to the root (five-level teams)', () => {
    // Level 5 inherits from 4, 3 and 2, which all inherit from the root.
    let chain: Record<string, unknown> = teamNode({
      id: 'root',
      issueEstimationType: 'fibonacci',
      issueEstimationExtended: false,
    });
    for (const id of ['level-2', 'level-3', 'level-4', 'level-5']) {
      chain = teamNode({
        id,
        issueEstimationType: 'notUsed',
        inheritIssueEstimation: true,
        parent: chain,
      });
    }
    expect(mapEstimateScale(chain)).toEqual({
      type: 'fibonacci',
      allowZero: false,
      extended: false,
    });
    // The issue detail query reads that many ancestors.
    expect(
      ISSUE_DETAIL_QUERY.match(/parent \{ \.\.\.EstimateScaleFields/g)
    ).toHaveLength(TEAM_ANCESTOR_LEVELS);
    expect(TEAM_ANCESTOR_LEVELS).toBe(4);
  });

  test('a chain that inherits past the levels read is logged', () => {
    const { logger, lines } = recordingLogger();
    const { parent: _cut, ...topRead } = teamNode({
      id: 'top-read',
      issueEstimationType: 'linear',
      inheritIssueEstimation: true,
    });
    expect(
      mapEstimateScale(
        teamNode({ inheritIssueEstimation: true, parent: topRead }),
        logger
      )
    ).toEqual({ type: 'linear', allowZero: false, extended: true });
    expect(lines.map((l) => l.message)).toEqual([
      'Linear team inherits estimates from beyond the levels read',
    ]);
  });

  test('an unknown scale reads as not used and is logged', () => {
    const { logger, lines } = recordingLogger();
    expect(
      mapEstimateScale(teamNode({ issueEstimationType: 'cubic' }), logger)
    ).toEqual({ type: 'notUsed', allowZero: false, extended: false });
    expect(lines.map((l) => l.message)).toEqual([
      'unknown Linear estimate scale; treating as not used',
    ]);
  });

  test('multi-select groups do not exclude each other', () => {
    expect(
      mapIssueLabel(
        labelNode('l', {
          team: null,
          parent: { id: 'g', name: 'Platforms', groupType: 'multiSelect' },
        })
      )
    ).toMatchObject({
      teamId: null,
      group: { id: 'g', name: 'Platforms', singleSelect: false },
    });
  });
});

describe('listIssueLabels', () => {
  test("pages the team's and workspace labels, dropping groups", async () => {
    const { gateway, calls } = gatewayWith({
      TeamIssueLabels: (variables) =>
        variables['after'] === null
          ? dataResponse({
              issueLabels: connection(
                [
                  labelNode('l-z', { name: 'Zeta' }),
                  labelNode('g', { name: 'Area', isGroup: true }),
                ],
                'next'
              ),
            })
          : dataResponse({
              issueLabels: connection([
                labelNode('l-a', { name: 'Alpha', team: null }),
              ]),
            }),
    });
    const labels = await gateway.listIssueLabels('team-1');
    expect(labels.map((l) => [l.id, l.teamId])).toEqual([
      ['l-a', null],
      ['l-z', 'team-1'],
    ]);
    expect(calls.map((c) => c.variables)).toEqual([
      { teamId: 'team-1', first: PAGE_SIZE, after: null },
      { teamId: 'team-1', first: PAGE_SIZE, after: 'next' },
    ]);
  });
});

describe('updateIssueFields', () => {
  test('sends exactly the patch keys and maps the updated issue', async () => {
    const { gateway, calls } = gatewayWith({
      IssueUpdate: () =>
        dataResponse({
          issueUpdate: {
            success: true,
            issue: issueNode('1', {
              title: 'Renamed',
              updatedAt: '2026-10-21T12:00:00.000Z',
            }),
          },
        }),
    });
    const issue = await gateway.updateIssueFields('1', {
      title: 'Renamed',
      description: null,
      assigneeId: null,
      priority: 1,
      projectMilestoneId: null,
      dueDate: '2026-11-30',
      estimate: 3,
      labelIds: ['l-1', 'l-2'],
    });
    expect(issue.title).toBe('Renamed');
    expect(calls[0]?.variables).toEqual({
      id: '1',
      input: {
        title: 'Renamed',
        description: null,
        assigneeId: null,
        priority: 1,
        projectMilestoneId: null,
        dueDate: '2026-11-30',
        estimate: 3,
        labelIds: ['l-1', 'l-2'],
      },
    });
    // No state change: the timestamp approximation stays as mapped.
    expect(issue.lastStateChangeAt).toBe('2026-10-01T10:00:00.000Z');
  });

  test('a state change dates lastStateChangeAt at updatedAt', async () => {
    const { gateway } = gatewayWith({
      IssueUpdate: () =>
        dataResponse({
          issueUpdate: {
            success: true,
            issue: issueNode('1', { updatedAt: '2026-10-21T12:00:00.000Z' }),
          },
        }),
    });
    const issue = await gateway.updateIssueFields('1', { stateId: 'state-2' });
    expect(issue.lastStateChangeAt).toBe('2026-10-21T12:00:00.000Z');
  });

  test('a malformed patch fails before any request', async () => {
    const { gateway, calls } = gatewayWith({});
    for (const patch of [
      {},
      { title: undefined },
      { priority: 5 },
      { priority: 1.5 },
      { dueDate: '11/30/2026' },
      { estimate: 2.5 },
      { labelIds: 'l-1' },
      { title: 3 },
      { assigneeId: 7 },
    ]) {
      expect(
        await caught(
          gateway.updateIssueFields(
            '1',
            patch as Parameters<typeof gateway.updateIssueFields>[1]
          )
        )
      ).toMatchObject({ kind: 'invalid_input' });
    }
    expect(calls).toEqual([]);
  });

  test("Linear's refusal of an estimate reads as a sentence", async () => {
    const { gateway } = gatewayWith({
      IssueUpdate: () =>
        jsonResponse(
          {
            data: null,
            errors: [
              {
                message: 'Argument Validation Error',
                path: ['issueUpdate'],
                extensions: {
                  code: 'INPUT_ERROR',
                  type: 'invalid input',
                  userPresentableMessage:
                    'Estimate 4 is not valid for this team.',
                },
              },
            ],
          },
          { status: 400 }
        ),
    });
    const error = await caught(gateway.updateIssueFields('1', { estimate: 4 }));
    expect(error).toBeInstanceOf(LinearApiError);
    expect(error).toMatchObject({
      kind: 'invalid_input',
      message:
        'Linear refused to update the issue: Estimate 4 is not valid for this team.',
    });
  });

  test('a forbidden edit says Linear does not allow it', async () => {
    const { gateway } = gatewayWith({
      IssueUpdate: () => new Response('', { status: 403 }),
    });
    expect(
      await caught(gateway.updateIssueFields('1', { title: 'x' }))
    ).toMatchObject({
      kind: 'forbidden',
      message: 'Linear does not let this account update the issue.',
    });
  });
});

describe('blocking relations', () => {
  test('createBlockingRelation sends blocker → blocked as type blocks', async () => {
    const { gateway, calls } = gatewayWith({
      IssueRelationCreate: () =>
        dataResponse({
          issueRelationCreate: {
            success: true,
            issueRelation: relationNode('rel-9', 'blocks', 'a', 'b'),
          },
        }),
    });
    expect(await gateway.createBlockingRelation('a', 'b')).toEqual({
      id: 'rel-9',
      blockerId: 'a',
      blockedId: 'b',
    });
    expect(calls[0]?.variables).toEqual({
      input: { issueId: 'a', relatedIssueId: 'b', type: 'blocks' },
    });
  });

  test('createBlockingRelation is not retried after a server error', async () => {
    let count = 0;
    const { gateway } = gatewayWith({
      IssueRelationCreate: () => {
        count += 1;
        return new Response('', { status: 502 });
      },
    });
    expect(
      await caught(gateway.createBlockingRelation('a', 'b'))
    ).toMatchObject({ kind: 'server' });
    expect(count).toBe(1);
  });

  test('deleteRelation checks success', async () => {
    const ok = gatewayWith({
      IssueRelationDelete: () =>
        dataResponse({
          issueRelationDelete: { success: true, entityId: 'rel-1' },
        }),
    });
    await ok.gateway.deleteRelation('rel-1');
    expect(ok.calls[0]?.variables).toEqual({ id: 'rel-1' });

    const refused = gatewayWith({
      IssueRelationDelete: () =>
        dataResponse({
          issueRelationDelete: { success: false, entityId: 'rel-1' },
        }),
    });
    expect(await caught(refused.gateway.deleteRelation('rel-1'))).toMatchObject(
      { kind: 'graphql' }
    );
  });
});

describe('readable write errors', () => {
  test('keeps kind, retry time and the original as cause', () => {
    const original = new LinearApiError('rate_limited', 'Linear rate limit', {
      retryAt: '2026-10-21T16:00:00.000Z',
    });
    const readable = readableWriteError(original, 'add the comment');
    expect(readable).toMatchObject({
      kind: 'rate_limited',
      retryAt: '2026-10-21T16:00:00.000Z',
      message: "Linear's rate limit was reached; could not add the comment.",
    });
    expect((readable as Error).cause).toBe(original);
    // Transport errors and foreign errors pass through.
    const network = new LinearApiError('network', 'down');
    expect(readableWriteError(network, 'x')).toBe(network);
    const plain = new Error('boom');
    expect(readableWriteError(plain, 'x')).toBe(plain);
  });

  test('issueUpdateInput leaves out absent keys', () => {
    expect(
      issueUpdateInput({ title: 'T', stateId: undefined, projectId: null })
    ).toEqual({ title: 'T', projectId: null });
  });
});
