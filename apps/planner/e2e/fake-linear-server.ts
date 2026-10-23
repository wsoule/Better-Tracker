// The fake Linear GraphQL endpoint for the api-key e2e, on loopback only:
//
//   bun e2e/fake-linear-server.ts --port <port>
//
// POST /graphql answers like Linear (fake-linear.ts); GET /__requests
// lists {operation, auth, who, keyInBodyOrUrl} for every request so far,
// never a key. It refuses to start without FAKE_LINEAR=1, and in a
// production NODE_ENV, so it can never stand in for Linear by accident.

import { createFakeLinear } from './fake-linear';

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

const today = new Date().toISOString().slice(0, 10);
const fake = createFakeLinear({ today });

Bun.serve({
  hostname: '127.0.0.1',
  port,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (request.method === 'GET' && pathname === '/__requests') {
      return Response.json(fake.requests);
    }
    if (request.method === 'GET' && pathname === '/__health') {
      return new Response('ok');
    }
    if (request.method === 'POST' && pathname === '/graphql') {
      return fake.handle(request);
    }
    return new Response('not found', { status: 404 });
  },
});
console.log(`fake Linear on http://127.0.0.1:${port}/graphql`);
