// After the OAuth e2e (architecture §11): scans everything both planners
// wrote under E2E_ARTIFACTS_DIR for the OAuth needles (a Linear token or
// code the fake issued, the OAuth client secret, the planners' own
// secrets: oauth-leak-needles.ts), and exits non-zero when any is found.
//
//   bun e2e/scan-oauth-leaks.ts "$E2E_ARTIFACTS_DIR"
//
// The same two scans as the api-key suite's (leak-scan.ts) over both
// planners' PGlite directories, logs and TMPDIR. Stored Linear tokens are
// encrypted and session tokens hashed, so neither may appear in plain
// text anywhere; the suite itself checks the session tokens it saw.

import { existsSync } from 'node:fs';

import { scanArtifacts } from './leak-scan';
import { OAUTH_LEAK_NEEDLES } from './oauth-leak-needles';

const dir = process.argv[2] ?? '';
if (dir === '' || !existsSync(dir)) {
  console.error('scan-oauth-leaks: pass the E2E_ARTIFACTS_DIR to scan');
  process.exit(2);
}

const scan = await scanArtifacts(dir, OAUTH_LEAK_NEEDLES, [
  'pglite',
  'pglite-closed',
]);
if (scan.found.length > 0) {
  console.error(
    `scan-oauth-leaks: an OAuth needle was found in:\n${scan.found.join('\n')}`
  );
  process.exit(1);
}
console.log(
  `scan-oauth-leaks: clean (${scan.files} files, ${scan.tables} tables, ${OAUTH_LEAK_NEEDLES.length} needles)`
);
