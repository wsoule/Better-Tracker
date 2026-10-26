// LINEAR_API_URL in OAuth mode (test-only; architecture §10, §11): the gate
// it shares with api_key mode (a loopback APP_URL, 127.0.0.1 or [::1], no
// user info), the URL swap (GraphQL to the URL itself, token, revoke and
// the authorize page at its origin), and a real OAuth-mode engine whose
// every Linear call goes to the test server, while the same boot without
// the variable names Linear exactly as before.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createEngineFromEnv, loadEngineConfigFromEnv } from '../src/index';
import {
  authorizeUrlViaTestEndpoint,
  fetchViaTestEndpoint,
  viaTestEndpoint,
} from '../src/test-endpoint';
import { ACME, createFakeLinear, person } from './fake-linear';
import { recordingLogger, TEST_KEY } from './helpers';

// Each boot opens a PGlite store (1–2 s); helpers.ts sets the same default,
// but only for the first file that imports it.
setDefaultTimeout(60_000);

const ENDPOINT = 'http://127.0.0.1:4010/graphql';
const ORIGIN = 'http://127.0.0.1:4010';

const LOCAL_OAUTH = {
  APP_URL: 'http://localhost:3394',
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

describe('LINEAR_API_URL in OAuth mode', () => {
  test('a loopback IP with a loopback APP_URL is the test endpoint', () => {
    for (const url of [ENDPOINT, 'http://[::1]:4010/graphql']) {
      for (const appUrl of [
        'http://localhost:3394',
        'http://127.0.0.1:3394',
        'http://[::1]:3394',
      ]) {
        expect(
          loadEngineConfigFromEnv({
            ...LOCAL_OAUTH,
            APP_URL: appUrl,
            LINEAR_API_URL: url,
          }).linearTestEndpoint
        ).toBe(url);
      }
    }
  });

  test('unset or blank leaves the config exactly as before', () => {
    for (const env of [
      LOCAL_OAUTH,
      { ...LOCAL_OAUTH, LINEAR_API_URL: '' },
      { ...LOCAL_OAUTH, LINEAR_API_URL: '  ' },
    ]) {
      const config = loadEngineConfigFromEnv(env);
      expect('linearTestEndpoint' in config).toBe(false);
      expect(config).toEqual(loadEngineConfigFromEnv(LOCAL_OAUTH));
    }
  });

  test('refuses anything but a local test server', () => {
    for (const url of [
      'https://api.linear.app/graphql',
      'https://evil.example/graphql',
      'http://localhost:4010/graphql',
      'http://127.0.0.1.evil.example/graphql',
      'http://127.0.0.1@evil.example/',
      'http://evil.example#@127.0.0.1',
      'http://u:p@127.0.0.1/',
      'http://u@127.0.0.1:4010/graphql',
      'file:///etc/passwd',
      'ftp://127.0.0.1/graphql',
      'not a url',
    ]) {
      expect(problems({ ...LOCAL_OAUTH, LINEAR_API_URL: url })).toContain(
        'LINEAR_API_URL may only point at a local test server (127.0.0.1 or [::1])'
      );
    }
  });

  test('refuses it without a loopback APP_URL, deployed or not', () => {
    const envs: Record<string, string>[] = [
      { APP_URL: 'https://planner.example.com' },
      { APP_URL: 'https://planner.example.com', NODE_ENV: 'production' },
      { APP_URL: 'http://10.0.0.5:3000' },
    ];
    for (const env of envs) {
      expect(
        problems({ ...LOCAL_OAUTH, ...env, LINEAR_API_URL: ENDPOINT })
      ).toContain('LINEAR_API_URL is test-only: it needs a loopback APP_URL');
    }
  });

  test('demo mode ignores it; api_key mode keeps its own endpoint', () => {
    const demo = loadEngineConfigFromEnv({
      LINEAR_FIXTURE: '1',
      LINEAR_API_URL: 'https://evil.example/graphql',
    });
    expect('linearTestEndpoint' in demo).toBe(false);
    const apiKey = loadEngineConfigFromEnv(
      {
        LINEAR_AUTH: 'api_key',
        APP_URL: 'http://localhost:3360',
        LINEAR_API_URL: ENDPOINT,
      },
      { execArgv: [] }
    );
    expect(apiKey.apiKey?.endpoint).toBe(ENDPOINT);
    expect('linearTestEndpoint' in apiKey).toBe(false);
  });
});

describe('the swap', () => {
  test("Linear's API host goes to the test endpoint, paths kept", () => {
    expect(viaTestEndpoint('https://api.linear.app/graphql', ENDPOINT)).toBe(
      ENDPOINT
    );
    expect(
      viaTestEndpoint('https://api.linear.app/graphql', `${ORIGIN}/v2/gql`)
    ).toBe(`${ORIGIN}/v2/gql`);
    expect(
      viaTestEndpoint('https://api.linear.app/oauth/token', ENDPOINT)
    ).toBe(`${ORIGIN}/oauth/token`);
    expect(
      viaTestEndpoint('https://api.linear.app/oauth/revoke?x=1', ENDPOINT)
    ).toBe(`${ORIGIN}/oauth/revoke?x=1`);
    expect(
      viaTestEndpoint(
        'https://api.linear.app/oauth/token',
        'http://[::1]:4010/graphql'
      )
    ).toBe('http://[::1]:4010/oauth/token');
  });

  test('every other URL is left alone', () => {
    for (const url of [
      'https://linear.app/oauth/authorize?client_id=x',
      'https://api.linear.app.evil.example/oauth/token',
      'https://api.linear.app',
      'http://api.linear.app/graphql',
      'https://slack.com/api/chat.postMessage',
    ]) {
      expect(viaTestEndpoint(url, ENDPOINT)).toBe(url);
    }
  });

  test('the authorize page moves to the test origin with its query', () => {
    const query =
      'client_id=c&redirect_uri=http%3A%2F%2Flocalhost%3A3394%2Fapi%2Fauth%2Flinear%2Fcallback&state=s';
    expect(
      authorizeUrlViaTestEndpoint(
        `https://linear.app/oauth/authorize?${query}`,
        ENDPOINT
      )
    ).toBe(`${ORIGIN}/oauth/authorize?${query}`);
    for (const url of [
      'https://linear.app/acme/issue/ENG-1',
      'https://linear.app/oauth/authorizex?y=1',
      'https://linear.app.evil.example/oauth/authorize?y=1',
    ]) {
      expect(authorizeUrlViaTestEndpoint(url, ENDPOINT)).toBe(url);
    }
  });

  test('the fetch passes the swapped URL and the request on', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = fetchViaTestEndpoint(ENDPOINT, (url, init) => {
      calls.push({ url, init });
      return Promise.resolve(new Response('ok'));
    });
    const init: RequestInit = { method: 'POST', body: 'grant_type=x' };
    await fetch('https://api.linear.app/oauth/token', init);
    await fetch('https://slack.com/api/chat.postMessage', init);
    expect(calls.map((call) => call.url)).toEqual([
      `${ORIGIN}/oauth/token`,
      'https://slack.com/api/chat.postMessage',
    ]);
    expect(calls[0]?.init).toBe(init);
  });
});

/**
 * Boots an OAuth-mode engine (LINEAR_WORKSPACES=acme) over the engine's
 * fake Linear, recording the URL of every fetch; the fake answers by
 * Linear's own URLs, so a call sent to the test origin is mapped back
 * before it answers. Signs Ana in to Acme and out again, and returns the
 * authorize URL, the URLs fetched and the log lines.
 */
async function signInAndOut(extra: Record<string, string>): Promise<{
  authorizeUrl: string;
  urls: string[];
  lines: string[];
}> {
  const dir = await mkdtemp(join(tmpdir(), 'engine-test-endpoint-'));
  const fake = createFakeLinear();
  const urls: string[] = [];
  const { logger, lines } = recordingLogger();
  const engine = await createEngineFromEnv(
    {
      ...LOCAL_OAUTH,
      LINEAR_WORKSPACES: 'acme',
      PGLITE_DIR: join(dir, 'pglite'),
      ...extra,
    },
    {
      logger,
      fetch: (url, init) => {
        urls.push(url);
        const linear = url.startsWith(`${ORIGIN}/`)
          ? url === ENDPOINT
            ? 'https://api.linear.app/graphql'
            : `https://api.linear.app/${url.slice(ORIGIN.length + 1)}`
          : url;
        return fake.fetch(linear, init);
      },
    }
  );
  try {
    const start = engine.startOAuth('signin');
    fake.addCode(
      'code-ana',
      { user: person('user-ana', 'Ana'), workspace: ACME },
      'read'
    );
    const result = await engine.finishSignIn({
      code: 'code-ana',
      codeVerifier: start.codeVerifier,
      intent: 'signin',
    });
    expect(result.session.workspaceId).toBe('org-acme');
    await engine.signOut(result.sessionToken);
    expect(fake.revoked).toHaveLength(1);
    return { authorizeUrl: start.url, urls, lines };
  } finally {
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  }
}

describe('an OAuth engine with a test endpoint', () => {
  test('signs in, identifies and revokes at the test server, and says so', async () => {
    const { authorizeUrl, urls, lines } = await signInAndOut({
      LINEAR_API_URL: ENDPOINT,
    });
    const authorize = new URL(authorizeUrl);
    expect(authorize.origin).toBe(ORIGIN);
    expect(authorize.pathname).toBe('/oauth/authorize');
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      'http://localhost:3394/api/auth/linear/callback'
    );
    expect(urls).toContain(`${ORIGIN}/oauth/token`);
    expect(urls).toContain(ENDPOINT);
    expect(urls).toContain(`${ORIGIN}/oauth/revoke`);
    expect(urls.filter((url) => !url.startsWith(`${ORIGIN}/`))).toEqual([]);
    const line = lines.find((entry) => entry.includes('LINEAR_API_URL is set'));
    expect(line).toContain('"level":"error"');
    expect(line).toContain(ORIGIN);
  });

  test('without it, every call and the authorize link name Linear', async () => {
    const { authorizeUrl, urls, lines } = await signInAndOut({});
    expect(authorizeUrl.startsWith('https://linear.app/oauth/authorize?')).toBe(
      true
    );
    expect(urls).toContain('https://api.linear.app/oauth/token');
    expect(urls).toContain('https://api.linear.app/graphql');
    expect(urls).toContain('https://api.linear.app/oauth/revoke');
    expect(
      urls.filter((url) => !url.startsWith('https://api.linear.app/'))
    ).toEqual([]);
    expect(lines.some((entry) => entry.includes('LINEAR_API_URL'))).toBe(false);
  });
});
