import { defineConfig, devices } from '@playwright/test';

// The planner's browser smoke test (architecture §11): a production build
// served by `next start` in demo mode (LINEAR_FIXTURE=1, the fictional
// in-memory workspace), so it never touches Linear and its edits vanish
// with the server. Run through moon (`moonx planner:test-e2e`; CI runs it as
// a `moon ci` target), which builds first. E2E_PORT picks the port (default
// 3390 plus WORKTREE_PORT_OFFSET, which the moon task loads from
// .env.worktree; scripts/README.md). PLAYWRIGHT_CHROMIUM_PATH points at a
// local Chromium when Playwright's own download is unavailable (agent
// sandboxes ship one under /opt/pw-browsers). Files are *.e2e.ts so
// `bun test` never picks them up.

const portOffset = Number(process.env.WORKTREE_PORT_OFFSET ?? '0');
const port = Number(process.env.E2E_PORT ?? String(3390 + portOffset));
const baseURL = `http://localhost:${port}`;
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  // The api-key run has its own config, servers and fake Linear
  // (playwright.api-key.config.ts).
  testIgnore: '**/api-key.e2e.ts',
  // One server, shared demo data: the tests run in order.
  workers: 1,
  fullyParallel: false,
  forbidOnly: process.env.CI !== undefined && process.env.CI !== '',
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    launchOptions:
      executablePath === undefined || executablePath === ''
        ? {}
        : { executablePath },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `next start --port ${port}`,
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { LINEAR_FIXTURE: '1', NEXT_TELEMETRY_DISABLED: '1' },
  },
});
