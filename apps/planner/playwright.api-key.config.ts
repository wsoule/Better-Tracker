import { defineConfig, devices } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The api-key browser test (architecture §11): the ordinary production
// build (made WITHOUT LINEAR_AUTH, which proves the mode is read at
// runtime) served by `next start` with LINEAR_AUTH=api_key, talking to a
// loopback fake of Linear's GraphQL endpoint (e2e/fake-linear-server.ts)
// through the test-only LINEAR_API_URL. Run it as the moon task
// `planner:test-e2e-api-key`, which then runs e2e/scan-api-key-leaks.ts
// over E2E_ARTIFACTS_DIR.
//
// E2E_PORT is the planner's port, E2E_PORT + 1 the fake's. Everything the
// server writes (its log, PGlite, its TMPDIR) goes under E2E_ARTIFACTS_DIR
// so the scans can read it; Playwright's own output stays out of it, with
// traces, videos and HARs off (they would record the typed keys).

const portOffset = Number(process.env.WORKTREE_PORT_OFFSET ?? '0');
const port = Number(process.env.E2E_PORT ?? String(3392 + portOffset));
const fakePort = port + 1;
const baseURL = `http://localhost:${port}`;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;
const artifacts =
  process.env.E2E_ARTIFACTS_DIR ??
  mkdtempSync(join(tmpdir(), 'planner-api-key-e2e-'));
process.env.E2E_ARTIFACTS_DIR = artifacts;
mkdirSync(join(artifacts, 'server-tmp'), { recursive: true });

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/api-key.e2e.ts',
  outputDir: 'test-results/api-key',
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
    {
      command: `sh -c 'exec next start --port ${port} >>"$E2E_ARTIFACTS_DIR/server.log" 2>&1'`,
      url: `${baseURL}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        LINEAR_AUTH: 'api_key',
        LINEAR_FIXTURE: '',
        APP_URL: baseURL,
        LINEAR_API_URL: `http://127.0.0.1:${fakePort}/graphql`,
        LINEAR_WORKSPACE: 'acme',
        PGLITE_DIR: join(artifacts, 'pglite'),
        TMPDIR: join(artifacts, 'server-tmp'),
        LOG_LEVEL: 'debug',
        NODE_OPTIONS: '--disable-sigusr1',
        NEXT_TELEMETRY_DISABLED: '1',
        E2E_ARTIFACTS_DIR: artifacts,
      },
    },
  ],
});
