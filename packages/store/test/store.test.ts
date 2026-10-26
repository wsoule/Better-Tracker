import type { MilestoneMeta, WorkspaceSettings } from '@better-tracker/core';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// Every Store method against in-memory PGlite, and the same suite against a
// real Postgres when TEST_DATABASE_URL is set (skipped otherwise). Each test uses
// its own workspace id, so the suite also runs against a shared database.
import { createHash } from 'node:crypto';

import { openPgliteSql, openPgSql, type Sql } from '../src/db';
import { isStoreNotFoundError, StoreNotFoundError } from '../src/errors';
import { createSqlStore } from '../src/store';
import type { MirrorEntity, NewRunEntry, Store } from '../src/types';
import {
  digest,
  installation,
  newWorkspaceId,
  rejection,
  repeatableReadSessionSql,
  repeatableReadUrl,
  TEST_KEY,
  tokens,
  workspaceData,
} from './fixtures';

const STARTUP_TIMEOUT = 60_000;
// Only TEST_DATABASE_URL enables the Postgres suites (see db.test.ts).
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const HAS_POSTGRES = DATABASE_URL !== undefined && DATABASE_URL !== '';
/** The calendar day most tests claim or notify for. */
const DAY = '2026-10-21';

function entry(overrides: Partial<NewRunEntry>): NewRunEntry {
  return {
    action: 'assign',
    outcome: 'applied',
    projectId: 'p-orion',
    milestoneId: 'm-alpha',
    issueId: 'iss-1',
    issueIdentifier: 'ENG-1',
    assigneeId: 'u-ana',
    reason: 'comment-1',
    detail: { toStateId: 's-todo', nested: { at: '2026-10-21' } },
    error: null,
    ...overrides,
  };
}

function settings(workspaceId: string): WorkspaceSettings {
  return {
    workspaceId,
    watcherUserIds: ['u-ana', 'u-watcher'],
    allocationMode: 'dry_run',
    warningsMode: 'preview',
    timezone: 'America/Chicago',
    tuning: {
      warnLeadDays: 7,
      paceWindowDays: 7,
      stallDays: 7,
      overdueRepeatDays: 1,
      newBadgeDays: 7,
      activeProjectStatuses: ['planned', 'started'],
      timelineDaysBack: 14,
      timelineDaysAhead: 70,
    },
  };
}

// A Sql that records every statement it is sent, transactions included
// (whitespace collapsed), so a test can count round trips.
function recordingSql(inner: Sql, statements: string[]): Sql {
  return {
    query: (text, params) => {
      statements.push(text.replace(/\s+/g, ' ').trim());
      return inner.query(text, params);
    },
    transaction: (fn) =>
      inner.transaction((tx) => fn(recordingSql(tx, statements))),
    close: () => inner.close(),
  };
}

// True when `promise` settles within `ms`: a call still waiting on a row
// lock does not.
function settlesWithin(
  promise: Promise<unknown>,
  ms: number
): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true
    ),
    Bun.sleep(ms).then(() => false),
  ]);
}

/** A key other suites sharing one database never use. */
function uniqueKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function storeSuite(label: string, openHandle: () => Promise<Sql>): void {
  describe(label, () => {
    let sql: Sql;
    let store: Store;
    // The store's clock for timestamps the contract does not pass in.
    let clock = new Date('2026-10-21T08:00:00.000Z');

    beforeAll(async () => {
      sql = await openHandle();
      store = createSqlStore(sql, {
        encryptionKey: TEST_KEY,
        now: () => clock,
      });
      await store.migrate();
    }, STARTUP_TIMEOUT);

    afterAll(async () => {
      await store.close();
    });

    describe('lifecycle', () => {
      test('migrate is idempotent', async () => {
        await store.migrate();
        await store.migrate();
        const rows = await sql.query<{ version: number }>(
          'SELECT version FROM schema_migrations WHERE version = 1'
        );
        expect(rows).toHaveLength(1);
      });

      test('ping', async () => {
        expect(await store.ping()).toBe(true);
      });
    });

    describe('installations', () => {
      test('save, get and list round-trip', async () => {
        const ws = newWorkspaceId();
        expect(await store.getInstallation(ws)).toBeNull();
        const saved = installation(ws);
        await store.saveInstallation(saved);
        expect(await store.getInstallation(ws)).toEqual(saved);
        const listed = await store.listInstallations();
        expect(listed.filter((i) => i.workspaceId === ws)).toEqual([saved]);
      });

      test('save overwrites (reinstall) and handles a null refresh token', async () => {
        const ws = newWorkspaceId();
        await store.saveInstallation(installation(ws));
        const reinstalled = {
          ...installation(ws),
          workspaceName: 'Acme Renamed',
          revokedAt: null,
          tokens: { ...tokens('v2'), refreshToken: null, expiresAt: null },
          updatedAt: '2026-10-21T10:00:00.000Z',
        };
        await store.saveInstallation(reinstalled);
        expect(await store.getInstallation(ws)).toEqual(reinstalled);
      });

      test('tokens are never stored in plaintext', async () => {
        const ws = newWorkspaceId();
        const saved = installation(ws);
        await store.saveInstallation(saved);
        const raw = await sql.query<Record<string, unknown>>(
          'SELECT * FROM installations WHERE workspace_id = $1',
          [ws]
        );
        const dump = JSON.stringify(raw);
        expect(dump).not.toContain(saved.tokens.accessToken);
        expect(dump).not.toContain(saved.tokens.refreshToken ?? 'unset');
        expect(String(raw[0]?.access_token_enc)).toMatch(/^v1:/);
        expect(String(raw[0]?.refresh_token_enc)).toMatch(/^v1:/);
      });

      test('markInstallationRevoked', async () => {
        const ws = newWorkspaceId();
        await store.saveInstallation(installation(ws));
        await store.markInstallationRevoked(ws, '2026-10-21T12:00:00.000Z');
        const revoked = await store.getInstallation(ws);
        expect(revoked?.revokedAt).toBe('2026-10-21T12:00:00.000Z');
        expect(revoked?.updatedAt).toBe('2026-10-21T12:00:00.000Z');
      });

      test('withInstallationLock persists rotated tokens before releasing', async () => {
        const ws = newWorkspaceId();
        await store.saveInstallation(installation(ws));
        clock = new Date('2026-10-21T09:30:00.000Z');
        const rotated = tokens('rotated');
        const result = await store.withInstallationLock(ws, (current) => {
          expect(current.tokens.refreshToken).toBe('lin_oauth_refresh_install');
          return Promise.resolve({ result: 'refreshed', tokens: rotated });
        });
        expect(result).toBe('refreshed');
        const after = await store.getInstallation(ws);
        expect(after?.tokens).toEqual(rotated);
        expect(after?.updatedAt).toBe('2026-10-21T09:30:00.000Z');
        const raw = JSON.stringify(
          await sql.query(
            'SELECT * FROM installations WHERE workspace_id = $1',
            [ws]
          )
        );
        expect(raw).not.toContain(rotated.accessToken);
      });

      test('withInstallationLock without tokens leaves the row alone', async () => {
        const ws = newWorkspaceId();
        const saved = installation(ws);
        await store.saveInstallation(saved);
        const result = await store.withInstallationLock(ws, (current) =>
          Promise.resolve({ result: current.urlKey })
        );
        expect(result).toBe('acme');
        expect(await store.getInstallation(ws)).toEqual(saved);
      });

      test('withInstallationLock rolls back when fn throws, and needs an installation', async () => {
        const ws = newWorkspaceId();
        const saved = installation(ws);
        await store.saveInstallation(saved);
        const failed = await rejection(
          store.withInstallationLock(ws, () =>
            Promise.reject(new Error('invalid_grant'))
          )
        );
        expect(failed.message).toBe('invalid_grant');
        expect(await store.getInstallation(ws)).toEqual(saved);
        const absent = newWorkspaceId();
        let called = false;
        const missing = await rejection(
          store.withInstallationLock(absent, () => {
            called = true;
            return Promise.resolve({ result: 1 });
          })
        );
        expect(missing.message).toMatch(/No installation/);
        // Typed, so callers never match on the message.
        expect(missing).toBeInstanceOf(StoreNotFoundError);
        expect(missing).toMatchObject({
          name: 'StoreNotFoundError',
          kind: 'installation',
          id: absent,
        });
        expect(isStoreNotFoundError(missing, 'installation')).toBe(true);
        expect(isStoreNotFoundError(missing, 'session')).toBe(false);
        expect(called).toBe(false);
      });

      test('the token locks bound their wait with lock_timeout before locking', async () => {
        // Records every statement the store sends, transactions included.
        const statements: string[] = [];
        const recording = (inner: Sql): Sql => ({
          query: (text, params) => {
            statements.push(text.replace(/\s+/g, ' ').trim());
            return inner.query(text, params);
          },
          transaction: (fn) => inner.transaction((tx) => fn(recording(tx))),
          close: () => inner.close(),
        });
        const watched = createSqlStore(recording(sql), {
          encryptionKey: TEST_KEY,
          now: () => clock,
        });
        const ws = newWorkspaceId();
        await store.saveInstallation(installation(ws));
        const { session } = await store.createSession({
          workspaceId: ws,
          userId: 'u-ana',
          userName: 'Ana Lead',
          tokens: tokens('user'),
          expiresAt: '2026-11-20T08:00:00.000Z',
        });
        await watched.withInstallationLock(ws, () =>
          Promise.resolve({ result: null })
        );
        await watched.withSessionLock(session.id, () =>
          Promise.resolve({ result: null })
        );
        const locks = statements.flatMap((text, i) =>
          text.endsWith('FOR UPDATE') ? [statements[i - 1]] : []
        );
        expect(locks).toEqual([
          "SET LOCAL lock_timeout = '30s'",
          "SET LOCAL lock_timeout = '30s'",
        ]);
      });

      test('concurrent refreshers are serialized by the row lock', async () => {
        const ws = newWorkspaceId();
        await store.saveInstallation(installation(ws));
        // Each refresher derives the next refresh token from the one it
        // read; without the lock both would read the original token.
        const rotate = (): Promise<string> =>
          store.withInstallationLock(ws, async (current) => {
            const next = `${current.tokens.refreshToken ?? ''}+`;
            await new Promise((resolve) => setTimeout(resolve, 20));
            return {
              result: next,
              tokens: { ...current.tokens, refreshToken: next },
            };
          });
        const results = await Promise.all([rotate(), rotate()]);
        expect(results.toSorted()).toEqual([
          'lin_oauth_refresh_install+',
          'lin_oauth_refresh_install++',
        ]);
        expect((await store.getInstallation(ws))?.tokens.refreshToken).toBe(
          'lin_oauth_refresh_install++'
        );
      });
    });

    describe('sessions', () => {
      test('createSession stores only the token hash; getSession finds it', async () => {
        const ws = newWorkspaceId();
        clock = new Date('2026-10-21T08:00:00.000Z');
        const { token, session } = await store.createSession({
          workspaceId: ws,
          userId: 'u-ana',
          userName: 'Ana Lead',
          tokens: tokens('user'),
          expiresAt: '2026-11-20T08:00:00.000Z',
        });
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(session).toEqual({
          id: session.id,
          workspaceId: ws,
          userId: 'u-ana',
          userName: 'Ana Lead',
          tokens: tokens('user'),
          createdAt: '2026-10-21T08:00:00.000Z',
          expiresAt: '2026-11-20T08:00:00.000Z',
        });
        expect(session.id).not.toBe(token);

        expect(
          await store.getSession(token, '2026-10-22T00:00:00.000Z')
        ).toEqual(session);
        expect(
          await store.getSession(`${token}x`, '2026-10-22T00:00:00.000Z')
        ).toBeNull();

        const raw = await sql.query<Record<string, unknown>>(
          'SELECT * FROM sessions WHERE id = $1',
          [session.id]
        );
        const dump = JSON.stringify(raw);
        expect(dump).not.toContain(token);
        expect(dump).not.toContain('lin_oauth_access_user');
        expect(dump).not.toContain('lin_oauth_refresh_user');
        expect(raw[0]?.token_hash).toBe(
          createHash('sha256').update(token).digest('hex')
        );
      });

      test('getSession ignores expired sessions', async () => {
        const { token } = await store.createSession({
          workspaceId: newWorkspaceId(),
          userId: 'u-ana',
          userName: 'Ana Lead',
          tokens: tokens('user'),
          expiresAt: '2026-10-21T10:00:00.000Z',
        });
        expect(
          await store.getSession(token, '2026-10-21T09:59:59.999Z')
        ).not.toBeNull();
        expect(
          await store.getSession(token, '2026-10-21T10:00:00.000Z')
        ).toBeNull();
      });

      test('deleteSession', async () => {
        const { token } = await store.createSession({
          workspaceId: newWorkspaceId(),
          userId: 'u-ana',
          userName: 'Ana Lead',
          tokens: tokens('user'),
          expiresAt: '2026-11-20T08:00:00.000Z',
        });
        await store.deleteSession(token);
        expect(
          await store.getSession(token, '2026-10-21T08:00:00.000Z')
        ).toBeNull();
      });

      test('deleteExpiredSessions removes only expired ones', async () => {
        const ws = newWorkspaceId();
        const make = (expiresAt: string) =>
          store.createSession({
            workspaceId: ws,
            userId: 'u-ana',
            userName: 'Ana Lead',
            tokens: tokens('user'),
            expiresAt,
          });
        const old1 = await make('2020-01-01T00:00:00.000Z');
        const old2 = await make('2020-02-01T00:00:00.000Z');
        const live = await make('2020-12-01T00:00:00.000Z');
        expect(
          await store.deleteExpiredSessions('2020-06-01T00:00:00.000Z')
        ).toBe(2);
        expect(
          await store.deleteExpiredSessions('2020-06-01T00:00:00.000Z')
        ).toBe(0);
        const remaining = await sql.query<{ id: string }>(
          'SELECT id FROM sessions WHERE workspace_id = $1',
          [ws]
        );
        expect(remaining.map((row) => row.id)).toEqual([live.session.id]);
        expect(old1.session.id).not.toBe(old2.session.id);
      });

      test('withSessionLock persists rotated user tokens', async () => {
        const { token, session } = await store.createSession({
          workspaceId: newWorkspaceId(),
          userId: 'u-ana',
          userName: 'Ana Lead',
          tokens: tokens('user'),
          expiresAt: '2026-11-20T08:00:00.000Z',
        });
        const upgraded = { ...tokens('user-write'), scopes: ['read', 'write'] };
        const result = await store.withSessionLock(session.id, (current) => {
          expect(current).toEqual(session);
          return Promise.resolve({ result: 42, tokens: upgraded });
        });
        expect(result).toBe(42);
        const after = await store.getSession(token, '2026-10-21T08:00:00.000Z');
        expect(after?.tokens).toEqual(upgraded);
        const missing = await rejection(
          store.withSessionLock('missing', () => Promise.resolve({ result: 1 }))
        );
        expect(missing.message).toMatch(/No session/);
        expect(missing).toBeInstanceOf(StoreNotFoundError);
        expect(missing).toMatchObject({ kind: 'session', id: 'missing' });
        expect(isStoreNotFoundError(missing, 'session')).toBe(true);
      });

      test('takeExpiredSessions deletes and returns expired sessions with their tokens', async () => {
        // A 2019 era no other test uses, so a shared database only holds
        // this test's expired rows.
        const ws = newWorkspaceId();
        const make = (suffix: string, expiresAt: string) =>
          store.createSession({
            workspaceId: ws,
            userId: `u-${suffix}`,
            userName: suffix,
            tokens: tokens(suffix),
            expiresAt,
          });
        const third = await make('third', '2019-03-01T00:00:00.000Z');
        const first = await make('first', '2019-01-01T00:00:00.000Z');
        const second = await make('second', '2019-02-01T00:00:00.000Z');
        const live = await make('live', '2099-01-01T00:00:00.000Z');
        const now = '2019-06-01T00:00:00.000Z';

        // Oldest first, at most `limit`, real (decrypted) tokens.
        const batch = await store.takeExpiredSessions(now, 2);
        expect(batch).toEqual([first.session, second.session]);
        expect(batch[0]?.tokens.refreshToken).toBe('lin_oauth_refresh_first');
        const rest = await store.takeExpiredSessions(now, 10);
        expect(rest.filter((s) => s.workspaceId === ws)).toEqual([
          third.session,
        ]);
        expect(await store.takeExpiredSessions(now, 10)).toEqual([]);
        const remaining = await sql.query<{ id: string }>(
          'SELECT id FROM sessions WHERE workspace_id = $1',
          [ws]
        );
        expect(remaining.map((row) => row.id)).toEqual([live.session.id]);
        expect(await store.takeExpiredSessions(now, Number.NaN)).toEqual([]);
        await store.deleteSession(live.token);
      });

      test('takeExpiredSessions drops rows it cannot decrypt and skips locked ones', async () => {
        const ws = newWorkspaceId();
        const otherKey = Buffer.alloc(32, 3).toString('base64');
        const foreign = createSqlStore(sql, { encryptionKey: otherKey });
        await foreign.createSession({
          workspaceId: ws,
          userId: 'u-old-key',
          userName: 'Old key',
          tokens: tokens('old-key'),
          expiresAt: '2019-01-01T00:00:00.000Z',
        });
        const readable = await store.createSession({
          workspaceId: ws,
          userId: 'u-ana',
          userName: 'Ana Lead',
          tokens: tokens('readable'),
          expiresAt: '2019-01-02T00:00:00.000Z',
        });
        const now = '2019-06-01T00:00:00.000Z';
        const taken = await store.takeExpiredSessions(now, 10);
        expect(taken.filter((s) => s.workspaceId === ws)).toEqual([
          readable.session,
        ]);
        const left = await sql.query<{ id: string }>(
          'SELECT id FROM sessions WHERE workspace_id = $1',
          [ws]
        );
        expect(left).toEqual([]);

        // A session held by withSessionLock (a refresh in flight) is left
        // for a later call instead of being waited for. PGlite has one
        // connection, so only a real Postgres can show the skip.
        if (label.includes('PGlite')) return;
        const locked = await store.createSession({
          workspaceId: ws,
          userId: 'u-ana',
          userName: 'Ana Lead',
          tokens: tokens('locked'),
          expiresAt: '2019-01-03T00:00:00.000Z',
        });
        let release = (): void => undefined;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let entered = (): void => undefined;
        const inside = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const holding = store.withSessionLock(locked.session.id, async () => {
          entered();
          await held;
          return { result: null };
        });
        await inside;
        const whileLocked = await store.takeExpiredSessions(now, 10);
        expect(whileLocked.filter((s) => s.workspaceId === ws)).toEqual([]);
        release();
        await holding;
        const after = await store.takeExpiredSessions(now, 10);
        expect(after.filter((s) => s.workspaceId === ws)).toEqual([
          locked.session,
        ]);
      });
    });

    describe('settings and milestone meta', () => {
      test('settings round-trip and overwrite', async () => {
        const ws = newWorkspaceId();
        expect(await store.getSettings(ws)).toBeNull();
        await store.saveSettings(settings(ws));
        expect(await store.getSettings(ws)).toEqual(settings(ws));
        const live: WorkspaceSettings = {
          ...settings(ws),
          allocationMode: 'live',
          watcherUserIds: [],
        };
        await store.saveSettings(live);
        expect(await store.getSettings(ws)).toEqual(live);
      });

      // The PM list was retired (owner decision 2026-10-22): rows saved
      // before it still carry pmUserIds, which reads ignore and writes
      // drop.
      test('settings saved with the retired PM list read without it', async () => {
        const ws = newWorkspaceId();
        const old = { ...settings(ws), pmUserIds: ['u-ana', 'u-ben'] };
        await sql.query(
          `INSERT INTO settings (workspace_id, data, updated_at)
           VALUES ($1, $2::text::jsonb, $3::timestamptz)`,
          [ws, JSON.stringify(old), '2026-10-21T08:00:00.000Z']
        );
        const read = await store.getSettings(ws);
        expect(read).toEqual(settings(ws));
        expect(read !== null && 'pmUserIds' in read).toBe(false);

        // Saving what an older caller spread from such a row stores no PM
        // list either.
        await store.saveSettings(old);
        const raw = await sql.query<{ data: Record<string, unknown> }>(
          'SELECT data FROM settings WHERE workspace_id = $1',
          [ws]
        );
        expect(raw[0]?.data).not.toHaveProperty('pmUserIds');
        expect(raw[0]?.data['watcherUserIds']).toEqual(['u-ana', 'u-watcher']);
      });

      test('milestone meta upsert and list', async () => {
        const ws = newWorkspaceId();
        expect(await store.listMilestoneMeta(ws)).toEqual([]);
        const beta: MilestoneMeta = {
          milestoneId: 'm-beta',
          weight: null,
          doneMeans: null,
          updatedAt: '2026-10-21T08:00:00.000Z',
          updatedBy: null,
        };
        const alpha: MilestoneMeta = {
          milestoneId: 'm-alpha',
          weight: 2.5,
          doneMeans: 'the old cluster is off',
          updatedAt: '2026-10-21T09:00:00.000Z',
          updatedBy: 'u-ana',
        };
        await store.upsertMilestoneMeta(ws, beta);
        await store.upsertMilestoneMeta(ws, alpha);
        expect(await store.listMilestoneMeta(ws)).toEqual([alpha, beta]);
        const bumped = { ...beta, weight: -1, updatedBy: 'u-ana' };
        await store.upsertMilestoneMeta(ws, bumped);
        expect(await store.listMilestoneMeta(ws)).toEqual([alpha, bumped]);
        expect(await store.listMilestoneMeta(newWorkspaceId())).toEqual([]);
      });

      test('a NUL in free text is dropped instead of failing the write', async () => {
        const ws = newWorkspaceId();
        const meta = await store.updateMilestoneMetaField(
          ws,
          'm-alpha',
          'doneMeans',
          'a\u0000b',
          'u-ana',
          '2026-10-21T09:00:00.000Z'
        );
        expect(meta.doneMeans).toBe('ab');
        await store.recordFullSync(ws, {
          at: '2026-10-21T09:00:00.000Z',
          ok: false,
          error: 'Linear said \u0000 no',
        });
        expect((await store.getSyncState(ws))?.lastFullSyncError).toBe(
          'Linear said  no'
        );
      });

      test('updateMilestoneMetaField writes only its own column', async () => {
        const ws = newWorkspaceId();
        // A missing row is inserted with the other field null.
        const created = await store.updateMilestoneMetaField(
          ws,
          'm-alpha',
          'weight',
          5,
          'u-ana',
          '2026-10-21T09:00:00.000Z'
        );
        expect(created).toEqual({
          milestoneId: 'm-alpha',
          weight: 5,
          doneMeans: null,
          updatedAt: '2026-10-21T09:00:00.000Z',
          updatedBy: 'u-ana',
        });
        // Two writers that each read the row before the other wrote: the
        // second write keeps the first one's field (no whole-row upsert).
        await store.updateMilestoneMetaField(
          ws,
          'm-alpha',
          'doneMeans',
          'the old cluster is off',
          'u-bo',
          '2026-10-21T09:01:00.000Z'
        );
        const both = await store.updateMilestoneMetaField(
          ws,
          'm-alpha',
          'weight',
          -2,
          'u-ana',
          '2026-10-21T09:02:00.000Z'
        );
        expect(both).toEqual({
          milestoneId: 'm-alpha',
          weight: -2,
          doneMeans: 'the old cluster is off',
          updatedAt: '2026-10-21T09:02:00.000Z',
          updatedBy: 'u-ana',
        });
        const cleared = await store.updateMilestoneMetaField(
          ws,
          'm-alpha',
          'doneMeans',
          null,
          'u-bo',
          '2026-10-21T09:03:00.000Z'
        );
        expect(cleared).toMatchObject({ weight: -2, doneMeans: null });
        expect(await store.listMilestoneMeta(ws)).toEqual([cleared]);

        // Values must match the field; nothing is written otherwise.
        for (const [field, value] of [
          ['weight', '12'],
          ['weight', Number.NaN],
          ['doneMeans', 3],
          ['nope', 1],
        ] as const) {
          const error = await rejection(
            store.updateMilestoneMetaField(
              ws,
              'm-alpha',
              field as 'weight',
              value,
              'u-ana',
              '2026-10-21T09:04:00.000Z'
            )
          );
          expect(error).toBeInstanceOf(TypeError);
        }
        expect(await store.listMilestoneMeta(ws)).toEqual([cleared]);
      });
    });

    describe('mirror', () => {
      test('replaceMirror + loadMirror round-trip every entity kind exactly', async () => {
        const ws = newWorkspaceId();
        expect(await store.loadMirror(ws)).toBeNull();
        const data = workspaceData(ws);
        const version = await store.replaceMirror(
          data,
          '2026-10-21T08:00:00.000Z'
        );
        expect(version).toBe(1);
        const loaded = await store.loadMirror(ws);
        expect(loaded).toEqual({
          data,
          version: 1,
          lastFullSyncAt: '2026-10-21T08:00:00.000Z',
        });
        // Dates inside JSON stay strings.
        expect(typeof loaded?.data.issues[0]?.createdAt).toBe('string');
        expect(loaded?.data.milestones[0]?.targetDate).toBe('2026-10-28');
      });

      test('strings Postgres cannot store are cleaned instead of failing the write', async () => {
        const ws = newWorkspaceId();
        const data = workspaceData(ws);
        const [first, second] = data.issues;
        if (first === undefined || second === undefined) {
          throw new Error('fixture has issues');
        }
        first.title = 'nul\u0000 byte';
        second.title = 'cut emoji \ud83d, stray \ude00, whole pair 😀';
        await store.replaceMirror(data, '2026-10-21T08:00:00.000Z');
        const titles = (await store.loadMirror(ws))?.data.issues.map(
          (issue) => issue.title
        );
        expect(titles?.slice(0, 2)).toEqual([
          'nul byte',
          'cut emoji �, stray �, whole pair 😀',
        ]);
        // Every JSON column goes through the same cleaning.
        await store.appendAudit({
          workspaceId: ws,
          actorUserId: 'u-ana',
          action: 'milestone.done_means',
          subjectId: 'm-alpha',
          before: null,
          after: { doneMeans: 'ship\u0000 it \udbff' },
          at: '2026-10-21T08:00:00.000Z',
        });
        expect((await store.listAudit(ws, 1))[0]?.after).toEqual({
          doneMeans: 'ship it �',
        });
      });

      test('replaceMirror deletes entities missing from the new data', async () => {
        const ws = newWorkspaceId();
        await store.replaceMirror(
          workspaceData(ws),
          '2026-10-21T08:00:00.000Z'
        );
        const smaller = workspaceData(ws);
        smaller.issues = smaller.issues.filter((issue) => issue.id !== 'iss-3');
        smaller.relations = [];
        smaller.users = smaller.users.map((user) =>
          user.id === 'u-ana' ? { ...user, name: 'Ana Renamed' } : user
        );
        const version = await store.replaceMirror(
          smaller,
          '2026-10-21T08:15:00.000Z'
        );
        expect(version).toBe(2);
        expect(await store.loadMirror(ws)).toEqual({
          data: smaller,
          version: 2,
          lastFullSyncAt: '2026-10-21T08:15:00.000Z',
        });
        const raw = await sql.query<{ kind: string; id: string }>(
          `SELECT kind, id FROM mirror_entities
           WHERE workspace_id = $1 AND kind IN ('issue', 'relation') ORDER BY id`,
          [ws]
        );
        expect(raw.map((row) => row.id)).toEqual(['iss-1', 'iss-2', 'iss-4']);
      });

      test('replaceMirror only touches its own workspace', async () => {
        const a = newWorkspaceId();
        const b = newWorkspaceId();
        await store.replaceMirror(workspaceData(a), '2026-10-21T08:00:00.000Z');
        await store.replaceMirror(
          { ...workspaceData(b), issues: [] },
          '2026-10-21T08:00:00.000Z'
        );
        expect((await store.loadMirror(a))?.data).toEqual(workspaceData(a));
        expect((await store.loadMirror(b))?.data.issues).toEqual([]);
      });

      test('applyMirrorChanges upserts, removes and bumps the version', async () => {
        const ws = newWorkspaceId();
        const data = workspaceData(ws);
        await store.replaceMirror(data, '2026-10-21T08:00:00.000Z');
        const [first] = data.issues;
        if (first === undefined) {
          throw new Error('fixture has issues');
        }
        const updatedIssue = {
          ...first,
          assigneeId: 'u-ana',
          stateId: 's-todo',
        };
        const newIssue = {
          ...first,
          id: 'iss-new',
          identifier: 'ENG-99',
          title: 'Brand new',
        };
        const changes: MirrorEntity[] = [
          { kind: 'issue', entity: updatedIssue },
          { kind: 'issue', entity: newIssue },
          {
            kind: 'relation',
            entity: { id: 'rel-3', blockerId: 'iss-new', blockedId: 'iss-2' },
          },
        ];
        const version = await store.applyMirrorChanges(ws, {
          upsert: changes,
          remove: [
            { kind: 'relation', id: 'rel-1' },
            { kind: 'milestone', id: 'm-beta' },
            { kind: 'issue', id: 'not-mirrored' },
          ],
        });
        expect(version).toBe(2);
        const loaded = await store.loadMirror(ws);
        expect(loaded?.version).toBe(2);
        // Upserted rows keep their position; new rows are appended.
        expect(loaded?.data.issues).toEqual([
          updatedIssue,
          ...data.issues.slice(1),
          newIssue,
        ]);
        expect(loaded?.data.relations.map((r) => r.id)).toEqual([
          'rel-2',
          'rel-3',
        ]);
        expect(loaded?.data.milestones.map((m) => m.id)).toEqual([
          'm-alpha',
          'm-halo',
        ]);
        // A webhook write is not a full sync.
        expect(loaded?.lastFullSyncAt).toBe('2026-10-21T08:00:00.000Z');
        expect((await store.getSyncState(ws))?.version).toBe(2);
      });

      test('applyMirrorChanges removes before upserting, so overlaps survive', async () => {
        const ws = newWorkspaceId();
        await store.replaceMirror(
          workspaceData(ws),
          '2026-10-21T08:00:00.000Z'
        );
        const relation = {
          id: 'rel-1',
          blockerId: 'iss-1',
          blockedId: 'iss-3',
        };
        await store.applyMirrorChanges(ws, {
          upsert: [{ kind: 'relation', entity: relation }],
          remove: [
            { kind: 'relation', id: 'rel-1' },
            { kind: 'relation', id: 'rel-2' },
          ],
        });
        expect((await store.loadMirror(ws))?.data.relations).toEqual([
          relation,
        ]);
      });

      test('applyMirrorChanges keeps the last of duplicate upserts', async () => {
        const ws = newWorkspaceId();
        const team = { id: 't-x', key: 'X', name: 'First' };
        await store.applyMirrorChanges(ws, {
          upsert: [
            { kind: 'team', entity: team },
            { kind: 'team', entity: { ...team, name: 'Second' } },
          ],
          remove: [],
        });
        const loaded = await store.loadMirror(ws);
        expect(loaded?.data.teams).toEqual([{ ...team, name: 'Second' }]);
        // A mirror built only from webhooks has never had a full sync.
        expect(loaded?.lastFullSyncAt).toBeNull();
        expect(loaded?.version).toBe(1);
      });

      test('applyMirrorChanges with nothing to do keeps the version', async () => {
        const ws = newWorkspaceId();
        expect(
          await store.applyMirrorChanges(ws, { upsert: [], remove: [] })
        ).toBe(0);
        await store.replaceMirror(
          workspaceData(ws),
          '2026-10-21T08:00:00.000Z'
        );
        expect(
          await store.applyMirrorChanges(ws, { upsert: [], remove: [] })
        ).toBe(1);
        expect((await store.loadMirror(ws))?.version).toBe(1);
      });

      test('concurrent mirror writes each get their own version', async () => {
        const ws = newWorkspaceId();
        await store.replaceMirror(
          workspaceData(ws),
          '2026-10-21T08:00:00.000Z'
        );
        const versions = await Promise.all(
          ['a', 'b', 'c'].map((id) =>
            store.applyMirrorChanges(ws, {
              upsert: [{ kind: 'team', entity: { id, key: id, name: id } }],
              remove: [],
            })
          )
        );
        expect(versions.toSorted((a, b) => a - b)).toEqual([2, 3, 4]);
        const loaded = await store.loadMirror(ws);
        expect(loaded?.version).toBe(4);
        const teamIds = loaded?.data.teams.map((t) => t.id) ?? [];
        // The original teams keep their place; every new team is appended.
        expect(teamIds.slice(0, 2)).toEqual(['t-eng', 't-ops']);
        expect(teamIds.slice(2).toSorted()).toEqual(['a', 'b', 'c']);
      });
    });

    describe('sync state and webhooks', () => {
      test('getSyncState and recordFullSync', async () => {
        const ws = newWorkspaceId();
        expect(await store.getSyncState(ws)).toBeNull();
        await store.recordFullSync(ws, {
          at: '2026-10-21T08:00:00.000Z',
          ok: false,
          error: 'Linear 503',
        });
        expect(await store.getSyncState(ws)).toEqual({
          workspaceId: ws,
          version: 0,
          lastFullSyncAt: '2026-10-21T08:00:00.000Z',
          lastFullSyncStatus: 'failed',
          lastFullSyncError: 'Linear 503',
          lastWebhookAt: null,
          consecutiveFailures: 1,
          lastFullSyncMs: null,
          lastSuccessAt: null,
          mirrorIssueCount: null,
          lastFullSyncStartedAt: null,
        });
        // A failed sync wrote no mirror, so there is nothing to load.
        expect(await store.loadMirror(ws)).toBeNull();
        await store.replaceMirror(
          workspaceData(ws),
          '2026-10-21T08:15:00.000Z'
        );
        await store.recordFullSync(ws, {
          at: '2026-10-21T08:15:00.000Z',
          ok: true,
          error: null,
        });
        expect(await store.getSyncState(ws)).toEqual({
          workspaceId: ws,
          version: 1,
          lastFullSyncAt: '2026-10-21T08:15:00.000Z',
          lastFullSyncStatus: 'ok',
          lastFullSyncError: null,
          lastWebhookAt: null,
          consecutiveFailures: 0,
          lastFullSyncMs: null,
          lastSuccessAt: '2026-10-21T08:15:00.000Z',
          mirrorIssueCount: null,
          lastFullSyncStartedAt: null,
        });
      });

      test('recordFullSyncStart stamps when an attempt started and changes nothing else', async () => {
        const ws = newWorkspaceId();
        // A first attempt that never ends (its process was killed) leaves
        // only its start.
        await store.recordFullSyncStart(ws, '2026-10-21T07:00:00.000Z');
        expect(await store.getSyncState(ws)).toEqual({
          workspaceId: ws,
          version: 0,
          lastFullSyncAt: null,
          lastFullSyncStatus: null,
          lastFullSyncError: null,
          lastWebhookAt: null,
          consecutiveFailures: 0,
          lastFullSyncMs: null,
          lastSuccessAt: null,
          mirrorIssueCount: null,
          lastFullSyncStartedAt: '2026-10-21T07:00:00.000Z',
        });
        await store.recordFullSync(ws, {
          at: '2026-10-21T08:00:00.000Z',
          ok: false,
          error: 'Linear 503',
          durationMs: 4000,
        });
        await store.recordFullSyncStart(ws, '2026-10-21T08:15:00.000Z');
        // The last finished attempt is untouched: backoff, the chronic
        // rule and the skip-recent rule read only that.
        expect(await store.getSyncState(ws)).toMatchObject({
          lastFullSyncAt: '2026-10-21T08:00:00.000Z',
          lastFullSyncStatus: 'failed',
          lastFullSyncError: 'Linear 503',
          consecutiveFailures: 1,
          lastFullSyncMs: 4000,
          lastSuccessAt: null,
          lastFullSyncStartedAt: '2026-10-21T08:15:00.000Z',
        });
        // A late writer never moves it back, and a finish leaves it alone.
        await store.recordFullSyncStart(ws, '2026-10-21T08:10:00.000Z');
        await store.recordFullSync(ws, {
          at: '2026-10-21T08:20:00.000Z',
          ok: true,
          error: null,
        });
        expect(await store.getSyncState(ws)).toMatchObject({
          lastFullSyncAt: '2026-10-21T08:20:00.000Z',
          lastFullSyncStatus: 'ok',
          consecutiveFailures: 0,
          lastFullSyncStartedAt: '2026-10-21T08:15:00.000Z',
        });
      });

      test('recordFullSync counts failures in a row and keeps the last success, duration and issue count', async () => {
        const ws = newWorkspaceId();
        const fail = (at: string, durationMs?: number) =>
          store.recordFullSync(ws, {
            at,
            ok: false,
            error: 'Linear 503',
            ...(durationMs === undefined ? {} : { durationMs }),
          });
        await fail('2026-10-21T08:00:00.000Z');
        await fail('2026-10-21T08:05:00.000Z');
        expect(await store.getSyncState(ws)).toMatchObject({
          consecutiveFailures: 2,
          lastSuccessAt: null,
          lastFullSyncMs: null,
        });
        await store.recordFullSync(ws, {
          at: '2026-10-21T08:10:00.000Z',
          ok: true,
          error: null,
          durationMs: 1234.6,
          issueCount: 42,
        });
        expect(await store.getSyncState(ws)).toMatchObject({
          lastFullSyncStatus: 'ok',
          consecutiveFailures: 0,
          lastSuccessAt: '2026-10-21T08:10:00.000Z',
          lastFullSyncMs: 1235,
          mirrorIssueCount: 42,
        });
        // A failure without a duration keeps the last success's numbers.
        await fail('2026-10-21T08:20:00.000Z');
        expect(await store.getSyncState(ws)).toMatchObject({
          lastFullSyncAt: '2026-10-21T08:20:00.000Z',
          lastFullSyncStatus: 'failed',
          consecutiveFailures: 1,
          lastSuccessAt: '2026-10-21T08:10:00.000Z',
          lastFullSyncMs: 1235,
          mirrorIssueCount: 42,
        });
        // A reported duration is stored whatever the outcome; numbers
        // that are not whole or not finite never fail the write.
        await fail('2026-10-21T08:30:00.000Z', Number.NaN);
        await fail('2026-10-21T08:40:00.000Z', 90_000.4);
        expect(await store.getSyncState(ws)).toMatchObject({
          consecutiveFailures: 3,
          lastFullSyncMs: 90_000,
        });
      });

      test('pruneWebhookDeliveries deletes only older deliveries', async () => {
        const ws = newWorkspaceId();
        const old = crypto.randomUUID();
        const recent = crypto.randomUUID();
        for (const [deliveryId, receivedAt] of [
          [old, '2026-08-01T00:00:00.000Z'],
          [recent, '2026-10-20T00:00:00.000Z'],
        ] as const) {
          await store.recordWebhookDelivery({
            deliveryId,
            workspaceId: ws,
            type: 'Issue',
            action: 'update',
            entityId: 'i1',
            receivedAt,
          });
        }
        expect(
          await store.pruneWebhookDeliveries('2026-09-21T00:00:00.000Z')
        ).toBeGreaterThanOrEqual(1);
        // The old delivery id is free again; the recent one is still deduped.
        const again = (deliveryId: string) =>
          store.recordWebhookDelivery({
            deliveryId,
            workspaceId: ws,
            type: 'Issue',
            action: 'update',
            entityId: 'i1',
            receivedAt: '2026-10-21T00:00:00.000Z',
          });
        expect(await again(old)).toBe(true);
        expect(await again(recent)).toBe(false);
      });

      test('recordWebhookDelivery dedupes on the delivery id', async () => {
        const ws = newWorkspaceId();
        await store.saveInstallation(installation(ws));
        const deliveryId = crypto.randomUUID();
        const input = {
          deliveryId,
          workspaceId: ws,
          type: 'Issue',
          action: 'update',
          entityId: 'iss-1',
          receivedAt: '2026-10-21T08:00:00.000Z',
        };
        expect(await store.recordWebhookDelivery(input)).toBe(true);
        expect((await store.getSyncState(ws))?.lastWebhookAt).toBe(
          '2026-10-21T08:00:00.000Z'
        );
        expect(
          await store.recordWebhookDelivery({
            ...input,
            receivedAt: '2026-10-21T09:00:00.000Z',
          })
        ).toBe(false);
        // The retried delivery changed nothing.
        expect((await store.getSyncState(ws))?.lastWebhookAt).toBe(
          '2026-10-21T08:00:00.000Z'
        );
        // A newer delivery moves lastWebhookAt forward, an older one never back.
        await store.recordWebhookDelivery({
          ...input,
          deliveryId: crypto.randomUUID(),
          receivedAt: '2026-10-21T10:00:00.000Z',
        });
        await store.recordWebhookDelivery({
          ...input,
          deliveryId: crypto.randomUUID(),
          entityId: null,
          receivedAt: '2026-10-21T07:00:00.000Z',
        });
        expect((await store.getSyncState(ws))?.lastWebhookAt).toBe(
          '2026-10-21T10:00:00.000Z'
        );
        // Webhook bookkeeping is not a mirror write.
        expect((await store.getSyncState(ws))?.version).toBe(0);
      });

      test('recordWebhookDelivery leaves no sync_state stub for an organization nobody installed', async () => {
        const ws = newWorkspaceId();
        const input = {
          deliveryId: crypto.randomUUID(),
          workspaceId: ws,
          type: 'Issue',
          action: 'update',
          entityId: 'iss-1',
          receivedAt: '2026-10-21T08:00:00.000Z',
        };
        expect(await store.recordWebhookDelivery(input)).toBe(true);
        expect(await store.getSyncState(ws)).toBeNull();
        // The delivery itself is recorded, so a retry is still a duplicate.
        expect(await store.recordWebhookDelivery(input)).toBe(false);

        // A workspace that already has a sync_state row is bumped either way.
        await store.recordFullSync(ws, {
          at: '2026-10-21T07:00:00.000Z',
          ok: false,
          error: 'x',
        });
        await store.recordWebhookDelivery({
          ...input,
          deliveryId: crypto.randomUUID(),
          receivedAt: '2026-10-21T09:00:00.000Z',
        });
        expect((await store.getSyncState(ws))?.lastWebhookAt).toBe(
          '2026-10-21T09:00:00.000Z'
        );
      });

      test('markWebhookProcessed records the outcome', async () => {
        const deliveryId = crypto.randomUUID();
        await store.recordWebhookDelivery({
          deliveryId,
          workspaceId: newWorkspaceId(),
          type: 'Project',
          action: 'remove',
          entityId: 'p-1',
          receivedAt: '2026-10-21T08:00:00.000Z',
        });
        await store.markWebhookProcessed(deliveryId, {
          at: '2026-10-21T08:00:01.000Z',
          error: 'fetchProject failed',
        });
        const rows = await sql.query<{
          processed_at: Date;
          error: string | null;
        }>(
          'SELECT processed_at, error FROM webhook_deliveries WHERE delivery_id = $1',
          [deliveryId]
        );
        expect(rows[0]?.processed_at.toISOString()).toBe(
          '2026-10-21T08:00:01.000Z'
        );
        expect(rows[0]?.error).toBe('fetchProject failed');
      });
    });

    describe('allocation runs', () => {
      const start = (
        workspaceId: string,
        now: string,
        staleAfterMinutes = 60
      ) =>
        store.startRun({
          workspaceId,
          mode: 'live',
          trigger: 'schedule',
          startedByUserId: null,
          now,
          staleAfterMinutes,
        });
      const summary = {
        assigned: 2,
        wouldAssign: 0,
        failed: 1,
        blockedProjects: 1,
        skippedIssues: 3,
      };

      test('startRun returns the run, and null while another is running', async () => {
        const ws = newWorkspaceId();
        const run = await store.startRun({
          workspaceId: ws,
          mode: 'dry_run',
          trigger: 'manual',
          startedByUserId: 'u-ana',
          now: '2026-10-21T08:00:00.000Z',
          staleAfterMinutes: 60,
        });
        expect(run).toEqual({
          id: run?.id ?? '',
          workspaceId: ws,
          mode: 'dry_run',
          trigger: 'manual',
          startedByUserId: 'u-ana',
          status: 'running',
          startedAt: '2026-10-21T08:00:00.000Z',
          finishedAt: null,
          summary: null,
          error: null,
        });
        expect(await start(ws, '2026-10-21T08:30:00.000Z')).toBeNull();
        // Another workspace is not blocked.
        expect(
          await start(newWorkspaceId(), '2026-10-21T08:30:00.000Z')
        ).not.toBeNull();
        await store.finishRun(run?.id ?? '', {
          status: 'succeeded',
          summary,
          error: null,
          now: '2026-10-21T08:31:00.000Z',
        });
        expect(await start(ws, '2026-10-21T08:32:00.000Z')).not.toBeNull();
      });

      test('concurrent startRun: exactly one wins', async () => {
        const ws = newWorkspaceId();
        const results = await Promise.all([
          start(ws, '2026-10-21T08:00:00.000Z'),
          start(ws, '2026-10-21T08:00:00.000Z'),
          start(ws, '2026-10-21T08:00:00.000Z'),
        ]);
        expect(results.filter((run) => run !== null)).toHaveLength(1);
      });

      test('a run running longer than staleAfterMinutes is failed and ignored', async () => {
        const ws = newWorkspaceId();
        const stuck = await start(ws, '2026-10-21T08:00:00.000Z');
        expect(await start(ws, '2026-10-21T08:59:00.000Z')).toBeNull();
        const fresh = await start(ws, '2026-10-21T09:00:01.000Z');
        expect(fresh).not.toBeNull();
        const old = await store.getRun(ws, stuck?.id ?? '');
        expect(old?.run).toMatchObject({
          status: 'failed',
          error: 'stale run',
          finishedAt: '2026-10-21T09:00:01.000Z',
        });
        expect((await store.getRun(ws, fresh?.id ?? ''))?.run.status).toBe(
          'running'
        );
      });

      test('appendRunEntries numbers entries; getRun returns them in order', async () => {
        const ws = newWorkspaceId();
        const run = await start(ws, '2026-10-21T08:00:00.000Z');
        const runId = run?.id ?? '';
        clock = new Date('2026-10-21T08:00:05.000Z');
        await store.appendRunEntries(runId, [
          entry({
            action: 'block',
            outcome: 'noted',
            milestoneId: null,
            issueId: null,
            issueIdentifier: null,
            assigneeId: null,
            reason: 'no_lead',
            detail: { gaps: ['no_target_date'] },
          }),
          entry({
            action: 'skip',
            outcome: 'noted',
            reason: 'triage',
            assigneeId: null,
          }),
        ]);
        await store.appendRunEntries(runId, []);
        await store.appendRunEntries(runId, [
          entry({
            outcome: 'failed',
            reason: null,
            error: 'Linear 500',
            detail: {},
          }),
        ]);
        const loaded = await store.getRun(ws, runId);
        expect(
          loaded?.entries.map((e) => [e.seq, e.action, e.outcome])
        ).toEqual([
          [1, 'block', 'noted'],
          [2, 'skip', 'noted'],
          [3, 'assign', 'failed'],
        ]);
        expect(loaded?.entries[0]).toEqual({
          runId,
          seq: 1,
          action: 'block',
          outcome: 'noted',
          projectId: 'p-orion',
          milestoneId: null,
          issueId: null,
          issueIdentifier: null,
          assigneeId: null,
          reason: 'no_lead',
          detail: { gaps: ['no_target_date'] },
          error: null,
          createdAt: '2026-10-21T08:00:05.000Z',
        });
        expect(loaded?.entries[2]?.error).toBe('Linear 500');
        const unknownRun = await rejection(
          store.appendRunEntries('missing-run', [entry({})])
        );
        expect(unknownRun.message).toMatch(/Unknown allocation run/);
      });

      test('concurrent appenders to one run get gap-free seq numbers', async () => {
        const ws = newWorkspaceId();
        const run = await start(ws, '2026-10-21T08:00:00.000Z');
        const runId = run?.id ?? '';
        await Promise.all(
          ['a', 'b', 'c', 'd'].map((batch) =>
            store.appendRunEntries(runId, [
              entry({ issueId: `${batch}-1` }),
              entry({ issueId: `${batch}-2` }),
            ])
          )
        );
        const entries = (await store.getRun(ws, runId))?.entries ?? [];
        expect(entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        // Each call's entries stay together, in the order given.
        for (let i = 0; i < entries.length; i += 2) {
          const firstId = entries[i]?.issueId ?? '';
          expect(firstId).toMatch(/-1$/);
          expect(entries[i + 1]?.issueId).toBe(firstId.replace(/-1$/, '-2'));
        }
      });

      test('finishRun stores status, summary and error', async () => {
        const ws = newWorkspaceId();
        const run = await start(ws, '2026-10-21T08:00:00.000Z');
        if (run === null) {
          throw new Error('expected the run to start');
        }
        await store.finishRun(run.id, {
          status: 'partial',
          summary,
          error: '1 write failed',
          now: '2026-10-21T08:02:00.000Z',
        });
        expect((await store.getRun(ws, run.id))?.run).toEqual({
          ...run,
          status: 'partial',
          summary,
          error: '1 write failed',
          finishedAt: '2026-10-21T08:02:00.000Z',
        });
        const unknownRun = await rejection(
          store.finishRun('missing-run', {
            status: 'failed',
            summary,
            error: null,
            now: '2026-10-21T08:02:00.000Z',
          })
        );
        expect(unknownRun.message).toMatch(/Unknown allocation run/);
      });

      test('listRuns is newest first and limited; getRun is workspace-scoped', async () => {
        const ws = newWorkspaceId();
        const ids: string[] = [];
        for (const minute of ['00', '10', '20']) {
          const run = await start(ws, `2026-10-21T08:${minute}:00.000Z`);
          ids.push(run?.id ?? '');
          await store.finishRun(run?.id ?? '', {
            status: 'succeeded',
            summary,
            error: null,
            now: `2026-10-21T08:${minute}:30.000Z`,
          });
        }
        expect((await store.listRuns(ws, 10)).map((r) => r.id)).toEqual(
          ids.toReversed()
        );
        expect((await store.listRuns(ws, 2)).map((r) => r.id)).toEqual(
          ids.toReversed().slice(0, 2)
        );
        expect(await store.listRuns(ws, -1)).toEqual([]);
        // Out-of-range limits are clamped instead of failing the query.
        expect((await store.listRuns(ws, 1e12)).map((r) => r.id)).toEqual(
          ids.toReversed()
        );
        expect(await store.listRuns(ws, Infinity)).toHaveLength(3);
        expect(await store.listRuns(ws, 1.9)).toHaveLength(1);
        expect(await store.listRuns(ws, Number.NaN)).toEqual([]);
        expect(await store.getRun(newWorkspaceId(), ids[0] ?? '')).toBeNull();
        expect(await store.getRun(ws, 'not-a-uuid')).toBeNull();
      });

      test('listAppliedAssignments returns live applied assigns since a time', async () => {
        const ws = newWorkspaceId();
        const dry = await store.startRun({
          workspaceId: ws,
          mode: 'dry_run',
          trigger: 'manual',
          startedByUserId: 'u-ana',
          now: '2026-10-10T08:00:00.000Z',
          staleAfterMinutes: 60,
        });
        clock = new Date('2026-10-10T08:00:01.000Z');
        await store.appendRunEntries(dry?.id ?? '', [
          entry({ outcome: 'planned' }),
        ]);
        await store.finishRun(dry?.id ?? '', {
          status: 'succeeded',
          summary,
          error: null,
          now: '2026-10-10T08:01:00.000Z',
        });

        const oldLive = await start(ws, '2026-10-01T08:00:00.000Z', 100_000);
        clock = new Date('2026-10-01T08:00:01.000Z');
        await store.appendRunEntries(oldLive?.id ?? '', [
          entry({ issueId: 'iss-old' }),
        ]);
        await store.finishRun(oldLive?.id ?? '', {
          status: 'succeeded',
          summary,
          error: null,
          now: '2026-10-01T08:01:00.000Z',
        });

        const live = await start(ws, '2026-10-20T08:00:00.000Z');
        clock = new Date('2026-10-20T08:00:01.000Z');
        await store.appendRunEntries(live?.id ?? '', [
          entry({ issueId: 'iss-1' }),
          entry({ issueId: 'iss-2', outcome: 'failed', error: 'boom' }),
          entry({
            issueId: 'iss-3',
            outcome: 'stale',
            reason: 'already_assigned',
          }),
          entry({ action: 'skip', outcome: 'noted', issueId: 'iss-4' }),
          entry({ issueId: 'iss-5', assigneeId: 'u-bo' }),
        ]);

        const applied = await store.listAppliedAssignments(
          ws,
          '2026-10-05T00:00:00.000Z'
        );
        expect(applied.map((e) => [e.issueId, e.assigneeId, e.seq])).toEqual([
          ['iss-1', 'u-ana', 1],
          ['iss-5', 'u-bo', 5],
        ]);
        expect(applied[0]?.createdAt).toBe('2026-10-20T08:00:01.000Z');
        expect(
          (
            await store.listAppliedAssignments(ws, '2026-09-01T00:00:00.000Z')
          ).map((e) => e.issueId)
        ).toEqual(['iss-old', 'iss-1', 'iss-5']);
        expect(
          await store.listAppliedAssignments(
            newWorkspaceId(),
            '2026-01-01T00:00:00.000Z'
          )
        ).toEqual([]);
      });
      test('listRunEntriesForIssue lists one issue newest first with its run mode', async () => {
        const ws = newWorkspaceId();
        const dry = await store.startRun({
          workspaceId: ws,
          mode: 'dry_run',
          trigger: 'manual',
          startedByUserId: 'u-ana',
          now: '2026-10-18T08:00:00.000Z',
          staleAfterMinutes: 60,
        });
        clock = new Date('2026-10-18T08:00:01.000Z');
        await store.appendRunEntries(dry?.id ?? '', [
          entry({ issueId: 'iss-7', outcome: 'planned' }),
          entry({ issueId: 'iss-8', outcome: 'planned' }),
        ]);
        await store.finishRun(dry?.id ?? '', {
          status: 'succeeded',
          summary,
          error: null,
          now: '2026-10-18T08:01:00.000Z',
        });
        const live = await start(ws, '2026-10-19T08:00:00.000Z');
        clock = new Date('2026-10-19T08:00:01.000Z');
        await store.appendRunEntries(live?.id ?? '', [
          entry({
            action: 'skip',
            outcome: 'noted',
            issueId: 'iss-7',
            reason: 'triage',
          }),
          entry({ issueId: 'iss-7' }),
          entry({ action: 'block', outcome: 'noted', issueId: null }),
        ]);
        // Another workspace's entry for the same issue id stays out.
        const other = newWorkspaceId();
        const otherRun = await start(other, '2026-10-19T09:00:00.000Z');
        await store.appendRunEntries(otherRun?.id ?? '', [
          entry({ issueId: 'iss-7' }),
        ]);

        const liveId = live?.id ?? '';
        const dryId = dry?.id ?? '';
        const history = await store.listRunEntriesForIssue(ws, 'iss-7', 20);
        expect(
          history.map((e) => [
            e.runId,
            e.seq,
            e.action,
            e.runMode,
            e.runTrigger,
          ])
        ).toEqual([
          [liveId, 2, 'assign', 'live', 'schedule'],
          [liveId, 1, 'skip', 'live', 'schedule'],
          [dryId, 1, 'assign', 'dry_run', 'manual'],
        ]);
        expect(history[0]).toMatchObject({
          issueId: 'iss-7',
          outcome: 'applied',
          reason: 'comment-1',
          createdAt: '2026-10-19T08:00:01.000Z',
        });
        expect(
          (await store.listRunEntriesForIssue(ws, 'iss-7', 1)).map((e) => e.seq)
        ).toEqual([2]);
        expect(await store.listRunEntriesForIssue(ws, 'iss-none', 20)).toEqual(
          []
        );
      });
    });

    describe('warnings and notifications', () => {
      test('warning memory upserts and lists', async () => {
        const ws = newWorkspaceId();
        expect(await store.listWarningMemory(ws)).toEqual([]);
        await store.saveWarningMemory(ws, [
          {
            subjectKind: 'project',
            subjectId: 'p-halo',
            lastKey: 'blocked:no_lead:m-halo:',
            lastNotifiedOn: '2026-10-20',
            occurrence: 1,
          },
          {
            subjectKind: 'milestone',
            subjectId: 'm-alpha',
            lastKey: null,
            lastNotifiedOn: null,
            occurrence: 0,
          },
        ]);
        await store.saveWarningMemory(ws, [
          {
            subjectKind: 'milestone',
            subjectId: 'm-alpha',
            lastKey: 'first',
            lastNotifiedOn: '2026-10-21',
            occurrence: 1,
          },
          {
            subjectKind: 'milestone',
            subjectId: 'm-alpha',
            lastKey: 'overdue:2026-10-20',
            lastNotifiedOn: '2026-10-21',
            occurrence: 2,
          },
        ]);
        await store.saveWarningMemory(ws, []);
        expect(await store.listWarningMemory(ws)).toEqual([
          {
            subjectKind: 'milestone',
            subjectId: 'm-alpha',
            lastKey: 'overdue:2026-10-20',
            lastNotifiedOn: '2026-10-21',
            occurrence: 2,
          },
          {
            subjectKind: 'project',
            subjectId: 'p-halo',
            lastKey: 'blocked:no_lead:m-halo:',
            lastNotifiedOn: '2026-10-20',
            occurrence: 1,
          },
        ]);
      });

      test('claim-first: insert pending, then record the outcome', async () => {
        const ws = newWorkspaceId();
        const claim = {
          workspaceId: ws,
          day: '2026-10-21',
          recipientId: 'u-ben',
          channel: 'slack' as const,
          status: 'pending' as const,
          digest: digest('u-ben', '2026-10-21'),
          error: null,
          now: '2026-10-21T13:00:00.000Z',
        };
        expect(await store.insertNotification(claim)).toBe(true);
        // A second runner the same day cannot claim it again.
        expect(await store.insertNotification(claim)).toBe(false);
        await store.updateNotificationStatus({
          workspaceId: ws,
          day: '2026-10-21',
          recipientId: 'u-ben',
          channel: 'slack',
          status: 'undeliverable',
          error: 'users_not_found',
        });
        const [record] = await store.listNotifications(ws, { limit: 5 });
        expect(record?.status).toBe('undeliverable');
        expect(record?.error).toBe('users_not_found');
        // Updating a record that does not exist is a no-op.
        await store.updateNotificationStatus({
          workspaceId: ws,
          day: '2026-10-22',
          recipientId: 'u-ben',
          channel: 'slack',
          status: 'sent',
          error: null,
        });
        expect(await store.listNotifications(ws, { limit: 5 })).toHaveLength(1);
      });

      test('insertNotification: one per recipient per day', async () => {
        const ws = newWorkspaceId();
        const base = {
          workspaceId: ws,
          day: '2026-10-21',
          recipientId: 'u-ana',
          channel: 'slack' as const,
          status: 'sent' as const,
          digest: digest('u-ana', '2026-10-21'),
          error: null,
          now: '2026-10-21T13:00:00.000Z',
        };
        expect(await store.insertNotification(base)).toBe(true);
        expect(
          await store.insertNotification({
            ...base,
            status: 'failed',
            error: 'second attempt',
            now: '2026-10-21T14:00:00.000Z',
          })
        ).toBe(false);
        expect(
          await store.insertNotification({
            ...base,
            day: '2026-10-22',
            channel: 'outbox',
            status: 'preview',
            digest: digest('u-ana', '2026-10-22'),
            now: '2026-10-22T13:00:00.000Z',
          })
        ).toBe(true);
        expect(
          await store.insertNotification({
            ...base,
            recipientId: 'u-watcher',
            status: 'undeliverable',
            error: 'users_not_found',
            now: '2026-10-21T13:00:01.000Z',
          })
        ).toBe(true);

        const all = await store.listNotifications(ws, { limit: 10 });
        expect(all.map((n) => [n.day, n.recipientId, n.status])).toEqual([
          ['2026-10-22', 'u-ana', 'preview'],
          ['2026-10-21', 'u-watcher', 'undeliverable'],
          ['2026-10-21', 'u-ana', 'sent'],
        ]);
        const first = all[2];
        expect(first).toEqual({
          id: first?.id ?? '',
          workspaceId: ws,
          day: '2026-10-21',
          recipientId: 'u-ana',
          channel: 'slack',
          status: 'sent',
          digest: digest('u-ana', '2026-10-21'),
          error: null,
          createdAt: '2026-10-21T13:00:00.000Z',
        });
        expect(
          (
            await store.listNotifications(ws, { limit: 10, day: '2026-10-21' })
          ).map((n) => n.recipientId)
        ).toEqual(['u-watcher', 'u-ana']);
        expect(await store.listNotifications(ws, { limit: 1 })).toHaveLength(1);
        expect(
          await store.listNotifications(ws, { limit: 10, day: '2026-10-23' })
        ).toEqual([]);
      });
    });

    describe('jobs', () => {
      test('claimJob is idempotent per day; releaseJob frees the claim', async () => {
        const ws = newWorkspaceId();
        const now = '2026-10-21T13:00:00.000Z';
        expect(await store.claimJob(ws, 'daily', '2026-10-21', now)).toBe(true);
        expect(await store.claimJob(ws, 'daily', '2026-10-21', now)).toBe(
          false
        );
        expect(await store.claimJob(ws, 'daily', '2026-10-22', now)).toBe(true);
        expect(
          await store.claimJob(newWorkspaceId(), 'daily', '2026-10-21', now)
        ).toBe(true);
        await store.releaseJob(ws, 'daily', '2026-10-21');
        expect(await store.claimJob(ws, 'daily', '2026-10-21', now)).toBe(true);
      });

      test('concurrent claims: exactly one wins', async () => {
        const ws = newWorkspaceId();
        const results = await Promise.all(
          [1, 2, 3].map(() =>
            store.claimJob(
              ws,
              'daily',
              '2026-10-21',
              '2026-10-21T13:00:00.000Z'
            )
          )
        );
        expect(results.filter(Boolean)).toHaveLength(1);
      });

      // The lease: an unfinished claim older than leaseMinutes belongs to
      // a process that died mid-run, so the next claimer takes it over.
      const T0 = '2026-10-21T08:00:00.000Z';
      const at = (minutes: number): string =>
        new Date(Date.parse(T0) + minutes * 60_000).toISOString();
      const lease = { leaseMinutes: 30 };

      test('an unfinished claim is taken over once it is older than the lease', async () => {
        const ws = newWorkspaceId();
        expect(await store.claimJob(ws, 'daily', DAY, T0, lease)).toBe(true);
        expect(await store.claimJob(ws, 'daily', DAY, at(30), lease)).toBe(
          false
        );
        expect(await store.claimJob(ws, 'daily', DAY, at(31), lease)).toBe(
          true
        );
        // The takeover's own claim is fresh again.
        expect(await store.claimJob(ws, 'daily', DAY, at(45), lease)).toBe(
          false
        );
        // Without a lease nothing is ever taken over.
        expect(await store.claimJob(ws, 'daily', DAY, at(600))).toBe(false);
      });

      test('a finished claim is never taken over', async () => {
        const ws = newWorkspaceId();
        expect(await store.claimJob(ws, 'daily', DAY, T0, lease)).toBe(true);
        expect(
          await store.finishJob(ws, 'daily', DAY, {
            claimedAt: T0,
            at: at(5),
          })
        ).toBe(true);
        expect(await store.claimJob(ws, 'daily', DAY, at(600), lease)).toBe(
          false
        );
        // Finishing twice is a no-op.
        expect(
          await store.finishJob(ws, 'daily', DAY, {
            claimedAt: T0,
            at: at(6),
          })
        ).toBe(false);
      });

      test('a taken-over holder can neither finish nor release the new claim', async () => {
        const ws = newWorkspaceId();
        await store.claimJob(ws, 'daily', DAY, T0, lease);
        expect(await store.claimJob(ws, 'daily', DAY, at(31), lease)).toBe(
          true
        );
        // The first holder wakes up late.
        expect(
          await store.finishJob(ws, 'daily', DAY, {
            claimedAt: T0,
            at: at(32),
          })
        ).toBe(false);
        await store.releaseJob(ws, 'daily', DAY, T0);
        expect(await store.claimJob(ws, 'daily', DAY, at(33), lease)).toBe(
          false
        );
        // The current holder releases its own claim.
        await store.releaseJob(ws, 'daily', DAY, at(31));
        expect(await store.claimJob(ws, 'daily', DAY, at(34), lease)).toBe(
          true
        );
      });

      test('a release by claim time leaves a finished claim alone', async () => {
        const ws = newWorkspaceId();
        await store.claimJob(ws, 'daily', DAY, T0, lease);
        await store.finishJob(ws, 'daily', DAY, { claimedAt: T0, at: at(1) });
        await store.releaseJob(ws, 'daily', DAY, T0);
        expect(await store.claimJob(ws, 'daily', DAY, at(2), lease)).toBe(
          false
        );
        // The unconditional release still frees it.
        await store.releaseJob(ws, 'daily', DAY);
        expect(await store.claimJob(ws, 'daily', DAY, at(3), lease)).toBe(true);
      });

      test('concurrent takeovers of a stale claim: exactly one wins', async () => {
        const ws = newWorkspaceId();
        await store.claimJob(ws, 'daily', DAY, T0, lease);
        const results = await Promise.all(
          [1, 2, 3, 4].map(() =>
            store.claimJob(ws, 'daily', DAY, at(40), lease)
          )
        );
        expect(results.filter(Boolean)).toHaveLength(1);
      });
    });

    describe('audit', () => {
      test('appendAudit and listAudit (newest first, limited)', async () => {
        const ws = newWorkspaceId();
        const entries = [
          {
            workspaceId: ws,
            actorUserId: 'u-ana',
            action: 'milestone.target_date' as const,
            subjectId: 'm-alpha',
            before: '2026-10-28',
            after: '2026-11-04',
            at: '2026-10-21T08:00:00.000Z',
          },
          {
            workspaceId: ws,
            actorUserId: 'u-ana',
            action: 'settings.update' as const,
            subjectId: ws,
            before: { allocationMode: 'dry_run', tuning: { warnLeadDays: 7 } },
            after: { allocationMode: 'live', tuning: { warnLeadDays: 5 } },
            at: '2026-10-21T09:00:00.000Z',
          },
          {
            workspaceId: ws,
            actorUserId: 'u-bo',
            action: 'milestone.weight' as const,
            subjectId: 'm-beta',
            before: null,
            after: 3,
            at: '2026-10-21T09:00:00.000Z',
          },
        ];
        for (const item of entries) {
          await store.appendAudit(item);
        }
        const older = {
          workspaceId: ws,
          actorUserId: 'u-ana',
          action: 'project.lead' as const,
          subjectId: 'p-orion',
          after: ['u-ana'],
          at: '2026-10-20T08:00:00.000Z',
        };
        // undefined is stored (and returned) as JSON null.
        await store.appendAudit({ ...older, before: undefined });
        const listed = await store.listAudit(ws, 10);
        // Same instant: the later insert comes first.
        expect(listed).toEqual([
          entries[2],
          entries[1],
          entries[0],
          { ...older, before: null },
        ]);
        expect(listed[3]?.before).toBeNull();
        expect(await store.listAudit(ws, 2)).toEqual([entries[2], entries[1]]);
        expect(await store.listAudit(newWorkspaceId(), 10)).toEqual([]);
      });

      // A bulk issue edit (architecture §5, §7.3): every field change of
      // every issue in one statement, sharing one `at`.
      test('appendAuditEntries writes every entry in one statement, in order', async () => {
        const ws = newWorkspaceId();
        const at = '2026-10-21T10:00:00.000Z';
        let statements = 0;
        const counting: Sql = {
          query: (text, params) => sql.query(text, params),
          transaction: (fn) =>
            sql.transaction((tx) =>
              fn({
                ...tx,
                query: (text, params) => {
                  if (text.includes('audit_log')) statements += 1;
                  return tx.query(text, params);
                },
              })
            ),
          close: () => Promise.resolve(),
        };
        const bulk = createSqlStore(counting, {
          encryptionKey: TEST_KEY,
          now: () => clock,
        });
        const base = {
          workspaceId: ws,
          actorUserId: 'u-ana',
          at,
        };
        await bulk.appendAuditEntries([
          {
            ...base,
            action: 'issue.project',
            subjectId: 'iss-1',
            before: 'p-orion',
            after: 'p-vega',
          },
          {
            ...base,
            action: 'issue.project',
            subjectId: 'iss-2',
            before: null,
            after: 'p-vega',
          },
          {
            ...base,
            action: 'issue.milestone',
            subjectId: 'iss-1',
            before: 'm-alpha',
            after: 'm-\u0000beta',
          },
          {
            ...base,
            action: 'issue.milestone',
            subjectId: 'iss-2',
            before: undefined,
            after: 'm-beta',
          },
        ]);
        expect(statements).toBe(1);
        const listed = await store.listAudit(ws, 10);
        // Newest first; with one shared `at`, the last appended comes first.
        expect(listed.map((e) => [e.action, e.subjectId])).toEqual([
          ['issue.milestone', 'iss-2'],
          ['issue.milestone', 'iss-1'],
          ['issue.project', 'iss-2'],
          ['issue.project', 'iss-1'],
        ]);
        expect(listed.every((e) => e.at === at)).toBe(true);
        expect(listed.every((e) => e.actorUserId === 'u-ana')).toBe(true);
        // U+0000 is dropped; undefined is stored as JSON null.
        expect(listed[1]?.after).toBe('m-beta');
        expect(listed[0]?.before).toBeNull();
        expect(listed[2]?.before).toBeNull();
        expect(listed[3]).toEqual({
          ...base,
          action: 'issue.project',
          subjectId: 'iss-1',
          before: 'p-orion',
          after: 'p-vega',
        });
      });

      test('appendAuditEntries with no entries writes nothing', async () => {
        let statements = 0;
        const counting: Sql = {
          query: (text, params) => {
            statements += 1;
            return sql.query(text, params);
          },
          transaction: (fn) => {
            statements += 1;
            return sql.transaction(fn);
          },
          close: () => Promise.resolve(),
        };
        const bulk = createSqlStore(counting, {
          encryptionKey: TEST_KEY,
          now: () => clock,
        });
        await bulk.appendAuditEntries([]);
        expect(statements).toBe(0);
      });
    });

    describe('workspaces (several on one deployment)', () => {
      const OTHER_KEY = Buffer.alloc(32, 3).toString('base64');
      const REVOKED_AT = '2026-09-01T00:00:00.000Z';
      const NOW = '2026-10-21T08:00:00.000Z';
      // Expired at NOW, but in no era the global session-cleanup tests
      // above count (2019, 2020), so the suites can share one database.
      const EXPIRED = '2026-01-01T00:00:00.000Z';

      function newSession(
        workspaceId: string,
        suffix: string,
        extra: { workspaceName?: string; workspaceUrlKey?: string } = {}
      ) {
        return store.createSession({
          workspaceId,
          userId: `u-${suffix}`,
          userName: suffix,
          tokens: tokens(suffix),
          expiresAt: '2099-01-01T00:00:00.000Z',
          ...extra,
        });
      }

      // One row in every workspace-keyed table.
      async function seedWorkspace(ws: string): Promise<void> {
        await store.saveInstallation(installation(ws));
        await newSession(ws, 'seed');
        await store.saveSettings(settings(ws));
        await store.upsertMilestoneMeta(ws, {
          milestoneId: 'm-alpha',
          weight: 1,
          doneMeans: null,
          updatedAt: NOW,
          updatedBy: 'u-ana',
        });
        await store.replaceMirror(workspaceData(ws), NOW);
        await store.recordWebhookDelivery({
          deliveryId: crypto.randomUUID(),
          workspaceId: ws,
          type: 'Issue',
          action: 'update',
          entityId: 'iss-1',
          receivedAt: NOW,
        });
        const run = await store.startRun({
          workspaceId: ws,
          mode: 'dry_run',
          trigger: 'manual',
          startedByUserId: 'u-ana',
          now: NOW,
          staleAfterMinutes: 30,
        });
        if (run === null) throw new Error('run did not start');
        await store.appendRunEntries(run.id, [entry({})]);
        await store.saveWarningMemory(ws, [
          {
            subjectKind: 'milestone',
            subjectId: 'm-alpha',
            lastKey: 'at_risk:2026-10-28',
            lastNotifiedOn: DAY,
            occurrence: 1,
          },
        ]);
        await store.insertNotification({
          workspaceId: ws,
          day: DAY,
          recipientId: 'u-ana',
          channel: 'outbox',
          status: 'pending',
          digest: digest('u-ana', DAY),
          error: null,
          now: NOW,
        });
        await store.claimJob(ws, 'daily', DAY, NOW);
        await store.appendAudit({
          workspaceId: ws,
          actorUserId: 'u-ana',
          action: 'milestone.weight',
          subjectId: 'm-alpha',
          before: null,
          after: 1,
          at: NOW,
        });
        await store.pinAdmitted(`entry-${ws}`, ws, NOW);
      }

      // Tables with a workspace_id column a purge keeps on purpose.
      const KEPT_BY_PURGE: readonly string[] = ['admitted_workspaces'];

      // Every public table with a workspace_id column, from the catalog.
      async function workspaceKeyedTables(): Promise<string[]> {
        const rows = await sql.query<{ table_name: string }>(
          `SELECT c.table_name FROM information_schema.columns c
           JOIN information_schema.tables t
             ON t.table_schema = c.table_schema AND t.table_name = c.table_name
           WHERE c.table_schema = current_schema()
             AND c.column_name = 'workspace_id'
             AND t.table_type = 'BASE TABLE'
           ORDER BY c.table_name`
        );
        return rows.map((row) => row.table_name);
      }

      async function rowsFor(table: string, ws: string): Promise<number> {
        // table comes from the catalog query above, never from input.
        const rows = await sql.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table} WHERE workspace_id = $1`,
          [ws]
        );
        return Number(rows[0]?.n ?? 0);
      }

      test('revokeInstallation records the reason and wipes credentials with the blank sentinel', async () => {
        const ws = newWorkspaceId();
        const saved = installation(ws);
        await store.saveInstallation(saved);
        expect(await store.revokeInstallation(ws, 'uninstalled', NOW)).toBe(
          true
        );
        const revoked = await store.getInstallation(ws);
        expect(revoked).toEqual({
          ...saved,
          revokedAt: NOW,
          tokens: {
            accessToken: '',
            refreshToken: null,
            expiresAt: null,
            scopes: saved.tokens.scopes,
          },
          // updated_at keeps meaning the grant's last write.
          updatedAt: saved.updatedAt,
        });
        const raw = await sql.query<Record<string, unknown>>(
          `SELECT access_token_enc, refresh_token_enc, token_expires_at,
             revoked_reason
           FROM installations WHERE workspace_id = $1`,
          [ws]
        );
        expect(raw).toEqual([
          {
            access_token_enc: '',
            refresh_token_enc: null,
            token_expires_at: null,
            revoked_reason: 'uninstalled',
          },
        ]);
        // The wiped row still locks and reads (blank tokens, no decrypt).
        const seen = await store.withInstallationLock(ws, (current) =>
          Promise.resolve({ result: current.tokens.accessToken })
        );
        expect(seen).toBe('');

        // Idempotent; nothing to revoke without a row; reasons are checked.
        expect(await store.revokeInstallation(ws, 'uninstalled', NOW)).toBe(
          false
        );
        expect(
          await store.revokeInstallation(newWorkspaceId(), 'removed', NOW)
        ).toBe(false);
        const bad = await rejection(
          store.revokeInstallation(ws, 'gone' as 'removed', NOW)
        );
        expect(bad).toBeInstanceOf(TypeError);
      });

      test('updateInstallationIdentity follows a rename and changes nothing else', async () => {
        const ws = newWorkspaceId();
        const saved = installation(ws);
        await store.saveInstallation(saved);
        const renamed = { workspaceName: 'Acme Labs', urlKey: 'acme-labs' };
        expect(await store.updateInstallationIdentity(ws, renamed)).toBe(true);
        // updated_at keeps dating the grant's last write (the stale-revoke
        // guard compares with it); the tokens are untouched.
        expect(await store.getInstallation(ws)).toEqual({
          ...saved,
          ...renamed,
        });
        expect(await store.updateInstallationIdentity(ws, renamed)).toBe(false);
        expect(
          await store.updateInstallationIdentity(newWorkspaceId(), renamed)
        ).toBe(false);
        // A revoked row follows too, and stays revoked.
        await store.revokeInstallation(ws, 'uninstalled', NOW);
        expect(
          await store.updateInstallationIdentity(ws, {
            workspaceName: 'Acme',
            urlKey: 'acme',
          })
        ).toBe(true);
        expect(await store.getInstallation(ws)).toMatchObject({
          workspaceName: 'Acme',
          urlKey: 'acme',
          revokedAt: NOW,
        });
      });

      test('updateInstallationIdentity with readAt records the read, and an older read changes nothing', async () => {
        const ws = newWorkspaceId();
        await store.saveInstallation(installation(ws));
        // An install counts as a read at its updatedAt.
        const readAt = async (): Promise<string | null | undefined> => {
          const [described] = await store.describeSessions(
            [(await newSession(ws, `probe-${Math.random()}`)).token],
            NOW
          );
          return described?.urlKeyReadAt;
        };
        expect(await readAt()).toBe('2026-10-01T09:00:00.000Z');
        const later = '2026-10-21T07:00:00.000Z';
        const renamed = { workspaceName: 'Acme Labs', urlKey: 'acme-labs' };
        expect(
          await store.updateInstallationIdentity(ws, renamed, { readAt: later })
        ).toBe(true);
        expect(await readAt()).toBe(later);
        // The same values read again: the read is recorded, nothing changed.
        const latest = '2026-10-21T07:30:00.000Z';
        expect(
          await store.updateInstallationIdentity(ws, renamed, {
            readAt: latest,
          })
        ).toBe(false);
        expect(await readAt()).toBe(latest);
        // A read older than the recorded one (a slow sync that asked Linear
        // before a sign-in did) changes nothing.
        expect(
          await store.updateInstallationIdentity(
            ws,
            { workspaceName: 'Acme', urlKey: 'acme' },
            { readAt: later }
          )
        ).toBe(false);
        expect(await store.getInstallation(ws)).toMatchObject({
          ...renamed,
          updatedAt: '2026-10-01T09:00:00.000Z',
        });
        expect(await readAt()).toBe(latest);
        expect(
          await store.updateInstallationIdentity(newWorkspaceId(), renamed, {
            readAt: latest,
          })
        ).toBe(false);
      });

      test('recordUrlKeyCheck counts failed tries in a row and never moves the time back', async () => {
        const ws = newWorkspaceId();
        await store.saveInstallation(installation(ws));
        const summary = async () =>
          (await store.listWorkspaceStatus()).find(
            (row) => row.workspaceId === ws
          )?.installation;
        expect(await summary()).toMatchObject({ urlKeyCheckedAt: null });
        const at = (hour: string) => `2026-10-21T${hour}:00:00.000Z`;
        expect(
          await store.recordUrlKeyCheck(ws, { at: at('05'), ok: false })
        ).toBe(1);
        expect(
          await store.recordUrlKeyCheck(ws, { at: at('07'), ok: false })
        ).toBe(2);
        // An older time is not taken; the count still goes on.
        expect(
          await store.recordUrlKeyCheck(ws, { at: at('06'), ok: false })
        ).toBe(3);
        expect(await summary()).toMatchObject({
          urlKeyCheckedAt: at('07'),
          updatedAt: '2026-10-01T09:00:00.000Z',
          revokedAt: null,
        });
        // One that worked starts the count again.
        expect(
          await store.recordUrlKeyCheck(ws, { at: at('08'), ok: true })
        ).toBe(0);
        expect(
          await store.recordUrlKeyCheck(ws, { at: at('09'), ok: false })
        ).toBe(1);
        expect(await summary()).toMatchObject({ urlKeyCheckedAt: at('09') });
        expect(
          await store.recordUrlKeyCheck(newWorkspaceId(), {
            at: NOW,
            ok: false,
          })
        ).toBe(0);
      });

      test('revokeInstallation ignores stale revokes, upgrades grant_dead and never downgrades', async () => {
        const ws = newWorkspaceId();
        const saved = installation(ws);
        await store.saveInstallation(saved);
        // An event older than the installation's last write (a reinstall
        // or rotation since): ignored, nothing wiped.
        expect(
          await store.revokeInstallation(ws, 'uninstalled', NOW, {
            ifUpdatedBefore: '2026-09-30T23:59:59.999Z',
          })
        ).toBe(false);
        expect(await store.getInstallation(ws)).toEqual(saved);

        expect(
          await store.revokeInstallation(ws, 'grant_dead', REVOKED_AT)
        ).toBe(true);
        expect(await store.revokeInstallation(ws, 'grant_dead', NOW)).toBe(
          false
        );
        // The cause becomes known: grant_dead takes uninstalled, and the
        // grace restarts. The guard compares the grant's last write, which
        // the dead-grant revoke did not move.
        expect(
          await store.revokeInstallation(ws, 'uninstalled', NOW, {
            ifUpdatedBefore: saved.updatedAt,
          })
        ).toBe(true);
        for (const reason of ['grant_dead', 'removed'] as const) {
          expect(
            await store.revokeInstallation(
              ws,
              reason,
              '2026-10-22T00:00:00.000Z'
            )
          ).toBe(false);
        }
        const [status] = (await store.listWorkspaceStatus()).filter(
          (row) => row.workspaceId === ws
        );
        expect(status?.installation).toMatchObject({
          revokedAt: NOW,
          revokedReason: 'uninstalled',
        });
      });

      test('a reinstall clears the reason; older revokes record grant_dead', async () => {
        const ws = newWorkspaceId();
        await store.saveInstallation(installation(ws));
        await store.revokeInstallation(ws, 'removed', NOW);
        const reinstalled = {
          ...installation(ws),
          tokens: tokens('v2'),
          updatedAt: '2026-10-22T08:00:00.000Z',
        };
        await store.saveInstallation(reinstalled);
        expect(await store.getInstallation(ws)).toEqual(reinstalled);
        const reason = async (): Promise<unknown> =>
          (
            await sql.query<{ revoked_reason: string | null }>(
              'SELECT revoked_reason FROM installations WHERE workspace_id = $1',
              [ws]
            )
          )[0]?.revoked_reason;
        expect(await reason()).toBeNull();

        // The older revoke records an unknown cause and keeps the tokens
        // (its callers move to revokeInstallation).
        await store.markInstallationRevoked(ws, NOW);
        expect(await reason()).toBe('grant_dead');
        expect((await store.getInstallation(ws))?.tokens).toEqual(tokens('v2'));
        // Saved again while revoked: the recorded reason stays; a new row
        // saved revoked gets grant_dead.
        await store.revokeInstallation(ws, 'uninstalled', NOW);
        await store.saveInstallation({ ...installation(ws), revokedAt: NOW });
        expect(await reason()).toBe('uninstalled');
        const fresh = newWorkspaceId();
        await store.saveInstallation({
          ...installation(fresh),
          revokedAt: NOW,
        });
        const [row] = await sql.query<{ revoked_reason: string | null }>(
          'SELECT revoked_reason FROM installations WHERE workspace_id = $1',
          [fresh]
        );
        expect(row?.revoked_reason).toBe('grant_dead');
      });

      test('listWorkspaceStatus joins installations, sync state and sessions without decrypting', async () => {
        const installed = newWorkspaceId();
        const signedInOnly = newWorkspaceId();
        const unreadable = newWorkspaceId();
        await store.saveInstallation(installation(installed));
        await store.recordFullSync(installed, {
          at: NOW,
          ok: true,
          error: null,
          durationMs: 5000,
          issueCount: 4,
        });
        await newSession(installed, 'ana');
        await store.createSession({
          workspaceId: installed,
          userId: 'u-old',
          userName: 'old',
          tokens: tokens('old'),
          expiresAt: EXPIRED,
        });
        clock = new Date('2026-10-21T08:00:00.000Z');
        await newSession(signedInOnly, 'early', {
          workspaceName: 'Globex (old name)',
          workspaceUrlKey: 'globex-old',
        });
        clock = new Date('2026-10-21T09:00:00.000Z');
        await newSession(signedInOnly, 'late', {
          workspaceName: 'Globex',
          workspaceUrlKey: 'globex',
        });
        // Encrypted with another key: listInstallations could not read it.
        await createSqlStore(sql, {
          encryptionKey: OTHER_KEY,
        }).saveInstallation(installation(unreadable));
        try {
          expect(
            (await rejection(store.getInstallation(unreadable))).message
          ).toMatch(/decrypt/);
          const all = await store.listWorkspaceStatus();
          const ids = all.map((row) => row.workspaceId);
          const pick = (ws: string) => all.find((r) => r.workspaceId === ws);
          expect(pick(installed)).toEqual({
            workspaceId: installed,
            workspaceName: 'Acme Robotics',
            urlKey: 'acme',
            installation: {
              workspaceName: 'Acme Robotics',
              urlKey: 'acme',
              appUserId: 'app-user',
              installedByUserId: 'u-ana',
              createdAt: '2026-10-01T09:00:00.000Z',
              updatedAt: '2026-10-01T09:00:00.000Z',
              revokedAt: null,
              revokedReason: null,
              urlKeyCheckedAt: null,
            },
            sync: {
              workspaceId: installed,
              version: 0,
              lastFullSyncAt: NOW,
              lastFullSyncStatus: 'ok',
              lastFullSyncError: null,
              lastWebhookAt: null,
              consecutiveFailures: 0,
              lastFullSyncMs: 5000,
              lastSuccessAt: NOW,
              mirrorIssueCount: 4,
              lastFullSyncStartedAt: null,
            },
            sessionCount: 2,
          });
          expect(pick(signedInOnly)).toEqual({
            workspaceId: signedInOnly,
            workspaceName: 'Globex',
            urlKey: 'globex',
            installation: null,
            sync: null,
            sessionCount: 2,
          });
          expect(pick(unreadable)?.installation?.workspaceName).toBe(
            'Acme Robotics'
          );
          // Never attempted first.
          expect(ids.indexOf(signedInOnly)).toBeLessThan(
            ids.indexOf(installed)
          );
          // With `now`, only unexpired sessions count.
          const live = await store.listWorkspaceStatus(NOW);
          expect(
            live.find((r) => r.workspaceId === installed)?.sessionCount
          ).toBe(1);
          expect(JSON.stringify(all)).not.toContain('lin_oauth');
        } finally {
          await sql.query('DELETE FROM installations WHERE workspace_id = $1', [
            unreadable,
          ]);
        }
      });

      test('listWorkspaceStatus orders by the later of an attempt start and finish', async () => {
        // In a shared database other tests' workspaces sort among these,
        // so only the relative order of these three is checked. `stuck`
        // finished long ago but started an attempt last (killed since);
        // `finished` finished after `older` did.
        const older = newWorkspaceId();
        const finished = newWorkspaceId();
        const stuck = newWorkspaceId();
        for (const ws of [older, finished, stuck]) {
          await store.saveInstallation(installation(ws));
        }
        const done = (ws: string, at: string) =>
          store.recordFullSync(ws, { at, ok: true, error: null });
        await done(stuck, '2026-10-20T05:00:00.000Z');
        await done(older, '2026-10-20T06:00:00.000Z');
        await done(finished, '2026-10-20T07:00:00.000Z');
        await store.recordFullSyncStart(stuck, '2026-10-20T07:30:00.000Z');
        const ids = (await store.listWorkspaceStatus())
          .map((row) => row.workspaceId)
          .filter((id) => id === older || id === finished || id === stuck);
        expect(ids).toEqual([older, finished, stuck]);
      });

      test('describeSessions describes held tokens in one statement, without credentials', async () => {
        // Every session below signs in at NOW.
        clock = new Date(NOW);
        const acme = newWorkspaceId();
        const globex = newWorkspaceId();
        await store.saveInstallation(installation(acme));
        await store.revokeInstallation(acme, 'uninstalled', NOW);
        await store.replaceMirror(workspaceData(acme), NOW);
        const [ana] = workspaceData(acme).users;
        if (ana === undefined) throw new Error('fixture has users');
        await store.applyMirrorChanges(acme, {
          upsert: [
            {
              kind: 'user',
              entity: { ...ana, id: 'u-guest', name: 'Gus', guest: true },
            },
          ],
          remove: [],
        });
        // u-ana's mirror row has no guest field (read as not a guest);
        // u-nobody has no mirror row at all.
        // Signed in before a rename: the installation (refreshed by every
        // sync and sign-in) wins over the session's sign-in values.
        const member = await newSession(acme, 'ana', {
          workspaceName: 'Acme (signed in)',
          workspaceUrlKey: 'acme-at-sign-in',
        });
        const guest = await newSession(acme, 'guest');
        const unknown = await newSession(acme, 'nobody');
        const elsewhere = await newSession(globex, 'ana', {
          workspaceName: 'Globex',
          workspaceUrlKey: 'globex',
        });
        const expired = await store.createSession({
          workspaceId: acme,
          userId: 'u-ana',
          userName: 'ana',
          tokens: tokens('expired'),
          expiresAt: EXPIRED,
        });

        const statements: string[] = [];
        const watched = createSqlStore(recordingSql(sql, statements), {
          encryptionKey: TEST_KEY,
          now: () => clock,
        });
        const described = await watched.describeSessions(
          [
            elsewhere.token,
            member.token,
            'not-a-session',
            guest.token,
            expired.token,
            unknown.token,
          ],
          NOW
        );
        expect(statements).toHaveLength(1);
        expect(statements[0]).not.toMatch(/token_enc|token_scopes/);
        const common = {
          expiresAt: '2099-01-01T00:00:00.000Z',
          installed: true,
          revokedAt: NOW,
          revokedReason: 'uninstalled' as const,
          workspaceId: acme,
          workspaceUrlKey: 'acme',
          // Signed in after the install read the installation's key.
          signedInAt: NOW,
          urlKeyReadAt: '2026-10-01T09:00:00.000Z',
        };
        expect(described).toEqual([
          {
            token: elsewhere.token,
            workspaceId: globex,
            workspaceName: 'Globex',
            workspaceUrlKey: 'globex',
            signInUrlKey: 'globex',
            signedInAt: NOW,
            urlKeyReadAt: null,
            userId: 'u-ana',
            userName: 'ana',
            expiresAt: '2099-01-01T00:00:00.000Z',
            guest: null,
            installed: false,
            revokedAt: null,
            revokedReason: null,
          },
          {
            ...common,
            token: member.token,
            workspaceName: 'Acme Robotics',
            // Admission also matches the key it signed in under.
            signInUrlKey: 'acme-at-sign-in',
            userId: 'u-ana',
            userName: 'ana',
            guest: false,
          },
          null,
          {
            ...common,
            token: guest.token,
            workspaceName: 'Acme Robotics',
            signInUrlKey: null,
            userId: 'u-guest',
            userName: 'guest',
            guest: true,
          },
          null,
          {
            ...common,
            token: unknown.token,
            workspaceName: 'Acme Robotics',
            signInUrlKey: null,
            userId: 'u-nobody',
            userName: 'nobody',
            guest: null,
          },
        ]);
        const dump = JSON.stringify(described);
        expect(dump).not.toContain('lin_oauth');
        expect(dump).not.toContain('v1:');

        statements.length = 0;
        expect(await watched.describeSessions([], NOW)).toEqual([]);
        expect(statements).toEqual([]);
      });

      test('takeSessionsForWorkspace takes one workspace, oldest first, with createdBefore and limit', async () => {
        const ws = newWorkspaceId();
        const other = newWorkspaceId();
        const at = (time: string) => {
          clock = new Date(time);
        };
        at('2026-10-21T08:00:00.000Z');
        const first = await newSession(ws, 'first');
        at('2026-10-21T09:00:00.000Z');
        const second = await newSession(ws, 'second');
        at('2026-10-21T10:00:00.000Z');
        const third = await newSession(ws, 'third');
        const kept = await newSession(other, 'kept');
        const cutoff = '2026-10-21T09:30:00.000Z';

        expect(
          await store.takeSessionsForWorkspace(ws, {
            createdBefore: cutoff,
            limit: 1,
          })
        ).toEqual([first.session]);
        const next = await store.takeSessionsForWorkspace(ws, {
          createdBefore: cutoff,
          limit: 10,
        });
        expect(next).toEqual([second.session]);
        expect(next[0]?.tokens?.refreshToken).toBe('lin_oauth_refresh_second');
        expect(
          await store.takeSessionsForWorkspace(ws, {
            createdBefore: cutoff,
            limit: 10,
          })
        ).toEqual([]);
        expect(await store.takeSessionsForWorkspace(ws, { limit: 10 })).toEqual(
          [third.session]
        );
        expect(await store.getSession(kept.token, NOW)).toEqual(kept.session);

        // A row encrypted with another key is deleted all the same and
        // reported without tokens.
        const foreign = await createSqlStore(sql, {
          encryptionKey: OTHER_KEY,
        }).createSession({
          workspaceId: ws,
          userId: 'u-old-key',
          userName: 'old key',
          tokens: tokens('old-key'),
          expiresAt: '2099-01-01T00:00:00.000Z',
        });
        const taken = await store.takeSessionsForWorkspace(ws, { limit: 10 });
        expect(taken).toEqual([{ ...foreign.session, tokens: null }]);
        expect(await rowsFor('sessions', ws)).toBe(0);
        await store.deleteSession(kept.token);
      });

      test('takeSessionsForWorkspace with purgeDueBefore takes only while a purge is due', async () => {
        const due = newWorkspaceId();
        const grace = newWorkspaceId();
        const dead = newWorkspaceId();
        const never = newWorkspaceId();
        const cutoff = '2026-09-21T08:00:00.000Z';
        for (const ws of [due, grace, dead]) {
          await store.saveInstallation(installation(ws));
        }
        await store.revokeInstallation(
          due,
          'uninstalled',
          '2026-09-01T00:00:00.000Z'
        );
        await store.revokeInstallation(
          grace,
          'removed',
          '2026-10-01T00:00:00.000Z'
        );
        await store.revokeInstallation(
          dead,
          'grant_dead',
          '2026-09-01T00:00:00.000Z'
        );
        for (const ws of [due, grace, dead, never]) {
          await newSession(ws, 'a');
          await newSession(ws, 'b');
        }
        const take = (ws: string) =>
          store.takeSessionsForWorkspace(ws, {
            limit: 1,
            purgeDueBefore: cutoff,
          });
        expect(await take(due)).toHaveLength(1);
        // Revoked too recently, revoked as grant_dead, never installed.
        for (const ws of [grace, dead, never]) {
          expect(await take(ws)).toEqual([]);
          expect(await rowsFor('sessions', ws)).toBe(2);
        }
        // A reinstall since: nothing is taken any more.
        await store.saveInstallation(installation(due));
        expect(await take(due)).toEqual([]);
        expect(await rowsFor('sessions', due)).toBe(1);
        for (const ws of [due, grace, dead, never]) {
          await store.takeSessionsForWorkspace(ws, { limit: 10 });
        }
      });

      test('takeSessionsForWorkspace waits for a refresh in flight and takes its rotated tokens', async () => {
        const ws = newWorkspaceId();
        const held = await newSession(ws, 'held');
        let release = (): void => undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let entered = (): void => undefined;
        const inside = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const rotated = tokens('rotated');
        const refreshing = store.withSessionLock(held.session.id, async () => {
          entered();
          await gate;
          return { result: null, tokens: rotated };
        });
        await inside;
        const taking = store.takeSessionsForWorkspace(ws, { limit: 10 });
        expect(await settlesWithin(taking, 150)).toBe(false);
        release();
        await refreshing;
        expect(await taking).toEqual([{ ...held.session, tokens: rotated }]);
      });

      test('purgeWorkspace deletes the workspace from every table with a workspace_id column', async () => {
        const ws = newWorkspaceId();
        const neighbour = newWorkspaceId();
        await seedWorkspace(ws);
        await seedWorkspace(neighbour);
        await store.blockWorkspace(ws, 'id', 'abuse', NOW);
        await store.revokeInstallation(ws, 'uninstalled', REVOKED_AT);
        try {
          const tables = await workspaceKeyedTables();
          // Every such table holds a row for the workspace before.
          for (const table of tables) {
            expect({ table, seeded: (await rowsFor(table, ws)) > 0 }).toEqual({
              table,
              seeded: true,
            });
          }

          const result = await store.purgeWorkspace(ws, {
            revokedBefore: NOW,
          });
          if (!result.purged) throw new Error(`refused: ${result.reason}`);
          // A table with a workspace_id column that the purge does not
          // know fails here. The LINEAR_WORKSPACES pins are kept on purpose
          // (a pinned entry must never admit another org after a purge).
          const purgedTables = tables.filter(
            (table) => !KEPT_BY_PURGE.includes(table)
          );
          expect(Object.keys(result.counts).toSorted()).toEqual(purgedTables);
          // The deleted sessions come back with their tokens, for the
          // caller to revoke once the purge committed.
          expect(result.sessions).toEqual([
            expect.objectContaining({
              workspaceId: ws,
              userId: 'u-seed',
              tokens: tokens('seed'),
            }),
          ]);
          for (const table of purgedTables) {
            expect({
              table,
              counted: result.counts[table as keyof typeof result.counts] > 0,
              left: await rowsFor(table, ws),
            }).toEqual({ table, counted: true, left: 0 });
          }
          expect(result.counts.mirror_entities).toBe(
            flattenedCount(workspaceData(ws))
          );
          expect(await store.getAdmittedPin(`entry-${ws}`)).toBe(ws);
          // The neighbour is untouched, and the block outlives the purge.
          for (const table of tables) {
            expect({
              table,
              kept: (await rowsFor(table, neighbour)) > 0,
            }).toEqual({ table, kept: true });
          }
          expect(
            (await store.listBlockedWorkspaces()).some((b) => b.key === ws)
          ).toBe(true);
          expect(await store.getInstallation(ws)).toBeNull();
          expect(
            await store.purgeWorkspace(ws, { revokedBefore: NOW })
          ).toEqual({ purged: false, reason: 'not_installed' });
        } finally {
          await store.unblockWorkspace(ws);
        }
      });

      test('purgeWorkspace refuses a workspace not revoked, revoked too recently, or grant_dead', async () => {
        const ws = newWorkspaceId();
        await seedWorkspace(ws);
        const refusal = (options: {
          revokedBefore: string;
          allowGrantDead?: boolean;
        }) => store.purgeWorkspace(ws, options);

        expect(await refusal({ revokedBefore: NOW })).toEqual({
          purged: false,
          reason: 'not_revoked',
        });
        await store.revokeInstallation(ws, 'grant_dead', REVOKED_AT);
        expect(await refusal({ revokedBefore: NOW })).toEqual({
          purged: false,
          reason: 'grant_dead',
        });
        expect(
          await refusal({ revokedBefore: REVOKED_AT, allowGrantDead: true })
        ).toEqual({ purged: false, reason: 'too_recent' });
        await store.revokeInstallation(ws, 'removed', REVOKED_AT);
        expect(await refusal({ revokedBefore: REVOKED_AT })).toEqual({
          purged: false,
          reason: 'too_recent',
        });
        // Nothing was deleted by the refusals.
        expect(await rowsFor('sessions', ws)).toBe(1);
        expect(await rowsFor('audit_log', ws)).toBe(1);

        // The operator's purge may take a grant_dead workspace.
        const dead = newWorkspaceId();
        await seedWorkspace(dead);
        await store.revokeInstallation(dead, 'grant_dead', REVOKED_AT);
        const purged = await store.purgeWorkspace(dead, {
          revokedBefore: NOW,
          allowGrantDead: true,
        });
        expect(purged.purged).toBe(true);
        expect(await store.getInstallation(dead)).toBeNull();
        const removed = await refusal({ revokedBefore: NOW });
        expect(removed.purged).toBe(true);
      });

      test('purgeWorkspace waits for a reinstall in flight, then sees it and refuses', async () => {
        const ws = newWorkspaceId();
        await seedWorkspace(ws);
        await store.revokeInstallation(ws, 'uninstalled', REVOKED_AT);
        let release = (): void => undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let entered = (): void => undefined;
        const inside = new Promise<void>((resolve) => {
          entered = resolve;
        });
        // A reinstall holding the installation row, not yet committed.
        const reinstalling = sql.transaction(async (tx) => {
          await tx.query(
            `UPDATE installations SET revoked_at = NULL, revoked_reason = NULL
             WHERE workspace_id = $1`,
            [ws]
          );
          entered();
          await gate;
        });
        await inside;
        const purging = store.purgeWorkspace(ws, { revokedBefore: NOW });
        expect(await settlesWithin(purging, 150)).toBe(false);
        release();
        await reinstalling;
        expect(await purging).toEqual({
          purged: false,
          reason: 'not_revoked',
        });
        expect(await rowsFor('sessions', ws)).toBe(1);
      });

      test('purgeWorkspace waits for a refresh in flight and returns the tokens it committed', async () => {
        const ws = newWorkspaceId();
        await store.saveInstallation(installation(ws));
        await store.revokeInstallation(ws, 'removed', REVOKED_AT);
        const held = await newSession(ws, 'held');
        let release = (): void => undefined;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        let entered = (): void => undefined;
        const inside = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const rotated = tokens('rotated');
        const refreshing = store.withSessionLock(held.session.id, async () => {
          entered();
          await gate;
          return { result: null, tokens: rotated };
        });
        await inside;
        const purging = store.purgeWorkspace(ws, { revokedBefore: NOW });
        expect(await settlesWithin(purging, 150)).toBe(false);
        release();
        await refreshing;
        const purged = await purging;
        if (!purged.purged) throw new Error(`refused: ${purged.reason}`);
        expect(purged.sessions).toEqual([{ ...held.session, tokens: rotated }]);
        expect(purged.counts.sessions).toBe(1);
      });

      test('purgeWorkspace and a concurrent reinstall never deadlock', async () => {
        for (let round = 0; round < 4; round += 1) {
          const ws = newWorkspaceId();
          await seedWorkspace(ws);
          await store.revokeInstallation(ws, 'removed', REVOKED_AT);
          const reinstall = {
            ...installation(ws),
            tokens: tokens(`again-${round}`),
            updatedAt: NOW,
          };
          const [purge] = await Promise.all([
            store.purgeWorkspace(ws, { revokedBefore: NOW }),
            store.saveInstallation(reinstall),
          ]);
          // Either order ends with the reinstalled, active installation:
          // purged first (the reinstall inserted a fresh row), or
          // reinstalled first (the purge saw it and refused).
          expect(await store.getInstallation(ws)).toEqual(reinstall);
          if (purge.purged) {
            expect(await rowsFor('sessions', ws)).toBe(0);
          } else {
            expect(purge.reason).toBe('not_revoked');
            expect(await rowsFor('sessions', ws)).toBe(1);
          }
        }
      });

      test('pruneNotifications and pruneJobClaims delete old rows in bounded batches', async () => {
        const ws = newWorkspaceId();
        const days = ['2001-01-01', '2001-01-02', '2001-01-03', '2026-10-21'];
        for (const day of days) {
          const at = `${day}T08:00:00.000Z`;
          await store.insertNotification({
            workspaceId: ws,
            day,
            recipientId: 'u-ana',
            channel: 'outbox',
            status: 'sent',
            digest: digest('u-ana', day),
            error: null,
            now: at,
          });
          await store.claimJob(ws, 'daily', day, at);
        }
        const before = '2001-06-01T00:00:00.000Z';
        for (const prune of [
          (limit: number) => store.pruneNotifications(before, limit),
          (limit: number) => store.pruneJobClaims(before, limit),
        ]) {
          // At least three rows qualify, so a batch of two takes exactly two.
          expect(await prune(2)).toBe(2);
          let more = await prune(2);
          while (more > 0) more = await prune(2);
          expect(await prune(Number.NaN)).toBe(0);
        }
        expect(
          (await store.listNotifications(ws, { limit: 10 })).map((n) => n.day)
        ).toEqual(['2026-10-21']);
        const claims = await sql.query<{ day: string }>(
          `SELECT to_char(day, 'YYYY-MM-DD') AS day FROM job_claims
           WHERE workspace_id = $1`,
          [ws]
        );
        expect(claims).toEqual([{ day: '2026-10-21' }]);
      });

      test('blocks are lower-cased, pinned from a URL key to the org id, and removed', async () => {
        const urlKey = uniqueKey('Acme');
        const orgId = uniqueKey('Org');
        const mine = async () =>
          (await store.listBlockedWorkspaces()).filter((block) =>
            [urlKey.toLowerCase(), orgId.toLowerCase()].includes(block.key)
          );
        await store.blockWorkspace(urlKey, 'url_key', 'spam', NOW);
        await store.blockWorkspace(
          urlKey.toUpperCase(),
          'url_key',
          'abuse lin_api_TESTKEY_member_q7Wz3Kp9Vx2Lm8Rt5Yb1Nc',
          '2026-10-22T00:00:00.000Z'
        );
        expect(await mine()).toEqual([
          {
            key: urlKey.toLowerCase(),
            kind: 'url_key',
            reason: 'abuse lin_api_[redacted]',
            createdAt: NOW,
            urlKey: null,
          },
        ]);
        expect(await store.pinBlockedUrlKey(urlKey.toUpperCase(), orgId)).toBe(
          true
        );
        // The id block remembers the URL key it was pinned from, so an
        // unblock by that key still finds it.
        expect(await mine()).toEqual([
          {
            key: orgId.toLowerCase(),
            kind: 'id',
            reason: 'abuse lin_api_[redacted]',
            createdAt: NOW,
            urlKey: urlKey.toLowerCase(),
          },
        ]);
        expect(await store.pinBlockedUrlKey(urlKey, orgId)).toBe(false);
        expect(await store.unblockWorkspace(orgId.toUpperCase())).toBe(true);
        expect(await store.unblockWorkspace(orgId)).toBe(false);
        expect(await mine()).toEqual([]);

        // The org already has an id block: it is kept (taking the URL key
        // it lacked), the URL-key row goes.
        await store.blockWorkspace(orgId, 'id', 'by id', NOW);
        await store.blockWorkspace(urlKey, 'url_key', 'by key', NOW);
        expect(await store.pinBlockedUrlKey(urlKey, orgId)).toBe(true);
        expect(await mine()).toEqual([
          {
            key: orgId.toLowerCase(),
            kind: 'id',
            reason: 'by id',
            createdAt: NOW,
            urlKey: urlKey.toLowerCase(),
          },
        ]);
        await store.unblockWorkspace(orgId);

        // An id block records the URL key it was made under; blocking it
        // again without one keeps it.
        await store.blockWorkspace(orgId, 'id', 'one', NOW, {
          urlKey: urlKey.toUpperCase(),
        });
        await store.blockWorkspace(orgId, 'id', 'two', NOW);
        expect(await mine()).toEqual([
          {
            key: orgId.toLowerCase(),
            kind: 'id',
            reason: 'two',
            createdAt: NOW,
            urlKey: urlKey.toLowerCase(),
          },
        ]);
        await store.unblockWorkspace(orgId);

        const bad = await rejection(
          store.blockWorkspace(urlKey, 'name' as 'id', null, NOW)
        );
        expect(bad).toBeInstanceOf(TypeError);
      });

      test('deleteAdmittedPin removes a pin and says which workspace it named', async () => {
        const entry = `unpin-${newWorkspaceId()}`;
        expect(await store.pinAdmitted(entry, 'org-1', NOW)).toBe('org-1');
        expect(await store.deleteAdmittedPin(entry.toUpperCase())).toBe(
          'org-1'
        );
        expect(await store.getAdmittedPin(entry)).toBeNull();
        expect(await store.deleteAdmittedPin(entry)).toBeNull();
        // Free again: the next pin wins.
        expect(await store.pinAdmitted(entry, 'org-2', NOW)).toBe('org-2');
        await store.deleteAdmittedPin(entry);
      });

      test('admission pins: the first pin of an entry wins', async () => {
        const entry = uniqueKey('Acme');
        expect(await store.getAdmittedPin(entry)).toBeNull();
        expect(await store.pinAdmitted(entry.toUpperCase(), 'org-1', NOW)).toBe(
          'org-1'
        );
        expect(await store.pinAdmitted(entry, 'org-2', NOW)).toBe('org-1');
        expect(await store.getAdmittedPin(entry.toUpperCase())).toBe('org-1');

        const raced = uniqueKey('Globex');
        const winners = await Promise.all(
          ['org-a', 'org-b', 'org-c', 'org-d'].map((id) =>
            store.pinAdmitted(raced, id, NOW)
          )
        );
        expect(new Set(winners).size).toBe(1);
        expect(await store.getAdmittedPin(raced)).toBe(winners[0] ?? null);
      });
    });
  });
}

// Mirror rows replaceMirror writes for a workspace (one per entity).
function flattenedCount(data: ReturnType<typeof workspaceData>): number {
  return (
    data.users.length +
    data.teams.length +
    data.states.length +
    data.initiatives.length +
    data.projects.length +
    data.milestones.length +
    data.issues.length +
    data.relations.length
  );
}

storeSuite('Store on PGlite (in-memory)', () => openPgliteSql());

describe.skipIf(!HAS_POSTGRES)(
  'Store on node-postgres (TEST_DATABASE_URL)',
  () => {
    storeSuite('suite', () => openPgSql(DATABASE_URL ?? ''));
  }
);

// The locking tests (concurrent refreshers, mirror writers, run starts)
// again, on a URL asking for sessions stricter than Postgres' READ
// COMMITTED default (the store's own startup option still wins).
describe.skipIf(!HAS_POSTGRES)(
  'Store on node-postgres, URL asking for repeatable read',
  () => {
    storeSuite('suite', () => openPgSql(repeatableReadUrl(DATABASE_URL ?? '')));
  }
);

// And once more where that startup option was lost (a transaction-mode
// pooler drops it): plain statements really run at REPEATABLE READ, so
// every write must pin its own level.
describe.skipIf(!HAS_POSTGRES)(
  'Store on node-postgres, sessions at repeatable read (startup option dropped)',
  () => {
    storeSuite('suite', () => repeatableReadSessionSql(DATABASE_URL ?? ''));
  }
);

describe('Store without a database', () => {
  test('ping is false when the database is unreachable', async () => {
    const unreachable: Sql = {
      query: () => Promise.reject(new Error('ECONNREFUSED')),
      transaction: () => Promise.reject(new Error('ECONNREFUSED')),
      close: () => Promise.resolve(),
    };
    const store = createSqlStore(unreachable, { encryptionKey: TEST_KEY });
    expect(await store.ping()).toBe(false);
  });

  test('createSqlStore rejects a malformed key', () => {
    const sql: Sql = {
      query: () => Promise.resolve([]),
      transaction: () => Promise.reject(new Error('unused')),
      close: () => Promise.resolve(),
    };
    expect(() => createSqlStore(sql, { encryptionKey: 'c2hvcnQ=' })).toThrow(
      /exactly 32 bytes/
    );
  });
});
