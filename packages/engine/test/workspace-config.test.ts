// LINEAR_WORKSPACES, OPERATOR_* and DEMO_URL (owner decision 2026-10-25):
// how they are read and validated, what OAuth boot logs about them, and the
// Slack fail-safe when the channel is chosen at boot.

import { openStore } from '@better-tracker/store';
import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  API_KEY_UNUSED_ENV_VARIABLES,
  apiKeyUnusedEnvVariables,
  createEngineFromEnv,
  isDeployedEnv,
  loadEngineConfigFromEnv,
  MAX_WORKSPACE_ENTRIES,
} from '../src/index';
import { recordingLogger, TEST_KEY } from './helpers';

// Each test opens one or more PGlite stores (1–2 s each); helpers.ts sets
// the same default, but only for the first file that imports it.
setDefaultTimeout(60_000);

const OAUTH_ENV = {
  APP_URL: 'https://planner.example.com',
  TOKEN_ENCRYPTION_KEY: TEST_KEY,
  LINEAR_CLIENT_ID: 'client-id',
  LINEAR_CLIENT_SECRET: 'client-secret',
};

function problems(env: Record<string, string>): string {
  try {
    loadEngineConfigFromEnv(env);
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

describe('LINEAR_WORKSPACES', () => {
  test('unset or empty is closed to new workspaces; * is any; else a list', () => {
    expect(loadEngineConfigFromEnv(OAUTH_ENV).workspaces).toEqual({
      mode: 'installed',
    });
    for (const blank of ['', '  ', ' , ,']) {
      expect(
        loadEngineConfigFromEnv({ ...OAUTH_ENV, LINEAR_WORKSPACES: blank })
          .workspaces
      ).toEqual({ mode: 'installed' });
    }
    expect(
      loadEngineConfigFromEnv({ ...OAUTH_ENV, LINEAR_WORKSPACES: ' * ' })
        .workspaces
    ).toEqual({ mode: 'any' });
    expect(
      loadEngineConfigFromEnv({
        ...OAUTH_ENV,
        LINEAR_WORKSPACES:
          ' Acme ,0F8FAD5B-D9CB-469F-A165-70867728950E,acme,other-co',
      }).workspaces
    ).toEqual({
      mode: 'list',
      entries: ['acme', '0f8fad5b-d9cb-469f-a165-70867728950e', 'other-co'],
    });
  });

  test('refuses * in a list, malformed entries and too many', () => {
    expect(problems({ ...OAUTH_ENV, LINEAR_WORKSPACES: '*,acme' })).toContain(
      'LINEAR_WORKSPACES is either * on its own or a list'
    );
    expect(
      problems({ ...OAUTH_ENV, LINEAR_WORKSPACES: 'acme,linear.app/acme' })
    ).toContain(
      'LINEAR_WORKSPACES has an entry that is not a Linear organization id or URL key'
    );
    expect(
      problems({ ...OAUTH_ENV, LINEAR_WORKSPACES: 'a'.repeat(65) })
    ).toContain('at most 64');
    const many = Array.from(
      { length: MAX_WORKSPACE_ENTRIES + 1 },
      (_, i) => `ws-${i}`
    ).join(',');
    expect(problems({ ...OAUTH_ENV, LINEAR_WORKSPACES: many })).toContain(
      `at most ${MAX_WORKSPACE_ENTRIES} are allowed`
    );
  });

  test('demo mode ignores it; api_key mode reports it unused', () => {
    expect(
      loadEngineConfigFromEnv({ LINEAR_FIXTURE: '1', LINEAR_WORKSPACES: '!!' })
    ).not.toHaveProperty('workspaces');
    const keyed = {
      LINEAR_AUTH: 'api_key',
      APP_URL: 'http://localhost:3360',
      LINEAR_WORKSPACES: 'acme',
    };
    expect(loadEngineConfigFromEnv(keyed, { execArgv: [] })).not.toHaveProperty(
      'workspaces'
    );
    expect(API_KEY_UNUSED_ENV_VARIABLES).toContain('LINEAR_WORKSPACES');
    expect(apiKeyUnusedEnvVariables(keyed)).toContain('LINEAR_WORKSPACES');
  });
});

describe('OPERATOR_* and DEMO_URL', () => {
  test('are optional and exposed on the config', () => {
    expect(loadEngineConfigFromEnv(OAUTH_ENV)).toMatchObject({
      operator: { name: null, email: null, url: null },
      demoUrl: null,
    });
    expect(
      loadEngineConfigFromEnv({
        ...OAUTH_ENV,
        OPERATOR_NAME: ' Pat Lee ',
        OPERATOR_EMAIL: 'pat@example.com',
        OPERATOR_URL: 'https://example.com/about',
        DEMO_URL: 'https://demo.example.com',
      })
    ).toMatchObject({
      operator: {
        name: 'Pat Lee',
        email: 'pat@example.com',
        url: 'https://example.com/about',
      },
      demoUrl: 'https://demo.example.com',
    });
  });

  test('loosely checks their shapes', () => {
    const message = problems({
      ...OAUTH_ENV,
      OPERATOR_NAME: 'x'.repeat(121),
      OPERATOR_EMAIL: 'not an email',
      OPERATOR_URL: 'javascript:alert(1)',
      DEMO_URL: 'https://user:pass@demo.example.com',
    });
    for (const part of [
      'OPERATOR_NAME must be one line of at most 120 characters',
      'OPERATOR_EMAIL is not an email address',
      'OPERATOR_URL must be an http:// or https:// URL',
      'DEMO_URL must be an http:// or https:// URL',
    ]) {
      expect(message).toContain(part);
    }
    expect(problems({ ...OAUTH_ENV, OPERATOR_NAME: 'two\nlines' })).toContain(
      'OPERATOR_NAME'
    );
  });

  test('isDeployedEnv: production on a non-loopback APP_URL', () => {
    expect(isDeployedEnv({ ...OAUTH_ENV, NODE_ENV: 'production' })).toBe(true);
    expect(isDeployedEnv(OAUTH_ENV)).toBe(false);
    expect(
      isDeployedEnv({
        APP_URL: 'http://localhost:3000',
        NODE_ENV: 'production',
      })
    ).toBe(false);
    expect(isDeployedEnv({ APP_URL: 'nope', NODE_ENV: 'production' })).toBe(
      false
    );
  });
});

describe('OAuth boot', () => {
  // Boots an OAuth engine over a fresh PGlite directory, after `seed`
  // prepared the store, and returns its log lines.
  async function boot(
    env: Record<string, string>,
    seed?: (dir: string) => Promise<void>
  ): Promise<string[]> {
    const dir = await mkdtemp(join(tmpdir(), 'engine-workspaces-'));
    const pgliteDir = join(dir, 'pglite');
    try {
      await seed?.(pgliteDir);
      const { logger, lines } = recordingLogger();
      const engine = await createEngineFromEnv(
        { ...OAUTH_ENV, PGLITE_DIR: pgliteDir, ...env },
        { logger }
      );
      await engine.close();
      return lines;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  function line(lines: string[], text: string): string | undefined {
    return lines.find((l) => l.includes(text));
  }

  test('logs which workspaces LINEAR_WORKSPACES admits', async () => {
    const closed = await boot({});
    expect(line(closed, 'closed to new workspaces')).toContain(
      '"level":"info"'
    );
    expect(
      line(await boot({ LINEAR_WORKSPACES: 'acme,org-other' }), 'admits 2')
    ).toContain('"level":"info"');
    expect(
      line(await boot({ LINEAR_WORKSPACES: '*' }), 'LINEAR_WORKSPACES is *')
    ).toContain('"level":"warn"');
    // Not deployed: no contact line.
    expect(line(closed, 'OPERATOR_EMAIL')).toBeUndefined();
  });

  test('a deployed planner without OPERATOR_EMAIL says so once', async () => {
    const deployed = await boot({ NODE_ENV: 'production' });
    expect(
      deployed.filter((l) => l.includes('OPERATOR_EMAIL is not set'))
    ).toHaveLength(1);
    expect(
      line(
        await boot({ NODE_ENV: 'production', OPERATOR_EMAIL: 'w@example.com' }),
        'OPERATOR_EMAIL'
      )
    ).toBeUndefined();
  });

  test('SLACK_BOT_TOKEN is not used while more than one workspace may be served', async () => {
    const slack = { SLACK_BOT_TOKEN: 'xoxb-test' };
    const ready = (lines: string[]): string | undefined =>
      line(lines, 'engine ready');

    expect(ready(await boot(slack))).toContain('"channel":"slack"');
    expect(
      ready(await boot({ ...slack, LINEAR_WORKSPACES: 'acme' }))
    ).toContain('"channel":"slack"');

    const any = await boot({ ...slack, LINEAR_WORKSPACES: '*' });
    expect(ready(any)).toContain('"channel":"outbox"');
    expect(line(any, 'SLACK_BOT_TOKEN is not used')).toContain(
      '"level":"warn"'
    );
    expect(
      ready(await boot({ ...slack, LINEAR_WORKSPACES: 'acme,other' }))
    ).toContain('"channel":"outbox"');

    // Unset: two installed workspaces are enough.
    const two = await boot(slack, async (pgliteDir) => {
      const store = await openStore({ pgliteDir, encryptionKey: TEST_KEY });
      await store.migrate();
      for (const id of ['org-acme', 'org-other']) {
        await store.saveInstallation({
          workspaceId: id,
          workspaceName: id,
          urlKey: id,
          appUserId: `app-${id}`,
          installedByUserId: 'u-ana',
          revokedAt: null,
          tokens: {
            accessToken: `token-${id}`,
            refreshToken: null,
            expiresAt: null,
            scopes: ['read'],
          },
          createdAt: '2026-10-01T00:00:00.000Z',
          updatedAt: '2026-10-01T00:00:00.000Z',
        });
      }
      await store.close();
    });
    expect(ready(two)).toContain('"channel":"outbox"');
    expect(line(two, 'SLACK_BOT_TOKEN is not used')).toContain(
      '2 Linear workspaces are installed'
    );
    // The token itself is never logged.
    expect(two.join('\n')).not.toContain('xoxb-test');
  });
});
