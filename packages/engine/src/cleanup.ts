// cleanup() (§7.1, §9 `tick`): the housekeeping the worker runs after every
// tick.
//
// - Expired sessions are deleted. In real mode their Linear grants are
//   revoked, best effort: Linear may auto-revoke a user's oldest tokens
//   once they hold more than about 10 for one app, so grants of sessions
//   nobody can use any more must not pile up. A failed revocation is logged
//   and counted, never fatal (the session is gone either way).
// - Webhook delivery records older than WEBHOOK_RETENTION_DAYS are pruned.
//   Dedupe only needs Linear's retry window (about six hours); the longer
//   window keeps each delivery's processing error around to investigate.

import type { OAuthClientConfig } from '@better-tracker/linear';

import { revokeGrant } from './auth';
import type { EngineRuntime } from './runtime';
import type { CleanupResult } from './types';

/** How long webhook delivery records are kept, in days. */
export const WEBHOOK_RETENTION_DAYS = 30;

const DAY_MS = 86_400_000;
/** Expired sessions taken from the store (and revoked) per call. */
const SESSION_BATCH = 50;
/**
 * At most this many expired sessions are revoked per cleanup, so a backlog
 * cannot stretch one tick past its timeout. The rest wait for the next
 * tick; being expired, they cannot be used meanwhile.
 */
const MAX_SESSIONS_PER_CLEANUP = 500;

// Takes expired sessions in batches and revokes each one's Linear grant,
// adding to `result`. Stops at a short batch (nothing left) or the cap.
async function revokeExpiredSessions(
  rt: EngineRuntime,
  oauth: OAuthClientConfig,
  now: Date,
  result: CleanupResult
): Promise<void> {
  const nowIso = now.toISOString();
  while (result.expiredSessions < MAX_SESSIONS_PER_CLEANUP) {
    const limit = Math.min(
      SESSION_BATCH,
      MAX_SESSIONS_PER_CLEANUP - result.expiredSessions
    );
    const batch = await rt.store.takeExpiredSessions(nowIso, limit);
    result.expiredSessions += batch.length;
    for (const session of batch) {
      const revoked = await revokeGrant(rt, oauth, session.tokens);
      if (revoked.ok) {
        result.revokedTokens += 1;
        continue;
      }
      result.revokeFailures += 1;
      rt.logger.warn("could not revoke an expired session's Linear token", {
        workspaceId: session.workspaceId,
        userId: session.userId,
        sessionId: session.id,
        error: revoked.error,
      });
    }
    if (batch.length < limit) return;
  }
}

/** Deletes expired sessions (revoking their grants) and old deliveries. */
export async function cleanup(rt: EngineRuntime): Promise<CleanupResult> {
  const now = rt.clock();
  const result: CleanupResult = {
    expiredSessions: 0,
    revokedTokens: 0,
    revokeFailures: 0,
    oldDeliveries: 0,
  };
  const oauth = rt.config.oauth;
  if (rt.linear.mode === 'fixture' || oauth === null) {
    // Demo sessions carry no real Linear grant to revoke.
    result.expiredSessions = await rt.store.deleteExpiredSessions(
      now.toISOString()
    );
  } else {
    await revokeExpiredSessions(rt, oauth, now, result);
  }
  result.oldDeliveries = await rt.store.pruneWebhookDeliveries(
    new Date(now.getTime() - WEBHOOK_RETENTION_DAYS * DAY_MS).toISOString()
  );
  rt.logger.info('cleanup finished', { ...result });
  return result;
}
