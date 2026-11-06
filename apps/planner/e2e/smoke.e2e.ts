import { expect, type Page, test } from '@playwright/test';

import { expectScriptsNonced } from './csp-nonce';

// Browser smoke test of the planner in demo mode (architecture §11): every
// screen renders, dragging a milestone's due date re-dates it, an issue
// takes an edit, Ctrl K opens the palette, the slide-over's keyboard
// behaviour (focus on a swap, Esc with unsaved text) holds in a real
// browser, the dependency graph drills from initiatives down and back up
// (owner decision 2026-10-22, graphs at every level), draws every item of
// its scope (owner decision 2026-10-23) in Vadim's chart, which traces a
// box's upstream and downstream and highlights the critical path, and the
// demo's Linear guest gets a
// read-only planner
// (owner decision 2026-10-22, "Guests limited to read only") whose graphs
// fall back to the projects he can see. A return path that normalises to
// another host ("/.//evil.example") stays on the planner. Every page it
// opens, signed in or out (the landing and the public privacy, terms and
// contact pages too), carries the nonce Content-Security-Policy on each of
// its scripts (owner decision 2026-10-25: proxy.ts nonces every page in
// every mode; e2e/csp-nonce.ts). Demo data is fictional and lives only in
// this server.

/**
 * Signs in through the demo picker on "/" (Chloe Diaz unless told), then
 * parks the pointer in the top-left corner (the sidebar's brand row, never
 * a page's content). The click leaves the mouse on her row, mid-page, and
 * Chromium carries that position into every page the test opens next: on
 * a graph, a box laid out under it reads as pointed at, so the paths and
 * the readout show that box instead of the graph at rest. Where a box
 * lands depends on the text widths the machine renders (the graph toolbar
 * wraps onto a second row when they run a little wider, as on the CI
 * runner), so the corner keeps every test's starting point the same.
 */
async function signIn(page: Page, userId = 'user-chloe'): Promise<void> {
  await page.goto('/');
  await page
    .locator('form[action="/api/auth/demo"]')
    .filter({ has: page.locator(`input[value="${userId}"]`) })
    .getByRole('button')
    .click();
  await expect(page).toHaveURL(/\/week$/);
  await page.mouse.move(0, 0);
}

/** Collects uncaught page errors so a screen that throws fails the test. */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  return errors;
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test('every screen renders', async ({ page }) => {
  const errors = trackErrors(page);
  for (const path of [
    '/week',
    '/timeline',
    '/projects',
    '/graph',
    '/graph?level=initiative',
    '/graph?initiative=init-growth',
    '/graph?project=proj-atlas&level=milestone',
    '/graph?chain=ENG-23',
    '/graph?node=ms-atlas-2',
    '/runs',
    '/settings',
    '/issues',
    '/issues/ENG-24',
    '/setup',
  ]) {
    const response = await page.goto(path);
    await expectScriptsNonced(response, path);
    await expect(page.locator('h1').first(), path).toBeVisible();
    await expect(page.getByText('Something went wrong'), path).toHaveCount(0);
  }
  expect(errors).toEqual([]);
});

test('signed out: the landing and the public pages, every script nonced', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  const errors = trackErrors(page);
  for (const [path, heading] of [
    ['/', 'Your week, from Linear.'],
    ['/privacy', 'Privacy'],
    ['/terms', 'Terms'],
    ['/contact', 'Contact'],
  ] as const) {
    const response = await page.goto(path);
    await expectScriptsNonced(response, path);
    await expect(
      page.getByRole('heading', { level: 1, name: heading }),
      path
    ).toBeVisible();
    const footer = page.getByRole('navigation', { name: 'About this planner' });
    for (const name of ['Privacy', 'Terms', 'Contact']) {
      await expect(footer.getByRole('link', { name }), path).toBeVisible();
    }
  }
  // The demo's privacy page says it is fictional and keeps nothing of
  // the visitor; the footer link opens it from the landing page.
  await page.goto('/');
  await page
    .getByRole('navigation', { name: 'About this planner' })
    .getByRole('link', { name: 'Privacy' })
    .click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByText('This is a demo')).toBeVisible();
  expect(errors).toEqual([]);
  await context.close();
});

test('a link whose return path normalises to another host stays on the planner', async ({
  page,
  baseURL,
}) => {
  // "/.//evil.example" passes a same-origin check but normalises to
  // "//evil.example"; Next's client router follows a page-level
  // redirect() to it, which the browser reads as another host.
  const offsite: string[] = [];
  await page.route(
    (url) => url.hostname === 'evil.example',
    async (route) => {
      offsite.push(route.request().url());
      await route.fulfill({ status: 200, body: 'offsite' });
    }
  );
  for (const path of [
    '/open?to=%2F.%2F%2Fevil.example%2Flogin',
    '/open?to=%2F%252e%2F%2Fevil.example%2Fx',
    '/?returnTo=%2F.%2F%2Fevil.example%2Fland',
  ]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(`${baseURL}/week`);
    await expect(page.locator('h1').first(), path).toBeVisible();
  }
  expect(offsite).toEqual([]);
});

/** A drawn chart box by its graph node id ("iss-eng-12"). */
const chartBox = (page: Page, id: string) =>
  page.locator(`[data-chart-node="${id}"]`);

/** The inspector beside (or under) the chart. */
const inspector = (page: Page) => page.locator('[data-chart-inspector]');

test('the graph drills from initiatives to projects and back up', async ({
  page,
}) => {
  await page.goto('/graph?level=initiative');
  // A click traces the box and fills the inspector; a double-click on a
  // container drills into its own graph.
  const platform = chartBox(page, 'init-platform');
  await platform.getByRole('button').click();
  await expect(platform).toHaveAttribute('data-trace', 'sel');
  await expect(
    inspector(page).getByRole('heading', { name: 'Platform reliability' })
  ).toBeVisible();
  await platform.getByRole('button').dblclick();
  await expect(page).toHaveURL(/\/graph\?initiative=init-platform$/);
  await expect(page.locator('h1')).toHaveText(
    'Projects in Platform reliability'
  );
  // The trail above the heading zooms back out.
  await page
    .getByRole('navigation', { name: 'Graph scope' })
    .getByRole('link', { name: 'Workspace' })
    .click();
  await expect(page).toHaveURL(/\/graph\?level=initiative$/);
  await expect(page.locator('h1')).toHaveText('Dependencies');
});

test('the chart draws every container, and issues on a relation', async ({
  page,
}) => {
  // Compass's milestones wait on nothing: all three are drawn all the
  // same, each saying it has no dependencies; Box by parent frames them.
  await page.goto('/graph?project=proj-compass&level=milestone');
  await expect(page.locator('[data-chart-node]')).toHaveCount(3);
  await expect(
    page.getByRole('button', { name: /^Guided setup, .*No dependencies/ })
  ).toBeVisible();
  await page.getByRole('button', { name: 'Display' }).click();
  await page.getByRole('switch', { name: 'Box by parent' }).click();
  await expect(page.locator('[data-chart-group-title]')).toHaveText(
    'Compass onboarding'
  );
  // Something is drawn, so the level tabs sit in the chart's toolbar.
  const tabs = page.getByRole('navigation', { name: 'Graph level' });
  await expect(tabs.getByRole('link', { name: 'Issues' })).toHaveAttribute(
    'href',
    '/graph?project=proj-compass'
  );

  // The workspace's issue level follows Vadim's chart: the 9 issues on a
  // blocking relation, the other 42 one toggle away (the inspector says
  // so), then every issue in its frames.
  await page.goto('/graph?level=issue');
  await expect(page.locator('[data-chart-node]')).toHaveCount(9);
  await expect(page.locator('[data-chart-edge]')).toHaveCount(6);
  await expect(inspector(page)).toContainText(
    '42 issues with no blocking relation either way are left off'
  );
  await inspector(page).getByRole('button', { name: 'Show unlinked' }).click();
  await expect(page.locator('[data-chart-node]')).toHaveCount(51);
  await page.getByRole('button', { name: 'Display' }).click();
  await page.getByRole('switch', { name: 'Box by parent' }).click();
  await expect(page.locator('[data-chart-group]')).toHaveCount(28);
  await expect(page.locator('h1 + p')).toHaveText(
    /^51 issues in the workspace, 45 of them in 16 milestones; 6 blocking relations/
  );
  // The display choices are remembered for this scope.
  await page.reload();
  await expect(page.locator('[data-chart-node]')).toHaveCount(51);
});

test('an empty graph says so, with nothing to highlight', async ({ page }) => {
  // Garnet's Push notifications milestone holds no issue yet.
  await page.goto('/graph?milestone=ms-garnet-2');
  await expect(
    page.getByText('No issues in Push notifications.')
  ).toBeVisible();
  await expect(page.locator('[data-chart-node]')).toHaveCount(0);
  await expect(page.locator('[data-chart-preset]')).toHaveCount(0);
});

test('a milestone drawer opens what it waits on as a graph', async ({
  page,
}) => {
  await page.goto('/timeline?milestone=ms-beacon-1');
  await page
    .getByRole('dialog')
    .getByRole('link', { name: 'What it waits on' })
    .click();
  await expect(page).toHaveURL(/\/graph\?node=ms-beacon-1$/);
  // Arriving with ?node= traces the box and opens its details panel.
  await expect(chartBox(page, 'ms-beacon-1')).toHaveAttribute(
    'data-trace',
    'sel'
  );
  await expect(chartBox(page, 'ms-atlas-2')).toHaveAttribute(
    'data-trace',
    'up'
  );
  const panel = page.getByRole('dialog');
  await expect(panel).toContainText(
    'Waits on 1 · Holds up 1 · Finishing it would clear 1'
  );
  await expect(
    panel.getByRole('button', { name: 'Show Dual-write, Start here' })
  ).toBeVisible();
  // The inspector's Details reopens it once closed.
  await panel.getByRole('button', { name: /close/i }).first().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await inspector(page).getByRole('button', { name: 'Details' }).click();
  await expect(page.getByRole('dialog')).toContainText('Search v2 beta');
});

test('a chain traces its issue; the critical path numbers its steps', async ({
  page,
}) => {
  const errors = trackErrors(page);
  await page.goto('/graph?chain=ENG-23');
  // The chain's issue is traced on arrival: what it waits on and what it
  // holds up.
  await expect(chartBox(page, 'iss-eng-23')).toHaveAttribute(
    'data-trace',
    'sel'
  );
  await expect(chartBox(page, 'iss-eng-12')).toHaveAttribute(
    'data-trace',
    'up'
  );
  await expect(chartBox(page, 'iss-ops-20')).toHaveAttribute(
    'data-trace',
    'down'
  );
  await expect(page.locator('[data-chart-edge][data-tone="up"]')).toHaveCount(
    1
  );
  await expect(page.locator('[data-chart-edge][data-tone="down"]')).toHaveCount(
    1
  );
  // Critical path: the longest open chain, numbered.
  await page.locator('[data-chart-preset="critical"]').click();
  await expect(chartBox(page, 'iss-eng-12')).toHaveAttribute(
    'data-trace',
    'set'
  );
  await expect(inspector(page)).toContainText('Critical path · 3');
  // Escape on the canvas lets it go.
  await page.locator('[data-chart-stage]').focus();
  await page.keyboard.press('Escape');
  await expect(chartBox(page, 'iss-eng-12')).not.toHaveAttribute(
    'data-trace',
    /.*/
  );
  // Find (/) traces a box; Open issue opens its slide-over.
  await page.keyboard.press('/');
  await page
    .getByRole('combobox', { name: 'Find on the chart' })
    .fill('OPS-20');
  await page.keyboard.press('Enter');
  await expect(chartBox(page, 'iss-ops-20')).toHaveAttribute(
    'data-trace',
    'sel'
  );
  await inspector(page).getByRole('button', { name: 'Open issue' }).click();
  await expect(page).toHaveURL(/\/graph\?chain=ENG-23&issue=OPS-20$/);
  await expect(page.getByRole('dialog')).toContainText('Brand review sign-off');
  expect(errors).toEqual([]);
});

// On a phone the inspector moves under the canvas and a tap traces.
test.describe('the chart on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('a tap traces a box, and the inspector follows', async ({ page }) => {
    await page.goto('/graph?chain=ENG-23');
    const eng12 = chartBox(page, 'iss-eng-12');
    await eng12.getByRole('button').tap();
    await expect(eng12).toHaveAttribute('data-trace', 'sel');
    await expect(
      inspector(page).getByRole('heading', {
        name: /Reconcile dual-write drift/,
      })
    ).toBeVisible();
    const stage = await page.locator('[data-chart-stage]').boundingBox();
    const aside = await inspector(page).boundingBox();
    if (stage === null || aside === null) throw new Error('not laid out');
    expect(aside.y).toBeGreaterThanOrEqual(stage.y + stage.height - 1);
  });
});

test('dragging a due date re-dates the milestone', async ({ page }) => {
  await page.goto('/timeline');
  const handle = page.getByRole('slider', {
    name: 'Due date of General availability',
  });
  await handle.scrollIntoViewIfNeeded();
  const before = await handle.getAttribute('aria-valuenow');
  const box = await handle.boundingBox();
  if (box === null) throw new Error('the due-date handle is not visible');
  const y = box.y + box.height / 2;
  const saved = page.waitForResponse(
    (response) =>
      response.url().includes('/api/milestones/') &&
      response.request().method() === 'PATCH'
  );
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, y, { steps: 10 });
  await page.mouse.up();
  expect((await saved).status()).toBe(200);
  // The new date survives a reload (the server holds it, not the client).
  await page.reload();
  await expect(
    page.getByRole('slider', { name: 'Due date of General availability' })
  ).not.toHaveAttribute('aria-valuenow', before ?? '');
});

test('an issue takes an edit', async ({ page }) => {
  await page.goto('/issues/ENG-24');
  const title = 'Search analytics events (edited in e2e)';
  await page.getByRole('button', { name: /^Search analytics events/ }).click();
  const field = page.getByRole('textbox', { name: 'Title' });
  await field.fill(title);
  const saved = page.waitForResponse(
    (response) =>
      response.url().includes('/api/issues/') &&
      response.request().method() === 'PATCH'
  );
  await field.press('Enter');
  expect((await saved).status()).toBe(200);
  await page.reload();
  await expect(page.locator('h1')).toContainText(title);
});

test('Ctrl K opens the command palette', async ({ page }) => {
  await page.goto('/week');
  await page.locator('body').click();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog');
  await expect(palette).toBeVisible();
  await expect(palette.getByRole('combobox')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
});

test('a drawer swapped in place keeps focus in the panel', async ({ page }) => {
  await page.goto('/week?issue=ENG-12');
  const dialog = page.getByRole('dialog');
  // The drawer moves focus to itself once it has hydrated. Step into it
  // only after that, or its first focus pulls focus back off the row and
  // Enter lands on the panel instead of the link.
  await expect(dialog).toBeFocused();
  const row = dialog.locator('a[href*="ENG-23"]').first();
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/issue=ENG-23/);
  await expect(dialog).toBeFocused();
});

test('Esc in a field with unsaved text resets it before closing', async ({
  page,
}) => {
  await page.goto('/timeline?milestone=ms-atlas-2');
  // The panel takes focus once it has hydrated. Typing before that loses
  // the field's focus to the panel, and Esc then closes instead of
  // resetting (seen on a cold server).
  await expect(page.getByRole('dialog')).toBeFocused();
  const weight = page.getByLabel('Weight override');
  await weight.fill('3');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(weight).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

// Gus Hart is the demo's Linear guest (Operations only): he sees the
// pages Linear lets him see, with no edit control anywhere, and the
// server refuses his writes even when the UI is bypassed.
test.describe('a Linear guest', () => {
  const NOTICE = 'You are a guest in Linear, so this view is read-only.';

  test.beforeEach(async ({ page }) => {
    // The file's beforeEach signed Chloe in, and "/" sends a signed-in
    // person to My week: start from a signed-out browser.
    await page.context().clearCookies();
    await signIn(page, 'user-gus');
  });

  test('pages render read-only, with no edit controls', async ({ page }) => {
    const errors = trackErrors(page);
    for (const path of [
      '/week',
      '/timeline',
      '/projects',
      '/graph',
      '/runs',
      '/settings',
      '/issues',
      '/issues/OPS-1',
    ]) {
      await page.goto(path);
      await expect(page.locator('h1').first(), path).toBeVisible();
      await expect(page.getByText('Something went wrong'), path).toHaveCount(0);
    }
    expect(errors).toEqual([]);
    await expect(
      page.getByText('Guest', { exact: true }).first()
    ).toBeVisible();

    await page.goto('/timeline');
    await expect(page.getByText(NOTICE)).toBeVisible();
    await expect(page.getByRole('slider')).toHaveCount(0);
    await expect(page.getByText('Allow edits in Linear')).toHaveCount(0);

    await page.goto('/timeline?milestone=ms-compass-1');
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByText(NOTICE)).toBeVisible();
    await expect(drawer.getByRole('textbox')).toHaveCount(0);
    await expect(drawer.getByRole('spinbutton')).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: 'Save' })).toHaveCount(0);

    await page.goto('/issues/OPS-1');
    await expect(page.getByText(NOTICE)).toBeVisible();
    await expect(page.getByRole('textbox')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Add/ })).toHaveCount(0);

    await page.goto('/runs');
    await expect(page.getByText(NOTICE)).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Preview (dry run)' })
    ).toHaveCount(0);

    await page.goto('/settings');
    await expect(page.getByText(NOTICE)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
    await expect(page.getByRole('switch')).toHaveCount(0);
    await page.goto('/settings?section=status');
    await expect(page.getByRole('button', { name: 'Resync now' })).toHaveCount(
      0
    );
  });

  // Linear shows guests no initiatives: an initiative's graph is his
  // projects', with a notice, never a 404, and the levels he has.
  test('an initiative graph falls back to his projects', async ({ page }) => {
    const errors = trackErrors(page);
    // The status cannot tell the fallback from the not-found page (the
    // (app) loading boundary streams both with 200), so the page itself
    // must not be the not-found one.
    await page.goto('/graph?initiative=init-platform');
    await expect(page.locator('h1')).toHaveText('Dependencies');
    await expect(page.getByText('Nothing lives at this address.')).toHaveCount(
      0
    );
    await expect(
      page.getByText(
        'Linear shows guests no initiatives, so this graph covers every project you can see.'
      )
    ).toBeVisible();
    const tabs = page.getByRole('navigation', { name: 'Graph level' });
    await expect(tabs.getByRole('link')).toHaveText([
      'Projects',
      'Milestones',
      'Issues',
    ]);
    await expect(page.getByRole('link', { name: 'Initiatives' })).toHaveCount(
      0
    );
    // He sees no relation, but the four projects he can see are drawn.
    await expect(page.locator('[data-chart-node]')).toHaveCount(4);
    await expect(page.locator('[data-chart-group]')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('the palette keeps navigation and the theme, not runs', async ({
    page,
  }) => {
    await page.goto('/week');
    await page.locator('body').click();
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog');
    await expect(palette).toBeVisible();
    await expect(
      palette.getByRole('option', { name: /Switch theme/ })
    ).toBeVisible();
    await expect(
      palette.getByRole('option', { name: /Go to Timeline/ })
    ).toBeVisible();
    await expect(
      palette.getByRole('option', { name: /Preview allocation/ })
    ).toHaveCount(0);
    await expect(
      palette.getByRole('option', { name: /Resync from Linear/ })
    ).toHaveCount(0);
  });

  test('a direct write is refused by the server', async ({ page, baseURL }) => {
    const origin = baseURL ?? '';
    const patch = await page.request.patch('/api/issues/iss-ops-1', {
      data: { priority: 1 },
      headers: { origin },
    });
    expect(patch.status()).toBe(403);
    expect(await patch.json()).toMatchObject({
      error: { code: 'read_only' },
    });
    const run = await page.request.post('/api/runs', {
      data: { mode: 'dry_run' },
      headers: { origin },
    });
    expect(run.status()).toBe(403);
    const milestone = await page.request.patch('/api/milestones/ms-delta-1', {
      data: { weight: 5 },
      headers: { origin },
    });
    expect(milestone.status()).toBe(403);
  });
});
