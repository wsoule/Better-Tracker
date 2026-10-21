import type { Digest } from '@better-tracker/core';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// The store on node-postgres keeps its READ COMMITTED guarantees without a
// racing connect-time query (TEST_DATABASE_URL only): the level arrives as
// a startup option, and every write pins it in its own BEGIN, so a write
// racing another writer gives the READ COMMITTED answer even on a session
// that defaults to REPEATABLE READ (a pooler that dropped the option).
import { join } from 'node:path';
import { type PoolClient, Pool } from 'pg';

import { openPgSql, type Sql } from '../src/db';
import { createSqlStore, openStore } from '../src/store';
import type { Store } from '../src/types';
import {
  newWorkspaceId,
  repeatableReadSessionSql,
  repeatableReadUrl,
  TEST_KEY,
  tokens,
} from './fixtures';

const STARTUP_TIMEOUT = 60_000;
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? '';
const DAY = '2026-10-21';
const NOW = '2026-10-21T08:00:00.000Z';

describe.skipIf(DATABASE_URL === '')(
  'READ COMMITTED on node-postgres (TEST_DATABASE_URL)',
  () => {
    test(
      'opening the store and querying emits no deprecation warning',
      async () => {
        const child = Bun.spawn(
          [process.execPath, join(import.meta.dir, 'deprecation-probe.ts')],
          {
            env: { ...process.env, TEST_DATABASE_URL: DATABASE_URL },
            stdout: 'pipe',
            stderr: 'pipe',
          }
        );
        const [code, stderr] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
        ]);
        expect(stderr).not.toContain('DeprecationWarning');
        expect(code).toBe(0);
      },
      STARTUP_TIMEOUT
    );

    test('connections default to read committed and keep the URL options', async () => {
      const url = new URL(repeatableReadUrl(DATABASE_URL));
      // Two server options in one value, plus another query parameter that
      // must survive the rewrite.
      url.searchParams.set(
        'options',
        `${url.searchParams.get('options') ?? ''} -c statement_timeout=12345`
      );
      url.searchParams.set('application_name', 'isolation-test');
      const sql = await openPgSql(url.toString());
      try {
        const [row] = await sql.query<{
          isolation: string;
          timeout: string;
          app: string;
        }>(
          `SELECT current_setting('default_transaction_isolation') AS isolation,
             current_setting('statement_timeout') AS timeout,
             current_setting('application_name') AS app`
        );
        expect(row).toEqual({
          isolation: 'read committed',
          timeout: '12345ms',
          app: 'isolation-test',
        });
      } finally {
        await sql.close();
      }
    });

    describe('writes racing an uncommitted writer, on repeatable read sessions', () => {
      let sql: Sql;
      let store: Store;
      let admin: Pool;

      beforeAll(async () => {
        sql = await repeatableReadSessionSql(DATABASE_URL);
        store = createSqlStore(sql, { encryptionKey: TEST_KEY });
        await store.migrate();
        admin = new Pool({ connectionString: DATABASE_URL });
      }, STARTUP_TIMEOUT);

      afterAll(async () => {
        await store.close();
        await admin.end();
      });

      // Holds `blockerSql` uncommitted on its own connection, starts `call`
      // (which must wait on that row lock), waits until Postgres reports it
      // blocked by the holder, then commits and returns call's result. A
      // REPEATABLE READ statement that waited like this sees a row its
      // snapshot cannot: serialization failure instead of an answer.
      async function racing<T>(
        blockerSql: string,
        params: unknown[],
        call: () => Promise<T>
      ): Promise<T> {
        const holder: PoolClient = await admin.connect();
        try {
          await holder.query('BEGIN');
          await holder.query(blockerSql, params);
          const pidRows = await holder.query<{ pid: number }>(
            'SELECT pg_backend_pid() AS pid'
          );
          const pid = pidRows.rows[0]?.pid;
          const pending = call();
          // Settled, so an early rejection is not reported as unhandled.
          const outcome = pending.then(
            (value) => ({ ok: true as const, value }),
            (error: unknown) => ({ ok: false as const, error })
          );
          for (let attempt = 0; attempt < 200; attempt += 1) {
            const waiting = await admin.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM pg_stat_activity
               WHERE $1::int = ANY (pg_blocking_pids(pid))`,
              [pid]
            );
            if ((waiting.rows[0]?.n ?? 0) > 0) break;
            await Bun.sleep(10);
          }
          await holder.query('COMMIT');
          const settled = await outcome;
          if (!settled.ok) throw settled.error;
          return settled.value;
        } finally {
          await holder.query('ROLLBACK').catch(() => undefined);
          holder.release();
        }
      }

      test('claimJob answers "already claimed"', async () => {
        const ws = newWorkspaceId();
        const claimed = await racing(
          `INSERT INTO job_claims (workspace_id, job, day, claimed_at)
           VALUES ($1, 'daily', $2::date, now())`,
          [ws, DAY],
          () => store.claimJob(ws, 'daily', DAY, NOW)
        );
        expect(claimed).toBe(false);
      });

      test('insertNotification answers "already has today\'s digest"', async () => {
        const ws = newWorkspaceId();
        const digest: Digest = {
          recipientId: 'u-ana',
          recipientName: 'Ana',
          recipientEmail: null,
          day: DAY,
          items: [],
        };
        const inserted = await racing(
          `INSERT INTO notifications (id, workspace_id, day, recipient_id,
             channel, status, digest, created_at)
           VALUES (gen_random_uuid()::text, $1, $2::date, 'u-ana', 'slack',
             'pending', '{}'::jsonb, now())`,
          [ws, DAY],
          () =>
            store.insertNotification({
              workspaceId: ws,
              day: DAY,
              recipientId: 'u-ana',
              channel: 'slack',
              status: 'pending',
              digest,
              error: null,
              now: NOW,
            })
        );
        expect(inserted).toBe(false);
      });

      test('updateMilestoneMetaField keeps the other field just committed', async () => {
        const ws = newWorkspaceId();
        await store.updateMilestoneMetaField(ws, 'm1', 'weight', 1, 'u-a', NOW);
        const meta = await racing(
          `UPDATE milestone_meta SET done_means = 'shipped'
           WHERE workspace_id = $1 AND milestone_id = 'm1'`,
          [ws],
          () =>
            store.updateMilestoneMetaField(ws, 'm1', 'weight', 2, 'u-b', NOW)
        );
        expect(meta).toMatchObject({ weight: 2, doneMeans: 'shipped' });
      });

      test('recordFullSync lands after a concurrent mirror write', async () => {
        const ws = newWorkspaceId();
        await store.recordFullSync(ws, { at: NOW, ok: false, error: 'x' });
        await racing(
          'UPDATE sync_state SET version = version + 1 WHERE workspace_id = $1',
          [ws],
          () => store.recordFullSync(ws, { at: NOW, ok: true, error: null })
        );
        expect(await store.getSyncState(ws)).toMatchObject({
          version: 1,
          lastFullSyncStatus: 'ok',
          lastFullSyncError: null,
        });
      });

      test('deleteSession removes a session another process just updated', async () => {
        const ws = newWorkspaceId();
        const { token, session } = await store.createSession({
          workspaceId: ws,
          userId: 'u-ana',
          userName: 'Ana',
          tokens: tokens('s'),
          expiresAt: '2099-01-01T00:00:00.000Z',
        });
        await racing(
          "UPDATE sessions SET user_name = 'Ana B' WHERE id = $1",
          [session.id],
          () => store.deleteSession(token)
        );
        expect(await store.getSession(token, NOW)).toBeNull();
      });
    });
  }
);

// TEST_PGBOUNCER_URL: a transaction-mode PgBouncer in its default
// configuration in front of a Postgres server. PgBouncer accepts only the
// startup parameters it tracks, so it closes every connection that carries
// the store's startup option ("unsupported startup parameter"); the store
// must still connect, and keep its READ COMMITTED answers through BEGIN.
const PGBOUNCER_URL = process.env['TEST_PGBOUNCER_URL'] ?? '';

describe.skipIf(PGBOUNCER_URL === '')(
  'Store behind PgBouncer (TEST_PGBOUNCER_URL)',
  () => {
    let store: Store;

    beforeAll(async () => {
      store = await openStore({
        databaseUrl: PGBOUNCER_URL,
        encryptionKey: TEST_KEY,
      });
      await store.migrate();
    }, STARTUP_TIMEOUT);

    afterAll(async () => {
      await store.close();
    });

    test('connects, and concurrent claims still have exactly one winner', async () => {
      const ws = newWorkspaceId();
      expect(await store.ping()).toBe(true);
      const claims = await Promise.all(
        [1, 2, 3, 4, 5, 6].map(() =>
          store.claimJob(ws, 'daily', DAY, NOW, { leaseMinutes: 30 })
        )
      );
      expect(claims.filter(Boolean)).toHaveLength(1);
      await store.recordFullSync(ws, { at: NOW, ok: true, error: null });
      expect(await store.getSyncState(ws)).toMatchObject({
        lastFullSyncStatus: 'ok',
      });
    });
  }
);
