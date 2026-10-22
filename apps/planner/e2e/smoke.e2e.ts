import { expect, type Page, test } from '@playwright/test';

// Browser smoke test of the planner in demo mode (architecture §11): every
// screen renders, dragging a milestone's due date re-dates it, an issue
// takes an edit, Ctrl K opens the palette, and the slide-over's keyboard
// behaviour (focus on a swap, Esc with unsaved text) holds in a real
// browser. Demo data is fictional and lives only in this server.

/** Signs in through the demo picker on "/" as Chloe Diaz. */
async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page
    .locator('form[action="/api/auth/demo"]')
    .filter({ has: page.locator('input[value="user-chloe"]') })
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
