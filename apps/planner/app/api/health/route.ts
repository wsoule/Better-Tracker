import { createLogger } from '@better-tracker/logger';

import { getEngine } from '../../../lib/runtime';

const logger = createLogger({ name: 'planner.health' });

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * GET /api/health for Railway's healthcheck (no auth, never cached):
 * `{ ok, db }`. The probe is the engine boot (store opened and migrated)
 * plus the store's own liveness check (`engine.ping()`, one trivial query
 * that never throws); a failed boot or a false ping answers 503, so a
 * deploy with a broken database never goes live and a database that goes
 * away later shows on the healthcheck.
 */
export async function GET(): Promise<Response> {
  try {
    const engine = await getEngine();
    if (await engine.ping()) {
      return Response.json({ ok: true, db: 'ok' }, { headers: NO_STORE });
    }
    logger.error('healthcheck failed: the database did not answer');
  } catch (error) {
    logger.error('healthcheck failed', { err: error });
  }
  return Response.json(
    { ok: false, db: 'error' },
    { status: 503, headers: NO_STORE }
  );
}
