import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';

import { POST } from '../app/api/webhooks/linear/route';
import { RATE_LIMITS, resetProcessRateLimiters } from '../lib/rate-limit';

// The webhook route rejects before it ever needs the engine: these cases
// run the exported handler with plain Requests and a test secret. The
// 2026-10-25 hardening: an unset secret or a missing signature is refused
// before the body is read, the body is capped at 1 MiB, and refused
// deliveries (never signed ones) count per client IP.

const SECRET = 'whsec-test-0123456789';
const URL = 'http://localhost/api/webhooks/linear';

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: 'update',
    type: 'Issue',
    organizationId: 'org-1',
    webhookTimestamp: Date.now(),
    data: { id: 'issue-1' },
    ...overrides,
  });
}

/** A body as a stream, so the request carries no Content-Length. */
function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      for (let at = 0; at < bytes.length; at += 64 * 1024) {
        controller.enqueue(bytes.slice(at, at + 64 * 1024));
      }
      controller.close();
    },
  });
}

function deliver(body: string, headers: Record<string, string>): Request {
  return new Request(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  resetProcessRateLimiters();
  saved.LINEAR_FIXTURE = process.env.LINEAR_FIXTURE;
  saved.LINEAR_WEBHOOK_SECRET = process.env.LINEAR_WEBHOOK_SECRET;
  delete process.env.LINEAR_FIXTURE;
  process.env.LINEAR_WEBHOOK_SECRET = SECRET;
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('POST /api/webhooks/linear', () => {
  test('rejects a bad signature with a bare 400', async () => {
    const body = payload();
    const response = await POST(
      deliver(body, { 'linear-signature': sign(body, 'another-secret') })
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('');
  });

  test('rejects a missing signature', async () => {
    const response = await POST(deliver(payload(), {}));
    expect(response.status).toBe(400);
  });

  test('rejects a stale timestamp even when the signature is right', async () => {
    const body = payload({ webhookTimestamp: Date.now() - 5 * 60_000 });
    const response = await POST(
      deliver(body, { 'linear-signature': sign(body) })
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('');
  });

  test('rejects a body signed after tampering', async () => {
    const body = payload();
    const signature = sign(body);
    const tampered = body.replace('issue-1', 'issue-2');
    const response = await POST(
      deliver(tampered, { 'linear-signature': signature })
    );
    expect(response.status).toBe(400);
  });

  test('acks verified event types it does not use', async () => {
    const body = payload({ type: 'Comment' });
    const response = await POST(
      deliver(body, { 'linear-signature': sign(body) })
    );
    expect(response.status).toBe(200);
  });

  test('refuses bodies over 1 MiB with 413, declared or not', async () => {
    const body = payload({ padding: 'x'.repeat(1024 * 1024) });
    const response = await POST(
      deliver(body, { 'linear-signature': sign(body) })
    );
    expect(response.status).toBe(413);
    // Without a Content-Length the reader stops past the limit.
    const streamed = new Request(URL, {
      method: 'POST',
      headers: { 'linear-signature': sign(body) },
      body: streamOf(body),
      duplex: 'half',
    } as RequestInit);
    expect((await POST(streamed)).status).toBe(413);
    const fits = payload({ type: 'Comment', padding: 'x'.repeat(900_000) });
    expect(
      (await POST(deliver(fits, { 'linear-signature': sign(fits) }))).status
    ).toBe(200);
  });

  test('without a configured secret, refuses with 503 before reading the body', async () => {
    delete process.env.LINEAR_WEBHOOK_SECRET;
    const body = payload();
    const request = deliver(body, { 'linear-signature': sign(body) });
    const response = await POST(request);
    expect(response.status).toBe(503);
    expect(request.bodyUsed).toBe(false);
  });

  test('a missing signature header is refused before reading the body', async () => {
    const cases: Record<string, string>[] = [{}, { 'linear-signature': '  ' }];
    for (const headers of cases) {
      const request = deliver(payload(), headers);
      const response = await POST(request);
      expect(response.status).toBe(400);
      expect(request.bodyUsed).toBe(false);
    }
  });

  test('demo mode acks without checking anything', async () => {
    process.env.LINEAR_FIXTURE = '1';
    const response = await POST(deliver('not json', {}));
    expect(response.status).toBe(200);
  });
});

describe('refused deliveries per client IP', () => {
  const IP = { 'x-real-ip': '203.0.113.50' };
  const LIMIT = RATE_LIMITS.webhookRefused.limit;

  test('after 100 refusals in a minute an IP gets a bare 429 with Retry-After, whatever it sends unsigned', async () => {
    for (let i = 0; i < LIMIT; i += 1) {
      const kind = i % 3;
      const body = payload();
      const headers =
        kind === 0
          ? IP
          : kind === 1
            ? { ...IP, 'linear-signature': sign(body, 'wrong-secret') }
            : { ...IP, 'content-length': String(2 * 1024 * 1024) };
      const response = await POST(deliver(body, headers));
      expect([400, 413]).toContain(response.status);
    }
    const body = payload();
    const missing = deliver(body, IP);
    const limited = await POST(missing);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await limited.text()).toBe('');
    expect(missing.bodyUsed).toBe(false);
    const forged = await POST(
      deliver(body, { ...IP, 'linear-signature': sign(body, 'nope') })
    );
    expect(forged.status).toBe(429);
    // Another IP is not affected.
    const other = await POST(deliver(body, { 'x-real-ip': '203.0.113.51' }));
    expect(other.status).toBe(400);
  });

  test('a signed delivery is never limited, even from an IP over the limit, and never counts', async () => {
    for (let i = 0; i < LIMIT + 5; i += 1) {
      await POST(deliver(payload(), IP));
    }
    const signed = payload({ type: 'Comment' });
    const response = await POST(
      deliver(signed, { ...IP, 'linear-signature': sign(signed) })
    );
    expect(response.status).toBe(200);
    // A signed delivery refused after the signature check (stale
    // timestamp) is a 400, not a 429, and does not count.
    const stale = payload({ webhookTimestamp: Date.now() - 5 * 60_000 });
    const old = await POST(
      deliver(stale, { ...IP, 'linear-signature': sign(stale) })
    );
    expect(old.status).toBe(400);
    resetProcessRateLimiters();
    for (let i = 0; i < LIMIT + 5; i += 1) {
      const ok = payload({ type: 'Comment' });
      const answer = await POST(
        deliver(ok, { ...IP, 'linear-signature': sign(ok) })
      );
      expect(answer.status).toBe(200);
    }
    expect((await POST(deliver(payload(), IP))).status).toBe(400);
  });

  test('without a client IP nothing is limited', async () => {
    for (let i = 0; i < LIMIT + 20; i += 1) {
      expect((await POST(deliver(payload(), {}))).status).toBe(400);
    }
  });
});

describe('POST /api/webhooks/linear with personal API keys', () => {
  test('LINEAR_AUTH=api_key answers a bare 404 without reading the body', async () => {
    const savedAuth = process.env.LINEAR_AUTH;
    process.env.LINEAR_AUTH = 'api_key';
    try {
      const body = payload();
      const request = deliver(body, { 'linear-signature': sign(body) });
      const response = await POST(request);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('');
      expect(request.bodyUsed).toBe(false);
    } finally {
      if (savedAuth === undefined) delete process.env.LINEAR_AUTH;
      else process.env.LINEAR_AUTH = savedAuth;
    }
  });
});
