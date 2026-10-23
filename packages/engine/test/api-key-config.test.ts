// LINEAR_AUTH and the api_key-mode variables (architecture §7.1, §10).

import { describe, expect, test } from 'bun:test';

import {
  apiKeyUnusedEnvVariables,
  isApiKeyEnv,
  linearAuthFromEnv,
  loadEngineConfigFromEnv,
  processFlagProblem,
} from '../src/config';
import { API_KEY_IDLE_MS, API_KEY_MAX_MS } from '../src/key-vault';
import { TEST_KEY } from './helpers';

const NO_FLAGS = { execArgv: [] as string[] };
const LOCAL = { LINEAR_AUTH: 'api_key', APP_URL: 'http://localhost:3360' };
const DEPLOYED = {
  LINEAR_AUTH: 'api_key',
  APP_URL: 'https://planner.example.com',
  NODE_ENV: 'production',
  LINEAR_WORKSPACE: 'acme',
  NODE_OPTIONS: '--disable-sigusr1',
};

function problems(
  env: Record<string, string>,
  execArgv: string[] = []
): string {
  try {
    loadEngineConfigFromEnv(env, { execArgv });
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

describe('LINEAR_AUTH', () => {
  test('the mode matrix', () => {
    expect(linearAuthFromEnv({ LINEAR_FIXTURE: '1' })).toBe('demo');
    expect(
      linearAuthFromEnv({ LINEAR_FIXTURE: 'showcase', LINEAR_AUTH: 'oauth' })
    ).toBe('demo');
    expect(linearAuthFromEnv({})).toBe('oauth');
    expect(
      linearAuthFromEnv({ LINEAR_FIXTURE: '0', LINEAR_AUTH: 'oauth' })
    ).toBe('oauth');
    expect(linearAuthFromEnv({ LINEAR_AUTH: 'api_key' })).toBe('api_key');
    expect(linearAuthFromEnv({ LINEAR_AUTH: ' API_KEY ' })).toBe('api_key');
    expect(
      linearAuthFromEnv({ LINEAR_FIXTURE: 'false', LINEAR_AUTH: 'api_key' })
    ).toBe('api_key');
    expect(isApiKeyEnv({ LINEAR_AUTH: 'api_key' })).toBe(true);
    expect(isApiKeyEnv({ LINEAR_AUTH: '' })).toBe(false);

    expect(
      loadEngineConfigFromEnv({ LINEAR_FIXTURE: '1' }, NO_FLAGS).auth
    ).toBe('demo');
    expect(loadEngineConfigFromEnv(LOCAL, NO_FLAGS).auth).toBe('api_key');
    expect(problems({ LINEAR_FIXTURE: '1', LINEAR_AUTH: 'api_key' })).toContain(
      'LINEAR_AUTH=api_key cannot be combined with LINEAR_FIXTURE (demo mode); unset one'
    );
    expect(problems({ ...LOCAL, LINEAR_AUTH: 'token' })).toContain(
      'LINEAR_AUTH must be oauth (default) or api_key'
    );
  });

  test('api_key needs only APP_URL locally, and reads no OAuth variable', () => {
    const config = loadEngineConfigFromEnv(LOCAL, NO_FLAGS);
    expect(config.oauth).toBeNull();
    expect(config.apiKey).toEqual({
      idleMs: API_KEY_IDLE_MS,
      absoluteMs: API_KEY_MAX_MS,
      syncIntervalMs: 15 * 60_000,
      workspacePin: null,
      endpoint: 'https://api.linear.app/graphql',
      deployed: false,
    });
    expect(API_KEY_IDLE_MS).toBe(2 * 3_600_000);
    expect(API_KEY_MAX_MS).toBe(12 * 3_600_000);
    expect(problems({ LINEAR_AUTH: 'api_key' })).toContain(
      'APP_URL is required'
    );
    // A broken OAuth variable is not even read.
    expect(
      loadEngineConfigFromEnv(
        { ...LOCAL, TOKEN_ENCRYPTION_KEY: 'not-base64!', SESSION_DAYS: 'x' },
        NO_FLAGS
      ).auth
    ).toBe('api_key');
  });

  test('deployed: https and the pin are required; loopback production is not deployed', () => {
    expect(loadEngineConfigFromEnv(DEPLOYED, NO_FLAGS).apiKey?.deployed).toBe(
      true
    );
    expect(
      problems({ ...DEPLOYED, APP_URL: 'http://planner.example.com' })
    ).toContain(
      'APP_URL must be https:// when LINEAR_AUTH=api_key is deployed (keys must only travel over HTTPS)'
    );
    const { LINEAR_WORKSPACE: _pin, ...unpinned } = DEPLOYED;
    expect(problems(unpinned)).toContain(
      'LINEAR_WORKSPACE is required when LINEAR_AUTH=api_key is deployed'
    );
    expect(problems({ ...DEPLOYED, LINEAR_WORKSPACE: '' })).toContain(
      'LINEAR_WORKSPACE is required'
    );
    const local = loadEngineConfigFromEnv(
      {
        LINEAR_AUTH: 'api_key',
        APP_URL: 'http://127.0.0.1:3360',
        NODE_ENV: 'production',
      },
      NO_FLAGS
    );
    expect(local.apiKey?.deployed).toBe(false);
    expect(local.apiKey?.workspacePin).toBeNull();
  });

  test("migrateOnly (the worker's migrate) skips the checks that guard keys", () => {
    const { LINEAR_WORKSPACE: _pin, NODE_OPTIONS: _flags, ...bare } = DEPLOYED;
    const env = { ...bare, APP_URL: 'http://planner.example.com' };
    expect(problems(env)).toContain('LINEAR_WORKSPACE is required');
    const config = loadEngineConfigFromEnv(env, {
      execArgv: ['--inspect'],
      migrateOnly: true,
    });
    expect(config.auth).toBe('api_key');
    expect(config.apiKey?.workspacePin).toBeNull();
    // Everything else is still checked.
    expect(() =>
      loadEngineConfigFromEnv(
        { ...env, SYNC_INTERVAL_MINUTES: 'often' },
        { execArgv: [], migrateOnly: true }
      )
    ).toThrow(/SYNC_INTERVAL_MINUTES/);
  });

  test('LINEAR_WORKSPACE and SYNC_INTERVAL_MINUTES are validated', () => {
    expect(
      loadEngineConfigFromEnv(
        { ...LOCAL, LINEAR_WORKSPACE: 'Acme-2' },
        NO_FLAGS
      ).apiKey?.workspacePin
    ).toBe('Acme-2');
    expect(problems({ ...LOCAL, LINEAR_WORKSPACE: 'acme corp' })).toContain(
      'LINEAR_WORKSPACE must be a Linear workspace URL key or organization id'
    );
    expect(problems({ ...LOCAL, LINEAR_WORKSPACE: 'a'.repeat(65) })).toContain(
      'LINEAR_WORKSPACE must be'
    );
    expect(
      loadEngineConfigFromEnv(
        { ...LOCAL, SYNC_INTERVAL_MINUTES: '5' },
        NO_FLAGS
      ).apiKey?.syncIntervalMs
    ).toBe(5 * 60_000);
    for (const bad of ['0', '1441', '2.5', 'often']) {
      expect(problems({ ...LOCAL, SYNC_INTERVAL_MINUTES: bad })).toContain(
        'SYNC_INTERVAL_MINUTES must be a whole number of minutes from 1 to 1440'
      );
    }
  });

  test('unused variables are listed for a warning each', () => {
    expect(
      apiKeyUnusedEnvVariables({
        ...LOCAL,
        TOKEN_ENCRYPTION_KEY: TEST_KEY,
        LINEAR_CLIENT_ID: 'id',
        LINEAR_CLIENT_SECRET: 'secret',
        LINEAR_WEBHOOK_SECRET: 'hook',
        SESSION_SECRET: 's',
        SLACK_BOT_TOKEN: 'xoxb',
        SESSION_DAYS: '3',
      })
    ).toEqual([
      'TOKEN_ENCRYPTION_KEY',
      'LINEAR_CLIENT_ID',
      'LINEAR_CLIENT_SECRET',
      'LINEAR_WEBHOOK_SECRET',
      'SESSION_SECRET',
      'SLACK_BOT_TOKEN',
      'SESSION_DAYS',
    ]);
    expect(
      apiKeyUnusedEnvVariables({ ...LOCAL, LINEAR_CLIENT_ID: ' ' })
    ).toEqual([]);
    expect(
      apiKeyUnusedEnvVariables({ TOKEN_ENCRYPTION_KEY: TEST_KEY })
    ).toEqual([]);
  });

  test('LINEAR_API_URL is test-only: loopback IPs with a loopback APP_URL', () => {
    for (const url of [
      'http://127.0.0.1:4010/graphql',
      'http://[::1]:4010/graphql',
    ]) {
      expect(
        loadEngineConfigFromEnv({ ...LOCAL, LINEAR_API_URL: url }, NO_FLAGS)
          .apiKey?.endpoint
      ).toBe(url);
    }
    for (const url of [
      'https://evil.example/graphql',
      'http://localhost:4010/graphql',
      'http://127.0.0.1.evil.example/graphql',
      'http://127.0.0.1@evil.example/',
      'http://evil.example#@127.0.0.1',
      'http://u:p@127.0.0.1/',
      'file:///etc/passwd',
    ]) {
      expect(problems({ ...LOCAL, LINEAR_API_URL: url })).toContain(
        'LINEAR_API_URL may only point at a local test server (127.0.0.1 or [::1])'
      );
    }
    expect(
      problems({
        ...DEPLOYED,
        LINEAR_API_URL: 'http://127.0.0.1:4010/graphql',
      })
    ).toContain('LINEAR_API_URL is test-only: it needs a loopback APP_URL');
    expect(
      problems({
        LINEAR_AUTH: 'api_key',
        APP_URL: 'https://planner.example.com',
        LINEAR_API_URL: 'http://127.0.0.1:4010/graphql',
      })
    ).toContain('LINEAR_API_URL is test-only');
  });

  test('inspector and heap-snapshot flags are refused', () => {
    for (const flag of [
      '--inspect',
      '--inspect=0',
      '--inspect-brk',
      '--inspect-port=1',
      '--debug-port=1',
      '--heapsnapshot-near-heap-limit=2',
      '--heapsnapshot-signal=SIGUSR2',
    ]) {
      const fromArgv = processFlagProblem({
        execArgv: [flag],
        nodeOptions: '',
        deployed: false,
      });
      const fromOptions = processFlagProblem({
        execArgv: [],
        nodeOptions: `--max-old-space-size=512 ${flag}`,
        deployed: false,
      });
      for (const problem of [fromArgv, fromOptions]) {
        expect(problem).toBe(
          `${flag} is refused when LINEAR_AUTH=api_key: it can expose or dump the server's memory, where connected keys live`
        );
      }
    }
    expect(problems({ ...LOCAL, NODE_OPTIONS: '--inspect' })).toContain(
      '--inspect is refused'
    );
    expect(problems(LOCAL, ['--inspect-brk'])).toContain(
      '--inspect-brk is refused'
    );
  });

  test('deployed needs --disable-sigusr1 in either list; local does not', () => {
    const missing = processFlagProblem({
      execArgv: [],
      nodeOptions: '',
      deployed: true,
    });
    expect(missing).toContain('Set NODE_OPTIONS=--disable-sigusr1');
    expect(
      processFlagProblem({
        execArgv: ['--disable-sigusr1'],
        nodeOptions: '',
        deployed: true,
      })
    ).toBeNull();
    expect(
      processFlagProblem({
        execArgv: [],
        nodeOptions: ' --disable-sigusr1 ',
        deployed: true,
      })
    ).toBeNull();
    expect(
      processFlagProblem({ execArgv: [], nodeOptions: '', deployed: false })
    ).toBeNull();
    const { NODE_OPTIONS: _flags, ...bare } = DEPLOYED;
    expect(problems(bare)).toContain('Set NODE_OPTIONS=--disable-sigusr1');
  });

  test('OAuth defaults are unchanged', () => {
    const config = loadEngineConfigFromEnv(
      {
        APP_URL: 'https://planner.example.com',
        TOKEN_ENCRYPTION_KEY: TEST_KEY,
        LINEAR_CLIENT_ID: 'id',
        LINEAR_CLIENT_SECRET: 'secret',
        LINEAR_WORKSPACE: 'ignored here',
        LINEAR_API_URL: 'https://evil.example',
      },
      NO_FLAGS
    );
    expect(config.auth).toBe('oauth');
    expect(config.apiKey).toBeNull();
    expect(config.oauth?.clientId).toBe('id');
    expect(problems({ APP_URL: 'https://p.example' })).toContain(
      'TOKEN_ENCRYPTION_KEY is required'
    );
  });
});
