// The fake Linear for the browser tests, on loopback only:
//
//   bun e2e/fake-linear-server.ts --port <port>
//
// One origin, http://127.0.0.1:<port>, answers like Linear's two hosts
// (fake-linear.ts): POST /graphql, /oauth/token and /oauth/revoke as
// https://api.linear.app does, GET|POST /oauth/authorize (the workspace
// chooser) as https://linear.app does, and the test controls GET
// /__requests ({operation, auth, who, …} for every request so far, never
// a credential), GET /__health, GET /__oauth/code, GET /__oauth/grants and
// POST /__oauth/authorize-behaviour. It refuses to start without
// FAKE_LINEAR=1, and in a production NODE_ENV, so it can never stand in
// for Linear by accident.
//
// The OAuth client it accepts is FAKE_LINEAR_CLIENT_ID and
// FAKE_LINEAR_CLIENT_SECRET (E2E_OAUTH_CLIENT when unset), and
// FAKE_LINEAR_TOKEN_TTL_SECONDS sets the access token lifetime (Linear's
// 86399 when unset), so a test can make tokens expire and be refreshed.

import { createFakeLinear } from './fake-linear';
import { E2E_OAUTH_CLIENT } from './fake-linear-oauth';

if (process.env.FAKE_LINEAR !== '1' || process.env.NODE_ENV === 'production') {
  console.error(
    'fake-linear-server: test only (set FAKE_LINEAR=1, not in production)'
  );
  process.exit(1);
}

const flag = process.argv.indexOf('--port');
const port = Number(flag === -1 ? Number.NaN : process.argv[flag + 1]);
if (!Number.isInteger(port) || port <= 0) {
  console.error('fake-linear-server: --port <port> is required');
  process.exit(2);
}

// An environment variable, or undefined when unset or empty.
function setting(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

const ttl = setting('FAKE_LINEAR_TOKEN_TTL_SECONDS');
const accessTokenTtlSeconds = ttl === undefined ? undefined : Number(ttl);
if (
  accessTokenTtlSeconds !== undefined &&
  (!Number.isInteger(accessTokenTtlSeconds) || accessTokenTtlSeconds <= 0)
) {
  console.error(
    'fake-linear-server: FAKE_LINEAR_TOKEN_TTL_SECONDS must be a whole number of seconds'
  );
  process.exit(2);
}

const today = new Date().toISOString().slice(0, 10);
const fake = createFakeLinear({
  today,
  oauthClient: {
    clientId: setting('FAKE_LINEAR_CLIENT_ID') ?? E2E_OAUTH_CLIENT.clientId,
    clientSecret:
      setting('FAKE_LINEAR_CLIENT_SECRET') ?? E2E_OAUTH_CLIENT.clientSecret,
  },
  ...(accessTokenTtlSeconds === undefined ? {} : { accessTokenTtlSeconds }),
});

Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch: (request) => fake.handle(request),
});
console.log(`fake Linear on http://127.0.0.1:${port}/graphql`);
