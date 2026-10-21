import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// The SQL layer and the migration runner, on in-memory PGlite (and on a
// PGlite data directory for persistence).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isUniqueViolation, openPgliteSql, type Sql } from '../src/db';
import { type Migration, MIGRATIONS, runMigrations } from '../src/migrations';
import { openStore } from '../src/store';
import { rejection, TEST_KEY } from './fixtures';

const STARTUP_TIMEOUT = 60_000;

let sql: Sql;

beforeAll(async () => {
  sql = await openPgliteSql();
  await sql.query('CREATE TABLE items (id text PRIMARY KEY, n integer)');
}, STARTUP_TIMEOUT);

afterAll(async () => {
  await sql.close();
});

async function ids(): Promise<string[]> {
  const rows = await sql.query<{ id: string }>(
    'SELECT id FROM items ORDER BY id'
  );
  return rows.map((row) => row.id);
}

describe('Sql on PGlite', () => {
  test('binds parameters instead of interpolating them', async () => {
    const hostile = "x'); DROP TABLE items; --";
    await sql.query('INSERT INTO items (id, n) VALUES ($1, $2)', [hostile, 1]);
    const rows = await sql.query<{ id: string; n: number }>(
      'SELECT id, n FROM items WHERE id = $1',
      [hostile]
    );
    expect(rows).toEqual([{ id: hostile, n: 1 }]);
    await sql.query('DELETE FROM items');
  });

  test('commits a transaction and returns its result', async () => {
    const result = await sql.transaction(async (tx) => {
      await tx.query("INSERT INTO items (id, n) VALUES ('a', 1)");
      return 'done';
    });
    expect(result).toBe('done');
    expect(await ids()).toEqual(['a']);
    await sql.query('DELETE FROM items');
  });

  test('rolls back when the callback throws', async () => {
    const failure = await rejection(
      sql.transaction(async (tx) => {
        await tx.query("INSERT INTO items (id, n) VALUES ('b', 1)");
        throw new Error('boom');
      })
    );
    expect(failure.message).toBe('boom');
    expect(await ids()).toEqual([]);
  });

  test('nested transactions use savepoints', async () => {
    await sql.transaction(async (tx) => {
      await tx.query("INSERT INTO items (id, n) VALUES ('outer', 1)");
      const failure: unknown = await tx
        .transaction(async (inner) => {
          await inner.query("INSERT INTO items (id, n) VALUES ('inner', 1)");
          // Unique violation: aborts only the savepoint.
          await inner.query("INSERT INTO items (id, n) VALUES ('outer', 2)");
        })
        .catch((caught: unknown) => caught);
      expect(isUniqueViolation(failure)).toBe(true);
      await tx.transaction(async (inner) => {
        await inner.query("INSERT INTO items (id, n) VALUES ('kept', 1)");
      });
    });
    expect(await ids()).toEqual(['kept', 'outer']);
    await sql.query('DELETE FROM items');
  });

  test('refuses queries after the transaction finished', async () => {
    const leaked = await sql.transaction(async (tx) => {
      await tx.query('SELECT 1');
      return tx;
    });
    expect((await rejection(leaked.query('SELECT 1'))).message).toMatch(
      /after its transaction finished/
    );
    expect((await rejection(leaked.close())).message).toMatch(
      /inside a transaction/
    );
  });

  test('isUniqueViolation recognizes SQLSTATE 23505 only', async () => {
    await sql.query("INSERT INTO items (id, n) VALUES ('dup', 1)");
    const error: unknown = await sql
      .query("INSERT INTO items (id, n) VALUES ('dup', 1)")
      .catch((caught: unknown) => caught);
    expect(isUniqueViolation(error)).toBe(true);
    expect(isUniqueViolation(new Error('nope'))).toBe(false);
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    await sql.query('DELETE FROM items');
  });
});

describe('runMigrations', () => {
  test('applies the real schema once and is idempotent', async () => {
    expect(await runMigrations(sql)).toEqual(MIGRATIONS.map((m) => m.version));
    expect(await runMigrations(sql)).toEqual([]);
    const rows = await sql.query<{ version: number; name: string }>(
      'SELECT version, name FROM schema_migrations ORDER BY version'
    );
    expect(rows).toEqual(
      MIGRATIONS.map((m) => ({ version: m.version, name: m.name }))
    );
    const tables = await sql.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`
    );
    expect(tables.map((row) => row.table_name)).toEqual([
      'allocation_entries',
      'allocation_runs',
      'audit_log',
      'installations',
      'items',
      'job_claims',
      'milestone_meta',
      'mirror_entities',
      'notifications',
      'schema_migrations',
      'sessions',
      'settings',
      'sync_state',
      'warning_memory',
      'webhook_deliveries',
    ]);
  });

  test('applies new migrations in order and records each', async () => {
    const extra: Migration[] = [
      ...MIGRATIONS,
      {
        version: 1001,
        name: 'add_t1',
        statements: ['CREATE TABLE t1 (id integer)'],
      },
      {
        version: 1002,
        name: 'add_t2_from_t1',
        statements: [
          'CREATE TABLE t2 (id integer)',
          'INSERT INTO t2 SELECT id FROM t1',
        ],
      },
    ];
    expect(await runMigrations(sql, extra)).toEqual([1001, 1002]);
    expect(await runMigrations(sql, extra)).toEqual([]);
  });

  test('rolls back a failing migration and leaves it unrecorded', async () => {
    const failing: Migration[] = [
      {
        version: 2001,
        name: 'half_broken',
        statements: [
          'CREATE TABLE half_done (id integer)',
          'SELECT * FROM table_that_does_not_exist',
        ],
      },
    ];
    expect((await rejection(runMigrations(sql, failing))).message).toMatch(
      /table_that_does_not_exist/
    );
    const recorded = await sql.query(
      'SELECT 1 FROM schema_migrations WHERE version = 2001'
    );
    expect(recorded).toEqual([]);
    const created = await sql.query(
      "SELECT 1 FROM information_schema.tables WHERE table_name = 'half_done'"
    );
    expect(created).toEqual([]);
  });

  test('rejects migration lists that are not strictly increasing', async () => {
    const unordered: Migration[] = [
      { version: 3002, name: 'b', statements: [] },
      { version: 3001, name: 'a', statements: [] },
    ];
    expect((await rejection(runMigrations(sql, unordered))).message).toMatch(
      /strictly increasing/
    );
  });

  test('concurrent migrators apply each migration once', async () => {
    const list: Migration[] = [
      {
        version: 4001,
        name: 'concurrent',
        statements: ['CREATE TABLE concurrent_t (id integer)'],
      },
    ];
    const results = await Promise.all([
      runMigrations(sql, list),
      runMigrations(sql, list),
    ]);
    expect(results.flat()).toEqual([4001]);
  });
});

describe('PGlite data directory', () => {
  test(
    'creates nested directories and persists across reopen',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'store-pglite-'));
      const dir = join(root, 'nested', 'pglite');
      try {
        const first = await openStore({
          pgliteDir: dir,
          encryptionKey: TEST_KEY,
        });
        await first.migrate();
        expect(
          await first.claimJob(
            'ws',
            'daily',
            '2026-10-21',
            '2026-10-21T08:00:00.000Z'
          )
        ).toBe(true);
        await first.close();

        const second = await openStore({
          pgliteDir: dir,
          encryptionKey: TEST_KEY,
        });
        await second.migrate();
        expect(
          await second.claimJob(
            'ws',
            'daily',
            '2026-10-21',
            '2026-10-21T09:00:00.000Z'
          )
        ).toBe(false);
        await second.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    STARTUP_TIMEOUT
  );

  test('openStore rejects a bad key before opening a database', async () => {
    expect(
      (await rejection(openStore({ encryptionKey: 'too-short' }))).message
    ).toMatch(/TOKEN_ENCRYPTION_KEY/);
  });
});
