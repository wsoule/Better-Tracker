// The credential-free store (LINEAR_AUTH=api_key, architecture §5) and the
// planner-owned scrub (every mode): PGlite always, and Postgres when
// TEST_DATABASE_URL is set. A credential-free store refuses every Linear
// token and never decrypts one; planner-owned and error text is stored
// with credential-shaped runs redacted; the mirror round-trips untouched.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { openPgliteSql, openPgSql, type Sql } from '../src/db';
import { StoreCredentialError } from '../src/errors';
import { createSqlStore } from '../src/store';
import type { Installation, Store, StoredTokens } from '../src/types';
import {
  installation,
  newWorkspaceId,
  rejection,
  TEST_KEY,
  tokens,
  workspaceData,
} from './fixtures';

const STARTUP_TIMEOUT = 60_000;
const DATABASE_URL = process.env.TEST_DATABASE_URL;
const HAS_POSTGRES = DATABASE_URL !== undefined && DATABASE_URL !== '';

/** An obviously fake personal API key (never a real secret). */
const KEY = 'lin_api_TESTKEY_member_q7Wz3Kp9Vx2Lm8Rt5Yb1Nc';
const AT = '2026-10-21T08:00:00.000Z';

const BLANK: StoredTokens = {
  accessToken: '',
  refreshToken: null,
  expiresAt: null,
  scopes: [],
};

function binding(workspaceId: string): Installation {
  return {
    ...installation(workspaceId),
    appUserId: '',
    tokens: { ...BLANK, scopes: [] },
  };
}

function credentialFreeSuite(label: string, open: () => Promise<Sql>): void {
  describe(label, () => {
    let sql: Sql;
    let keyed: Store;
    let free: Store;
    const clock = (): Date => new Date(AT);

    beforeAll(async () => {
      sql = await open();
      keyed = createSqlStore(sql, { encryptionKey: TEST_KEY, now: clock });
      await keyed.migrate();
      free = createSqlStore(sql, { encryptionKey: null, now: clock });
    }, STARTUP_TIMEOUT);

    afterAll(async () => {
      await sql.close();
    });

    // One column of one row as text, straight from SQL.
    async function rawText(query: string, params: string[]): Promise<string> {
      const rows = await sql.query<{ value: string | null }>(query, params);
      return rows.map((row) => row.value ?? '').join('\n');
    }

    test('blank tokens round-trip; any token is refused without its value', async () => {
      const ws = newWorkspaceId();
      await free.saveInstallation(binding(ws));
      const saved = await free.getInstallation(ws);
      expect(saved?.tokens).toEqual({ ...BLANK, scopes: [] });
      expect(saved?.appUserId).toBe('');

      const refused: StoredTokens[] = [
        { ...BLANK, accessToken: KEY },
        { ...BLANK, refreshToken: KEY },
      ];
      for (const bad of refused) {
        const error = await rejection(
          free.saveInstallation({ ...binding(ws), tokens: bad })
        );
        expect(error).toBeInstanceOf(StoreCredentialError);
        const message = error instanceof Error ? error.message : '';
        expect(message).toBe(
          'This store keeps no Linear credentials (LINEAR_AUTH=api_key).'
        );
        expect(message).not.toContain('TESTKEY');
      }
      const session = await rejection(
        free.createSession({
          workspaceId: ws,
          userId: 'u-ana',
          userName: 'Ana',
          tokens: { ...BLANK, accessToken: KEY },
          expiresAt: '2099-01-01T00:00:00.000Z',
        })
      );
      expect(session).toBeInstanceOf(StoreCredentialError);
    });

    test('adopting an OAuth row blanks its tokens and app user', async () => {
      const ws = newWorkspaceId();
      await keyed.saveInstallation(installation(ws));
      await free.saveInstallation(binding(ws));
      const rows = await sql.query<{
        access_token_enc: string;
        refresh_token_enc: string | null;
        app_user_id: string;
      }>(
        `SELECT access_token_enc, refresh_token_enc, app_user_id
         FROM installations WHERE workspace_id = $1`,
        [ws]
      );
      expect(rows).toEqual([
        { access_token_enc: '', refresh_token_enc: null, app_user_id: '' },
      ]);
      // A keyed store reads the blank access token back as '' too.
      expect((await keyed.getInstallation(ws))?.tokens.accessToken).toBe('');
    });

    test("a keyed store's encrypted rows read back blank and stay in place", async () => {
      const ws = newWorkspaceId();
      await keyed.saveInstallation(installation(ws));
      const created = await keyed.createSession({
        workspaceId: ws,
        userId: 'u-ana',
        userName: 'Ana',
        tokens: tokens('session-row'),
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
      const readFree = await free.getInstallation(ws);
      expect(readFree?.tokens.accessToken).toBe('');
      expect(readFree?.tokens.refreshToken).toBeNull();
      const session = await free.getSession(created.token, AT);
      expect(session?.tokens.accessToken).toBe('');
      expect(session?.tokens.refreshToken).toBeNull();
      // Nothing was purged: the keyed store still decrypts both.
      expect((await keyed.getInstallation(ws))?.tokens.accessToken).toBe(
        tokens('install').accessToken
      );
      expect(
        (await keyed.getSession(created.token, AT))?.tokens.accessToken
      ).toBe(tokens('session-row').accessToken);
    });

    test('planner-owned and error text is stored redacted', async () => {
      const ws = newWorkspaceId();
      await free.saveSettings({
        workspaceId: ws,
        watcherUserIds: [KEY],
        allocationMode: 'dry_run',
        warningsMode: 'preview',
        timezone: 'UTC',
        tuning: {
          warnLeadDays: 7,
          paceWindowDays: 7,
          stallDays: 7,
          overdueRepeatDays: 1,
          newBadgeDays: 7,
          activeProjectStatuses: ['started'],
          timelineDaysBack: 14,
          timelineDaysAhead: 70,
        },
      });
      await free.upsertMilestoneMeta(ws, {
        milestoneId: 'm-alpha',
        weight: 2,
        doneMeans: `done means ${KEY}`,
        updatedAt: AT,
        updatedBy: 'u-ana',
      });
      await free.updateMilestoneMetaField(
        ws,
        'm-beta',
        'doneMeans',
        `again ${KEY}`,
        'u-ana',
        AT
      );
      await free.recordFullSync(ws, { at: AT, ok: false, error: `x ${KEY}` });
      const run = await free.startRun({
        workspaceId: ws,
        mode: 'dry_run',
        trigger: 'manual',
        startedByUserId: 'u-ana',
        now: AT,
        staleAfterMinutes: 30,
      });
      if (run === null) throw new Error('run did not start');
      await free.appendRunEntries(run.id, [
        {
          action: 'assign',
          outcome: 'failed',
          projectId: 'p-orion',
          milestoneId: 'm-alpha',
          issueId: 'iss-1',
          issueIdentifier: 'ENG-1',
          assigneeId: 'u-ana',
          reason: null,
          detail: { note: `detail ${KEY}` },
          error: `error ${KEY}`,
        },
      ]);
      await free.finishRun(run.id, {
        status: 'failed',
        summary: {
          assigned: 0,
          wouldAssign: 0,
          failed: 1,
          blockedProjects: 0,
          skippedIssues: 0,
        },
        error: `run ${KEY}`,
        now: AT,
      });
      await free.appendAudit({
        workspaceId: ws,
        actorUserId: 'u-ana',
        action: 'milestone.done_means',
        subjectId: 'm-alpha',
        before: { text: `before ${KEY}` },
        after: `after ${KEY}`,
        at: AT,
      });
      await free.appendAuditEntries([
        {
          workspaceId: ws,
          actorUserId: 'u-ana',
          action: 'settings.update',
          subjectId: ws,
          before: null,
          after: { list: [`bulk ${KEY}`] },
          at: AT,
        },
      ]);

      const text = [
        await rawText(
          'SELECT data::text AS value FROM settings WHERE workspace_id = $1',
          [ws]
        ),
        await rawText(
          'SELECT done_means AS value FROM milestone_meta WHERE workspace_id = $1',
          [ws]
        ),
        await rawText(
          'SELECT last_full_sync_error AS value FROM sync_state WHERE workspace_id = $1',
          [ws]
        ),
        await rawText(
          `SELECT detail::text || ' ' || coalesce(error, '') AS value
           FROM allocation_entries WHERE workspace_id = $1`,
          [ws]
        ),
        await rawText(
          `SELECT summary::text || ' ' || coalesce(error, '') AS value
           FROM allocation_runs WHERE workspace_id = $1`,
          [ws]
        ),
        await rawText(
          `SELECT before_value::text || ' ' || after_value::text AS value
           FROM audit_log WHERE workspace_id = $1`,
          [ws]
        ),
      ].join('\n');
      expect(text).not.toContain('TESTKEY');
      expect(
        text.split('lin_api_[redacted]').length - 1
      ).toBeGreaterThanOrEqual(10);
    });

    test('the mirror round-trips byte for byte, credential-shaped text included', async () => {
      const ws = newWorkspaceId();
      const data = workspaceData(ws);
      const titles = [
        'Bearer token refresh fails',
        'bearer of bad news',
        'lin_api_MIRRORTEXT_abcdefghijklmnop',
      ];
      data.issues = data.issues.map((issue, index) => ({
        ...issue,
        title: titles[index % titles.length] ?? issue.title,
      }));
      await free.replaceMirror(data, AT);
      const first = data.issues[0];
      if (first === undefined) throw new Error('fixture has issues');
      await free.applyMirrorChanges(ws, {
        upsert: [
          {
            kind: 'issue',
            entity: { ...first, id: 'iss-key', title: titles[2] ?? '' },
          },
        ],
        remove: [],
      });
      const loaded = await free.loadMirror(ws);
      const loadedTitles = new Map(
        loaded?.data.issues.map((issue) => [issue.id, issue.title])
      );
      for (const issue of data.issues) {
        expect(loadedTitles.get(issue.id)).toBe(issue.title);
      }
      expect(loadedTitles.get('iss-key')).toBe(
        'lin_api_MIRRORTEXT_abcdefghijklmnop'
      );
    });
  });
}

credentialFreeSuite('credential-free store on PGlite', () => openPgliteSql());

describe.skipIf(!HAS_POSTGRES)(
  'credential-free store on node-postgres (TEST_DATABASE_URL)',
  () => {
    credentialFreeSuite('suite', () => openPgSql(DATABASE_URL ?? ''));
  }
);
