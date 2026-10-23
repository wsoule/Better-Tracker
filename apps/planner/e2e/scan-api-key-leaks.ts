// After the api-key e2e (architecture §11): scans everything the server
// wrote under E2E_ARTIFACTS_DIR for the test keys' needles, and exits
// non-zero when any is found.
//
//   bun e2e/scan-api-key-leaks.ts "$E2E_ARTIFACTS_DIR"
//
// Two scans: every byte of every file (the PGlite directory, server.log,
// the server's TMPDIR), and SQL over the PGlite database (every public
// table, every row cast to text), since a byte scan alone would miss
// TOAST-compressed jsonb.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The store's own PGlite opener (resolves PGlite from the store package,
// so the planner needs no database dependency of its own).
import { openPgliteSql } from '../../../packages/store/src/db';
import { LEAK_NEEDLES } from './leak-needles';

const dir = process.argv[2] ?? '';
if (dir === '' || !existsSync(dir)) {
  console.error('scan-api-key-leaks: pass the E2E_ARTIFACTS_DIR to scan');
  process.exit(2);
}

function files(root: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...files(path));
    else if (stat.isFile()) out.push(path);
  }
  return out;
}

const found: string[] = [];
const all = files(dir);
for (const path of all) {
  const bytes = readFileSync(path);
  for (const needle of LEAK_NEEDLES) {
    if (bytes.includes(needle)) found.push(`${path} (bytes)`);
  }
}

const pgliteDir = join(dir, 'pglite');
let tables = 0;
if (existsSync(pgliteDir)) {
  const db = await openPgliteSql(pgliteDir);
  try {
    const listed = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );
    tables = listed.length;
    // Base64 needles can hold characters LIKE treats specially; the
    // text-safe ones are enough here (the byte scan covered the rest).
    const textSafe = LEAK_NEEDLES.filter((needle) =>
      /^[A-Za-z0-9_-]+$/.test(needle)
    );
    for (const { table_name: table } of listed) {
      for (const needle of textSafe) {
        const result = await db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM "${table}" t WHERE CAST(t.* AS text) LIKE $1`,
          [`%${needle.replaceAll('_', '\\_')}%`]
        );
        if ((result[0]?.n ?? 0) > 0) found.push(`${table} (sql)`);
      }
    }
  } finally {
    await db.close();
  }
} else {
  found.push(`${pgliteDir} is missing: nothing to scan`);
}

if (found.length > 0) {
  console.error(
    `scan-api-key-leaks: a test key's needle was found in:\n${[...new Set(found)].join('\n')}`
  );
  process.exit(1);
}
console.log(
  `scan-api-key-leaks: clean (${all.length} files, ${tables} tables, ${LEAK_NEEDLES.length} needles)`
);
