import { beforeEach, describe, expect, test } from 'bun:test';

import {
  apiRateRule,
  clientIp,
  createRateLimiter,
  limitByIp,
  RATE_LIMITS,
  type RateRule,
  rateLimitedMessage,
  rateLimitedRedirect,
  rateLimitedResponse,
  resetProcessRateLimiters,
  waitText,
} from '../lib/rate-limit';

// lib/rate-limit.ts (owner decision 2026-10-25, architecture §8.1 "Rate
// limits"): sliding windows per key, bounded memory, the client IP from
// X-Real-IP alone (none: no IP limit), per-session rules by route, and the
// answers a limited request gets.

const RULE: RateRule = { name: 'test', limit: 3, windowMs: 60_000 };

function clock(start = 1_000_000): { now: () => number; at: number } {
  const c = {
    at: start,
    now: () => c.at,
  };
  return c;
}

function request(
  path: string,
  method = 'POST',
  headers: Record<string, string> = {}
): Request {
  return new Request(`http://localhost:3000${path}`, { method, headers });
}

beforeEach(() => {
  resetProcessRateLimiters();
});

describe('the sliding window', () => {
  test('allows `limit` hits per window, then refuses with the seconds until the oldest leaves', () => {
    const c = clock();
    const limiter = createRateLimiter(RULE, { now: c.now });
    for (let i = 0; i < 3; i += 1) {
      expect(limiter.hit('a')).toEqual({ ok: true });
      c.at += 10_000;
    }
    // Hits at 0, 10 s and 20 s; now 30 s: the first leaves at 60 s.
    expect(limiter.hit('a')).toEqual({ ok: false, retryAfterSeconds: 30 });
    // A refused hit is not counted: once the first leaves, one more fits.
    c.at += 30_000;
    expect(limiter.hit('a')).toEqual({ ok: true });
    expect(limiter.hit('a')).toEqual({ ok: false, retryAfterSeconds: 10 });
  });

  test('slides rather than resetting: a burst at the end of a window still counts', () => {
    const c = clock();
    const limiter = createRateLimiter(RULE, { now: c.now });
    c.at += 59_000;
    for (let i = 0; i < 3; i += 1) expect(limiter.hit('a').ok).toBe(true);
    c.at += 2_000;
    expect(limiter.hit('a').ok).toBe(false);
    c.at += 58_000;
    expect(limiter.hit('a').ok).toBe(true);
  });

  test('keys count apart', () => {
    const c = clock();
    const limiter = createRateLimiter(RULE, { now: c.now });
    for (let i = 0; i < 3; i += 1) limiter.hit('a');
    expect(limiter.hit('a').ok).toBe(false);
    expect(limiter.hit('b').ok).toBe(true);
  });

  test('Retry-After is at least one second', () => {
    const c = clock();
    const limiter = createRateLimiter(
      { name: 'tiny', limit: 1, windowMs: 100 },
      { now: c.now }
    );
    limiter.hit('a');
    c.at += 99;
    expect(limiter.hit('a')).toEqual({ ok: false, retryAfterSeconds: 1 });
  });
});

describe('bounded memory', () => {
  test('remembers at most maxKeys keys, dropping the least recently used', () => {
    const c = clock();
    const limiter = createRateLimiter(RULE, { now: c.now, maxKeys: 3 });
    for (const key of ['a', 'b', 'c']) {
      for (let i = 0; i < 3; i += 1) limiter.hit(key);
    }
    expect(limiter.hit('a').ok).toBe(false); // a is now the most recent
    limiter.hit('d');
    expect(limiter.size()).toBe(3);
    // b was the least recently used: forgotten, so it starts again.
    expect(limiter.hit('b').ok).toBe(true);
    expect(limiter.hit('a').ok).toBe(false);
  });

  test('keys whose hits all left the window are pruned as it goes', () => {
    const c = clock();
    const limiter = createRateLimiter(RULE, { now: c.now });
    for (let i = 0; i < 100; i += 1) limiter.hit(`ip-${i}`);
    expect(limiter.size()).toBe(100);
    c.at += 60_000;
    limiter.hit('fresh');
    expect(limiter.size()).toBe(1);
  });

  test('a key keeps at most `limit` timestamps, however often it is refused', () => {
    const c = clock();
    const limiter = createRateLimiter(RULE, { now: c.now });
    for (let i = 0; i < 10_000; i += 1) limiter.hit('flood');
    // Only the three counted hits are held: after the window one fits again.
    c.at += 60_000;
    expect(limiter.hit('flood').ok).toBe(true);
  });
});

describe('the client IP', () => {
  test('is X-Real-IP alone, shape-checked; X-Forwarded-For is never read', () => {
    expect(
      clientIp(request('/x', 'GET', { 'x-real-ip': ' 203.0.113.7 ' }))
    ).toBe('203.0.113.7');
    expect(clientIp(request('/x', 'GET', { 'x-real-ip': '2001:db8::1' }))).toBe(
      '2001:db8::1'
    );
    expect(
      clientIp(request('/x', 'GET', { 'x-forwarded-for': '203.0.113.7' }))
    ).toBeNull();
    expect(
      clientIp(request('/x', 'GET', { 'x-real-ip': 'evil host<script>' }))
    ).toBeNull();
    expect(clientIp(request('/x'))).toBeNull();
  });

  test('without one, IP limits do not apply at all (no shared bucket)', () => {
    const c = clock();
    const limiter = createRateLimiter(RULE, { now: c.now });
    for (let i = 0; i < 50; i += 1) {
      expect(limitByIp(request('/x'), RULE, limiter)).toBeNull();
    }
    expect(limiter.size()).toBe(0);
    const ip = request('/x', 'GET', { 'x-real-ip': '198.51.100.2' });
    for (let i = 0; i < 3; i += 1) {
      expect(limitByIp(ip, RULE, limiter)).toBeNull();
    }
    expect(limitByIp(ip, RULE, limiter)).toEqual({ retryAfterSeconds: 60 });
  });
});

describe('the rules', () => {
  test('the numbers of the spec, in one place', () => {
    const minutes = (rule: RateRule): number => rule.windowMs / 60_000;
    // Raised from the spec's 30 so an office behind one NAT can sign in
    // together (review HARD-5).
    expect([
      RATE_LIMITS.oauthStart.limit,
      minutes(RATE_LIMITS.oauthStart),
    ]).toEqual([120, 10]);
    expect([
      RATE_LIMITS.switchWorkspace.limit,
      minutes(RATE_LIMITS.switchWorkspace),
    ]).toEqual([60, 10]);
    // Sign-out is never limited (review HARD-4).
    expect('signOut' in RATE_LIMITS).toBe(false);
    expect([RATE_LIMITS.runs.limit, minutes(RATE_LIMITS.runs)]).toEqual([
      6, 10,
    ]);
    expect([
      RATE_LIMITS.warningsPreview.limit,
      minutes(RATE_LIMITS.warningsPreview),
    ]).toEqual([20, 10]);
    expect([RATE_LIMITS.mutation.limit, minutes(RATE_LIMITS.mutation)]).toEqual(
      [300, 1]
    );
    expect([
      RATE_LIMITS.webhookRefused.limit,
      minutes(RATE_LIMITS.webhookRefused),
    ]).toEqual([100, 1]);
    const names = Object.values(RATE_LIMITS).map((rule) => rule.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('API requests: runs and the preview have their own rule, other writes share one, reads none', () => {
    expect(apiRateRule(request('/api/runs'))).toBe(RATE_LIMITS.runs);
    expect(apiRateRule(request('/api/runs/'))).toBe(RATE_LIMITS.runs);
    expect(apiRateRule(request('/api/warnings/preview'))).toBe(
      RATE_LIMITS.warningsPreview
    );
    for (const [path, method] of [
      ['/api/sync', 'POST'],
      ['/api/settings', 'PATCH'],
      ['/api/issues/iss-1', 'PATCH'],
      ['/api/relations/rel-1', 'DELETE'],
      ['/api/issues/iss-1/comments', 'POST'],
    ] as const) {
      expect(apiRateRule(request(path, method))).toBe(RATE_LIMITS.mutation);
    }
    for (const method of ['GET', 'HEAD']) {
      expect(apiRateRule(request('/api/runs', method))).toBeNull();
    }
  });
});

describe('the answers', () => {
  test('an API request: 429 rate_limited with Retry-After and a sentence that says when', async () => {
    const response = rateLimitedResponse(RATE_LIMITS.runs, 125);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('125');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: {
        code: 'rate_limited',
        message:
          'Too many allocation runs from this session in the last 10 minutes. Try again in 3 min.',
      },
    });
    expect(rateLimitedMessage(RATE_LIMITS.mutation, 12)).toBe(
      'Too many changes from this session in the last minute. Try again in 12 s.'
    );
  });

  test('an auth navigation: a 303 to the landing page, which says why', () => {
    const response = rateLimitedRedirect(40, ['a=b; Path=/']);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(
      '/?auth_error=auth_rate_limited'
    );
    expect(response.headers.get('retry-after')).toBe('40');
    expect(response.headers.get('set-cookie')).toBe('a=b; Path=/');
  });

  test('waits read as seconds under a minute, else whole minutes', () => {
    expect(waitText(1)).toBe('1 s');
    expect(waitText(59)).toBe('59 s');
    expect(waitText(60)).toBe('1 min');
    expect(waitText(61)).toBe('2 min');
  });
});
