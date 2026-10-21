// Validates every document in src/queries.ts against Linear's vendored SDL
// (schema/linear.graphql, @linear/sdk 98.0.0). This is what proves the
// field names, argument names, filter shapes and variable types are right
// without reaching api.linear.app.

import { describe, expect, test } from 'bun:test';
import {
  buildSchema,
  getNamedType,
  type GraphQLSchema,
  Kind,
  NoDeprecatedCustomRule,
  parse,
  specifiedRules,
  TypeInfo,
  validate,
  visit,
  visitWithTypeInfo,
} from 'graphql';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as queries from '../src/queries';

const schema: GraphQLSchema = buildSchema(
  readFileSync(join(import.meta.dir, '..', 'schema', 'linear.graphql'), 'utf8')
);

// Every exported string constant is a document; builders are expanded at
// the sizes the gateway uses (1 and the full batch).
const documents: [string, string][] = [
  ...Object.entries(queries).flatMap(([name, value]): [string, string][] =>
    typeof value === 'string' ? [[name, value]] : []
  ),
  ...[1, 2, queries.STATE_CHANGE_BATCH_SIZE].flatMap(
    (n): [string, string][] => [
      [
        `buildStateHistoryBatchQuery(${n})`,
        queries.buildStateHistoryBatchQuery(n),
      ],
      [
        `buildIssueHistoryBatchQuery(${n})`,
        queries.buildIssueHistoryBatchQuery(n),
      ],
    ]
  ),
];

// Fields whose type is a Linear connection must pass an explicit `first`
// (literal or variable) so complexity stays bounded and predictable.
function connectionsWithoutFirst(source: string): string[] {
  const typeInfo = new TypeInfo(schema);
  const missing: string[] = [];
  visit(
    parse(source),
    visitWithTypeInfo(typeInfo, {
      Field(node) {
        const type = typeInfo.getType();
        if (type === null) return;
        const named = getNamedType(type);
        if (named?.name.endsWith('Connection') !== true) return;
        const hasFirst = (node.arguments ?? []).some(
          (arg) => arg.name.value === 'first'
        );
        if (!hasFirst) missing.push(node.name.value);
      },
    })
  );
  return missing;
}

describe('queries.ts against the Linear schema', () => {
  test('there is a document for every gateway operation', () => {
    const names = documents.map(([name]) => name);
    for (const expected of [
      'IDENTITY_QUERY',
      'USERS_QUERY',
      'TEAMS_QUERY',
      'WORKFLOW_STATES_QUERY',
      'INITIATIVES_QUERY',
      'PROJECTS_QUERY',
      'PROJECT_MILESTONES_QUERY',
      'PROJECT_ISSUES_QUERY',
      'OPEN_ISSUES_WITHOUT_PROJECT_QUERY',
      'WORKSPACE_RELATIONS_QUERY',
      'ISSUE_QUERY',
      'PROJECT_QUERY',
      'MILESTONE_QUERY',
      'USER_QUERY',
      'INITIATIVE_QUERY',
      'ISSUE_RELATIONS_QUERY',
      'STATE_HISTORY_PAGE_QUERY',
      'ISSUE_HISTORY_PAGE_QUERY',
      'ISSUE_UPDATE_MUTATION',
      'COMMENT_CREATE_MUTATION',
      'PROJECT_MILESTONE_UPDATE_MUTATION',
      'PROJECT_UPDATE_MUTATION',
    ]) {
      expect(names).toContain(expected);
    }
  });

  for (const [name, source] of documents) {
    test(`${name} validates with zero errors and no deprecated fields`, () => {
      const document = parse(source);
      const errors = validate(schema, document, [
        ...specifiedRules,
        NoDeprecatedCustomRule,
      ]);
      expect(errors.map((e) => e.message)).toEqual([]);
      // Exactly one operation per document, so the client can name it.
      const operations = document.definitions.filter(
        (d) => d.kind === Kind.OPERATION_DEFINITION
      );
      expect(operations).toHaveLength(1);
    });

    test(`${name} gives every connection an explicit first`, () => {
      expect(connectionsWithoutFirst(source)).toEqual([]);
    });
  }

  test('root connections page with PAGE_SIZE through $first', () => {
    expect(queries.PAGE_SIZE).toBe(100);
    for (const doc of [
      queries.USERS_QUERY,
      queries.TEAMS_QUERY,
      queries.WORKFLOW_STATES_QUERY,
      queries.INITIATIVES_QUERY,
      queries.PROJECTS_QUERY,
      queries.PROJECT_MILESTONES_QUERY,
      queries.PROJECT_ISSUES_QUERY,
      queries.OPEN_ISSUES_WITHOUT_PROJECT_QUERY,
      queries.WORKSPACE_RELATIONS_QUERY,
    ]) {
      expect(doc).toContain('$first: Int!');
      expect(doc).toContain('$after: String');
      expect(doc).toContain('pageInfo { hasNextPage endCursor }');
    }
  });

  test('the documented filters are present', () => {
    expect(queries.USERS_QUERY).toContain('includeDisabled: true');
    expect(queries.PROJECTS_QUERY).toContain(
      'status: { type: { nin: ["completed", "canceled"] } }'
    );
    expect(queries.PROJECT_ISSUES_QUERY).toContain('null: false');
    expect(queries.OPEN_ISSUES_WITHOUT_PROJECT_QUERY).toContain(
      'project: { null: true }'
    );
    expect(queries.OPEN_ISSUES_WITHOUT_PROJECT_QUERY).toContain(
      'state: { type: { nin: ["completed", "canceled", "duplicate"] } }'
    );
  });

  test('batch builders alias each issue and reject bad sizes', () => {
    const doc = queries.buildStateHistoryBatchQuery(3);
    expect(doc).toContain('i0: issue(id: $id0)');
    expect(doc).toContain('i2: issue(id: $id2)');
    expect(doc).not.toContain('i3:');
    expect(doc).toContain('stateHistory(first: 50)');
    expect(queries.buildIssueHistoryBatchQuery(1)).toContain('toStateId');
    expect(() => queries.buildStateHistoryBatchQuery(0)).toThrow(RangeError);
  });
});
