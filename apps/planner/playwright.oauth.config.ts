import { defineConfig, devices } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { E2E_OAUTH_CLIENT } from './e2e/fake-linear-oauth';
import { E2E_OAUTH_SERVER } from './e2e/oauth-leak-needles';

// The OAuth browser test (architecture §11): the ordinary production build
// served by `next start` in OAuth mode, against a loopback fake of Linear
// (e2e/fake-linear-server.ts: Acme and Globex, the token, revoke and
// authorize endpoints and GraphQL) through the test-only LINEAR_API_URL,
// whose origin also stands in for Linear's authorize page, so the browser
// signs in through the fake's workspace chooser. Run it as the moon task
// `planner:test-e2e-oauth`, which then runs e2e/scan-oauth-leaks.ts over
// E2E_ARTIFACTS_DIR.
//
// E2E_PORT is the planner's port (default 3394 plus WORKTREE_PORT_OFFSET),
// E2E_PORT + 1 the fake's, and E2E_PORT + 2 a second planner over its own
// database that admits only Acme (LINEAR_WORKSPACES=acme), for the
// refused sign-in. Everything the planners write (their logs, PGlite,
// their TMPDIR) goes under E2E_ARTIFACTS_DIR so the scans can read it;
// Playwright's own output stays out of it, with traces, videos and HARs
// off (they would record cookies).

const portOffset = Number(process.env.WORKTREE_PORT_OFFSET ?? '0');
const port = Number(process.env.E2E_PORT ?? String(3394 + portOffset));
const fakePort = port + 1;
const closedPort = port + 2;
const baseURL = `http://localhost:${port}`;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const artifacts =
  process.env.E2E_ARTIFACTS_DIR ??
  mkdtempSync(join(tmpdir(), 'planner-oauth-e2e-'));
process.env.E2E_ARTIFACTS_DIR = artifacts;
mkdirSync(join(artifacts, 'server-tmp'), { recursive: true });
mkdirSync(join(artifacts, 'server-closed-tmp'), { recursive: true });

// One OAuth-mode planner on `serverPort`: its admission list, its own
// PGlite directory, temp dir and log file under the artifacts.
function planner(serverPort: number, name: string, workspaces: string) {
  const url = `http://localhost:${serverPort}`;
  return {
    command: `sh -c 'exec next start --port ${serverPort} >>"$E2E_ARTIFACTS_DIR/${name}.log" 2>&1'`,
    url: `${url}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      LINEAR_AUTH: '',
      LINEAR_FIXTURE: '',
      APP_URL: url,
      LINEAR_API_URL: `http://127.0.0.1:${fakePort}/graphql`,
      LINEAR_CLIENT_ID: E2E_OAUTH_CLIENT.clientId,
      LINEAR_CLIENT_SECRET: E2E_OAUTH_CLIENT.clientSecret,
      TOKEN_ENCRYPTION_KEY: E2E_OAUTH_SERVER.tokenEncryptionKey,
      SESSION_SECRET: E2E_OAUTH_SERVER.sessionSecret,
      LINEAR_WORKSPACES: workspaces,
      DATABASE_URL: '',
      SLACK_BOT_TOKEN: '',
      PGLITE_DIR: join(
        artifacts,
        name === 'server' ? 'pglite' : 'pglite-closed'
      ),
      TMPDIR: join(artifacts, `${name}-tmp`),
      LOG_LEVEL: 'debug',
      NEXT_TELEMETRY_DISABLED: '1',
      E2E_ARTIFACTS_DIR: artifacts,
    },
  };
}

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/oauth.e2e.ts',
  outputDir: 'test-results/oauth',
  workers: 1,
  fullyParallel: false,
  forbidOnly: process.env.CI !== undefined && process.env.CI !== '',
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: {
    baseURL,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    launchOptions:
      executablePath === undefined || executablePath === ''
        ? {}
        : { executablePath },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `bun e2e/fake-linear-server.ts --port ${fakePort}`,
      url: `http://127.0.0.1:${fakePort}/__health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: { FAKE_LINEAR: '1', NODE_ENV: 'test' },
    },
    planner(port, 'server', 'acme,globex'),
    planner(closedPort, 'server-closed', 'acme'),
  ],
});
