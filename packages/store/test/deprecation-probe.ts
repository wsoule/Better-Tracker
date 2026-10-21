// Run as a subprocess by isolation.test.ts (not a test file itself): opens
// the store on TEST_DATABASE_URL, runs plain queries and transactions on
// several fresh pooled connections at once, closes it, and exits 1 after
// printing every DeprecationWarning the process emitted (none expected).
import { openStore } from '../src/store';
import { newWorkspaceId, TEST_KEY } from './fixtures';

const deprecations: string[] = [];
process.on('warning', (warning) => {
  if (warning.name === 'DeprecationWarning') {
    deprecations.push(warning.message);
  }
});

const store = await openStore({
  databaseUrl: process.env['TEST_DATABASE_URL'] ?? '',
  encryptionKey: TEST_KEY,
});
await store.migrate();
const workspaceId = newWorkspaceId();
// Concurrent calls make the pool open several connections, each of which
// would carry the old connect-time query.
await Promise.all([
  store.ping(),
  store.getSettings(workspaceId),
  store.claimJob(workspaceId, 'daily', '2026-10-21', '2026-10-21T08:00:00Z'),
  store.listWarningMemory(workspaceId),
  store.recordFullSync(workspaceId, {
    at: '2026-10-21T08:00:00Z',
    ok: true,
    error: null,
  }),
]);
await store.close();
// Warnings are emitted on a later tick than the call that caused them.
await new Promise((resolve) => setTimeout(resolve, 20));
if (deprecations.length > 0) {
  console.error(deprecations.map((m) => `DeprecationWarning: ${m}`).join('\n'));
  process.exit(1);
}
