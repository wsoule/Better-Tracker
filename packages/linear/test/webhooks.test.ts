import { describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';

import {
  parseWebhookEvent,
  verifyWebhookSignature,
  WEBHOOK_TOLERANCE_MS,
} from '../src/webhooks';

const SECRET = 'lin_wh_test_secret';
const NOW = 1792584000000; // 2026-10-21T12:00:00.000Z

// Reference vector computed independently with
// `printf '%s' "$BODY" | openssl dgst -sha256 -hmac lin_wh_test_secret`.
const VECTOR_BODY =
  '{"action":"update","type":"Issue","organizationId":"org-1","webhookTimestamp":1792584000000,"data":{"id":"iss-1"}}';
const VECTOR_SIGNATURE =
  'd6fcfebbc78fec27d59032905cf611969f53d7aab8d4942bf9147765911ddcf0';

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action: 'update',
    type: 'Issue',
    organizationId: 'org-1',
    webhookId: 'wh-1',
    webhookTimestamp: NOW,
    createdAt: '2026-10-21T12:00:00.000Z',
    url: 'https://linear.app/acme/issue/ENG-1',
    data: { id: 'iss-1', title: 'Hello' },
    updatedFrom: { stateId: 'st-old', updatedAt: '2026-10-20T00:00:00.000Z' },
    actor: { id: 'user-1', type: 'user' },
    ...overrides,
  });
}

describe('verifyWebhookSignature', () => {
  test('accepts the reference vector (string and raw bytes)', () => {
    expect(verifyWebhookSignature(VECTOR_BODY, VECTOR_SIGNATURE, SECRET)).toBe(
      true
    );
    expect(
      verifyWebhookSignature(
        new TextEncoder().encode(VECTOR_BODY),
        VECTOR_SIGNATURE,
        SECRET
      )
    ).toBe(true);
    expect(
      verifyWebhookSignature(
        VECTOR_BODY,
        VECTOR_SIGNATURE.toUpperCase(),
        SECRET
      )
    ).toBe(true);
  });

  test('rejects the wrong secret', () => {
    expect(
      verifyWebhookSignature(VECTOR_BODY, VECTOR_SIGNATURE, 'other-secret')
    ).toBe(false);
  });

  test('rejects a tampered body, even by one byte or whitespace', () => {
    expect(
      verifyWebhookSignature(
        VECTOR_BODY.replace('iss-1', 'iss-2'),
        VECTOR_SIGNATURE,
        SECRET
      )
    ).toBe(false);
    expect(
      verifyWebhookSignature(`${VECTOR_BODY} `, VECTOR_SIGNATURE, SECRET)
    ).toBe(false);
    // Re-serialised JSON is not the raw body.
    expect(
      verifyWebhookSignature(
        JSON.stringify(JSON.parse(VECTOR_BODY), null, 2),
        VECTOR_SIGNATURE,
        SECRET
      )
    ).toBe(false);
  });

  test('missing, empty, short, long or non-hex headers are false, never thrown', () => {
    expect(verifyWebhookSignature(VECTOR_BODY, null, SECRET)).toBe(false);
    expect(verifyWebhookSignature(VECTOR_BODY, '', SECRET)).toBe(false);
    expect(
      verifyWebhookSignature(VECTOR_BODY, VECTOR_SIGNATURE.slice(0, 62), SECRET)
    ).toBe(false);
    expect(
      verifyWebhookSignature(VECTOR_BODY, `${VECTOR_SIGNATURE}00`, SECRET)
    ).toBe(false);
    expect(
      verifyWebhookSignature(
        VECTOR_BODY,
        `${VECTOR_SIGNATURE.slice(0, 63)}z`,
        SECRET
      )
    ).toBe(false);
    expect(verifyWebhookSignature(VECTOR_BODY, VECTOR_SIGNATURE, '')).toBe(
      false
    );
  });

  test('a body signed by sign() verifies', () => {
    const body = payload();
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe(true);
  });
});

describe('parseWebhookEvent', () => {
  test('normalises an Issue update', () => {
    expect(parseWebhookEvent(payload(), NOW)).toEqual({
      ok: true,
      event: {
        workspaceId: 'org-1',
        type: 'Issue',
        action: 'update',
        entityId: 'iss-1',
        webhookTimestamp: NOW,
        updatedFrom: {
          stateId: 'st-old',
          updatedAt: '2026-10-20T00:00:00.000Z',
        },
      },
    });
  });

  test('timestamps exactly ±60 s away are accepted; one ms further is stale', () => {
    expect(WEBHOOK_TOLERANCE_MS).toBe(60_000);
    for (const delta of [60_000, -60_000, 0]) {
      expect(
        parseWebhookEvent(payload({ webhookTimestamp: NOW + delta }), NOW).ok
      ).toBe(true);
    }
    for (const delta of [60_001, -60_001, 3_600_000]) {
      expect(
        parseWebhookEvent(payload({ webhookTimestamp: NOW + delta }), NOW)
      ).toEqual({
        ok: false,
        reason: 'stale_timestamp',
      });
    }
  });

  test('a custom tolerance is honoured', () => {
    expect(
      parseWebhookEvent(payload({ webhookTimestamp: NOW - 5_000 }), NOW, 1_000)
    ).toEqual({
      ok: false,
      reason: 'stale_timestamp',
    });
  });

  test('invalid JSON and non-object bodies', () => {
    expect(parseWebhookEvent('{not json', NOW)).toEqual({
      ok: false,
      reason: 'invalid_json',
    });
    expect(parseWebhookEvent('[1,2]', NOW)).toEqual({
      ok: false,
      reason: 'invalid_json',
    });
    expect(parseWebhookEvent('null', NOW)).toEqual({
      ok: false,
      reason: 'invalid_json',
    });
  });

  test('missing required fields', () => {
    for (const field of [
      'organizationId',
      'type',
      'action',
      'webhookTimestamp',
    ]) {
      expect(parseWebhookEvent(payload({ [field]: undefined }), NOW)).toEqual({
        ok: false,
        reason: 'missing_fields',
      });
    }
    expect(
      parseWebhookEvent(payload({ webhookTimestamp: String(NOW) }), NOW)
    ).toEqual({
      ok: false,
      reason: 'missing_fields',
    });
  });

  test('OAuthApp revoked has no data: entityId null', () => {
    const body = JSON.stringify({
      action: 'revoked',
      type: 'OAuthApp',
      organizationId: 'org-1',
      oauthClientId: 'client-123',
      createdAt: '2026-10-21T12:00:00.000Z',
      webhookId: 'wh-1',
      webhookTimestamp: NOW - 1_000,
    });
    expect(parseWebhookEvent(body, NOW)).toEqual({
      ok: true,
      event: {
        workspaceId: 'org-1',
        type: 'OAuthApp',
        action: 'revoked',
        entityId: null,
        webhookTimestamp: NOW - 1_000,
        updatedFrom: null,
      },
    });
  });

  test('remove events carry the entity id and no updatedFrom', () => {
    const result = parseWebhookEvent(
      payload({
        action: 'remove',
        type: 'Project',
        data: { id: 'proj-1' },
        updatedFrom: undefined,
      }),
      NOW
    );
    expect(result).toEqual({
      ok: true,
      event: {
        workspaceId: 'org-1',
        type: 'Project',
        action: 'remove',
        entityId: 'proj-1',
        webhookTimestamp: NOW,
        updatedFrom: null,
      },
    });
  });

  test('types the engine does not handle are a typed rejection', () => {
    for (const type of ['Comment', 'Cycle', 'ProjectUpdate', 'Reaction']) {
      expect(parseWebhookEvent(payload({ type }), NOW)).toEqual({
        ok: false,
        reason: 'unsupported_type',
      });
    }
    for (const type of ['Issue', 'Project', 'Initiative', 'User']) {
      expect(parseWebhookEvent(payload({ type }), NOW)).toMatchObject({
        ok: true,
        event: { type, entityId: 'iss-1' },
      });
    }
  });

  test('an entity event without data.id cannot be refetched: missing_fields', () => {
    for (const data of [undefined, null, {}, { id: '' }, { id: 42 }]) {
      expect(parseWebhookEvent(payload({ data }), NOW)).toEqual({
        ok: false,
        reason: 'missing_fields',
      });
    }
  });

  test('OAuthAuthorization (no data) is accepted with entityId null', () => {
    const body = JSON.stringify({
      action: 'updated',
      type: 'OAuthAuthorization',
      organizationId: 'org-1',
      oauthClientId: 'client-123',
      userId: 'user-9',
      activeTokensForUser: 0,
      createdAt: '2026-10-21T12:00:00.000Z',
      webhookId: 'wh-1',
      webhookTimestamp: NOW,
    });
    expect(parseWebhookEvent(body, NOW)).toEqual({
      ok: true,
      event: {
        workspaceId: 'org-1',
        type: 'OAuthAuthorization',
        action: 'updated',
        entityId: null,
        webhookTimestamp: NOW,
        updatedFrom: null,
      },
    });
  });
});
