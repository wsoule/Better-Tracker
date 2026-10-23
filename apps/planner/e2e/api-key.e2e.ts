import {
  type APIRequestContext,
  type APIResponse,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  request as playwrightRequest,
  test,
} from '@playwright/test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { FakeRequestRecord } from './fake-linear';
import { E2E_KEYS, LEAK_NEEDLES, needlesIn } from './leak-needles';

// The api-key browser test (architecture §11; playwright.api-key.config.ts):
// connecting with personal Linear API keys against a fake Linear, end to
// end. The tests run in order and share the server: the form, refused
// keys, a member connecting and editing (the edit goes out with her own
// key, raw), another workspace refused, a read-only key, per-viewer
// visibility, signing out on every device, refused posts, the rate limit,
// and finally a leak scan of every response, the server log and the build.
// Keys are obviously fake (TESTKEY).

test.describe.configure({ mode: 'serial' });

// The same ports as playwright.api-key.config.ts: the planner on E2E_PORT,
// the fake Linear on the next one.
const port = Number(
  process.env.E2E_PORT ??
    String(3392 + Number(process.env.WORKTREE_PORT_OFFSET ?? '0'))
);
const FAKE = `http://127.0.0.1:${port + 1}`;
const ARTIFACTS = process.env.E2E_ARTIFACTS_DIR ?? '';

/** Every response a test saw: its URL, headers and text body. */
const seen: Promise<{ url: string; text: string }>[] = [];

function record(context: BrowserContext): void {
  context.on('response', (response) => {
    seen.push(
      (async () => {
        const headers = await response.allHeaders().catch(() => ({}));
        let body = '';
        try {
          body = (await response.body()).toString('utf8');
        } catch {
          // Redirects and aborted requests have no body.
        }
        return {
          url: response.url(),
          text: `${JSON.stringify(headers)}\n${body}`,
        };
      })()
    );
  });
}

function recordApi(response: APIResponse): APIResponse {
  seen.push(
    (async () => ({
      url: response.url(),
      text: `${JSON.stringify(response.headers())}\n${await response.text().catch(() => '')}`,
    }))()
  );
  return response;
}

async function newContext(
  browser: Browser,
  baseURL: string
): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL });
  record(context);
  return context;
}

/** Pastes a key into the connect form on "/" and submits it. */
async function connect(page: Page, key: string): Promise<void> {
  await page.goto('/');
  const field = page.locator('input[name="apiKey"]');
  await field.fill(key);
  await page.getByRole('button', { name: 'Connect' }).click();
}

async function fakeRequests(): Promise<FakeRequestRecord[]> {
  const api = await playwrightRequest.newContext();
  try {
    const response = await api.get(`${FAKE}/__requests`);
    return (await response.json()) as FakeRequestRecord[];
  } finally {
    await api.dispose();
  }
}

const SYNC_OPERATIONS = [
  'Users',
  'Teams',
  'WorkflowStates',
  'Initiatives',
  'Projects',
  'ProjectMilestones',
  'ProjectIssues',
  'OpenIssuesWithoutProject',
  'IssueRelations',
  'TeamMemberships',
];

// Contexts shared by the tests below, in order.
let ana: BrowserContext;
let anaCookie = '';
let ben: BrowserContext;

test('1. the connect form: a password field, framing refused, every script nonced', async ({
  browser,
  baseURL,
}) => {
  const context = await newContext(browser, baseURL ?? '');
  const page = await context.newPage();
  const response = await page.goto('/');
  if (response === null) throw new Error('no response for /');
  const headers = await response.allHeaders();
  expect(headers['x-frame-options']).toBe('DENY');
  const csp = headers['content-security-policy'] ?? '';
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("'nonce-");
  expect(csp).toContain("'strict-dynamic'");
  const html = await response.text();
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  expect(scripts.length).toBeGreaterThan(0);
  for (const script of scripts) expect(script).toContain('nonce=');

  const field = page.locator(
    'form[action="/api/auth/key"] input[name="apiKey"]'
  );
  await expect(field).toHaveAttribute('type', 'password');
  await expect(field).toHaveAttribute('autocomplete', 'off');
  expect(await field.getAttribute('value')).toBeNull();
  expect(await field.inputValue()).toBe('');
  await expect(page.getByText('Sign in with Linear')).toHaveCount(0);
  await context.close();
});

test('2. a string that is not a key is refused by shape', async ({
  browser,
  baseURL,
}) => {
  const context = await newContext(browser, baseURL ?? '');
  const page = await context.newPage();
  await connect(page, 'not-a-key');
  await expect(page).toHaveURL(/\/\?auth_error=key_shape$/);
  await expect(
    page.getByText('That does not look like a Linear personal API key')
  ).toBeVisible();
  expect(await page.locator('input[name="apiKey"]').inputValue()).toBe('');
  await context.close();
});

test('3. a revoked key is refused by Linear', async ({ browser, baseURL }) => {
  const context = await newContext(browser, baseURL ?? '');
  const page = await context.newPage();
  await connect(page, E2E_KEYS.revoked);
  await expect(page).toHaveURL(/auth_error=key_rejected/);
  await expect(page.getByText('Linear did not accept that key')).toBeVisible();
  await context.close();
});

test('4. Ana connects: My week, a session cookie, and her key in Settings', async ({
  browser,
  baseURL,
}) => {
  ana = await newContext(browser, baseURL ?? '');
  const page = await ana.newPage();
  await connect(page, E2E_KEYS.member);
  await expect(page).toHaveURL(/\/week$/);
  await expect(page.getByText('Ship the billing export').first()).toBeVisible();
  const cookie = (await ana.cookies()).find((c) => c.name === 'mp_session');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Lax');
  expect(cookie?.expires).toBe(-1);
  anaCookie = cookie?.value ?? '';

  await page.goto('/settings?section=status');
  await expect(page.getByText('Your key', { exact: true })).toBeVisible();
  await expect(
    page.getByText('Mirror read with', { exact: true })
  ).toBeVisible();
  await expect(page.getByText('Ana Ruiz’s key')).toBeVisible();
  await expect(page.getByText('Scheduled jobs', { exact: true })).toBeVisible();
});

test("5. an edit goes out with Ana's own key, raw, and survives a reload", async () => {
  const page = await ana.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto('/issues/ENG-1');
  const title = 'Ship the billing export (edited with a key)';
  await page.getByRole('button', { name: /^Ship the billing export/ }).click();
  const field = page.getByRole('textbox', { name: 'Title' });
  await field.fill(title);
  const saved = page.waitForResponse(
    (r) => r.url().includes('/api/issues/') && r.request().method() === 'PATCH'
  );
  await field.press('Enter');
  expect((await saved).status()).toBe(200);
  await page.reload();
  await expect(page.locator('h1')).toContainText(title);
  expect(errors).toEqual([]);
  const requests = await fakeRequests();
  const updates = requests.filter((r) => r.operation === 'IssueUpdate');
  expect(updates).toEqual([
    {
      operation: 'IssueUpdate',
      auth: 'raw',
      who: 'member',
      keyInBodyOrUrl: false,
    },
  ]);
  expect(requests.filter((r) => r.auth === 'bearer')).toEqual([]);
  await page.close();
});

test('5b. a key pasted into the address bar is dropped before the page renders', async () => {
  const page = await ana.newPage();
  const response = await page.goto(
    `/issues?q=${encodeURIComponent(E2E_KEYS.member)}&state=all`
  );
  await expect(page).toHaveURL(/\/issues\?state=all$/);
  expect(response?.status()).toBe(200);
  expect(needlesIn(await page.content())).toEqual([]);
  await page.close();
});

test('6. a key from another workspace is refused without naming this one', async ({
  browser,
  baseURL,
}) => {
  const context = await newContext(browser, baseURL ?? '');
  const page = await context.newPage();
  await connect(page, E2E_KEYS.otherorg);
  await expect(page).toHaveURL(/auth_error=key_wrong_workspace/);
  await expect(page.getByText('a different Linear workspace')).toBeVisible();
  expect(await page.locator('body').innerText()).not.toContain('Acme');
  await context.close();
});

test('7. a read-only key: Linear refuses once, then the planner is read-only', async ({
  browser,
  baseURL,
}) => {
  const context = await newContext(browser, baseURL ?? '');
  const page = await context.newPage();
  await connect(page, E2E_KEYS.readonly);
  await expect(page).toHaveURL(/\/week$/);
  await page.goto('/issues/ENG-2');
  await page.getByRole('button', { name: /^Retire the old cron/ }).click();
  const field = page.getByRole('textbox', { name: 'Title' });
  await field.fill('Chloe tries an edit');
  const refused = page.waitForResponse(
    (r) => r.url().includes('/api/issues/') && r.request().method() === 'PATCH'
  );
  await field.press('Enter');
  expect((await refused).status()).toBe(403);
  await expect(page.getByText(/only allows reading/).first()).toBeVisible();

  await page.reload();
  await expect(
    page.getByText(/Your Linear API key only allows reading/).first()
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /^Retire the old cron/ })
  ).toHaveCount(0);
  const direct = recordApi(
    await page.request.patch('/api/issues/iss-eng-2', {
      data: { title: 'Direct' },
      headers: { origin: baseURL ?? '' },
    })
  );
  expect(direct.status()).toBe(403);
  expect(await direct.json()).toMatchObject({ error: { code: 'read_only' } });
  const updates = (await fakeRequests()).filter(
    (r) => r.operation === 'IssueUpdate' && r.who === 'readonly'
  );
  expect(updates).toHaveLength(1);

  // A read-only person can still sign out (it changes nothing in Linear).
  await page.goto('/settings?section=status');
  await page
    .getByRole('button', { name: 'Forget my key and sign out' })
    .click();
  await expect(page).toHaveURL(/\/\?signed_out=1$/);
  await context.close();
});

test('8. per-viewer visibility: Ben sees no Security, Gus only Platform', async ({
  browser,
  baseURL,
}) => {
  ben = await newContext(browser, baseURL ?? '');
  const benPage = await ben.newPage();
  await connect(benPage, E2E_KEYS.second);
  await expect(benPage).toHaveURL(/\/week$/);
  await benPage.goto('/issues?state=all', { waitUntil: 'networkidle' });
  await expect(benPage.getByText(/^ENG-\d+$/).first()).toBeVisible();
  await expect(benPage.getByText(/^MOB-\d+$/).first()).toBeVisible();
  await expect(benPage.getByText(/^SEC-\d+$/)).toHaveCount(0);

  const gus = await newContext(browser, baseURL ?? '');
  const gusPage = await gus.newPage();
  await connect(gusPage, E2E_KEYS.guest);
  await gusPage.goto('/issues?state=all', { waitUntil: 'networkidle' });
  await expect(
    gusPage.getByText('You are a guest in Linear, so this view is read-only.')
  ).toBeVisible();
  await expect(gusPage.getByText(/^ENG-\d+$/).first()).toBeVisible();
  await expect(gusPage.getByText(/^(MOB|SEC)-\d+$/)).toHaveCount(0);
  const guestSyncs = (await fakeRequests()).filter(
    (r) => r.who === 'guest' && SYNC_OPERATIONS.includes(r.operation)
  );
  expect(guestSyncs).toEqual([]);
  await gus.close();
});

test('9. signing out forgets the key on every device; a stale cookie says it cannot', async ({
  browser,
  baseURL,
}) => {
  const second = await newContext(browser, baseURL ?? '');
  const secondPage = await second.newPage();
  await connect(secondPage, E2E_KEYS.member);
  await expect(secondPage).toHaveURL(/\/week$/);

  const page = await ana.newPage();
  await page.goto('/settings?section=status');
  await page
    .getByRole('button', { name: 'Forget my key and sign out' })
    .click();
  await expect(page).toHaveURL(/\/\?signed_out=1$/);
  await expect(page.getByText('SIGNED OUT')).toBeVisible();

  const api = await playwrightRequest.newContext({ baseURL: baseURL ?? '' });
  const replay = recordApi(
    await api.get('/api/issues/options', {
      headers: { cookie: `mp_session=${anaCookie}` },
    })
  );
  expect(replay.status()).toBe(401);
  await api.dispose();
  const otherDevice = recordApi(
    await second.request.get('/api/issues/options')
  );
  expect(otherDevice.status()).toBe(401);

  await ana.addCookies([
    { name: 'mp_session', value: anaCookie, url: baseURL ?? '' },
  ]);
  await page.goto('/');
  await expect(page.locator('input[name="apiKey"]')).toBeVisible();
  await expect(page.getByText('CONNECTION ENDED')).toBeVisible();

  // Signing out again with that stale cookie: the planner no longer knows
  // whose it was, so it never claims the key was forgotten everywhere.
  const stale = recordApi(
    await page.request.post('/api/auth/logout', {
      headers: { origin: baseURL ?? '' },
      maxRedirects: 0,
    })
  );
  expect(stale.status()).toBe(303);
  expect(stale.headers()['location']).toBe('/?signed_out=ended');
  await page.goto('/?signed_out=ended');
  await expect(page.getByText('ALREADY DISCONNECTED')).toBeVisible();
  await expect(
    page.getByText('in every browser you connected it from')
  ).toHaveCount(0);

  const before = (await fakeRequests()).length;
  const benPage = await ben.newPage();
  const resync = recordApi(
    await benPage.request.post('/api/sync', {
      data: {},
      headers: { origin: baseURL ?? '' },
    })
  );
  expect(resync.status()).toBe(200);
  const syncs = (await fakeRequests())
    .slice(before)
    .filter((r) => SYNC_OPERATIONS.includes(r.operation));
  expect(syncs.length).toBeGreaterThan(0);
  expect(new Set(syncs.map((r) => r.who))).toEqual(new Set(['second']));
  await second.close();
  await page.close();
});

test('10. cross-site, null-origin and multipart posts are refused', async ({
  baseURL,
}) => {
  const api = await playwrightRequest.newContext({ baseURL: baseURL ?? '' });
  try {
    const form = { apiKey: E2E_KEYS.second };
    const evil = recordApi(
      await api.post('/api/auth/key', {
        form,
        headers: { origin: 'http://evil.example' },
        maxRedirects: 0,
      })
    );
    expect(evil.status()).toBe(403);
    const nullOrigin = recordApi(
      await api.post('/api/auth/key', {
        form,
        headers: { origin: 'null' },
        maxRedirects: 0,
      })
    );
    expect(nullOrigin.status()).toBe(403);
    const multipart = recordApi(
      await api.post('/api/auth/key', {
        multipart: form,
        headers: { origin: baseURL ?? '' },
        maxRedirects: 0,
      })
    );
    expect(multipart.status()).toBe(415);
  } finally {
    await api.dispose();
  }
});

test('11. the eleventh failure from one place is rate limited; another IP still connects', async ({
  baseURL,
}) => {
  const api: APIRequestContext = await playwrightRequest.newContext({
    baseURL: baseURL ?? '',
  });
  try {
    const post = async (key: string, headers: Record<string, string> = {}) =>
      recordApi(
        await api.post('/api/auth/key', {
          form: { apiKey: key },
          headers: { origin: baseURL ?? '', ...headers },
          maxRedirects: 0,
        })
      );
    // Tests 2, 3 and 6 put three failures in the shared no-ip bucket.
    for (let i = 0; i < 7; i++) {
      const response = await post('still-not-a-key');
      expect(response.headers()['location']).toBe('/?auth_error=key_shape');
    }
    const limited = await post('still-not-a-key');
    expect(limited.headers()['location']).toBe(
      '/?auth_error=connect_rate_limited'
    );
    expect(Number(limited.headers()['retry-after'])).toBeGreaterThan(0);

    const elsewhere = await post(E2E_KEYS.second, {
      'x-real-ip': '198.51.100.7',
    });
    expect(elsewhere.status()).toBe(303);
    expect(elsewhere.headers()['set-cookie'] ?? '').toContain('mp_session=');
  } finally {
    await api.dispose();
  }
});

// Every file under `dir`, recursively.
function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...files(path));
    else if (stat.isFile()) out.push(path);
  }
  return out;
}

test('12. no key in any response, the server log, the build or the fake’s requests', async () => {
  await ben.close();
  await ana.close();
  const responses = await Promise.all(seen);
  expect(responses.length).toBeGreaterThan(20);
  const leaking = responses
    .filter((response) => needlesIn(response.text).length > 0)
    .map((response) => response.url);
  expect(leaking).toEqual([]);

  expect(ARTIFACTS).not.toBe('');
  const log = readFileSync(join(ARTIFACTS, 'server.log'), 'utf8');
  expect(log).toContain('connected a Linear API key');
  expect(needlesIn(log)).toEqual([]);

  const build = join(import.meta.dirname, '..', '.next');
  const hits: string[] = [];
  for (const path of files(build)) {
    const bytes = readFileSync(path);
    for (const needle of LEAK_NEEDLES) {
      if (bytes.includes(needle)) hits.push(`${path}: ${needle.slice(0, 6)}…`);
    }
  }
  expect(hits).toEqual([]);

  const requests = await fakeRequests();
  expect(requests.length).toBeGreaterThan(10);
  expect(requests.filter((r) => r.keyInBodyOrUrl)).toEqual([]);
});
