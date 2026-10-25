import { EngineInputError, PURGE_AFTER_DAYS } from '@better-tracker/engine';
import { silentLogger } from '@better-tracker/logger';
import { describe, expect, test } from 'bun:test';

import type { OperatorCommand } from '../src/cli';
import type { CommandContext } from '../src/commands';
import { loadWorkerConfig } from '../src/config';
import {
  redactText,
  runOperatorCommand,
  statusLabel,
  type WorkspaceRow,
} from '../src/operator';
import {
  type FakeEngine,
  fakeEngine,
  overview,
  revokedOverview,
} from './fake-engine';

const NOW = new Date('2026-10-25T12:00:00.000Z');
const HOUR = 3_600_000;
const ago = (ms: number): string => new Date(NOW.getTime() - ms).toISOString();
// Credential- and address-shaped text that must never be printed.
const TOKEN = 'lin_oauth_0123456789abcdef0123456789abcdef';
const EMAIL = 'ana@acme.example';

function context(engine: FakeEngine): CommandContext {
  return {
    engine,
    logger: silentLogger,
    config: loadWorkerConfig({}),
    now: () => NOW,
    deadlineAt: new Date(NOW.getTime() + 10 * 60_000),
  };
}

function run(
  engine: FakeEngine,
  command: OperatorCommand
): ReturnType<typeof runOperatorCommand> {
  return runOperatorCommand(context(engine), command);
}

// One of each status the listing shows.
function everyKind(): FakeEngine {
  return fakeEngine({
    statuses: [
      overview('org-acme', {
        workspaceName: 'Acme',
        urlKey: 'acme',
        sessionCount: 3,
        sync: {
          lastFullSyncAt: '2026-10-25T11:45:00.000Z',
          lastFullSyncStatus: 'ok',
          lastFullSyncMs: 812,
          lastSuccessAt: '2026-10-25T11:45:00.000Z',
          mirrorIssueCount: 412,
        },
      }),
      overview('org-stuck', {
        installation: { createdAt: ago(72 * HOUR) },
        sync: {
          lastFullSyncAt: '2026-10-25T11:50:00.000Z',
          lastFullSyncStatus: 'failed',
          lastFullSyncError: `Linear refused ${TOKEN} for ${EMAIL}`,
          consecutiveFailures: 7,
          lastSuccessAt: ago(30 * HOUR),
        },
      }),
      revokedOverview('org-gone', 'removed', '2026-10-24T09:00:00.000Z'),
      revokedOverview('org-dead', 'grant_dead', '2026-10-23T09:00:00.000Z'),
      { ...overview('org-spam'), admission: 'blocked' },
      { ...overview('org-unlisted'), admission: 'not_allowed' },
      overview('org-people', { installation: null, sessionCount: 1 }),
    ],
    overrides: {
      listBlockedWorkspaces: () =>
        Promise.resolve([
          {
            key: 'org-spam',
            kind: 'id',
            reason: `spam, reported by ${EMAIL}`,
            createdAt: '2026-10-24T10:00:00.000Z',
          },
          {
            key: 'evilcorp',
            kind: 'url_key',
            reason: null,
            createdAt: '2026-10-24T11:00:00.000Z',
          },
        ]),
    },
  });
}

describe('workspaces', () => {
  test('prints a table, the blocks and a summary, without tokens or emails', async () => {
    const result = await run(everyKind(), { name: 'workspaces', json: false });
    expect(result.code).toBe(0);
    const text = result.lines.join('\n');
    expect(result.lines[0]).toMatch(
      /^Workspace id\s+URL key\s+Name\s+Status\s+Installed\s+Purge on\s+Last sync\s+Issues\s+Sessions$/
    );
    const row = (id: string): string =>
      result.lines.find((line) => line.startsWith(id)) ?? '';
    expect(row('org-acme')).toMatch(
      /^org-acme\s+acme\s+Acme\s+active\s+2026-10-21\s+2026-10-25 11:45Z ok 812 ms\s+412\s+3$/
    );
    expect(row('org-stuck')).toContain(
      '2026-10-25 11:50Z failed, 7 failed in a row, chronic'
    );
    expect(row('org-gone')).toMatch(
      /revoked:removed\s+2026-10-21\s+2026-11-23/
    );
    expect(row('org-dead')).toContain('revoked:grant_dead');
    expect(row('org-dead')).not.toMatch(/2026-11/);
    expect(row('org-spam')).toContain('blocked');
    expect(row('org-unlisted')).toContain('not admitted');
    expect(row('org-people')).toMatch(/not installed\s+never\s+1$/);
    expect(text).toContain('Blocks:');
    expect(text).toMatch(/org-spam\s+organization id\s+2026-10-24\s+spam/);
    expect(text).toMatch(/evilcorp\s+URL key \(not seen yet\)\s+2026-10-24/);
    expect(result.lines.at(-1)).toBe(
      'workspaces ok — 7 workspaces (2 active, 1 revoked:removed, 1 revoked:grant_dead, 1 blocked, 1 not admitted, 1 not installed); 1 chronic; 2 blocks'
    );
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(EMAIL);
  });

  test('--json prints one JSON document with every field, redacted', async () => {
    const result = await run(everyKind(), { name: 'workspaces', json: true });
    expect(result.code).toBe(0);
    expect(result.lines).toHaveLength(1);
    const text = result.lines[0] ?? '';
    const parsed = JSON.parse(text) as {
      workspaces: WorkspaceRow[];
      blocks: unknown[];
    };
    expect(parsed.workspaces.map((row) => [row.id, row.status])).toEqual([
      ['org-acme', 'active'],
      ['org-stuck', 'active'],
      ['org-gone', 'revoked:removed'],
      ['org-dead', 'revoked:grant_dead'],
      ['org-spam', 'blocked'],
      ['org-unlisted', 'not admitted'],
      ['org-people', 'not installed'],
    ]);
    expect(parsed.workspaces[0]).toEqual({
      id: 'org-acme',
      urlKey: 'acme',
      name: 'Acme',
      status: 'active',
      admission: 'ok',
      installedAt: '2026-10-21T00:00:00.000Z',
      revokedAt: null,
      revokedReason: null,
      purgeOn: null,
      lastSync: {
        at: '2026-10-25T11:45:00.000Z',
        status: 'ok',
        durationMs: 812,
        consecutiveFailures: 0,
        lastSuccessAt: '2026-10-25T11:45:00.000Z',
        error: null,
      },
      chronic: false,
      issues: 412,
      sessions: 3,
    });
    const gone = parsed.workspaces[2];
    expect(gone?.purgeOn).toBe(
      new Date(
        Date.parse('2026-10-24T09:00:00.000Z') + PURGE_AFTER_DAYS * 86_400_000
      ).toISOString()
    );
    expect(parsed.workspaces[1]?.chronic).toBe(true);
    expect(parsed.workspaces[1]?.lastSync?.error).toBe(
      'Linear refused lin_oauth_[redacted] for [email]'
    );
    expect(parsed.blocks).toEqual([
      {
        key: 'org-spam',
        kind: 'id',
        reason: 'spam, reported by [email]',
        createdAt: '2026-10-24T10:00:00.000Z',
      },
      {
        key: 'evilcorp',
        kind: 'url_key',
        reason: null,
        createdAt: '2026-10-24T11:00:00.000Z',
      },
    ]);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(EMAIL);
  });

  test('no workspaces yet', async () => {
    const result = await run(fakeEngine({ statuses: [] }), {
      name: 'workspaces',
      json: false,
    });
    expect(result.lines).toEqual([
      'No workspaces yet: nobody has signed in or installed the app.',
      '',
      'workspaces ok — no workspaces',
    ]);
  });

  test('a block outranks a revoke in the status word', () => {
    expect(
      statusLabel({
        ...revokedOverview('org-a', 'removed'),
        admission: 'blocked',
      })
    ).toBe('blocked');
    expect(
      statusLabel({
        ...revokedOverview('org-a', 'removed'),
        admission: 'not_allowed',
      })
    ).toBe('revoked:removed');
  });
});

describe('remove', () => {
  test('passes the name to the engine, which resolves it', async () => {
    const engine = fakeEngine();
    const result = await run(engine, { name: 'remove', workspace: 'acme' });
    expect(engine.calls).toEqual(['removeWorkspace:acme']);
    expect(result).toEqual({
      code: 0,
      lines: [
        "remove ok — org-acme: installation revoked as removed; its data is purged on 2026-11-24 unless an admin installs the app again; the app's token revoked with Linear; 2 sessions ended (2 Linear grants revoked)",
      ],
    });
  });

  test('says what was not done', async () => {
    const engine = fakeEngine({
      overrides: {
        removeWorkspace: () =>
          Promise.resolve({
            workspaceId: 'org-acme',
            revoked: false,
            appTokenRevoked: false,
            endedSessions: 3,
            revokedTokens: 1,
            revokeFailures: 2,
          }),
      },
    });
    const [line] = (
      await run(engine, { name: 'remove', workspace: 'org-acme' })
    ).lines;
    expect(line).toBe(
      "remove ok — org-acme: no active installation to revoke (never installed, or already uninstalled or removed); Linear did not confirm revoking the app's token (see the warn log; it is wiped here all the same); 3 sessions ended (1 Linear grant revoked, 2 could not be)"
    );
  });

  test.each([
    ['not_found', 'No workspace here has that organization id or URL key.'],
    ['conflict', 'More than one workspace here has that URL key.'],
    ['invalid', 'Workspace commands are off.'],
  ] as const)(
    'an engine refusal (%s) exits 1 with its sentence',
    async (code, message) => {
      const engine = fakeEngine({
        overrides: {
          removeWorkspace: () =>
            Promise.reject(new EngineInputError(code, message)),
        },
      });
      expect(await run(engine, { name: 'remove', workspace: 'acme' })).toEqual({
        code: 1,
        lines: [`remove FAILED — ${message}`],
      });
    }
  );

  test('any other error is left for the driver to report', async () => {
    const engine = fakeEngine({
      overrides: {
        removeWorkspace: () => Promise.reject(new Error('database down')),
      },
    });
    const thrown = await run(engine, {
      name: 'remove',
      workspace: 'acme',
    }).then(
      () => null,
      (error: unknown) => error
    );
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('database down');
  });
});

describe('purge', () => {
  test.each([
    [
      'not_revoked',
      'org-acme: not purged: it is still installed; run remove --workspace org-acme first',
    ],
    [
      'too_recent',
      'org-acme: not purged: it was revoked less than 15 minutes ago and a sync may still be finishing; try again later',
    ],
    [
      'not_installed',
      'org-acme: not purged: it was never installed (people only signed in); there is nothing to purge but their sessions, which remove ends',
    ],
  ] as const)('refuses %s with exit 1', async (reason, text) => {
    const engine = fakeEngine({
      overrides: {
        purgeWorkspaceNow: () =>
          Promise.resolve({ purged: false, workspaceId: 'org-acme', reason }),
      },
    });
    expect(await run(engine, { name: 'purge', workspace: 'acme' })).toEqual({
      code: 1,
      lines: [`purge FAILED — ${text}`],
    });
  });

  test('prints the rows deleted per table, at the command clock', async () => {
    let asked: unknown;
    const engine = fakeEngine({
      overrides: {
        purgeWorkspaceNow: (name, options) => {
          asked = [name, options];
          return Promise.resolve({
            purged: true,
            workspaceId: 'org-acme',
            endedSessions: 1,
            counts: {
              installations: 1,
              sessions: 0,
              settings: 1,
              milestone_meta: 4,
              sync_state: 1,
              mirror_entities: 900,
              webhook_deliveries: 12,
              allocation_entries: 30,
              allocation_runs: 5,
              warning_memory: 7,
              notifications: 9,
              job_claims: 3,
              audit_log: 20,
              admitted_workspaces: 1,
            },
          });
        },
      },
    });
    const result = await run(engine, { name: 'purge', workspace: 'acme' });
    expect(asked).toEqual(['acme', { now: NOW.toISOString() }]);
    expect(result.code).toBe(0);
    expect(result.lines[0]).toMatch(/^ {2}Table\s+Rows deleted$/);
    expect(result.lines).toContainEqual(
      expect.stringMatching(/^ {2}mirror_entities\s+900$/)
    );
    expect(result.lines).toHaveLength(16);
    expect(result.lines.at(-1)).toBe(
      'purge ok — org-acme: 994 rows deleted; 1 session ended first'
    );
  });
});

describe('block and unblock', () => {
  test('an unknown URL key is stored and named on its first sign-in', async () => {
    const engine = fakeEngine();
    const result = await run(engine, {
      name: 'block',
      workspace: 'evilcorp',
      reason: 'spam',
    });
    expect(engine.calls).toEqual(['blockWorkspace:evilcorp:spam']);
    expect(result.lines).toEqual([
      'block ok — evilcorp: blocked by URL key; no workspace here has that URL key yet; the block names its organization the first time it signs in or installs',
    ]);
  });

  test('a known workspace is blocked by id and removed', async () => {
    const engine = fakeEngine({
      overrides: {
        blockWorkspace: (name, reason) => {
          engine.calls.push(`blockWorkspace:${name}:${reason ?? 'no reason'}`);
          return Promise.resolve({
            key: 'org-acme',
            kind: 'id',
            workspaceId: 'org-acme',
            removal: {
              workspaceId: 'org-acme',
              revoked: true,
              appTokenRevoked: null,
              endedSessions: 0,
              revokedTokens: 0,
              revokeFailures: 0,
            },
          });
        },
      },
    });
    const result = await run(engine, {
      name: 'block',
      workspace: 'acme',
      reason: null,
    });
    expect(engine.calls).toEqual(['blockWorkspace:acme:no reason']);
    expect(result.lines).toEqual([
      'block ok — org-acme: blocked by organization id; installation revoked as removed; its data is purged on 2026-11-24 unless an admin installs the app again; 0 sessions ended',
    ]);
  });

  test('unblock says whether a block was lifted', async () => {
    const engine = fakeEngine();
    expect(
      (await run(engine, { name: 'unblock', workspace: 'acme' })).lines
    ).toEqual([
      'unblock ok — acme: block removed; the workspace stays removed until an admin installs the app again',
    ]);
    engine.unblockWorkspace = () => Promise.resolve(false);
    expect(await run(engine, { name: 'unblock', workspace: 'acme' })).toEqual({
      code: 0,
      lines: [
        'unblock ok — acme: nothing was blocked under that name; nothing changed',
      ],
    });
  });
});

test('redactText removes credentials and email addresses', () => {
  expect(redactText(`token ${TOKEN} of <${EMAIL}>`)).toBe(
    'token lin_oauth_[redacted] of <[email]>'
  );
  expect(redactText('plain words')).toBe('plain words');
});
