import { expect, type Page, test } from '@playwright/test';

// Lock on and drill down on the graph (owner request 2026-10-23: "lock on
// to the thing so it stays highlighted (along with its path) but I can
// still scroll", "there must still be a way to open it obviously", "when
// I double click on the graph item, it should take me to that items
// graph"; architecture §8.4 Graph "Lock on", "Drill down"), in demo mode.

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

/** A drawn box by its graph node id ("iss-eng-23"). */
const box = (page: Page, id: string) =>
  page.locator(`[data-graph-node="${id}"]`);

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
});

test('a locked box stays lit while the canvas scrolls and the pointer moves on', async ({
  page,
}) => {
  await page.goto('/graph?level=issue');
  const eng23 = box(page, 'iss-eng-23');
  await eng23.click();
  await expect(eng23).toHaveAttribute('data-locked', '');
  await expect(eng23).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/\/graph\?level=issue&lock=ENG-23$/);
  const readout = page.locator('[data-graph-readout]');
  await expect(readout).toContainText('Locked on ENG-23');
  await expect(box(page, 'iss-eng-12')).toHaveAttribute('data-state', 'lit');
  await expect(box(page, 'iss-ops-20')).toHaveAttribute('data-state', 'down');

  // Scroll the canvas with the wheel and drag it: nothing moves the lock.
  const viewport = page.locator('[data-graph-viewport]');
  const frame = await viewport.boundingBox();
  if (frame === null) throw new Error('no frame');
  await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2);
  await page.mouse.wheel(0, 240);
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await page.mouse.wheel(0, -240);
  const blank = await viewport.evaluate((el) => {
    // A point on the background: the frame's top-left corner area clear
    // of every box.
    const r = el.getBoundingClientRect();
    for (let y = r.top + 6; y < r.bottom - 20; y += 12) {
      for (let x = r.left + 6; x < r.right - 20; x += 12) {
        const at = document.elementFromPoint(x, y);
        if (
          at !== null &&
          at.closest(
            '[data-graph-node], [data-graph-lock-strip], [data-graph-cluster-title]'
          ) === null
        ) {
          return { x, y };
        }
      }
    }
    return null;
  });
  if (blank === null) throw new Error('no background to drag');
  await page.mouse.move(blank.x, blank.y);
  await page.mouse.down();
  await page.mouse.move(blank.x + 80, blank.y + 30, { steps: 6 });
  await page.mouse.up();
  await expect(eng23).toHaveAttribute('data-locked', '');

  // Point at other boxes: the lock keeps the highlight.
  await box(page, 'iss-eng-26').hover();
  await expect(eng23).toHaveAttribute('data-state', 'active');
  await expect(box(page, 'iss-eng-26')).not.toHaveAttribute(
    'data-pointed',
    /.*/
  );
  await expect(readout).toContainText('Locked on ENG-23');

  // Zoom out and switch the highlight: still locked, and the frame stays
  // on the locked box (Critical path does not jump to its step 1).
  await page.getByRole('button', { name: 'Zoom out' }).click();
  await expect(page.getByRole('group', { name: 'Zoom' })).toContainText('83%');
  const scrolled = () =>
    viewport.evaluate((el) => [el.scrollLeft, el.scrollTop]);
  const before = await scrolled();
  await page
    .getByRole('radiogroup', { name: 'Highlight' })
    .getByRole('radio', { name: 'Critical path' })
    .click();
  await expect(eng23).toHaveAttribute('data-locked', '');
  await expect(page).toHaveURL(
    /\/graph\?level=issue&lock=ENG-23&highlight=critical$/
  );
  expect(await scrolled()).toEqual(before);

  // The strip rides the box, inside the visible frame.
  const strip = page.locator('[data-graph-lock-strip="iss-eng-23"]');
  await expect(strip).toBeVisible();
  const stripBox = await strip.boundingBox();
  const frameNow = await viewport.boundingBox();
  if (stripBox === null || frameNow === null) throw new Error('no strip');
  expect(stripBox.x).toBeGreaterThanOrEqual(frameNow.x);
  expect(stripBox.x + stripBox.width).toBeLessThanOrEqual(
    frameNow.x + frameNow.width
  );
  expect(stripBox.height).toBeGreaterThanOrEqual(24);

  // Escape unlocks, and the address bar says so: from anywhere on the page
  // (a drag or a click beside the frame leaves focus outside the graph).
  await page.locator('h1').click();
  await page.keyboard.press('Escape');
  await expect(eng23).not.toHaveAttribute('data-locked', /.*/);
  await expect(page).toHaveURL(/\/graph\?level=issue&highlight=critical$/);
  await expect(strip).toHaveCount(0);
});

test('the strip’s Open opens the issue, and so does a second click; a reload keeps the lock', async ({
  page,
}) => {
  await page.goto('/graph?level=issue');
  const eng23 = box(page, 'iss-eng-23');
  await eng23.click();
  const strip = page.locator('[data-graph-lock-strip="iss-eng-23"]');
  await expect(strip.getByRole('button', { name: 'Open' })).toBeVisible();
  await expect(strip.getByRole('link', { name: 'Open graph' })).toHaveAttribute(
    'href',
    '/graph?chain=ENG-23'
  );
  await expect(strip.getByRole('button', { name: 'Unlock' })).toBeVisible();

  // A reload keeps it.
  await page.reload();
  await expect(eng23).toHaveAttribute('data-locked', '');
  await expect(strip).toBeVisible();

  // The strip's Open: the issue's slide-over.
  await strip.getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(/lock=ENG-23&issue=ENG-23$/);
  await expect(page.getByRole('dialog')).toContainText('Typo tolerance');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /close/i })
    .first()
    .click();
  await expect(page).not.toHaveURL(/issue=/);
  await expect(eng23).toHaveAttribute('data-locked', '');

  // A second click on the locked box opens it too.
  await eng23.click();
  await expect(page).toHaveURL(/issue=ENG-23/);
  await expect(page.getByRole('dialog')).toContainText('Typo tolerance');
});

test('a double-click on a milestone lands on its issue graph; Back returns to it locked', async ({
  page,
}) => {
  await page.goto('/graph');
  const milestone = box(page, 'ms-beacon-1');
  await milestone.dblclick();
  await expect(page).toHaveURL(/\/graph\?milestone=ms-beacon-1$/);
  await expect(page.locator('h1')).toHaveText('Issues in Search v2 beta');
  // No panel opened on the way down.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/graph\?lock=ms-beacon-1$/);
  await expect(box(page, 'ms-beacon-1')).toHaveAttribute('data-locked', '');
});

test('the drill-down keeps the highlight, and the strip and the keyboard reach it too', async ({
  page,
}) => {
  await page.goto('/graph?level=issue&highlight=risk');
  // A frame title drills into what it stands for.
  await page
    .locator('[data-graph-cluster-title="milestone:ms-beacon-1"]')
    .dblclick();
  await expect(page).toHaveURL(
    /\/graph\?milestone=ms-beacon-1&highlight=risk$/
  );
  // The strip's Open graph, and Shift + Enter.
  await box(page, 'iss-eng-23').click();
  await page
    .locator('[data-graph-lock-strip="iss-eng-23"]')
    .getByRole('link', { name: 'Open graph' })
    .click();
  await expect(page).toHaveURL(/\/graph\?chain=ENG-23&highlight=risk$/);
  await box(page, 'iss-eng-12').focus();
  await page.keyboard.press('Shift+Enter');
  await expect(page).toHaveURL(/\/graph\?chain=ENG-12&highlight=risk$/);
});

test('Enter locks, Tab reaches the strip, Enter on the locked box opens it', async ({
  page,
}) => {
  await page.goto('/graph');
  const dualWrite = box(page, 'ms-atlas-2');
  // Hydrated: pointing at a box reads it.
  await dualWrite.hover();
  await expect(dualWrite).toHaveAttribute('data-state', 'active');
  await page.mouse.move(0, 0);
  await dualWrite.focus();
  await page.keyboard.press('Enter');
  await expect(dualWrite).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(/\/graph\?lock=ms-atlas-2$/);
  await page.keyboard.press('Tab');
  await expect(
    page
      .locator('[data-graph-lock-strip="ms-atlas-2"]')
      .getByRole('button', { name: 'Open' })
  ).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dualWrite).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toContainText('Dual-write');
});

test('Open always opens, never closes: an arrival with its panel open, a second click, Open twice, a double-click on Open', async ({
  page,
}) => {
  const dialog = page.getByRole('dialog');
  const stripOf = (id: string) =>
    page.locator(`[data-graph-lock-strip="${id}"]`);
  const readoutOpen = page
    .locator('[data-graph-readout]')
    .getByRole('button', { name: 'Open', exact: true });

  // A timeline link arrives with the milestone's panel open (?node=).
  await page.goto('/graph?node=ms-atlas-2');
  await expect(dialog).toContainText('Dual-write');
  const dualWrite = box(page, 'ms-atlas-2');
  await dualWrite.click();
  await expect(page).toHaveURL(/lock=ms-atlas-2/);
  await expect(dialog).toContainText('Dual-write');
  // The second click opens it (after the double-click window): it stays.
  await dualWrite.click();
  await page.waitForTimeout(800);
  await expect(dialog).toContainText('Dual-write');
  // The strip's Open and the readout's Open, with it open: still open.
  await stripOf('ms-atlas-2').getByRole('button', { name: 'Open' }).click();
  await expect(dialog).toContainText('Dual-write');
  await readoutOpen.click();
  await readoutOpen.click();
  await expect(dialog).toContainText('Dual-write');
  // A double-click on the strip's Open: still open.
  await stripOf('ms-atlas-2').getByRole('button', { name: 'Open' }).dblclick();
  await page.waitForTimeout(300);
  await expect(dialog).toContainText('Dual-write');
  await expect(dualWrite).toHaveAttribute('data-locked', '');

  // An issue link arrives with its slide-over open (?issue=).
  await page.goto('/graph?level=issue&issue=ENG-12');
  await expect(dialog).toBeVisible();
  const eng12 = box(page, 'iss-eng-12');
  await eng12.click();
  await expect(page).toHaveURL(/lock=ENG-12/);
  await eng12.click();
  await page.waitForTimeout(800);
  await expect(page).toHaveURL(/issue=ENG-12/);
  await expect(dialog).toBeVisible();
  await stripOf('iss-eng-12').getByRole('button', { name: 'Open' }).click();
  await stripOf('iss-eng-12').getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(/issue=ENG-12/);
  await stripOf('iss-eng-12').getByRole('button', { name: 'Open' }).dblclick();
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/issue=ENG-12/);
  await expect(dialog).toBeVisible();
  // Closing stays with the panel's own ×; the lock is kept.
  await dialog.getByRole('button', { name: /close/i }).first().click();
  await expect(page).not.toHaveURL(/issue=/);
  await expect(eng12).toHaveAttribute('data-locked', '');
});

test('a slow double-click on the locked box drills without opening it on the way', async ({
  page,
}) => {
  await page.goto('/graph?level=issue&lock=ENG-23');
  const eng23 = box(page, 'iss-eng-23');
  await expect(eng23).toHaveAttribute('data-locked', '');
  // Hydrated: the strip is drawn by the island.
  await expect(
    page.locator('[data-graph-lock-strip="iss-eng-23"]')
  ).toBeVisible();
  await page.evaluate(() => {
    const seen = { dialog: false };
    (window as unknown as { seen: typeof seen }).seen = seen;
    new MutationObserver(() => {
      if (document.querySelector('[role="dialog"]') !== null) {
        seen.dialog = true;
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  const at = await eng23.boundingBox();
  if (at === null) throw new Error('no box');
  const x = at.x + at.width / 2;
  const y = at.y + at.height / 2;
  // 400 ms apart: past the double tap's window, still a double-click to
  // the OS (Windows and macOS count up to about 500 ms).
  await page.mouse.move(x, y);
  await page.mouse.down({ clickCount: 1 });
  await page.mouse.up({ clickCount: 1 });
  await page.waitForTimeout(400);
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.up({ clickCount: 2 });
  await expect(page).toHaveURL(/\/graph\?chain=ENG-23$/);
  await page.waitForTimeout(700);
  expect(
    await page.evaluate(
      () => (window as unknown as { seen: { dialog: boolean } }).seen.dialog
    )
  ).toBe(false);
});

test('on a phone the strip stays clear of the tab bar', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/graph?level=issue&highlight=status');
  const viewport = page.locator('[data-graph-viewport]');
  const tabbar = page.locator('[data-ui-edge-bar="bottom"]');
  await expect(tabbar).toBeVisible();
  const barTop = (await tabbar.boundingBox())?.y ?? 0;
  // At page scroll 0 the frame runs on under the bar.
  const frame = await viewport.boundingBox();
  if (frame === null) throw new Error('no frame');
  expect(frame.y + frame.height).toBeGreaterThan(barTop + 30);
  // Scroll the frame so a box sits whole just above the tab bar, with no
  // room under it on screen (the first box the frame can bring there).
  const id = await viewport.evaluate(
    (el, { top }) => {
      const frameRect = el.getBoundingClientRect();
      for (const node of el.querySelectorAll<HTMLElement>(
        '[data-graph-node]'
      )) {
        const r = node.getBoundingClientRect();
        const scrollTop = el.scrollTop + r.bottom - (top - 12);
        const scrollLeft = el.scrollLeft + r.left - (frameRect.left + 12);
        const maxTop = el.scrollHeight - el.clientHeight;
        const maxLeft = el.scrollWidth - el.clientWidth;
        if (scrollTop < 0 || scrollTop > maxTop) continue;
        if (scrollLeft < 0 || scrollLeft > maxLeft) continue;
        if (r.width > frameRect.width - 24) continue;
        el.scrollTop = scrollTop;
        el.scrollLeft = scrollLeft;
        return node.dataset.graphNode ?? null;
      }
      return null;
    },
    { top: barTop }
  );
  if (id === null) throw new Error('no box to bring above the bar');
  const low = box(page, id);
  const at = await low.boundingBox();
  if (at === null) throw new Error('no box');
  expect(at.y + at.height).toBeLessThanOrEqual(barTop);
  // Hydrated: pointing at the box reads it.
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await expect(low).toHaveAttribute('data-state', 'active');
  await page.mouse.click(at.x + at.width / 2, at.y + at.height / 2);
  await expect(low).toHaveAttribute('data-locked', '');
  const strip = page.locator(`[data-graph-lock-strip="${id}"]`);
  await expect(strip).toBeVisible();
  // Every button on the strip is on screen and on top (not under the bar).
  for (const button of await strip.locator('a, button').all()) {
    const r = await button.boundingBox();
    if (r === null) throw new Error('no button');
    expect(r.y + r.height).toBeLessThanOrEqual(barTop);
    const hit = await page.evaluate(
      ({ x, y }) =>
        document.elementFromPoint(x, y)?.closest('[data-graph-lock-strip]') !==
        null,
      { x: r.x + r.width / 2, y: r.y + r.height / 2 }
    );
    expect(hit).toBe(true);
  }
});
