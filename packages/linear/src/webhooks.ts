// Linear webhook verification and parsing (architecture §4.1).
// - `Linear-Signature` is the lowercase hex HMAC-SHA256 of the raw body with
//   the app's webhook signing secret; compare in constant time, before any
//   JSON parsing.
// - Freshness comes from the body's `webhookTimestamp` (ms): Linear's SDK
//   rejects a delta of more than 60 s in either direction, so exactly 60 s
//   is still accepted.

import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  isRecord,
  optionalNumber,
  optionalObject,
  optionalString,
} from './json';

/** Default freshness window, matching Linear's SDK. */
export const WEBHOOK_TOLERANCE_MS = 60_000;

const HEX_SHA256 = /^[0-9a-f]{64}$/i;

function toBytes(rawBody: string | Uint8Array): Uint8Array {
  return typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
}

/**
 * True when `signatureHeader` is the hex HMAC-SHA256 of the exact raw body.
 * Missing headers, non-hex values and length mismatches are false (never
 * thrown), and the comparison itself is constant time.
 */
export function verifyWebhookSignature(
  rawBody: string | Uint8Array,
  signatureHeader: string | null,
  secret: string
): boolean {
  if (signatureHeader === null || secret === '') return false;
  const provided = signatureHeader.trim();
  if (!HEX_SHA256.test(provided)) return false;
  const expected = createHmac('sha256', secret)
    .update(toBytes(rawBody))
    .digest();
  const actual = Buffer.from(provided, 'hex');
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** A webhook payload reduced to what the engine routes on. */
export interface LinearWebhookEvent {
  /** Payload `organizationId`: the workspace the delivery is for. */
  workspaceId: string;
  /** Issue, Project, Initiative, User, OAuthApp, … */
  type: string;
  /** create, update, remove, revoked, … */
  action: string;
  /** `data.id`; null for events without data (OAuthApp revoked). */
  entityId: string | null;
  webhookTimestamp: number;
  /** Previous values of changed fields on update events. */
  updatedFrom: Record<string, unknown> | null;
}

export type WebhookParseResult =
  | { ok: true; event: LinearWebhookEvent }
  | {
      ok: false;
      reason: 'invalid_json' | 'missing_fields' | 'stale_timestamp';
    };

/**
 * Parses a verified webhook body. Rejects bodies that are not JSON objects,
 * lack organizationId/type/action/webhookTimestamp, or whose timestamp is
 * more than `toleranceMs` away from `nowMs` (either direction).
 */
export function parseWebhookEvent(
  rawBody: string,
  nowMs: number,
  toleranceMs: number = WEBHOOK_TOLERANCE_MS
): WebhookParseResult {
  let body: unknown;
  try {
    body = JSON.parse(rawBody) as unknown;
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (!isRecord(body)) return { ok: false, reason: 'invalid_json' };

  const workspaceId = optionalString(body, 'organizationId');
  const type = optionalString(body, 'type');
  const action = optionalString(body, 'action');
  const webhookTimestamp = optionalNumber(body, 'webhookTimestamp');
  if (
    workspaceId === null ||
    type === null ||
    action === null ||
    webhookTimestamp === null
  ) {
    return { ok: false, reason: 'missing_fields' };
  }
  if (Math.abs(nowMs - webhookTimestamp) > toleranceMs) {
    return { ok: false, reason: 'stale_timestamp' };
  }

  const data = optionalObject(body, 'data');
  return {
    ok: true,
    event: {
      workspaceId,
      type,
      action,
      entityId: data === null ? null : optionalString(data, 'id'),
      webhookTimestamp,
      updatedFrom: optionalObject(body, 'updatedFrom'),
    },
  };
}
