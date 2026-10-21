import { describe, expect, test } from 'bun:test';

import {
  classifyGraphqlErrors,
  createGraphqlClient,
  LINEAR_GRAPHQL_ENDPOINT,
  LinearGraphqlErrors,
  operationName,
  parseGraphqlErrors,
  rateLimitResetMs,
} from '../src/client';
import { LinearApiError } from '../src/gateway';
import {
  dataResponse,
  jsonResponse,
  recordingLogger,
  scriptedFetch,
} from './helpers';

const TOKEN = 'lin_oauth_SECRET_TOKEN_VALUE';
const QUERY = 'query Viewer { viewer { id } }';
const NOW = Date.parse('2026-10-21T12:00:00.000Z');

function recordingSleep(): {
  sleep: (ms: number) => Promise<void>;
  waits: number[];
} {
  const waits: number[] = [];
  return {
    waits,
    sleep: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    },
  };
}

async function captureError(
  promise: Promise<unknown>
): Promise<LinearApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LinearApiError) return error;
    throw error;
  }
  throw new Error('expected the request to fail');
}

const rateLimitedBody = {
  data: null,
  errors: [
    {
      message: 'Rate limit exceeded',
      extensions: { code: 'RATELIMITED', type: 'ratelimited' },
    },
  ],
};

describe('createGraphqlClient: request shape', () => {
  test('POSTs JSON with a Bearer token to the Linear endpoint', async () => {
    const { fetch, calls } = scriptedFetch([
      dataResponse({ viewer: { id: 'u1' } }),
    ]);
    const client = createGraphqlClient({ accessToken: TOKEN, fetch });
    const data = await client.request<{ viewer: { id: string } }>(QUERY, {
      a: 1,
    });
    expect(data).toEqual({ viewer: { id: 'u1' } });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(LINEAR_GRAPHQL_ENDPOINT);
    expect(call?.method).toBe('POST');
    expect(call?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(call?.headers['content-type']).toBe('application/json');
    expect(JSON.parse(call?.body ?? '')).toEqual({
      query: QUERY,
      variables: { a: 1 },
    });
  });

  test('a custom endpoint is used', async () => {
    const { fetch, calls } = scriptedFetch([dataResponse({ ok: true })]);
    await createGraphqlClient({
      accessToken: TOKEN,
      fetch,
      endpoint: 'http://fake/graphql',
    }).request(QUERY);
    expect(calls[0]?.url).toBe('http://fake/graphql');
  });
});

describe('createGraphqlClient: rate limits', () => {
  test('HTTP 400 + RATELIMITED waits until the reset header, then succeeds', async () => {
    const { sleep, waits } = recordingSleep();
    const { fetch, calls } = scriptedFetch([
      jsonResponse(rateLimitedBody, {
        status: 400,
        headers: {
          'x-ratelimit-requests-remaining': '0',
          'x-ratelimit-requests-reset': String(NOW + 5_000),
          'x-ratelimit-complexity-remaining': '1500000',
          'x-ratelimit-complexity-reset': String(NOW + 40_000),
        },
      }),
      dataResponse({ viewer: { id: 'u1' } }),
    ]);
    const client = createGraphqlClient({
      accessToken: TOKEN,
      fetch,
      sleep,
      now: () => NOW,
    });
    expect(await client.request<unknown>(QUERY)).toEqual({
      viewer: { id: 'u1' },
    });
    expect(calls).toHaveLength(2);
    // The exhausted window (requests) decides the wait, plus a small margin.
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThanOrEqual(5_000);
    expect(waits[0]).toBeLessThan(6_000);
  });

  test('extensions.type "ratelimited" alone is recognised', async () => {
    const { sleep, waits } = recordingSleep();
    const { fetch } = scriptedFetch([
      jsonResponse(
        {
          errors: [
            { message: 'slow down', extensions: { type: 'ratelimited' } },
          ],
        },
        { status: 400 }
      ),
      dataResponse({ ok: 1 }),
    ]);
    const client = createGraphqlClient({
      accessToken: TOKEN,
      fetch,
      sleep,
      now: () => NOW,
    });
    expect(await client.request<unknown>(QUERY)).toEqual({ ok: 1 });
    // No reset header: exponential backoff starting at 500 ms.
    expect(waits).toEqual([500]);
  });

  test('HTTP 429 with a complexity reset is retried', async () => {
    const { sleep, waits } = recordingSleep();
    const { fetch } = scriptedFetch([
      jsonResponse(rateLimitedBody, {
        status: 429,
        headers: {
          'x-ratelimit-complexity-remaining': '0',
          'x-ratelimit-complexity-reset': String(NOW + 2_000),
        },
      }),
      dataResponse({ ok: 1 }),
    ]);
    const client = createGraphqlClient({
      accessToken: TOKEN,
      fetch,
      sleep,
      now: () => NOW,
    });
    expect(await client.request<unknown>(QUERY)).toEqual({ ok: 1 });
    expect(waits[0]).toBeGreaterThanOrEqual(2_000);
  });

  test('a reset beyond the wait cap fails fast with retryAt', async () => {
    const { sleep, waits } = recordingSleep();
    const reset = NOW + 30 * 60_000;
    const { fetch, calls } = scriptedFetch([
      jsonResponse(rateLimitedBody, {
        status: 429,
        headers: { 'x-ratelimit-requests-reset': String(reset) },
      }),
    ]);
    const client = createGraphqlClient({
      accessToken: TOKEN,
      fetch,
      sleep,
      now: () => NOW,
    });
    const error = await captureError(client.request(QUERY));
    expect(error.kind).toBe('rate_limited');
    expect(error.retryAt).toBe(new Date(reset).toISOString());
    expect(calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  test('bounded attempts: still limited after maxRetries → rate_limited', async () => {
    const { sleep, waits } = recordingSleep();
    const limited = (): Response =>
      jsonResponse(rateLimitedBody, {
        status: 400,
        headers: { 'x-ratelimit-requests-reset': String(NOW + 1_000) },
      });
    const { fetch, calls } = scriptedFetch([limited, limited, limited]);
    const client = createGraphqlClient({
      accessToken: TOKEN,
      fetch,
      sleep,
      now: () => NOW,
      maxRetries: 2,
    });
    const error = await captureError(client.request(QUERY));
    expect(error.kind).toBe('rate_limited');
    expect(error.retryAt).toBe(new Date(NOW + 1_000).toISOString());
    expect(calls).toHaveLength(3);
    expect(waits).toHaveLength(2);
  });

  test('rate limits are retried even for non-idempotent mutations', async () => {
    const { sleep } = recordingSleep();
    const { fetch, calls } = scriptedFetch([
      jsonResponse(rateLimitedBody, { status: 429 }),
      dataResponse({ commentCreate: { success: true } }),
    ]);
    const client = createGraphqlClient({
      accessToken: TOKEN,
      fetch,
      sleep,
      now: () => NOW,
    });
    await client.request('mutation C { x }', {}, { idempotent: false });
    expect(calls).toHaveLength(2);
  });
});

describe('createGraphqlClient: auth, server and network errors', () => {
  test('401 → unauthorized, no retry', async () => {
    const { fetch, calls } = scriptedFetch([
      jsonResponse(
        { errors: [{ message: 'Authentication required' }] },
        { status: 401 }
      ),
    ]);
    const error = await captureError(
      createGraphqlClient({ accessToken: TOKEN, fetch }).request(QUERY)
    );
    expect(error.kind).toBe('unauthorized');
    expect(calls).toHaveLength(1);
  });

  test('AUTHENTICATION_ERROR on HTTP 400 → unauthorized', async () => {
    const { fetch } = scriptedFetch([
      jsonResponse(
        {
          data: null,
          errors: [
            {
              message: 'Invalid token',
              extensions: {
                code: 'AUTHENTICATION_ERROR',
                type: 'authentication error',
              },
            },
          ],
        },
        { status: 400 }
      ),
    ]);
    const error = await captureError(
      createGraphqlClient({ accessToken: TOKEN, fetch }).request(QUERY)
    );
    expect(error.kind).toBe('unauthorized');
  });

  test('403 → forbidden', async () => {
    const { fetch } = scriptedFetch([jsonResponse({}, { status: 403 })]);
    const error = await captureError(
      createGraphqlClient({ accessToken: TOKEN, fetch }).request(QUERY)
    );
    expect(error.kind).toBe('forbidden');
  });

  test('5xx is retried with exponential backoff, then succeeds', async () => {
    const { sleep, waits } = recordingSleep();
    const { fetch, calls } = scriptedFetch([
      new Response('bad gateway', { status: 502 }),
      jsonResponse({ errors: [{ message: 'Internal' }] }, { status: 500 }),
      dataResponse({ viewer: { id: 'u1' } }),
    ]);
    const client = createGraphqlClient({ accessToken: TOKEN, fetch, sleep });
    expect(await client.request<unknown>(QUERY)).toEqual({
      viewer: { id: 'u1' },
    });
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([500, 1_000]);
  });

  test('5xx after every retry → server', async () => {
    const { sleep } = recordingSleep();
    const fail = (): Response => new Response('oops', { status: 503 });
    const { fetch, calls } = scriptedFetch([fail, fail, fail, fail]);
    const error = await captureError(
      createGraphqlClient({ accessToken: TOKEN, fetch, sleep }).request(QUERY)
    );
    expect(error.kind).toBe('server');
    expect(calls).toHaveLength(4);
  });

  test('network failures are retried, then reported as network', async () => {
    const { sleep } = recordingSleep();
    const { fetch, calls } = scriptedFetch([
      new TypeError('fetch failed'),
      new TypeError('fetch failed'),
    ]);
    const error = await captureError(
      createGraphqlClient({
        accessToken: TOKEN,
        fetch,
        sleep,
        maxRetries: 1,
      }).request(QUERY)
    );
    expect(error.kind).toBe('network');
    expect(error.message).toContain('fetch failed');
    expect(calls).toHaveLength(2);
  });

  test('non-idempotent requests are not retried on 5xx or network errors', async () => {
    const { sleep } = recordingSleep();
    const first = scriptedFetch([new Response('', { status: 500 })]);
    const error = await captureError(
      createGraphqlClient({
        accessToken: TOKEN,
        fetch: first.fetch,
        sleep,
      }).request('mutation M { x }', {}, { idempotent: false })
    );
    expect(error.kind).toBe('server');
    expect(first.calls).toHaveLength(1);

    const second = scriptedFetch([new TypeError('socket hang up')]);
    const networkError = await captureError(
      createGraphqlClient({
        accessToken: TOKEN,
        fetch: second.fetch,
        sleep,
      }).request('mutation M { x }', {}, { idempotent: false })
    );
    expect(networkError.kind).toBe('network');
    expect(second.calls).toHaveLength(1);
  });
});

describe('createGraphqlClient: GraphQL errors', () => {
  test('data null → graphql with the first message and the errors as cause', async () => {
    const { fetch } = scriptedFetch([
      jsonResponse({
        data: null,
        errors: [
          { message: 'Something broke', path: ['viewer'] },
          { message: 'second' },
        ],
      }),
    ]);
    const error = await captureError(
      createGraphqlClient({ accessToken: TOKEN, fetch }).request(QUERY)
    );
    expect(error.kind).toBe('graphql');
    expect(error.message).toContain('Something broke');
    expect(error.message).toContain('Viewer');
    expect(error.cause).toBeInstanceOf(LinearGraphqlErrors);
    expect((error.cause as LinearGraphqlErrors).errors[0]?.path).toEqual([
      'viewer',
    ]);
  });

  test('INPUT_ERROR and validation failures → invalid_input', async () => {
    for (const extensions of [
      { code: 'INPUT_ERROR', type: 'invalid input' },
      { code: 'GRAPHQL_VALIDATION_FAILED' },
    ]) {
      const { fetch } = scriptedFetch([
        jsonResponse(
          { errors: [{ message: 'Argument Validation Error', extensions }] },
          { status: 400 }
        ),
      ]);
      const error = await captureError(
        createGraphqlClient({ accessToken: TOKEN, fetch }).request(QUERY)
      );
      expect(error.kind).toBe('invalid_input');
    }
  });

  test('Entity not found → not_found (even though Linear types it invalid input)', async () => {
    const { fetch } = scriptedFetch([
      jsonResponse(
        {
          data: null,
          errors: [
            {
              message: 'Entity not found: Issue',
              path: ['issue'],
              extensions: {
                code: 'INPUT_ERROR',
                type: 'invalid input',
                userPresentableMessage: 'Could not find referenced Issue.',
              },
            },
          ],
        },
        { status: 400 }
      ),
    ]);
    const error = await captureError(
      createGraphqlClient({ accessToken: TOKEN, fetch }).request(QUERY)
    );
    expect(error.kind).toBe('not_found');
    expect(error.message).toContain('Could not find referenced Issue.');
  });

  test('partial data with errors is returned and logged', async () => {
    const { logger, lines } = recordingLogger();
    const { fetch } = scriptedFetch([
      jsonResponse({
        data: { viewer: { id: 'u1' }, other: null },
        errors: [{ message: 'other failed' }],
      }),
    ]);
    const data = await createGraphqlClient({
      accessToken: TOKEN,
      fetch,
      logger,
    }).request(QUERY);
    expect(data).toEqual({ viewer: { id: 'u1' }, other: null });
    expect(lines.some((l) => l.level === 'warn')).toBe(true);
  });

  test('a 200 without data, or invalid JSON, is a graphql error', async () => {
    const { fetch } = scriptedFetch([
      jsonResponse({}),
      new Response('<html>', { status: 200 }),
    ]);
    const client = createGraphqlClient({ accessToken: TOKEN, fetch });
    expect((await captureError(client.request(QUERY))).kind).toBe('graphql');
    expect((await captureError(client.request(QUERY))).kind).toBe('graphql');
  });

  test('the token never appears in log lines or error messages', async () => {
    const { logger, lines } = recordingLogger();
    const { sleep } = recordingSleep();
    const { fetch } = scriptedFetch([
      new Response('', { status: 502 }),
      new TypeError('boom'),
      jsonResponse(rateLimitedBody, { status: 429 }),
      jsonResponse({ errors: [{ message: 'nope' }] }, { status: 401 }),
    ]);
    const error = await captureError(
      createGraphqlClient({ accessToken: TOKEN, fetch, logger, sleep }).request(
        QUERY
      )
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
    expect(error.message).not.toContain(TOKEN);
  });
});

describe('client helpers', () => {
  test('operationName', () => {
    expect(operationName('\nquery Users($first: Int!) { users }')).toBe(
      'Users'
    );
    expect(operationName('mutation IssueUpdate { x }')).toBe('IssueUpdate');
    expect(operationName('{ viewer { id } }')).toBe('anonymous');
  });

  test('rateLimitResetMs prefers the exhausted window', () => {
    const headers = new Headers({
      'x-ratelimit-requests-remaining': '10',
      'x-ratelimit-requests-reset': '2000',
      'x-ratelimit-complexity-remaining': '0',
      'x-ratelimit-complexity-reset': '1000',
    });
    expect(rateLimitResetMs(headers)).toBe(1000);
    expect(
      rateLimitResetMs(
        new Headers({
          'x-ratelimit-requests-reset': '5',
          'x-ratelimit-complexity-reset': '9',
        })
      )
    ).toBe(9);
    expect(rateLimitResetMs(new Headers())).toBeNull();
  });

  test('parseGraphqlErrors ignores junk entries', () => {
    expect(
      parseGraphqlErrors({
        errors: [
          null,
          'x',
          { message: 'm', path: ['a', 1, {}], extensions: { code: 'C' } },
        ],
      })
    ).toEqual([
      {
        message: 'm',
        path: ['a', 1],
        code: 'C',
        type: null,
        userPresentableMessage: null,
      },
    ]);
    expect(parseGraphqlErrors('nope')).toEqual([]);
  });

  test('classifyGraphqlErrors precedence', () => {
    const e = (
      message: string,
      code: string | null = null,
      type: string | null = null
    ) => ({
      message,
      path: [],
      code,
      type,
      userPresentableMessage: null,
    });
    expect(classifyGraphqlErrors([e('x', 'FORBIDDEN')])).toBe('forbidden');
    expect(classifyGraphqlErrors([e('Entity not found', 'INPUT_ERROR')])).toBe(
      'not_found'
    );
    expect(classifyGraphqlErrors([e('bad', null, 'invalid input')])).toBe(
      'invalid_input'
    );
    expect(classifyGraphqlErrors([e('weird')])).toBe('graphql');
  });
});
