import { after } from 'next/server';

import { handleConnect } from '../../../../lib/api-key-connect';
import { processConnectLimiter } from '../../../../lib/connect-limit';
import { getEngine } from '../../../../lib/runtime';

export const runtime = 'nodejs';

/**
 * POST /api/auth/key (LINEAR_AUTH=api_key only; 404 elsewhere): the
 * connect form's target. A thin wrapper around handleConnect
 * (lib/api-key-connect.ts), which checks the origin, HTTPS, the form,
 * the rate limits and the key's shape, then has the engine ask Linear
 * whose key it is. The key is held in this server's memory only; the
 * browser gets a session cookie and a 303.
 */
export async function POST(request: Request): Promise<Response> {
  const engine = await getEngine();
  return handleConnect(request, {
    engine,
    limiter: processConnectLimiter(),
    schedule: (task) => after(task),
  });
}
