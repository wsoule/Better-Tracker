import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// The SQL layer and the migration runner, on in-memory PGlite (and on a
// PGlite data directory for persistence).
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool, PoolConfig } from 'pg';

import {
  isStartupOptionRefused,
  isUniqueViolation,
  openPgliteSql,
  openPgSql,
  pgConnectionConfig,
  pgSqlOverPools,
  READ_COMMITTED_STARTUP_OPTION,
  type Sql,
} from '../src/db';
import { type Migration, MIGRATIONS, runMigrations } from '../src/migrations';
import { createSqlStore, openStore } from '../src/store';
import { rejection, repeatableReadUrl, TEST_KEY } from './fixtures';

const STARTUP_TIMEOUT = 60_000;
// Only TEST_DATABASE_URL enables the Postgres suites, so a production-style
// DATABASE_URL in the environment never points tests at a real database.
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';

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

describe('pgConnectionConfig', () => {
  const RC = READ_COMMITTED_STARTUP_OPTION;

  test('the startup option sets read committed as one escaped value', () => {
    expect(RC).toBe('-c default_transaction_isolation=read\\ committed');
  });

  test.each([
    [
      'a URL without a query',
      'postgres://u:p%40ss@db.example:5432/app',
      undefined,
      'postgres://u:p%40ss@db.example:5432/app',
      RC,
    ],
    [
      'PGOPTIONS when the URL has no options',
      'postgres://db.example/app?sslmode=require',
      '-c search_path=app',
      'postgres://db.example/app?sslmode=require',
      `-c search_path=app ${RC}`,
    ],
    [
      'URL options (which beat PGOPTIONS), moved out of the URL',
      'postgres://db.example/app?sslmode=require&options=-c%20statement_timeout%3D5s&application_name=a%2Fb',
      '-c ignored=1',
      'postgres://db.example/app?sslmode=require&application_name=a%2Fb',
      `-c statement_timeout=5s ${RC}`,
    ],
    [
      'the last of repeated URL options, as node-postgres reads them',
      'postgres://db.example/app?options=-c+a%3D1&options=-c+a%3D2#frag',
      undefined,
      'postgres://db.example/app#frag',
      `-c a=2 ${RC}`,
    ],
    [
      'a socket-path string',
      '/var/run/postgresql app',
      '-c x=y',
      '/var/run/postgresql app',
      `-c x=y ${RC}`,
    ],
  ])('merges %s', (_label, url, envOptions, connectionString, options) => {
    expect(pgConnectionConfig(url, envOptions)).toEqual({
      connectionString,
      options,
    });
  });
});

describe('pgSqlOverPools: a pooler that refuses the startup option', () => {
  const URL = 'postgres://db.example/app?options=-c%20search_path%3Dapp';

  // A pg error as node-postgres raises it from a refused connection.
  function pgError(code: string, message: string): Error {
    return Object.assign(new Error(message), { code, severity: 'FATAL' });
  }

  // A stand-in for pg.Pool: every connection attempt fails with `refusal`
  // when set, else queries answer one row. Records what ran on it.
  interface FakePool {
    pool: Pool;
    config: PoolConfig;
    ran: string[];
    ended: boolean;
  }
  function fakePools(refusals: (Error | null)[]): {
    made: FakePool[];
    makePool: (config: PoolConfig) => Pool;
  } {
    const made: FakePool[] = [];
    const makePool = (config: PoolConfig): Pool => {
      const refusal = refusals[made.length] ?? null;
      const fake: FakePool = {
        pool: {} as Pool,
        config,
        ran: [],
        ended: false,
      };
      const run = (text: string) => {
        if (refusal !== null) return Promise.reject(refusal);
        fake.ran.push(text);
        return Promise.resolve({ rows: [{ ok: 1 }] });
      };
      const pool = {
        on: () => pool,
        query: run,
        connect: () =>
          refusal === null
            ? Promise.resolve({ query: run, release: () => undefined })
            : Promise.reject(refusal),
        end: () => {
          fake.ended = true;
          return Promise.resolve();
        },
      };
      fake.pool = pool as unknown as Pool;
      made.push(fake);
      return fake.pool;
    };
    return { made, makePool };
  }

  test.each([
    'unsupported startup parameter: options',
    'unsupported startup parameter in options: default_transaction_isolation',
  ])(
    'reconnects without it, once, after PgBouncer says %p',
    async (message) => {
      const { made, makePool } = fakePools([pgError('08P01', message), null]);
      const infos: string[] = [];
      const sql = pgSqlOverPools(makePool, URL, {
        info: (line) => infos.push(line),
        warn: () => undefined,
        error: () => undefined,
      });
      // Concurrent calls all fail on the first pool; only one switches.
      const [a, b, tx] = await Promise.all([
        sql.query('SELECT 1 AS ok'),
        sql.query('SELECT 2 AS ok'),
        sql.transaction((t) => t.query('SELECT 3 AS ok')),
      ]);
      expect([a, b, tx]).toEqual([[{ ok: 1 }], [{ ok: 1 }], [{ ok: 1 }]]);
      expect(made.map((m) => m.config)).toEqual([
        { ...pgConnectionConfig(URL), connectionTimeoutMillis: 10_000 },
        { connectionString: URL, connectionTimeoutMillis: 10_000 },
      ]);
      expect(made[1]?.ran).toEqual([
        'SELECT 1 AS ok',
        'SELECT 2 AS ok',
        'BEGIN ISOLATION LEVEL READ COMMITTED',
        'SELECT 3 AS ok',
        'COMMIT',
      ]);
      expect(infos).toHaveLength(1);
      // Later calls go straight to the pool without the option.
      await sql.query('SELECT 4 AS ok');
      expect(made).toHaveLength(2);
      await sql.close();
      expect(made.map((m) => m.ended)).toEqual([true, true]);
    }
  );

  test('other connection errors reach the caller without a switch', async () => {
    const auth = pgError('28P01', 'password authentication failed');
    const { made, makePool } = fakePools([auth]);
    const sql = pgSqlOverPools(makePool, URL);
    expect(await rejection(sql.query('SELECT 1'))).toBe(auth);
    expect(await rejection(sql.transaction(() => Promise.resolve()))).toBe(
      auth
    );
    expect(made).toHaveLength(1);
  });

  test("a refusal of the URL's own options reaches the caller", async () => {
    const refused = pgError(
      '08P01',
      'unsupported startup parameter in options: search_path'
    );
    const { made, makePool } = fakePools([refused, refused]);
    const sql = pgSqlOverPools(makePool, URL);
    expect(await rejection(sql.query('SELECT 1'))).toBe(refused);
    expect(await rejection(sql.query('SELECT 1'))).toBe(refused);
    expect(made).toHaveLength(2);
  });

  test.each([
    [pgError('08P01', 'unsupported startup parameter: options'), true],
    [
      pgError(
        '08P01',
        'unsupported startup parameter in options: default_transaction_isolation'
      ),
      true,
    ],
    [pgError('08P01', 'invalid message format'), false],
    [pgError('42704', 'unsupported startup parameter: options'), false],
    [{ code: '08P01', message: 'unsupported startup parameter' }, false],
    [null, false],
  ])('isStartupOptionRefused(%p) is %p', (error, expected) => {
    expect(isStartupOptionRefused(error)).toBe(expected);
  });
});

describe('pgSqlOverPools: an unreachable database', () => {
  test('a server that never answers fails the call within the connect timeout', async () => {
    const { createServer } = await import('node:net');
    const { Pool: PgPool } = await import('pg');
    // Accepts TCP connections and never says a word, like a host whose
    // packets are dropped after the handshake.
    const sockets: import('node:net').Socket[] = [];
    const server = createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const address = server.address();
    const port =
      typeof address === 'object' && address !== null ? address.port : 0;
    const silent = pgSqlOverPools(
      (config) => new PgPool(config),
      `postgres://nobody@127.0.0.1:${port}/x`,
      undefined,
      { connectTimeoutMs: 200 }
    );
    try {
      const started = Date.now();
      const error = await rejection(silent.query('SELECT 1'));
      expect(error.message).toMatch(/timeout/i);
      expect(Date.now() - started).toBeLessThan(5_000);
      const txError = await rejection(
        silent.transaction((tx) => tx.query('SELECT 1'))
      );
      expect(txError.message).toMatch(/timeout/i);
    } finally {
      await silent.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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

  test('migration 3 counts the claims made before leases as finished', async () => {
    const fresh = await openPgliteSql();
    try {
      await runMigrations(
        fresh,
        MIGRATIONS.filter((m) => m.version <= 2)
      );
      await fresh.query(
        `INSERT INTO job_claims (workspace_id, job, day, claimed_at)
         VALUES ('ws', 'daily', '2026-10-21', '2026-10-21T08:00:00Z')`
      );
      expect(
        await runMigrations(
          fresh,
          MIGRATIONS.filter((m) => m.version <= 3)
        )
      ).toEqual([3]);
      const store = createSqlStore(fresh, { encryptionKey: TEST_KEY });
      // A day an older version claimed stays claimed, lease or not.
      expect(
        await store.claimJob(
          'ws',
          'daily',
          '2026-10-21',
          '2026-10-21T20:00:00.000Z',
          { leaseMinutes: 30 }
        )
      ).toBe(false);
    } finally {
      await fresh.close();
    }
  });

  test('migration 4 indexes allocation entries by issue', async () => {
    const fresh = await openPgliteSql();
    try {
      await runMigrations(fresh);
      const rows = await fresh.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE tablename = 'allocation_entries'
           AND indexname = 'allocation_entries_issue_idx'`
      );
      expect(rows.map((r) => r.indexname)).toEqual([
        'allocation_entries_issue_idx',
      ]);
    } finally {
      await fresh.close();
    }
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

// PGlite runs one transaction at a time, so only a real server can race
// migrators. Each one gets its own pool (its own connections), like
// separate processes booting at once.
describe.skipIf(DATABASE_URL === '')(
  'runMigrations on node-postgres (TEST_DATABASE_URL)',
  () => {
    // URLs are built lazily: this table is evaluated even when skipped.
    test.each([
      ['the server default isolation', () => DATABASE_URL],
      [
        'sessions defaulting to repeatable read',
        () => repeatableReadUrl(DATABASE_URL),
      ],
    ])(
      'separate pools racing apply a migration exactly once (%s)',
      async (_label, toUrl) => {
        const url = toUrl();
        // A version and table no other run uses, removed afterwards, so the
        // test also runs against a shared database.
        const version = 900_000_000 + Math.floor(Math.random() * 100_000_000);
        const table = `migration_race_${version}`;
        const list: Migration[] = [
          {
            version,
            name: 'migration_race',
            statements: [`CREATE TABLE ${table} (id integer)`],
          },
        ];
        const pools = await Promise.all([1, 2, 3, 4].map(() => openPgSql(url)));
        try {
          const applied = await Promise.all(
            pools.map((pool) => runMigrations(pool, list))
          );
          expect(applied.flat()).toEqual([version]);
        } finally {
          const [first] = pools;
          await first?.query(`DROP TABLE IF EXISTS ${table}`);
          await first?.query(
            'DELETE FROM schema_migrations WHERE version = $1',
            [version]
          );
          await Promise.all(pools.map((pool) => pool.close()));
        }
      },
      STARTUP_TIMEOUT
    );
  }
);

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
