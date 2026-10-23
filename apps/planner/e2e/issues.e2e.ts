import { expect, type Page, test } from '@playwright/test';

// The Issues page in a real browser (owner request 2026-10-22, "every
// issue in one list"; architecture §8.4 "Issues"), in demo mode: the
// default grouped view, a filter chosen from the Filter menu that lives in
// the URL (reload, Back and Forward restore it), empty milestones listed
// as targets for a project's unplanned issues, the slide-over, the /tasks
// redirect, the phone width, and the guest's read-only page; then moving
// issues: a shift-click selection moved with the bulk bar (kept after a
// reload), the `m` key with Undo, a drag onto another milestone, the
// phone's Select mode, and the guest's refused write. Every move is put
// back, so later tests (and smoke.e2e.ts) see the demo as it was.

/** Signs in through the demo picker on "/" (Chloe Diaz unless told). */
async function signIn(page: Page, userId = 'user-chloe'): Promise<void> {
  await page.goto('/');
  await page
    .locator('form[action="/api/auth/demo"]')
    .filter({ has: page.locator(`input[value="${userId}"]`) })
    .getByRole('button')
    .click();
  await expect(page).toHaveURL(/\/week$/);
}

/** Collects uncaught page errors so a screen that throws fails the test. */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  return errors;
}

const filters = (page: Page) =>
  page.getByRole('group', { name: 'Issue filters' });

/** A filter chip, by its picker's accessible name ("Project filter: …"). */
const chip = (page: Page, name: string) =>
  filters(page).getByRole('button', { name });

test.describe('as a member', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('the default view: milestone groups under the tier dividers', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await page.goto('/issues');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Issues');
    for (const tier of [
      'Overdue',
      'Upcoming',
      'No milestone',
      'Inactive projects',
    ]) {
      await expect(
        page.getByRole('heading', { level: 2, name: new RegExp(`^${tier}`) })
      ).toBeVisible();
    }
    await expect(
      page
        .getByRole('navigation', { name: 'Issue presets' })
        .getByRole('link', { name: /^All/ })
    ).toHaveAttribute('aria-current', 'page');
    await expect(chip(page, 'Status filter: open')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('a project filter lives in the URL: reload, Back and Forward', async ({
    page,
  }) => {
    await page.goto('/issues', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await page.getByRole('option', { name: 'Project', exact: true }).click();
    await page.getByRole('option', { name: 'Garnet mobile app' }).click();
    await expect(page).toHaveURL(/\/issues\?project=proj-garnet$/);
    await page.keyboard.press('Escape');
    const garnet = chip(page, 'Project filter: Garnet mobile app');
    await expect(garnet).toBeVisible();
    await expect(page.getByText('Dual-write invoices')).toHaveCount(0);

    await page.reload();
    await expect(garnet).toBeVisible();

    await page.goBack();
    await expect(page).toHaveURL(/\/issues$/);
    await expect(garnet).toHaveCount(0);
    await expect(page.getByText('Dual-write invoices')).toBeVisible();

    await page.goForward();
    await expect(page).toHaveURL(/\/issues\?project=proj-garnet$/);
    await expect(garnet).toBeVisible();
  });

  test('a project’s unplanned issues come with its milestones as targets', async ({
    page,
  }) => {
    await page.goto('/issues?project=proj-garnet&milestone=none');
    await expect(page.getByText('Crash on cold start')).toBeVisible();
    await expect(page.getByText('Dark mode icons')).toBeVisible();
    // Push notifications is empty; Offline mode's own issues do not match.
    await expect(page.getByText('No open issues here yet.')).toBeVisible();
    await expect(
      page.getByText('None of its 3 open issues match these filters.')
    ).toBeVisible();
  });

  test('a title opens the issue in the slide-over', async ({ page }) => {
    await page.goto('/issues', { waitUntil: 'networkidle' });
    await page.getByRole('link', { name: 'Dual-write invoices' }).click();
    await expect(page).toHaveURL(/[?&]issue=ENG-10$/);
    const drawer = page.getByRole('dialog');
    await expect(drawer).toContainText('Dual-write invoices');
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/\/issues$/);
  });

  // The graph-highlight cookie is Path=/graph, and a page loaded at
  // /issues never sees it from script, even once a link has moved it to
  // /graph: the graph island takes the server's read of it instead, so
  // "Open as graph" and a row's Blocking chain keep the mode picked on
  // this device, as a reload does.
  test('links into the graph keep the highlight picked on this device', async ({
    page,
  }) => {
    await page.goto('/graph', { waitUntil: 'networkidle' });
    await page
      .getByRole('radiogroup', { name: 'Highlight' })
      .getByRole('radio', { name: 'Risk' })
      .click();
    await expect(page).toHaveURL(/\/graph\?highlight=risk$/);
    await page.goto('/issues?project=proj-atlas', { waitUntil: 'networkidle' });
    await page.getByRole('link', { name: 'Open as graph' }).click();
    await expect(page).toHaveURL(/\/graph\?project=proj-atlas&highlight=risk$/);
    await expect(page.locator('[data-highlight]')).toHaveAttribute(
      'data-highlight',
      'risk'
    );
    await page.goto('/issues?project=proj-atlas', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Actions for ENG-12' }).click();
    await page.getByRole('option', { name: 'Blocking chain' }).click();
    await expect(page).toHaveURL(/\/graph\?chain=ENG-12&highlight=risk$/);
    await expect(page.locator('[data-highlight]')).toHaveAttribute(
      'data-highlight',
      'risk'
    );
    await expect(
      page
        .getByRole('radiogroup', { name: 'Highlight' })
        .getByRole('radio', { name: 'Risk' })
    ).toHaveAttribute('aria-checked', 'true');
  });

  test('the search narrows the list and keeps one history entry', async ({
    page,
  }) => {
    // Wait for the page to hydrate: `/` is the page's own key.
    await page.goto('/issues', { waitUntil: 'networkidle' });
    await page.keyboard.press('/');
    await expect(
      page.getByRole('searchbox', { name: 'Search issues' })
    ).toBeFocused();
    await page.keyboard.type('dual');
    await expect(page).toHaveURL(/\/issues\?q=dual$/);
    await expect(page.locator('li[data-row-id]')).toHaveCount(4);
    await page.goBack();
    await expect(page).toHaveURL(/\/issues$/);
  });

  test('/tasks leads to /issues, query kept', async ({ page }) => {
    await page.goto('/tasks?project=proj-atlas');
    await expect(page).toHaveURL(/\/issues\?project=proj-atlas$/);
    await expect(
      chip(page, 'Project filter: Atlas billing migration')
    ).toBeVisible();
  });

  test('a phone has no sideways scroll', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/issues');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Issues');
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

/** A milestone group's shown rows, by the milestone's id. */
const rowsOf = (page: Page, milestoneId: string) =>
  page.locator(`[data-group-id$="m:${milestoneId}"] li[data-row-id]`);

/** A toast's sentence (the toast, not its screen-reader announcement). */
const toastSaying = (page: Page, text: string) => page.getByText(text).first();

/** Garnet's "No milestone" group's shown rows. */
const unplannedRows = (page: Page) =>
  page.locator('[data-group-id$="nm:proj-garnet"] li[data-row-id]');

test.describe('moving issues, as a member', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('shift-click two issues, move them with the bulk bar; a reload keeps them there', async ({
    page,
  }) => {
    const errors = trackErrors(page);
    await page.goto('/issues?project=proj-garnet', {
      waitUntil: 'networkidle',
    });
    await expect(unplannedRows(page)).toHaveCount(2);
    await page.getByRole('checkbox', { name: 'Select ENG-54' }).click();
    await page
      .getByRole('checkbox', { name: 'Select ENG-55' })
      .click({ modifiers: ['Shift'] });
    const bar = page.getByRole('toolbar', {
      name: 'Actions for 2 selected issues',
    });
    await expect(bar).toBeVisible();
    await bar.getByRole('button', { name: 'Move to milestone' }).click();
    await page
      .getByRole('dialog', { name: 'Move 2 issues to a milestone' })
      .getByRole('option', { name: /Push notifications/ })
      .click();
    await expect(
      toastSaying(
        page,
        'Moved 2 issues to Garnet mobile app › Push notifications.'
      )
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
    await expect(rowsOf(page, 'ms-garnet-2')).toHaveCount(2);

    await page.reload({ waitUntil: 'networkidle' });
    await expect(rowsOf(page, 'ms-garnet-2')).toHaveCount(2);
    await expect(unplannedRows(page)).toHaveCount(0);

    // Back to "No milestone", through the move picker's search.
    await page.getByRole('checkbox', { name: 'Select ENG-54' }).click();
    await page
      .getByRole('checkbox', { name: 'Select ENG-55' })
      .click({ modifiers: ['Shift'] });
    await bar.getByRole('button', { name: 'Move to milestone' }).click();
    const picker = page.getByRole('dialog', {
      name: 'Move 2 issues to a milestone',
    });
    await picker.getByRole('combobox').fill('no milestone garnet');
    await page.keyboard.press('Enter');
    await expect(
      toastSaying(page, 'Moved 2 issues to Garnet mobile app › No milestone.')
    ).toBeVisible();
    await expect(unplannedRows(page)).toHaveCount(2);
    expect(errors).toEqual([]);
  });

  test('`m` on a focused row opens the move picker; Undo puts it back', async ({
    page,
  }) => {
    await page.goto('/issues?project=proj-garnet', {
      waitUntil: 'networkidle',
    });
    await page.getByRole('link', { name: 'Crash on cold start' }).focus();
    await page.keyboard.press('m');
    const picker = page.getByRole('dialog', {
      name: 'Move ENG-54 to a milestone',
    });
    await expect(picker.getByRole('combobox')).toBeFocused();
    await page.keyboard.type('push');
    await page.keyboard.press('Enter');
    await expect(
      toastSaying(
        page,
        'Moved ENG-54 to Garnet mobile app › Push notifications.'
      )
    ).toBeVisible();
    await expect(rowsOf(page, 'ms-garnet-2')).toHaveCount(1);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(
      toastSaying(page, 'The issue is back where it was.')
    ).toBeVisible();
    await expect(unplannedRows(page)).toHaveCount(2);
    await expect(rowsOf(page, 'ms-garnet-2')).toHaveCount(0);
  });

  // Keyboard focus is never left on <body>: Esc in a row key's picker goes
  // back to the row's title, a keyboard move follows the row to its new
  // group, and Z (named in the toast's live text) undoes it.
  test('focus follows a keyboard move, and Z undoes it', async ({ page }) => {
    await page.goto('/issues?project=proj-garnet', {
      waitUntil: 'networkidle',
    });
    const title = (scope: ReturnType<typeof rowsOf>) =>
      scope.getByRole('link', { name: 'Crash on cold start' });
    await title(unplannedRows(page)).focus();
    await page.keyboard.press('m');
    const picker = page.getByRole('dialog', {
      name: 'Move ENG-54 to a milestone',
    });
    await expect(picker.getByRole('combobox')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect(title(unplannedRows(page))).toBeFocused();

    await page.keyboard.press('m');
    await expect(picker.getByRole('combobox')).toBeFocused();
    await page.keyboard.type('push');
    await page.keyboard.press('Enter');
    await expect(rowsOf(page, 'ms-garnet-2')).toHaveCount(1);
    await expect(title(rowsOf(page, 'ms-garnet-2'))).toBeFocused();
    await expect(
      page.getByText(
        'Moved ENG-54 to Garnet mobile app, Push notifications. Press Z to undo.'
      )
    ).toHaveCount(1);

    await page.keyboard.press('z');
    await expect(
      toastSaying(page, 'The issue is back where it was.')
    ).toBeVisible();
    await expect(unplannedRows(page)).toHaveCount(2);
    await expect(title(unplannedRows(page))).toBeFocused();
  });

  test('a row dragged onto another milestone moves there', async ({ page }) => {
    await page.goto('/issues?project=proj-garnet', {
      waitUntil: 'networkidle',
    });
    const row = page.locator('li[data-row-id]').filter({ hasText: 'ENG-55' });
    await row.hover();
    await row
      .locator('[data-draggable="true"]')
      .dragTo(
        page.locator('[data-group-id$="m:ms-garnet-2"] [data-nav-item="group"]')
      );
    await expect(
      toastSaying(
        page,
        'Moved ENG-55 to Garnet mobile app › Push notifications.'
      )
    ).toBeVisible();
    await expect(rowsOf(page, 'ms-garnet-2')).toHaveCount(1);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(unplannedRows(page)).toHaveCount(2);
  });

  test('a phone selects with the Select button, with no sideways scroll', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/issues?project=proj-garnet', {
      waitUntil: 'networkidle',
    });
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await page.getByRole('button', { name: 'Select', exact: true }).click();
    await expect(
      page.getByRole('checkbox', { name: 'Select ENG-54' })
    ).toBeVisible();
    // In Select mode a tap on a card selects it rather than opening it,
    // and its title says so: a checkbox, not a link.
    await expect(
      page.getByRole('link', { name: 'Crash on cold start' })
    ).toHaveCount(0);
    const title = page.getByRole('checkbox', { name: 'Crash on cold start' });
    await title.click();
    await expect(
      page.getByRole('toolbar', { name: 'Actions for 1 selected issue' })
    ).toBeVisible();
    await expect(title).toHaveAttribute('aria-checked', 'true');
    await expect(page).toHaveURL(/\/issues\?project=proj-garnet$/);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});

test.describe('as a Linear guest', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page, 'user-gus');
  });

  test('Operations only, read-only, no initiatives', async ({ page }) => {
    const errors = trackErrors(page);
    await page.goto('/issues', { waitUntil: 'networkidle' });
    await expect(
      page.getByText('You are a guest in Linear, so this view is read-only.')
    ).toBeVisible();
    await expect(page.getByText(/^ENG-\d+$/)).toHaveCount(0);
    await expect(page.getByText(/^OPS-\d+$/).first()).toBeVisible();
    await expect(page.getByRole('checkbox')).toHaveCount(0);
    await expect(page.locator('[data-draggable]')).toHaveCount(0);
    await expect(page.getByText('Allow edits in Linear')).toHaveCount(0);
    await page.getByRole('button', { name: 'Filter', exact: true }).click();
    await expect(
      page.getByRole('option', { name: 'Initiative', exact: true })
    ).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('a direct bulk change is refused by the server', async ({
    page,
    baseURL,
  }) => {
    const response = await page.request.patch('/api/issues', {
      data: { issueIds: ['iss-ops-1'], patch: { priority: 1 } },
      headers: { origin: baseURL ?? '' },
    });
    expect(response.status()).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: 'read_only' },
    });
  });
});
