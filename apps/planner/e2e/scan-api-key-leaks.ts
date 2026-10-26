// After the api-key e2e (architecture §11): scans everything the server
// wrote under E2E_ARTIFACTS_DIR for the test keys' needles, and exits
// non-zero when any is found.
//
//   bun e2e/scan-api-key-leaks.ts "$E2E_ARTIFACTS_DIR"
//
// Two scans (leak-scan.ts): every byte of every file (the PGlite
// directory, server.log, the server's TMPDIR), and SQL over the PGlite
// database (every public table, every row cast to text), since a byte
// scan alone would miss TOAST-compressed jsonb.

import { existsSync } from 'node:fs';

import { LEAK_NEEDLES } from './leak-needles';
import { scanArtifacts } from './leak-scan';

const dir = process.argv[2] ?? '';
if (dir === '' || !existsSync(dir)) {
  console.error('scan-api-key-leaks: pass the E2E_ARTIFACTS_DIR to scan');
  process.exit(2);
}

const scan = await scanArtifacts(dir, LEAK_NEEDLES, ['pglite']);
if (scan.found.length > 0) {
  console.error(
    `scan-api-key-leaks: a test key's needle was found in:\n${scan.found.join('\n')}`
  );
  process.exit(1);
}
console.log(
  `scan-api-key-leaks: clean (${scan.files} files, ${scan.tables} tables, ${LEAK_NEEDLES.length} needles)`
);
