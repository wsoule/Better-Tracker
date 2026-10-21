import { describe, expect, test } from 'bun:test';

import { renderDigest } from '../src/render';
import { createSlackChannel } from '../src/slack';
import {
  CONTEXT,
  fakeFetch,
  type FakeReply,
  fakeSleep,
  LOOKUP_OK,
  makeDigest,
  makeItem,
  POST_OK,
  recordingLogger,
  TOKEN,
} from './helpers';

function setup(
  replies: FakeReply[],
  options: {
    maxRetryAfterSeconds?: number;
    minPostIntervalMs?: number;
    requestTimeoutMs?: number;
  } = {}
) {
  const net = fakeFetch(replies);
  const timer = fakeSleep();
  const log = recordingLogger();
  const channel = createSlackChannel({
    botToken: TOKEN,
    fetch: net.fetch,
    sleep: timer.sleep,
    now: timer.now,
    logger: log.logger,
    ...options,
  });
  return {
    channel,
    requests: net.requests,
    waits: timer.waits,
    advance: timer.advance,
    logs: log.lines,
  };
}

function slackError(
  error: string,
  extra: Record<string, unknown> = {}
): FakeReply {
  return { json: { ok: false, error, ...extra } };
}

describe('createSlackChannel', () => {
  test('identifies itself as a delivering slack channel', () => {
    const { channel } = setup([]);
    expect(channel.name).toBe('slack');
    expect(channel.delivers).toBe(true);
  });

  test('looks the person up by email, then DMs the rendered digest', async () => {
    const { channel, requests, logs } = setup([LOOKUP_OK, POST_OK]);
    const digest = makeDigest([makeItem()], {
      recipientEmail: 'Ana+ops@Example.com',
    });

    const result = await channel.send(digest, CONTEXT);

    expect(result).toEqual({
      status: 'sent',
      channel: 'slack',
      detail: 'D456 1729500000.000100',
    });
    expect(requests.length).toBe(2);

    const [lookup, post] = requests;
    expect(lookup.method).toBe('GET');
    expect(lookup.url).toBe(
      'https://slack.com/api/users.lookupByEmail?email=Ana%2Bops%40Example.com'
    );
    expect(lookup.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(lookup.body).toBeNull();

    expect(post.method).toBe('POST');
    expect(post.url).toBe('https://slack.com/api/chat.postMessage');
    expect(post.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(post.headers['content-type']).toBe(
      'application/json; charset=utf-8'
    );
    const body: unknown = JSON.parse(post.body!);
    const rendered = renderDigest(digest, CONTEXT);
    expect(body).toEqual({
      channel: 'U123',
      text: rendered.text,
      blocks: rendered.blocks,
      unfurl_links: false,
      unfurl_media: false,
    });

    // The token never reaches the logs.
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
    expect(logs.at(-1)).toMatchObject({
      level: 'info',
      message: 'Slack digest sent',
    });
  });

  test('caches email → user id per channel instance', async () => {
    const { channel, requests } = setup([LOOKUP_OK, POST_OK, POST_OK]);
    const first = makeDigest([makeItem()], {
      recipientEmail: 'ana@example.com',
    });
    const second = makeDigest([makeItem({ id: 'ms-2' })], {
      recipientEmail: ' ANA@example.com ',
      day: '2026-10-22',
    });

    expect((await channel.send(first, CONTEXT)).status).toBe('sent');
    expect((await channel.send(second, CONTEXT)).status).toBe('sent');

    expect(requests.map((r) => r.url)).toEqual([
      'https://slack.com/api/users.lookupByEmail?email=ana%40example.com',
      'https://slack.com/api/chat.postMessage',
      'https://slack.com/api/chat.postMessage',
    ]);
    expect(JSON.parse(requests[2].body!).channel).toBe('U123');
  });

  test('a failed lookup is not cached', async () => {
    const { channel, requests } = setup([
      slackError('users_not_found'),
      LOOKUP_OK,
      POST_OK,
    ]);
    const digest = makeDigest([makeItem()]);
    expect((await channel.send(digest, CONTEXT)).status).toBe('undeliverable');
    expect((await channel.send(digest, CONTEXT)).status).toBe('sent');
    expect(requests.length).toBe(3);
  });

  test('no email in Linear → undeliverable without calling Slack', async () => {
    const { channel, requests } = setup([]);
    for (const recipientEmail of [null, '   ']) {
      const result = await channel.send(
        makeDigest([makeItem()], { recipientEmail }),
        CONTEXT
      );
      expect(result).toEqual({
        status: 'undeliverable',
        channel: 'slack',
        detail: 'no email in Linear',
      });
    }
    expect(requests.length).toBe(0);
  });

  test('users_not_found → undeliverable with the Slack code', async () => {
    const { channel, requests, logs } = setup([slackError('users_not_found')]);
    const result = await channel.send(makeDigest([makeItem()]), CONTEXT);
    expect(result).toEqual({
      status: 'undeliverable',
      channel: 'slack',
      detail: 'users_not_found (users.lookupByEmail)',
    });
    expect(requests.length).toBe(1);
    expect(logs.at(-1)?.level).toBe('warn');
  });

  test('invalid_auth → failed and logged at error, without the token', async () => {
    const { channel, logs } = setup([slackError('invalid_auth')]);
    const result = await channel.send(makeDigest([makeItem()]), CONTEXT);
    expect(result).toEqual({
      status: 'failed',
      channel: 'slack',
      detail: 'invalid_auth (users.lookupByEmail)',
    });
    expect(logs.at(-1)).toMatchObject({
      level: 'error',
      fields: { code: 'invalid_auth', method: 'users.lookupByEmail' },
    });
    expect(JSON.stringify(logs)).not.toContain(TOKEN);
  });

  test('missing_scope reports which scope is needed', async () => {
    const { channel } = setup([
      slackError('missing_scope', { needed: 'users:read.email' }),
    ]);
    const result = await channel.send(makeDigest([makeItem()]), CONTEXT);
    expect(result).toEqual({
      status: 'failed',
      channel: 'slack',
      detail: 'missing_scope (users.lookupByEmail; needed users:read.email)',
    });
  });

  test('classifies every documented Slack error code', async () => {
    const cases: [string, 'failed' | 'undeliverable'][] = [
      ['invalid_auth', 'failed'],
      ['not_authed', 'failed'],
      ['account_inactive', 'failed'],
      ['token_revoked', 'failed'],
      ['token_expired', 'failed'],
      ['missing_scope', 'failed'],
      ['users_not_found', 'undeliverable'],
      ['user_not_found', 'undeliverable'],
      ['user_disabled', 'undeliverable'],
      ['channel_not_found', 'undeliverable'],
      ['messages_tab_disabled', 'undeliverable'],
      ['service_unavailable', 'failed'],
      ['fatal_error', 'failed'],
      ['request_timeout', 'failed'],
      ['invalid_blocks', 'failed'],
    ];
    for (const [code, status] of cases) {
      // Post-time errors: the lookup succeeds, chat.postMessage fails.
      const { channel } = setup([LOOKUP_OK, slackError(code)]);
      const result = await channel.send(makeDigest([makeItem()]), CONTEXT);
      expect({ code, result }).toEqual({
        code,
        result: {
          status,
          channel: 'slack',
          detail: `${code} (chat.postMessage)`,
        },
      });
    }
  });

  test('HTTP 429 waits Retry-After seconds, then retries once', async () => {
    const { channel, requests, waits } = setup([
      LOOKUP_OK,
      { text: '', status: 429, headers: { 'Retry-After': '7' } },
      POST_OK,
    ]);
    const result = await channel.send(makeDigest([makeItem()]), CONTEXT);
    expect(result.status).toBe('sent');
    expect(waits).toEqual([7000]);
    expect(requests.map((r) => r.url)).toEqual([
      'https://slack.com/api/users.lookupByEmail?email=ana%40example.com',
      'https://slack.com/api/chat.postMessage',
      'https://slack.com/api/chat.postMessage',
    ]);
    expect(requests[2].body).toBe(requests[1].body);
  });

  test('ratelimited in a 200 body is treated like 429', async () => {
    const { channel, waits } = setup([
      {
        json: { ok: false, error: 'ratelimited' },
        headers: { 'Retry-After': '2' },
      },
      LOOKUP_OK,
      POST_OK,
    ]);
    const result = await channel.send(makeDigest([makeItem()]), CONTEXT);
    expect(result.status).toBe('sent');
    expect(waits).toEqual([2000]);
  });

  test('rate_limited without Retry-After waits one second', async () => {
    const { channel, waits } = setup([
      LOOKUP_OK,
      slackError('rate_limited'),
      POST_OK,
    ]);
    expect((await channel.send(makeDigest([makeItem()]), CONTEXT)).status).toBe(
      'sent'
    );
    expect(waits).toEqual([1000]);
  });

  test('a blank Retry-After waits the default second, not zero', async () => {
    const { channel, waits } = setup([
      LOOKUP_OK,
      { text: '', status: 429, headers: { 'Retry-After': '  ' } },
      POST_OK,
    ]);
    expect((await channel.send(makeDigest([makeItem()]), CONTEXT)).status).toBe(
      'sent'
    );
    expect(waits).toEqual([1000]);
  });

  test('the Retry-After wait is capped', async () => {
    const capped = setup(
      [
        LOOKUP_OK,
        { text: '', status: 429, headers: { 'Retry-After': '600' } },
        POST_OK,
      ],
      { maxRetryAfterSeconds: 5 }
    );
    await capped.channel.send(makeDigest([makeItem()]), CONTEXT);
    expect(capped.waits).toEqual([5000]);

    const byDefault = setup([
      LOOKUP_OK,
      { text: '', status: 429, headers: { 'Retry-After': '600' } },
      POST_OK,
    ]);
    await byDefault.channel.send(makeDigest([makeItem()]), CONTEXT);
    expect(byDefault.waits).toEqual([30000]);
  });

  test('a second rate limit → failed, with no third attempt', async () => {
    const { channel, requests, waits } = setup([
      LOOKUP_OK,
      { text: '', status: 429, headers: { 'Retry-After': '1' } },
      { text: '', status: 429, headers: { 'Retry-After': '1' } },
    ]);
    const result = await channel.send(makeDigest([makeItem()]), CONTEXT);
    expect(result).toEqual({
      status: 'failed',
      channel: 'slack',
      detail:
        'ratelimited (chat.postMessage; still rate limited after one retry)',
    });
    expect(requests.length).toBe(3);
    expect(waits).toEqual([1000]);
  });

  test('network error → failed', async () => {
    const { channel, logs } = setup([
      { throws: new TypeError('fetch failed') },
    ]);
    const result = await channel.send(makeDigest([makeItem()]), CONTEXT);
    expect(result).toEqual({
      status: 'failed',
      channel: 'slack',
      detail: 'network_error (users.lookupByEmail; fetch failed)',
    });
    expect(logs.at(-1)?.level).toBe('warn');
  });

  test('network error while posting → failed', async () => {
    const { channel } = setup([
      LOOKUP_OK,
      { throws: new Error('socket hang up') },
    ]);
    const result = await channel.send(makeDigest([makeItem()]), CONTEXT);
    expect(result).toEqual({
      status: 'failed',
      channel: 'slack',
      detail: 'network_error (chat.postMessage; socket hang up)',
    });
  });

  test('a request with no answer times out → failed (transient)', async () => {
    const { channel, logs } = setup([{ hangs: true }], {
      requestTimeoutMs: 5,
    });
    const result = await channel.send(makeDigest([makeItem()]), CONTEXT);
    expect(result).toEqual({
      status: 'failed',
      channel: 'slack',
      detail: 'request_timeout (users.lookupByEmail; no answer within 5 ms)',
    });
    expect(logs.at(-1)?.level).toBe('warn');
  });

  test('a hung chat.postMessage times out without a retry', async () => {
    const { channel, requests } = setup([LOOKUP_OK, { hangs: true }], {
      requestTimeoutMs: 5,
    });
    const result = await channel.send(makeDigest([makeItem()]), CONTEXT);
    expect(result).toEqual({
      status: 'failed',
      channel: 'slack',
      detail: 'request_timeout (chat.postMessage; no answer within 5 ms)',
    });
    expect(requests.length).toBe(2);
  });

  test('every request carries an abort signal', async () => {
    let signals = 0;
    const net = fakeFetch([LOOKUP_OK, POST_OK]);
    const channel = createSlackChannel({
      botToken: TOKEN,
      fetch: Object.assign(
        (input: string | URL | Request, init?: RequestInit) => {
          if (init?.signal instanceof AbortSignal) signals++;
          return net.fetch(input, init);
        },
        { preconnect: () => {} }
      ),
      sleep: fakeSleep().sleep,
    });
    await channel.send(makeDigest([makeItem()]), CONTEXT);
    expect(signals).toBe(2);
  });

  test('posts are paced about one per second', async () => {
    const { channel, waits, advance } = setup([
      LOOKUP_OK,
      POST_OK,
      POST_OK,
      POST_OK,
    ]);
    const digest = makeDigest([makeItem()]);
    expect((await channel.send(digest, CONTEXT)).status).toBe('sent');
    // The first post never waits; the next one waits out the full second.
    expect(waits).toEqual([]);
    expect((await channel.send(digest, CONTEXT)).status).toBe('sent');
    expect(waits).toEqual([1000]);
    // Time the caller spent elsewhere counts toward the gap.
    advance(400);
    expect((await channel.send(digest, CONTEXT)).status).toBe('sent');
    expect(waits).toEqual([1000, 600]);
  });

  test('concurrent sends still post one at a time, paced', async () => {
    const net = fakeFetch([
      LOOKUP_OK,
      LOOKUP_OK,
      LOOKUP_OK,
      POST_OK,
      POST_OK,
      POST_OK,
    ]);
    const timer = fakeSleep();
    let inFlight = 0;
    let maxInFlight = 0;
    const postTimes: number[] = [];
    const channel = createSlackChannel({
      botToken: TOKEN,
      sleep: timer.sleep,
      now: timer.now,
      fetch: Object.assign(
        async (input: string | URL | Request, init?: RequestInit) => {
          const url = input instanceof Request ? input.url : input.toString();
          const isPost = url.endsWith('/chat.postMessage');
          if (isPost) {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            postTimes.push(timer.now());
          }
          try {
            return await net.fetch(input, init);
          } finally {
            if (isPost) inFlight--;
          }
        },
        { preconnect: () => {} }
      ),
    });
    const results = await Promise.all(
      ['a@example.com', 'b@example.com', 'c@example.com'].map((email) =>
        channel.send(
          makeDigest([makeItem()], { recipientEmail: email }),
          CONTEXT
        )
      )
    );
    expect(results.map((r) => r.status)).toEqual(['sent', 'sent', 'sent']);
    expect(maxInFlight).toBe(1);
    expect(postTimes.length).toBe(3);
    expect(postTimes[1] - postTimes[0]).toBeGreaterThanOrEqual(1000);
    expect(postTimes[2] - postTimes[1]).toBeGreaterThanOrEqual(1000);
  });

  test('pacing can be turned off', async () => {
    const { channel, waits } = setup([LOOKUP_OK, POST_OK, POST_OK], {
      minPostIntervalMs: 0,
    });
    const digest = makeDigest([makeItem()]);
    await channel.send(digest, CONTEXT);
    await channel.send(digest, CONTEXT);
    expect(waits).toEqual([]);
  });

  test('a failed post still holds the next one back', async () => {
    const { channel, waits } = setup([
      LOOKUP_OK,
      slackError('invalid_blocks'),
      POST_OK,
    ]);
    const digest = makeDigest([makeItem()]);
    expect((await channel.send(digest, CONTEXT)).status).toBe('failed');
    expect((await channel.send(digest, CONTEXT)).status).toBe('sent');
    expect(waits).toEqual([1000]);
  });

  test('non-JSON 5xx → failed with the HTTP status', async () => {
    const { channel } = setup([
      { text: '<html>Bad gateway</html>', status: 502 },
    ]);
    const result = await channel.send(makeDigest([makeItem()]), CONTEXT);
    expect(result).toEqual({
      status: 'failed',
      channel: 'slack',
      detail: 'http_502 (users.lookupByEmail)',
    });
  });

  test('malformed success bodies → failed, not sent', async () => {
    const lookupWithoutId = setup([{ json: { ok: true, user: {} } }]);
    expect(
      await lookupWithoutId.channel.send(makeDigest([makeItem()]), CONTEXT)
    ).toEqual({
      status: 'failed',
      channel: 'slack',
      detail: 'invalid_response (users.lookupByEmail; no user id)',
    });

    const notJson = setup([{ text: 'ok', status: 200 }]);
    expect(
      await notJson.channel.send(makeDigest([makeItem()]), CONTEXT)
    ).toEqual({
      status: 'failed',
      channel: 'slack',
      detail: 'invalid_response (users.lookupByEmail)',
    });
  });
});
