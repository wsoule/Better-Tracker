import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Tamper-proof, expiring cookie values: base64url(JSON payload) + "." +
 * base64url(HMAC-SHA256(payload, secret)). Used for the short-lived OAuth
 * cookie that carries state + PKCE verifier between /api/auth/linear and the
 * callback. Not encrypted: it holds nothing that is useful once the code has
 * been exchanged, and it is httpOnly.
 */
export function signValue(
  payload: Record<string, unknown>,
  secret: string,
  expiresAtMs: number
): string {
  assertSecret(secret);
  const body = Buffer.from(
    JSON.stringify({ ...payload, exp: expiresAtMs }),
    'utf8'
  ).toString('base64url');
  return `${body}.${mac(body, secret)}`;
}

/** Returns the payload when the signature is valid and not expired, else null. */
export function verifyValue(
  value: string | undefined,
  secret: string,
  nowMs: number
): Record<string, unknown> | null {
  assertSecret(secret);
  if (value === undefined) return null;
  const dot = value.indexOf('.');
  if (dot <= 0 || dot !== value.lastIndexOf('.')) return null;
  const body = value.slice(0, dot);
  const given = Buffer.from(value.slice(dot + 1), 'base64url');
  const expected = Buffer.from(mac(body, secret), 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const exp = record.exp;
  if (typeof exp !== 'number' || exp <= nowMs) return null;
  return record;
}

/** Constant-time string equality for state parameters. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function mac(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

function assertSecret(secret: string): void {
  if (secret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters.');
  }
}
