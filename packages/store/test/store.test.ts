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
  });
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
