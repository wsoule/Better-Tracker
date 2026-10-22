import { expect, type Page, test } from '@playwright/test';

// Browser smoke test of the planner in demo mode (architecture §11): every
// screen renders, dragging a milestone's due date re-dates it, an issue
// takes an edit, Ctrl K opens the palette, the slide-over's keyboard
// behaviour (focus on a swap, Esc with unsaved text) holds in a real
// browser, and the demo's Linear guest gets a read-only planner (owner
// decision 2026-10-22, "Guests limited to read only"). Demo data is
// fictional and lives only in this server.

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
    '/runs',
    '/settings',
    '/issues/ENG-24',
  ]) {
    await page.goto(path);
    await expect(page.locator('h1').first(), path).toBeVisible();
    await expect(page.getByText('Something went wrong'), path).toHaveCount(0);
  }
  expect(errors).toEqual([]);
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
