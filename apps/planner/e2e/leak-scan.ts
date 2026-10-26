// The scan both browser suites run over what their servers wrote
// (architecture §11): every byte of every file under the artifacts
// directory (the PGlite directories, the server logs, the servers'
// TMPDIR), and SQL over each PGlite database (every public table, every
// row cast to text), since a byte scan alone would miss TOAST-compressed
// jsonb. Run by bun after Playwright (scan-api-key-leaks.ts,
// scan-oauth-leaks.ts), never by Playwright itself: it opens PGlite
// through the store package.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// The store's own PGlite opener (resolves PGlite from the store package,
// so the planner needs no database dependency of its own).
import { openPgliteSql } from '../../../packages/store/src/db';

/** What scanArtifacts found, and how much it looked at. */
export interface LeakScan {
  /** Where a needle was found ("<path> (bytes)", "<table> (sql)"). */
  found: string[];
  files: number;
  tables: number;
}

// Every file under `root`, recursively.
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

/**
 * Scans `dir` for `needles`: the bytes of every file, then every table of
 * each PGlite database in `databases` (directory names under `dir`, each
 * of which must exist, or the scan reports it missing).
 */
export async function scanArtifacts(
  dir: string,
  needles: readonly string[],
  databases: readonly string[]
): Promise<LeakScan> {
  const found: string[] = [];
  const all = files(dir);
  for (const path of all) {
    const bytes = readFileSync(path);
    for (const needle of needles) {
      if (bytes.includes(needle)) found.push(`${path} (bytes)`);
    }
  }

  // Base64 needles can hold characters LIKE treats specially; the
  // text-safe ones are enough here (the byte scan covered the rest).
  const textSafe = needles.filter((needle) => /^[A-Za-z0-9_-]+$/.test(needle));
  let tables = 0;
  for (const name of databases) {
    const pgliteDir = join(dir, name);
    if (!existsSync(pgliteDir)) {
      found.push(`${pgliteDir} is missing: nothing to scan`);
      continue;
    }
    const db = await openPgliteSql(pgliteDir);
    try {
      const listed = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
      );
      tables += listed.length;
      for (const { table_name: table } of listed) {
        for (const needle of textSafe) {
          const result = await db.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM "${table}" t WHERE CAST(t.* AS text) LIKE $1`,
            [`%${needle.replaceAll('_', '\\_')}%`]
          );
          if ((result[0]?.n ?? 0) > 0) found.push(`${name}/${table} (sql)`);
        }
      }
    } finally {
      await db.close();
    }
  }
  return { found: [...new Set(found)], files: all.length, tables };
}
