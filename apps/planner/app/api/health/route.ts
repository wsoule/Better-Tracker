import { createLogger } from '@better-tracker/logger';

import { getEngine } from '../../../lib/runtime';

const logger = createLogger({ name: 'planner.health' });

const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * GET /api/health for Railway's healthcheck (no auth, never cached):
 * `{ ok, db }`. The engine has no dedicated ping, so the probe is the
 * engine boot (store opened and migrated) plus one small read of the
 * installations table; a failure answers 503 so a deploy with a broken
 * database never goes live.
 */
export async function GET(): Promise<Response> {
  try {
    const engine = await getEngine();
    await engine.listWorkspaceIds();
    return Response.json({ ok: true, db: 'ok' }, { headers: NO_STORE });
  } catch (error) {
    logger.error('healthcheck failed', { err: error });
    return Response.json(
      { ok: false, db: 'error' },
      { status: 503, headers: NO_STORE }
    );
  }
}
