import { isFixtureEnv, linearAuthFromEnv } from '@better-tracker/engine';
import {
  parseWebhookEvent,
  verifyWebhookSignature,
} from '@better-tracker/linear';
import { createLogger } from '@better-tracker/logger';
import { after } from 'next/server';

import { readLimitedText } from '../../../../lib/body';
import { limitByIp, RATE_LIMITS } from '../../../../lib/rate-limit';
import { getEngine } from '../../../../lib/runtime';

export const runtime = 'nodejs';

const logger = createLogger({ name: 'planner.webhooks' });

/**
 * Linear payloads are small (an entity id and a few fields); anything past
 * this is refused unread. next.config.ts caps what the proxy buffers at
 * 2 MB, above every body a route reads.
 */
const MAX_WEBHOOK_BYTES = 1024 * 1024;

function empty(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers },
  });
}

/**
 * The answer to a refused delivery (no signature, a body over the limit,
 * a signature that does not match): `status`, or a bare 429 with
 * Retry-After once the client IP has had 100 refusals in the last minute
 * (lib/rate-limit.ts). Only refusals count, so a delivery Linear signed is
 * never limited, even from an address an outsider's refusals filled
 * (Linear's own webhook senders are shared by every Linear customer).
 * Without a client IP nothing is limited.
 */
function refuse(request: Request, status: number): Response {
  const limited = limitByIp(request, RATE_LIMITS.webhookRefused);
  if (limited !== null) {
    return empty(429, { 'Retry-After': String(limited.retryAfterSeconds) });
  }
  return empty(status);
}

/**
 * POST /api/webhooks/linear (architecture §4.1, §8.1). Linear wants a 2xx
 * within 5 seconds, so this only checks the delivery and acks. In order,
 * nothing read before it is needed: LINEAR_WEBHOOK_SECRET must be set
 * (else 503) and the Linear-Signature header present (else 400), both
 * before the body is read; the raw body is at most 1 MiB (else 413); its
 * HMAC must match (else 400) and its webhookTimestamp be within 60 s
 * (else 400). A refused delivery (no signature, too large, a bad
 * signature) counts against its client IP, which gets a bare 429 after
 * 100 in a minute; a signed one never does, nor anything after the
 * signature check. No answer carries detail for a caller who cannot sign.
 * A verified event is handed to the engine in after(), deduped by the
 * Linear-Delivery header. Event types the planner does not use are acked
 * and dropped, so Linear never disables the webhook over them. Demo mode
 * has no webhooks and acks everything; api_key mode answers a bare 404.
 */
export async function POST(request: Request): Promise<Response> {
  // Personal API keys: no webhooks at all (nothing stored could process
  // them), refused before the body is read.
  if (linearAuthFromEnv(process.env) === 'api_key') {
    return new Response(null, { status: 404 });
  }
  if (isFixtureEnv(process.env)) return empty(200);

  const secret = process.env.LINEAR_WEBHOOK_SECRET ?? '';
  if (secret === '') {
    logger.error(
      'LINEAR_WEBHOOK_SECRET is not set; refusing webhook deliveries'
    );
    return empty(503);
  }
  const signature = request.headers.get('linear-signature');
  if (signature === null || signature.trim() === '') {
    return refuse(request, 400);
  }

  const raw = await readLimitedText(request, MAX_WEBHOOK_BYTES);
  if (raw === null) return refuse(request, 413);

  if (!verifyWebhookSignature(raw, signature, secret)) {
    const answer = refuse(request, 400);
    if (answer.status !== 429) logger.warn('webhook signature mismatch');
    return answer;
  }

  const parsed = parseWebhookEvent(raw, Date.now());
  if (!parsed.ok) {
    if (parsed.reason === 'unsupported_type') return empty(200);
    logger.warn('webhook rejected', { reason: parsed.reason });
    return empty(400);
  }

  const { event } = parsed;
  const deliveryId = request.headers.get('linear-delivery');
  after(async () => {
    try {
      const engine = await getEngine();
      await engine.handleWebhook({
        deliveryId,
        workspaceId: event.workspaceId,
        type: event.type,
        action: event.action,
        entityId: event.entityId,
        updatedFrom: event.updatedFrom,
        createdAt: event.createdAt,
      });
    } catch (error) {
      logger.error('webhook processing failed', {
        type: event.type,
        workspaceId: event.workspaceId,
        err: error,
      });
    }
  });
  return empty(200);
}
