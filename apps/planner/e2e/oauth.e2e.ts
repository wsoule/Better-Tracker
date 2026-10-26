import {
  type APIResponse,
  type Browser,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from '@playwright/test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { expectScriptsNonced } from './csp-nonce';
import type { FakeOrgKey } from './fake-linear-data';
import {
  type FakeOAuthRequestRecord,
  type FakeRequestRecord,
  isBearerRecord,
  isOAuthRecord,
  readFakeGrants,
  readFakeRequests,
} from './fake-linear-log';
import type { FakeGrantSummary } from './fake-linear-oauth';
import type { AuthorizeBehaviourChange } from './linear-authorize';
import { oauthNeedlesIn } from './oauth-leak-needles';

// The OAuth browser test (architecture §11; playwright.oauth.config.ts):
// one browser holding sessions for two Linear workspaces of the fake
// Linear, Acme (Ana is its admin) and Globex (Ana is a guest there, Gia
// its admin), end to end through the fake's own authorize page (its
// workspace chooser, reached through the test-only LINEAR_API_URL). The
// tests run in order and share the servers: Ana signs in to Acme, installs
// it and allows edits; connects Globex, which Gia installs; every page
// shows only the active workspace's data, through the brand-row switcher
// and the palette; connecting while Acme is open at Linear keeps her Acme
// session and its write grant; she is read-only in Globex and editable in
// Acme; a stale tab's write is refused 409 and its next navigation reloads
// it into the active workspace; a link for Globex opens the interstitial;
// signing out of Globex keeps Acme and revokes only Globex's grant; a
// planner that admits only Acme refuses Globex; and finally no Linear
// token or code, no secret and no session token is in any response, the
// servers' logs or their files.

test.describe.configure({ mode: 'serial' });

// The same ports as playwright.oauth.config.ts: the planner on E2E_PORT,
// the fake Linear on the next one, the Acme-only planner on the one after.
const port = Number(
  process.env.E2E_PORT ??
    String(3394 + Number(process.env.WORKTREE_PORT_OFFSET ?? '0'))
);
const APP = `http://localhost:${port}`;
const FAKE = `http://127.0.0.1:${port + 1}`;
const CLOSED = `http://localhost:${port + 2}`;
const ARTIFACTS = process.env.E2E_ARTIFACTS_DIR ?? '';

const NAME: Record<FakeOrgKey, string> = { acme: 'Acme', globex: 'Globex' };
const ORG_ID: Record<FakeOrgKey, string> = {
  acme: 'org-acme',
  globex: 'org-globex',
};

/**
 * Words only one workspace's data holds (issue titles, projects,
 * milestones, people), as Ana sees it there. A page of the other workspace
 * must show none of them, in its text or its HTML (RSC payload included).
 */
const MARKERS: Record<FakeOrgKey, readonly string[]> = {
  acme: [
    'Ship the billing export',
    'Retire the old cron',
    'Platform roadmap',
    'Security roadmap',
    'Platform beta',
    'Ben Ortiz',
    'Chloe Kim',
  ],
  globex: [
    'Launch the Globex storefront',
    'Take card payments at checkout',
    'Storefront roadmap',
    'Storefront beta',
    'Gia Moreau',
    'Hal Brandt',
  ],
};

/** Every page the switcher test visits, with what it shows per workspace. */
const PAGES: readonly [string, Record<FakeOrgKey, string>][] = [
  ['/week', { acme: 'Ship the billing export', globex: 'Gia Moreau' }],
  ['/timeline', { acme: 'Platform roadmap', globex: 'Storefront roadmap' }],
  ['/projects', { acme: 'Platform roadmap', globex: 'Storefront roadmap' }],
  ['/graph', { acme: 'Platform roadmap', globex: 'Storefront roadmap' }],
  [
    '/issues',
    { acme: 'Ship the billing export', globex: 'Launch the Globex storefront' },
  ],
  [
    '/issues/ENG-1',
    { acme: 'Ship the billing export', globex: 'Launch the Globex storefront' },
  ],
  [
    '/runs',
    { acme: 'No allocation runs yet.', globex: 'No allocation runs yet.' },
  ],
  [
    '/settings?section=status',
    { acme: 'linear.app/acme', globex: 'linear.app/globex' },
  ],
];

/** Every planner response a test saw: its URL, headers and body. */
const seen: Promise<{
  url: string;
  headers: Record<string, string>;
  body: string;
}>[] = [];
/** Every session token a planner set in a cookie (active or stashed). */
const sessionTokens = new Set<string>();

// Session cookie values from a response's Set-Cookie lines (one per line).
function collectSessionTokens(setCookie: string | undefined): void {
  for (const line of (setCookie ?? '').split('\n')) {
    const match = /^(mp_session|mp_sessions)=([^;]*)/.exec(line.trim());
    for (const token of (match?.[2] ?? '').split('.')) {
      if (token !== '') sessionTokens.add(token);
    }
  }
}

function isPlanner(url: string): boolean {
  return url.startsWith(`${APP}/`) || url.startsWith(`${CLOSED}/`);
}

function record(context: BrowserContext): void {
  context.on('response', (response) => {
    if (!isPlanner(response.url())) return;
    seen.push(
      (async () => {
        const headers: Record<string, string> = await response
          .allHeaders()
          .catch(() => ({}));
        collectSessionTokens(headers['set-cookie']);
        let body = '';
        try {
          body = (await response.body()).toString('utf8');
        } catch {
          // Redirects and aborted requests have no body.
        }
        return { url: response.url(), headers, body };
      })()
    );
  });
}

function recordApi(response: APIResponse): APIResponse {
  seen.push(
    (async () => {
      const headers = response.headers();
      collectSessionTokens(headers['set-cookie']);
      return {
        url: response.url(),
        headers,
        body: await response.text().catch(() => ''),
      };
    })()
  );
  return response;
}

async function newContext(
  browser: Browser,
  baseURL: string = APP
): Promise<BrowserContext> {
  const context = await browser.newContext({ baseURL });
  record(context);
  return context;
}

/** Changes how the fake's authorize page answers from now on. */
async function authorizeBehaviour(
  changes: AuthorizeBehaviourChange
): Promise<void> {
  const response = await fetch(`${FAKE}/__oauth/authorize-behaviour`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(changes),
  });
  expect(response.status).toBe(200);
}

/**
 * On the fake's workspace chooser: picks `org` as `who` (a handle) and
 * waits for the planner's answer. Returns what the chooser said it was
 * asked for.
 */
async function choose(
  page: Page,
  org: FakeOrgKey,
  who: string,
  planner: string = APP
): Promise<{ scopes: string; actor: string; prompt: string }> {
  await expect(page).toHaveURL(new RegExp(`^${FAKE}/oauth/authorize\\?`));
  const asked = {
    scopes: await page.getByTestId('scopes').innerText(),
    actor: await page.getByTestId('actor').innerText(),
    prompt: await page.getByTestId('prompt').innerText(),
  };
  await page.getByLabel(`${NAME[org]} account`).selectOption(who);
  await page.getByRole('button', { name: NAME[org], exact: true }).click();
  await page.waitForURL((url) => url.href.startsWith(`${planner}/`));
  return asked;
}

/** The brand row's switcher button, named after the active workspace. */
function switcher(page: Page, org: FakeOrgKey) {
  return page.getByRole('button', {
    name: `Milestone Planner ${NAME[org]}, switch workspace`,
  });
}

/**
 * Opens a popup with `open` until `popup` shows: a click or key press
 * before the page has hydrated does nothing, so it is tried again (never
 * twice while the popup is up, which would close it).
 */
async function openPopup(
  popup: Locator,
  open: () => Promise<void>
): Promise<Locator> {
  await expect(async () => {
    if (!(await popup.isVisible())) await open();
    await expect(popup).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  return popup;
}

/** Opens the brand row's workspace menu (the switcher's listbox). */
function openMenu(page: Page, org: FakeOrgKey): Promise<Locator> {
  return openPopup(page.getByRole('listbox', { name: 'Workspace' }), () =>
    switcher(page, org).click()
  );
}

/** Switches with the brand-row switcher and waits for the reload. */
async function switchWithMenu(
  page: Page,
  from: FakeOrgKey,
  to: FakeOrgKey
): Promise<void> {
  const menu = await openMenu(page, from);
  await menu.getByRole('option', { name: new RegExp(NAME[to]) }).click();
  await expect(switcher(page, to)).toBeVisible();
}

/** Switches from the palette's "Switch to <name>" and waits for the reload. */
async function switchWithPalette(
  page: Page,
  from: FakeOrgKey,
  to: FakeOrgKey
): Promise<void> {
  await expect(switcher(page, from)).toBeVisible();
  const palette = await openPopup(page.getByRole('dialog'), () =>
    page.keyboard.press('Control+k')
  );
  await palette
    .getByRole('option', { name: new RegExp(`Switch to ${NAME[to]}`) })
    .click();
  await expect(switcher(page, to)).toBeVisible();
}

/**
 * Opens `path` and checks it shows `org`'s data only: the switcher names
 * `org`, the page shows `marker`, and neither its text nor its HTML holds
 * a word of the other workspace's data. Every script on it carries the
 * response's CSP nonce.
 */
async function expectOnly(
  page: Page,
  org: FakeOrgKey,
  path: string,
  marker: string
): Promise<void> {
  const response = await page.goto(path, { waitUntil: 'networkidle' });
  expect(response?.status(), path).toBe(200);
  // OAuth pages get the nonce policy too (proxy.ts, every mode).
  await expectScriptsNonced(response, path);
  const html = (await response?.text()) ?? '';
  await expect(switcher(page, org)).toBeVisible();
  await expect(page.locator('main')).toContainText(marker);
  // The HTML holds the page's own data, so a miss below means something.
  expect(html, path).toContain(marker);
  const other = MARKERS[org === 'acme' ? 'globex' : 'acme'];
  const text = await page.locator('body').innerText();
  const shown = other.filter((word) => text.includes(word));
  const inHtml = other.filter((word) => html.includes(word));
  expect({ path, shown, inHtml }).toEqual({ path, shown: [], inHtml: [] });
}

/** The fake's OAuth records from `from` on (oldest first). */
async function oauthRecordsSince(
  from: number
): Promise<FakeOAuthRequestRecord[]> {
  return (await readFakeRequests(FAKE)).slice(from).filter(isOAuthRecord);
}

/** What a revoke record says, for comparing lists. */
function revoked(record: FakeOAuthRequestRecord) {
  return {
    org: record.org,
    who: record.who,
    tokenType: record.tokenType,
    effect: record.effect,
  };
}

async function grantsOf(
  org: FakeOrgKey,
  who: string
): Promise<FakeGrantSummary[]> {
  return (await readFakeGrants(FAKE)).filter(
    (grant) => grant.org === org && grant.who === who
  );
}

/** Edits an issue's title on its page and returns the PATCH answer. */
async function editTitle(
  page: Page,
  current: RegExp,
  title: string
): Promise<number> {
  await page.getByRole('button', { name: current }).click();
  const field = page.getByRole('textbox', { name: 'Title' });
  await field.fill(title);
  const saved = page.waitForResponse(
    (r) => r.url().includes('/api/issues/') && r.request().method() === 'PATCH'
  );
  await field.press('Enter');
  return (await saved).status();
}

// Contexts shared by the tests below, in order.
let ana: BrowserContext;
let page: Page;

test('1. Ana signs in to Acme through the chooser and lands on Setup', async ({
  browser,
}) => {
  ana = await newContext(browser);
  page = await ana.newPage();
  await page.goto('/');
  await page.getByRole('link', { name: 'Sign in with Linear' }).click();
  const asked = await choose(page, 'acme', 'ana');
  expect(asked).toEqual({ scopes: 'read', actor: 'user', prompt: '' });
  await expect(page).toHaveURL(`${APP}/setup`);
  await expect(page.getByText('Acme · not installed yet')).toBeVisible();
  await expect(switcher(page, 'acme')).toBeVisible();
  const cookie = (await ana.cookies()).find((c) => c.name === 'mp_session');
  expect(cookie?.httpOnly).toBe(true);
  expect(cookie?.sameSite).toBe('Lax');
  expect(cookie?.path).toBe('/');
  expect((await ana.cookies()).map((c) => c.name)).not.toContain('mp_sessions');
});

test('2. Ana installs Acme as its admin and allows edits', async () => {
  await page.getByRole('link', { name: 'Install in Linear' }).click();
  const asked = await choose(page, 'acme', 'ana');
  expect(asked).toEqual({
    scopes: 'read,write,initiative:read',
    actor: 'app',
    prompt: 'consent',
  });
  await expect(page).toHaveURL(`${APP}/timeline`);
  await expect(page.locator('main')).toContainText('Platform roadmap');

  await page.getByRole('link', { name: 'Allow edits in Linear' }).click();
  expect((await choose(page, 'acme', 'ana')).scopes).toBe('read,write');
  await expect(page).toHaveURL(`${APP}/timeline`);
  await expect(page.locator('main')).toContainText('Platform roadmap');
  await expect(
    page.getByRole('link', { name: 'Allow edits in Linear' })
  ).toHaveCount(0);
  const live = (await grantsOf('acme', 'ana')).filter((g) => !g.revoked);
  expect(live.map((g) => g.scopes.includes('write'))).toEqual([true]);
});

test('3. Ana connects Globex from the workspace menu and lands on Setup; Gia installs it', async ({
  browser,
}) => {
  await page.goto('/week');
  const menu = await openMenu(page, 'acme');
  await menu.getByRole('option', { name: 'Connect another workspace' }).click();
  await expect(page).toHaveURL(`${APP}/setup/connect`);
  await expect(
    page.getByText(
      'Linear connects the workspace you have open at linear.app. Open the one you want to add there first.'
    )
  ).toBeVisible();
  await page.getByRole('link', { name: 'Continue to Linear' }).click();
  const asked = await choose(page, 'globex', 'ana');
  expect(asked).toEqual({ scopes: 'read', actor: 'user', prompt: 'consent' });
  // Globex has no installation yet, so the connect lands on Setup.
  await expect(page).toHaveURL(`${APP}/setup`);
  await expect(page.getByText('Globex · not installed yet')).toBeVisible();
  await expect(switcher(page, 'globex')).toBeVisible();
  const names = (await ana.cookies()).map((c) => c.name).sort();
  expect(names).toContain('mp_session');
  expect(names).toContain('mp_sessions');

  // Ana is a guest in Globex: its admin, Gia, installs it.
  const gia = await newContext(browser);
  const giaPage = await gia.newPage();
  await giaPage.goto('/');
  await giaPage.getByRole('link', { name: 'Sign in with Linear' }).click();
  await choose(giaPage, 'globex', 'gia');
  await expect(giaPage).toHaveURL(`${APP}/setup`);
  await giaPage.getByRole('link', { name: 'Install in Linear' }).click();
  expect((await choose(giaPage, 'globex', 'gia')).actor).toBe('app');
  await expect(giaPage).toHaveURL(`${APP}/timeline`);
  await expect(giaPage.locator('main')).toContainText('Storefront roadmap');
  await gia.close();
});

test('4. every page shows only the active workspace, through the switcher and the palette', async () => {
  for (const [path, marker] of PAGES) {
    await expectOnly(page, 'globex', path, marker.globex);
  }
  await switchWithMenu(page, 'globex', 'acme');
  for (const [path, marker] of PAGES) {
    await expectOnly(page, 'acme', path, marker.acme);
  }
  await switchWithPalette(page, 'acme', 'globex');
  await expectOnly(
    page,
    'globex',
    '/issues/ENG-1',
    'Launch the Globex storefront'
  );
});

test("5. connecting while Acme is open at Linear keeps Ana's Acme session and its write grant", async () => {
  const [writeGrant] = (await grantsOf('acme', 'ana')).filter(
    (g) => !g.revoked
  );
  expect(writeGrant?.scopes).toContain('write');
  const from = (await readFakeRequests(FAKE)).length;
  // Linear authorizes whichever workspace is open, even with prompt=consent.
  await authorizeBehaviour({ open: 'acme', chooser: 'never' });
  try {
    await page.goto('/setup/connect');
    await page.getByRole('link', { name: 'Continue to Linear' }).click();
    await page.waitForURL(`${APP}/week?connect=same`);
  } finally {
    await authorizeBehaviour({ open: null, chooser: 'always' });
  }
  await expect(
    page.getByText(
      'Linear connected Acme again, which this browser already has.',
      { exact: false }
    )
  ).toBeVisible();
  await expect(switcher(page, 'acme')).toBeVisible();

  // The new read grant was revoked at once; the write grant is untouched.
  await expect
    .poll(async () =>
      (await oauthRecordsSince(from))
        .filter((r) => r.operation === 'oauth/revoke')
        .map(revoked)
    )
    .toEqual([
      {
        org: 'acme',
        who: 'ana',
        tokenType: 'refresh_token',
        effect: 'revoked',
      },
    ]);
  const live = (await grantsOf('acme', 'ana')).filter((g) => !g.revoked);
  expect(live.map((g) => g.grant)).toEqual([writeGrant?.grant]);

  // And Ana still edits in Acme, with that grant.
  await page.goto('/issues/ENG-1', { waitUntil: 'networkidle' });
  const before = (await readFakeRequests(FAKE)).length;
  expect(
    await editTitle(
      page,
      /^Ship the billing export/,
      'Ship the billing export, edited in Acme'
    )
  ).toBe(200);
  await page.reload();
  await expect(page.locator('h1')).toContainText(
    'Ship the billing export, edited in Acme'
  );
  const updates = (await readFakeRequests(FAKE))
    .slice(before)
    .filter(isBearerRecord)
    .filter((r) => r.operation === 'IssueUpdate');
  expect(updates.map((r) => [r.org, r.who, r.status])).toEqual([
    ['acme', 'ana', 200],
  ]);
});

test('6. Ana is read-only in Globex, a guest there, and editable in Acme', async () => {
  await page.goto('/week');
  await switchWithPalette(page, 'acme', 'globex');
  await page.goto('/issues/ENG-1', { waitUntil: 'networkidle' });
  await expect(page.locator('h1')).toContainText(
    'Launch the Globex storefront'
  );
  await expect(
    page.getByText('You are a guest in Linear, so this view is read-only.')
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /^Launch the Globex storefront/ })
  ).toHaveCount(0);
  const before = (await readFakeRequests(FAKE)).length;
  const direct = recordApi(
    await page.request.patch('/api/issues/gx-iss-eng-1', {
      data: { title: 'A guest edit' },
      headers: { origin: APP, 'x-planner-workspace': ORG_ID.globex },
    })
  );
  expect(direct.status()).toBe(403);
  expect(await direct.json()).toMatchObject({ error: { code: 'read_only' } });
  const writes = (await readFakeRequests(FAKE))
    .slice(before)
    .filter(isBearerRecord)
    .filter((r) => r.operation === 'IssueUpdate');
  expect(writes).toEqual([]);

  await switchWithMenu(page, 'globex', 'acme');
  await page.goto('/issues/ENG-1', { waitUntil: 'networkidle' });
  await expect(
    page.getByRole('button', { name: /^Ship the billing export/ })
  ).toBeVisible();
  await expect(
    page.getByText('You are a guest in Linear, so this view is read-only.')
  ).toHaveCount(0);
});

test('7. a stale tab is refused 409 workspace_changed, and its next navigation reloads it', async () => {
  const stale = await ana.newPage();
  await stale.goto('/issues/ENG-1', { waitUntil: 'networkidle' });
  await expect(switcher(stale, 'acme')).toBeVisible();

  // Another tab of the same browser switches to Globex.
  const other = await ana.newPage();
  await other.goto('/week');
  await switchWithMenu(other, 'acme', 'globex');
  await other.close();

  const before = (await readFakeRequests(FAKE)).length;
  expect(
    await editTitle(
      stale,
      /^Ship the billing export/,
      'Written from a stale tab'
    )
  ).toBe(409);
  const toast = stale
    .getByRole('listitem')
    .filter({ has: stale.getByRole('button', { name: 'Reload' }) });
  await expect(toast).toContainText('Not saved');
  await expect(toast).toContainText(
    'This tab shows Acme, but this browser switched to Globex in another tab. Reload to continue in Globex, or switch back to Acme.'
  );
  // No write reached either workspace.
  const writes = (await readFakeRequests(FAKE))
    .slice(before)
    .filter(isBearerRecord)
    .filter((r) => r.operation.endsWith('Update'));
  expect(writes).toEqual([]);

  // A client navigation renders Globex's page under Acme's shell for a
  // moment; the guard reloads the tab into Globex (a full load, which
  // drops the mark this document carries).
  await stale.keyboard.press('Escape');
  await stale.evaluate(() => {
    (window as unknown as { staleMark?: boolean }).staleMark = true;
  });
  await stale.getByRole('link', { name: 'Timeline', exact: true }).click();
  await expect(switcher(stale, 'globex')).toBeVisible();
  expect(
    await stale.evaluate(
      () => (window as unknown as { staleMark?: boolean }).staleMark
    )
  ).toBeUndefined();
  await expect(stale).toHaveURL(`${APP}/timeline`);
  await expect(stale.locator('main')).toContainText('Storefront roadmap');
  await expect(stale.locator('body')).not.toContainText('Platform roadmap');
  await stale.close();
});

test('8. a link for Globex opened while Acme is active shows the interstitial, whose Switch lands on Globex', async () => {
  await page.goto('/week');
  await switchWithMenu(page, 'globex', 'acme');
  // A digest's link names its workspace; the proxy sends it to /open.
  await page.goto(`/timeline?ws=${ORG_ID.globex}`);
  await expect(page).toHaveURL(/\/open\?/);
  await expect(page.getByText('This link is for Globex.')).toBeVisible();
  await page.getByRole('button', { name: 'Switch to Globex' }).click();
  await expect(page).toHaveURL(`${APP}/timeline`);
  await expect(switcher(page, 'globex')).toBeVisible();
  await expect(page.locator('main')).toContainText('Storefront roadmap');
});

test("9. signing out of Globex keeps Acme and revokes only Globex's grant", async () => {
  const [acmeGrant] = (await grantsOf('acme', 'ana')).filter((g) => !g.revoked);
  const from = (await readFakeRequests(FAKE)).length;
  await page.goto('/week');
  await page.getByRole('button', { name: 'Sign out of Globex' }).click();
  await expect(page).toHaveURL(/\/week\?signed_out=1/);
  await expect(
    page.getByText('Signed out of Globex. Still signed in to Acme.')
  ).toBeVisible();
  await expect(switcher(page, 'acme')).toBeVisible();
  await expect
    .poll(async () =>
      (await oauthRecordsSince(from))
        .filter((r) => r.operation === 'oauth/revoke')
        .map(revoked)
    )
    .toEqual([
      {
        org: 'globex',
        who: 'ana',
        tokenType: 'refresh_token',
        effect: 'revoked',
      },
    ]);
  expect((await grantsOf('globex', 'ana')).every((g) => g.revoked)).toBe(true);
  expect(
    (await grantsOf('acme', 'ana'))
      .filter((g) => !g.revoked)
      .map((g) => g.grant)
  ).toEqual([acmeGrant?.grant]);
  // Both installations keep their app grants.
  const apps = (await readFakeGrants(FAKE)).filter((g) => g.actor === 'app');
  expect(
    apps
      .map((g) => `${g.org} ${g.revoked ? 'revoked' : 'live'}`)
      .sort((a, b) => a.localeCompare(b))
  ).toEqual(['acme live', 'globex live']);

  // Acme still works, and the menu holds only Acme now.
  await expectOnly(page, 'acme', '/issues', 'Ship the billing export');
  const options = (await openMenu(page, 'acme')).getByRole('option');
  await expect(options).toHaveCount(2);
  await expect(options.nth(1)).toHaveText('Connect another workspace');
  await page.keyboard.press('Escape');
});

test('10. a planner that admits only Acme refuses Globex at sign-in', async ({
  browser,
}) => {
  const from = (await readFakeRequests(FAKE)).length;
  const context = await newContext(browser, CLOSED);
  const closed = await context.newPage();
  await closed.goto('/');
  await closed.getByRole('link', { name: 'Sign in with Linear' }).click();
  await choose(closed, 'globex', 'ana', CLOSED);
  await expect(closed).toHaveURL(`${CLOSED}/?auth_error=workspace_not_allowed`);
  await expect(
    closed.getByText('This planner is not open to that Linear workspace yet.', {
      exact: false,
    })
  ).toBeVisible();
  expect((await context.cookies()).map((c) => c.name)).not.toContain(
    'mp_session'
  );
  // The grant Linear issued for Globex was revoked at once.
  await expect
    .poll(async () =>
      (await oauthRecordsSince(from))
        .filter((r) => r.operation === 'oauth/revoke')
        .map(revoked)
    )
    .toEqual([
      {
        org: 'globex',
        who: 'ana',
        tokenType: 'refresh_token',
        effect: 'revoked',
      },
    ]);
  await context.close();
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

test('11. no Linear token or code, secret or session token in any response, log or file', async () => {
  await ana.close();
  const responses = await Promise.all(seen);
  expect(responses.length).toBeGreaterThan(50);
  // Client navigations' RSC payloads were among them.
  expect(
    responses.some((r) =>
      r.headers['content-type']?.includes('text/x-component')
    )
  ).toBe(true);
  // Ana's two Acme sessions (signed in, then allowed edits), her Globex
  // one and Gia's: the connect=same session never reached a cookie.
  expect(sessionTokens.size).toBeGreaterThanOrEqual(4);
  const tokens = [...sessionTokens];
  const leaking: string[] = [];
  for (const response of responses) {
    const { 'set-cookie': setCookie = '', ...rest } = response.headers;
    const text = `${JSON.stringify(rest)}\n${response.body}`;
    if (oauthNeedlesIn(`${text}\n${setCookie}`).length > 0) {
      leaking.push(`${response.url}: an OAuth needle`);
    }
    if (tokens.some((token) => text.includes(token))) {
      leaking.push(`${response.url}: a session token outside Set-Cookie`);
    }
  }
  expect(leaking).toEqual([]);

  expect(ARTIFACTS).not.toBe('');
  const log = readFileSync(join(ARTIFACTS, 'server.log'), 'utf8');
  expect(log).toContain('LINEAR_API_URL is set');
  expect(log).toContain('signed in');
  const hits: string[] = [];
  for (const path of files(ARTIFACTS)) {
    const bytes = readFileSync(path);
    for (const token of tokens) {
      if (bytes.includes(token)) hits.push(`${path}: a session token`);
    }
    if (path.endsWith('.log')) {
      const found = oauthNeedlesIn(bytes.toString('utf8'));
      if (found.length > 0) hits.push(`${path}: ${found.length} needle(s)`);
    }
  }
  expect([...new Set(hits)]).toEqual([]);

  const requests: FakeRequestRecord[] = await readFakeRequests(FAKE);
  expect(requests.filter(isBearerRecord).length).toBeGreaterThan(20);
  expect(
    requests.filter(isBearerRecord).filter((r) => r.tokenInBodyOrUrl)
  ).toEqual([]);
  expect(requests.filter((r) => r.keyInBodyOrUrl)).toEqual([]);
});
