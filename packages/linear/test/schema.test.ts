// Validates every document in src/queries.ts against Linear's vendored SDL
// (schema/linear.graphql, @linear/sdk 98.0.0). This is what proves the
// field names, argument names, filter shapes and variable types are right
// without reaching api.linear.app.

import { describe, expect, test } from 'bun:test';
import {
  type ArgumentNode,
  buildSchema,
  type FragmentDefinitionNode,
  getNamedType,
  type GraphQLNamedType,
  type GraphQLSchema,
  isInterfaceType,
  isLeafType,
  isObjectType,
  Kind,
  NoDeprecatedCustomRule,
  parse,
  type SelectionSetNode,
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

// Connection fields that do not select `pageInfo { hasNextPage }`: without
// it a list longer than `first` is cut off with no way to notice.
function connectionsWithoutPageInfo(source: string): string[] {
  const typeInfo = new TypeInfo(schema);
  const missing: string[] = [];
  const document = parse(source);
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const d of document.definitions) {
    if (d.kind === Kind.FRAGMENT_DEFINITION) fragments.set(d.name.value, d);
  }
  // Fields selected directly in a set, following fragment spreads.
  const selectedFields = (set: SelectionSetNode): SelectionSetNode[] => {
    const out: SelectionSetNode[] = [set];
    for (const sel of set.selections) {
      if (sel.kind === Kind.FRAGMENT_SPREAD) {
        const fragment = fragments.get(sel.name.value);
        if (fragment !== undefined) {
          out.push(...selectedFields(fragment.selectionSet));
        }
      } else if (sel.kind === Kind.INLINE_FRAGMENT) {
        out.push(...selectedFields(sel.selectionSet));
      }
    }
    return out;
  };
  visit(
    document,
    visitWithTypeInfo(typeInfo, {
      Field(node) {
        const type = typeInfo.getType();
        if (type === null || node.selectionSet === undefined) return;
        if (getNamedType(type)?.name.endsWith('Connection') !== true) return;
        const pageInfo = selectedFields(node.selectionSet)
          .flatMap((set) => set.selections)
          .find(
            (sel) => sel.kind === Kind.FIELD && sel.name.value === 'pageInfo'
          );
        const hasNextPage =
          pageInfo?.kind === Kind.FIELD &&
          (pageInfo.selectionSet?.selections ?? []).some(
            (sel) => sel.kind === Kind.FIELD && sel.name.value === 'hasNextPage'
          );
        if (!hasNextPage) missing.push(node.name.value);
      },
    })
  );
  return missing;
}

// A conservative estimate of Linear's query complexity (architecture §4.1,
// Linear's rate-limit docs): 0.1 per scalar, 1 per object, and a
// connection multiplies everything under it (pageInfo included, which
// over-counts) by `first`, 50 when absent. Linear rejects queries over
// 10,000 points.
function estimateComplexity(
  source: string,
  variables: Record<string, number>
): number {
  const document = parse(source);
  const fragments = new Map<string, FragmentDefinitionNode>();
  let operation: SelectionSetNode | null = null;
  let operationType: GraphQLNamedType | null | undefined = null;
  for (const d of document.definitions) {
    if (d.kind === Kind.FRAGMENT_DEFINITION) fragments.set(d.name.value, d);
    if (d.kind === Kind.OPERATION_DEFINITION) {
      operation = d.selectionSet;
      operationType =
        d.operation === 'mutation'
          ? schema.getMutationType()
          : schema.getQueryType();
    }
  }
  const firstOf = (args: readonly ArgumentNode[] | undefined): number => {
    const value = args?.find((a) => a.name.value === 'first')?.value;
    if (value?.kind === Kind.INT) return Number(value.value);
    if (value?.kind === Kind.VARIABLE) {
      const bound = variables[value.name.value];
      if (bound === undefined) throw new Error(`unbound $${value.name.value}`);
      return bound;
    }
    return 50;
  };
  const cost = (set: SelectionSetNode, type: GraphQLNamedType): number => {
    let total = 0;
    for (const sel of set.selections) {
      if (sel.kind === Kind.FRAGMENT_SPREAD) {
        const fragment = fragments.get(sel.name.value);
        const on = schema.getType(fragment?.typeCondition.name.value ?? '');
        if (fragment === undefined || on === undefined) {
          throw new Error(`unknown fragment ${sel.name.value}`);
        }
        total += cost(fragment.selectionSet, on);
        continue;
      }
      if (sel.kind === Kind.INLINE_FRAGMENT) {
        total += cost(sel.selectionSet, type);
        continue;
      }
      if (!isObjectType(type) && !isInterfaceType(type)) {
        throw new Error(`cannot select ${sel.name.value} on ${type.name}`);
      }
      const field = type.getFields()[sel.name.value];
      if (field === undefined) throw new Error(`unknown ${sel.name.value}`);
      const named = getNamedType(field.type);
      if (isLeafType(named) || sel.selectionSet === undefined) {
        total += 0.1;
        continue;
      }
      const children = cost(sel.selectionSet, named);
      total += named.name.endsWith('Connection')
        ? 1 + firstOf(sel.arguments) * children
        : 1 + children;
    }
    return total;
  };
  if (
    operation === null ||
    operationType === null ||
    operationType === undefined
  ) {
    throw new Error('no operation');
  }
  return Math.ceil(cost(operation, operationType));
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

    test(`${name} selects pageInfo.hasNextPage on every connection`, () => {
      expect(connectionsWithoutPageInfo(source)).toEqual([]);
    });

    test(`${name} stays well under 10,000 complexity points`, () => {
      // Half the hard limit leaves room for Linear's own accounting.
      expect(
        estimateComplexity(source, { first: queries.PAGE_SIZE })
      ).toBeLessThan(5_000);
    });
  }

  test('the complexity estimate counts connections by first', () => {
    // The connection object (1) + 50 × (a user: 1 + 7 scalars × 0.1, and
    // pageInfo: 1 + 2 × 0.1) = 1 + 50 × 2.9 = 146.
    expect(estimateComplexity(queries.USERS_QUERY, { first: 50 })).toBe(146);
    expect(
      estimateComplexity(queries.USERS_QUERY, { first: 100 })
    ).toBeGreaterThan(estimateComplexity(queries.USERS_QUERY, { first: 50 }));
  });

  test('root connections page with PAGE_SIZE through $first', () => {
    // Linear's documented default; its maximum is not documented (§4.1).
    expect(queries.PAGE_SIZE).toBe(50);
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
