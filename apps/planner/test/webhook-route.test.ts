import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';

import { POST } from '../app/api/webhooks/linear/route';

// The webhook route rejects before it ever needs the engine: these cases
// run the exported handler with plain Requests and a test secret.

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

function deliver(body: string, headers: Record<string, string>): Request {
  return new Request(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
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

  test('refuses bodies over 5 MiB with 413', async () => {
    const body = payload({ padding: 'x'.repeat(5 * 1024 * 1024) });
    const response = await POST(
      deliver(body, { 'linear-signature': sign(body) })
    );
    expect(response.status).toBe(413);
  });

  test('without a configured secret, refuses with 503', async () => {
    delete process.env.LINEAR_WEBHOOK_SECRET;
    const body = payload();
    const response = await POST(
      deliver(body, { 'linear-signature': sign(body) })
    );
    expect(response.status).toBe(503);
  });

  test('demo mode acks without checking anything', async () => {
    process.env.LINEAR_FIXTURE = '1';
    const response = await POST(deliver('not json', {}));
    expect(response.status).toBe(200);
  });
});
