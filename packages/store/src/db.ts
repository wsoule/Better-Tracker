import type { PGlite } from '@electric-sql/pglite';
// A deliberately tiny SQL layer so the store runs unchanged on node-postgres
// (production) and PGlite (local dev and tests). Both speak the same
// Postgres dialect; only connection and transaction handling differ.
import { mkdir } from 'node:fs/promises';
import type { Pool } from 'pg';

/**
 * Values bound to `$1, $2, …` placeholders. Kept to primitives so both
 * drivers serialize them identically: JSON travels as text and is cast in
 * SQL (`$1::text::jsonb`), instants as ISO strings (`$2::timestamptz`).
 */
export type SqlParam = string | number | boolean | null;

export interface Sql {
  /** Runs one parameterized statement and returns its rows. */
  query<T>(text: string, params?: readonly SqlParam[]): Promise<T[]>;
  /**
   * Runs fn inside a transaction: committed when fn resolves, rolled back
   * when it throws. Nested calls on a transaction use savepoints.
   */
  transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** The logging surface the SQL layer and the store need. */
export interface SqlLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

type QueryFn = <T>(text: string, params?: readonly SqlParam[]) => Promise<T[]>;

/** True for Postgres' unique_violation (SQLSTATE 23505) from either driver. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}

// Wraps a query function so it refuses to run once its transaction has
// finished. With node-postgres the client goes back to the pool at that
// point, and a stray late query would run on someone else's connection.
function guardQuery(query: QueryFn, isFinished: () => boolean): QueryFn {
  return async <T>(text: string, params?: readonly SqlParam[]) => {
    if (isFinished()) {
      throw new Error('Query issued after its transaction finished');
    }
    return query<T>(text, params);
  };
}

// Builds the Sql handle given to a transaction callback. Nested
// transaction() calls become SAVEPOINTs on the same connection, so an inner
// failure (e.g. an expected unique violation) can be rolled back without
// aborting the outer transaction. Savepoint names come from a depth counter,
// never from input.
function transactionSql(query: QueryFn, depth: number): Sql {
  return {
    query,
    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
      const savepoint = `store_sp_${depth + 1}`;
      await query(`SAVEPOINT ${savepoint}`);
      try {
        const result = await fn(transactionSql(query, depth + 1));
        await query(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        await query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        throw error;
      }
    },
    close(): Promise<void> {
      return Promise.reject(
        new Error('close() cannot be called inside a transaction')
      );
    },
  };
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * node-postgres pool. Plain queries use any pooled connection; each
 * transaction checks out one client and runs BEGIN/COMMIT/ROLLBACK on it.
 */
export async function openPgSql(
  databaseUrl: string,
  logger?: SqlLogger
): Promise<Sql> {
  const { Pool: PgPool } = await import('pg');
  const pool: Pool = new PgPool({ connectionString: databaseUrl });
  // An idle client losing its connection emits 'error' on the pool; without
  // a listener Node treats it as unhandled and kills the process.
  pool.on('error', (error) => {
    logger?.error('postgres idle client error', { error });
  });

  const poolQuery: QueryFn = async <T>(
    text: string,
    params: readonly SqlParam[] = []
  ) => {
    const result = await pool.query(text, [...params]);
    const rows: unknown[] = result.rows;
    return rows as T[];
  };

  return {
    query: poolQuery,
    async transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let finished = false;
      // Set when ROLLBACK itself fails: the connection is in an unknown
      // state, so it is destroyed instead of returned to the pool.
      let brokenConnection: Error | undefined;
      const clientQuery = guardQuery(
        async <R>(text: string, params: readonly SqlParam[] = []) => {
          const result = await client.query(text, [...params]);
          const rows: unknown[] = result.rows;
          return rows as R[];
        },
        () => finished
      );
      try {
        await client.query('BEGIN');
        const result = await fn(transactionSql(clientQuery, 0));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          brokenConnection = toError(rollbackError);
        }
        throw error;
      } finally {
        finished = true;
        client.release(brokenConnection);
      }
    },
    close(): Promise<void> {
      return pool.end();
    },
  };
}

/**
 * PGlite (Postgres compiled to WASM, in-process). In memory when no
 * directory is given; otherwise persisted to `dir`, which is created first
 * because PGlite only creates the last path segment itself. Transactions
 * use PGlite's own transaction() API, which holds the instance's single
 * connection until fn settles.
 */
export async function openPgliteSql(dir?: string): Promise<Sql> {
  const { PGlite: PGliteClass } = await import('@electric-sql/pglite');
  let db: PGlite;
  if (dir === undefined || dir === '') {
    db = await PGliteClass.create();
  } else {
    await mkdir(dir, { recursive: true });
    db = await PGliteClass.create({ dataDir: dir });
  }

  return {
    async query<T>(
      text: string,
      params: readonly SqlParam[] = []
    ): Promise<T[]> {
      const result = await db.query<T>(text, [...params]);
      return result.rows;
    },
    transaction<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
      return db.transaction(async (tx) => {
        let finished = false;
        const txQuery = guardQuery(
          async <R>(text: string, params: readonly SqlParam[] = []) => {
            const result = await tx.query<R>(text, [...params]);
            return result.rows;
          },
          () => finished
        );
        try {
          return await fn(transactionSql(txQuery, 0));
        } finally {
          finished = true;
        }
      });
    },
    close(): Promise<void> {
      return db.close();
    },
  };
}
