import { isFixtureEnv } from '@better-tracker/engine';
import {
  parseWebhookEvent,
  verifyWebhookSignature,
} from '@better-tracker/linear';
import { createLogger } from '@better-tracker/logger';
import { after } from 'next/server';

import { readLimitedText } from '../../../../lib/body';
import { getEngine } from '../../../../lib/runtime';

export const runtime = 'nodejs';

const logger = createLogger({ name: 'planner.webhooks' });

/** Linear payloads are small; anything past this is refused unread. */
const MAX_WEBHOOK_BYTES = 5 * 1024 * 1024;

function empty(status: number): Response {
  return new Response(null, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

/**
 * POST /api/webhooks/linear (architecture §4.1, §8.1). Linear wants a 2xx
 * within 5 seconds, so this only checks the delivery and acks: the raw
 * body (≤ 5 MiB, else 413) must carry a valid Linear-Signature HMAC and a
 * webhookTimestamp within 60 s; anything that fails is a bare 400 (no
 * detail for a caller who cannot sign). A verified event is handed to the
 * engine in after(), deduped by the Linear-Delivery header. Event types
 * the planner does not use are acked and dropped, so Linear never disables
 * the webhook over them. Demo mode has no webhooks and acks everything.
 */
export async function POST(request: Request): Promise<Response> {
  if (isFixtureEnv(process.env)) return empty(200);

  const raw = await readLimitedText(request, MAX_WEBHOOK_BYTES);
  if (raw === null) return empty(413);

  const secret = process.env.LINEAR_WEBHOOK_SECRET ?? '';
  if (secret === '') {
    logger.error(
      'LINEAR_WEBHOOK_SECRET is not set; refusing webhook deliveries'
    );
    return empty(503);
  }
  if (
    !verifyWebhookSignature(
      raw,
      request.headers.get('linear-signature'),
      secret
    )
  ) {
    logger.warn('webhook signature mismatch');
    return empty(400);
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
