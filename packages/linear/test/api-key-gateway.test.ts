// A personal API key forgotten while a paged read runs (architecture §4.1,
// security S4): the gateway reads the key through its getter before every
// request, so the next page is never requested once the getter is empty.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { LinearApiError } from '../src/gateway';
import { createLinearGateway } from '../src/linear-gateway';
import {
  caught,
  dataResponse,
  connection,
  graphqlFetch,
  issueNode,
  noSleep,
  workspaceHandlers,
} from './helpers';

const KEY = 'lin_api_TESTKEY_member_q7Wz3Kp9Vx2Lm8Rt5Yb1Nc';

describe('a forgotten key mid-request', () => {
  test('no further request is sent after the getter flips to null', async () => {
    let held: string | null = KEY;
    const handlers = workspaceHandlers();
    handlers['ProjectIssues'] = () => {
      // Page 1 answers, then the key is forgotten.
      held = null;
      return dataResponse({ issues: connection([issueNode('1')], 'c1') });
    };
    const fake = graphqlFetch(handlers);
    const gateway = createLinearGateway({
      apiKey: () => held,
      fetch: fake.fetch,
      sleep: noSleep,
    });
    const error = await caught(gateway.fetchWorkspace());
    expect(error).toBeInstanceOf(LinearApiError);
    expect((error as LinearApiError).kind).toBe('unauthorized');
    // Every request that went out carried the key raw; the second page was
    // never requested once the key was gone.
    expect(fake.calls.every((c) => c.headers['authorization'] === KEY)).toBe(
      true
    );
    expect(
      fake.calls.filter(
        (c) => c.operation === 'ProjectIssues' && c.variables['after'] === 'c1'
      )
    ).toHaveLength(0);
  });
});

describe('queries', () => {
  test('never select rateLimitStatus (it can echo the key, F9)', () => {
    const source = readFileSync(
      new URL('../src/queries.ts', import.meta.url),
      'utf8'
    );
    expect(source).not.toMatch(/rateLimitStatus/);
  });
});
