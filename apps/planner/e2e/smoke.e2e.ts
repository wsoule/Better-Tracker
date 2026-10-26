import { expect, type Page, test } from '@playwright/test';

import { expectScriptsNonced } from './csp-nonce';

// Browser smoke test of the planner in demo mode (architecture §11): every
// screen renders, dragging a milestone's due date re-dates it, an issue
// takes an edit, Ctrl K opens the palette, the slide-over's keyboard
// behaviour (focus on a swap, Esc with unsaved text) holds in a real
// browser, the dependency graph drills from initiatives down and back up
// (owner decision 2026-10-22, graphs at every level), draws every item of
// its scope in frames by parent (owner decision 2026-10-23) and highlights
// what can start, both paths and the critical path (owner request
// 2026-10-22, graph highlights), and the demo's Linear guest gets a
// read-only planner
// (owner decision 2026-10-22, "Guests limited to read only") whose graphs
// fall back to the projects he can see. Every screen it opens carries the
// nonce Content-Security-Policy on each of its scripts (owner decision
// 2026-10-25: proxy.ts nonces every page in every mode; e2e/csp-nonce.ts).
// Demo data is fictional and lives only in this server.

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

test('the graph drills from initiatives to projects and back up', async ({
  page,
}) => {
  await page.goto('/graph?level=initiative');
  // A click locks the box; a second click on it opens its panel.
  const platform = page.getByRole('button', {
    name: /^Platform reliability\./,
  });
  await platform.click();
  await expect(platform).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/\/graph\?level=initiative&lock=init-platform$/);
  await platform.click();
  await page
    .getByRole('dialog')
    .getByRole('link', { name: 'Projects in Platform reliability' })
    .click();
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

test('the graph draws every item, framed by its parent', async ({ page }) => {
  // Compass's milestones wait on nothing: all three are drawn all the
  // same, inside Compass's frame, each saying it has no dependencies.
  await page.goto('/graph?project=proj-compass&level=milestone');
  await expect(page.locator('[data-graph-node]')).toHaveCount(3);
  await expect(page.locator('[data-graph-cluster]')).toHaveCount(1);
  await expect(page.locator('[data-graph-cluster-title]')).toHaveText(
    'Compass onboarding'
  );
  await expect(
    page.getByRole('button', { name: /^Guided setup\..*no dependencies/ })
  ).toBeVisible();
  await expect(page.locator('[data-graph-readout]')).toContainText(
    '3 with no dependencies'
  );
  // Something is drawn, so the level tabs sit in the canvas toolbar.
  const tabs = page.getByRole('navigation', { name: 'Graph level' });
  await expect(tabs.getByRole('link', { name: 'Issues' })).toHaveAttribute(
    'href',
    '/graph?project=proj-compass'
  );

  // The workspace's issue level: every issue, done ones included, in a
  // frame per milestone (or "No milestone") inside one per project, and
  // "No project". Those on no relation are neutral, with no chip.
  await page.goto('/graph?level=issue');
  await expect(page.locator('[data-graph-node]')).toHaveCount(51);
  await expect(page.locator('[data-graph-cluster]')).toHaveCount(28);
  await expect(page.locator('[data-readiness="independent"]')).toHaveCount(36);
  await expect(
    page.locator('[data-readiness="independent"] [data-readiness-chip]')
  ).toHaveCount(0);
  await expect(page.locator('h1 + p')).toHaveText(
    /^51 issues in the workspace, 45 of them in 16 milestones; 6 blocking relations/
  );
  await expect(page.getByText('no blocking relations')).toHaveCount(0);
});

test('an empty graph says so, with nothing to highlight', async ({ page }) => {
  // Garnet's Push notifications milestone holds no issue yet.
  await page.goto('/graph?milestone=ms-garnet-2');
  await expect(
    page.getByText('No issues in Push notifications.')
  ).toBeVisible();
  await expect(page.locator('[data-graph-node]')).toHaveCount(0);
  await expect(page.getByRole('radiogroup', { name: 'Highlight' })).toHaveCount(
    0
  );
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
  // Arriving with ?node= selects the box (its paths lit at rest) and opens
  // its panel; it locks nothing.
  const beacon = page.getByRole('button', { name: /^Search v2 beta\./ });
  await expect(beacon).toHaveAttribute('data-state', 'active');
  await expect(beacon).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('dialog')).toBeVisible();
  // The box panel's own parts: where it stands in one line, where to
  // start upstream, what finishing it would clear, the box-arrow caveat.
  const panel = page.getByRole('dialog');
  await expect(panel).toContainText(
    'Waits on 1 · Holds up 1 · Finishing it would clear 1'
  );
  await expect(
    panel.getByRole('button', { name: 'Show Dual-write, Start here' })
  ).toBeVisible();
  await expect(
    panel.getByRole('button', { name: 'Show Tokens and type, Clear next' })
  ).toBeVisible();
  await expect(panel).toContainText(
    'Box paths follow the arrows between boxes: an arrow in and an arrow out may be different issues.'
  );
  // Under Critical path it says its step on the longest chain through it.
  await page.goto('/graph?node=ms-beacon-1&highlight=critical');
  await expect(page.getByRole('dialog')).toContainText(
    'Step 2 of 3 (Dual-write → Search v2 beta → Tokens and type)'
  );
});

// The graph highlights (architecture §8.4 "Graph"): each test is a fresh
// browser context, so no graph-highlight cookie carries over between them
// and the anchored URL assertions elsewhere still hold.
test.describe('graph highlights', () => {
  /** A drawn box by its graph node id ("iss-eng-12"). */
  const box = (page: Page, id: string) =>
    page.locator(`[data-graph-node="${id}"]`);

  test('a chain reads its focus and lights both paths on hover and focus', async ({
    page,
  }) => {
    await page.goto('/graph?chain=ENG-23');
    // At rest means no pointer on a box: the sign-in click leaves the mouse
    // mid-page, where a box may now sit.
    await page.mouse.move(0, 0);
    const frame = page.locator('[data-highlight]');
    await expect(frame).toHaveAttribute('data-highlight', 'status');
    await expect(
      page
        .getByRole('radiogroup', { name: 'Highlight' })
        .getByRole('radio', { name: 'Status' })
    ).toHaveAttribute('aria-checked', 'true');
    // At rest the readout describes the chain's focus.
    const readout = page.locator('[data-graph-readout]');
    await expect(readout).toHaveText(
      'ENG-23 · Blocked by 1 · Waits on 1 open, start with ENG-12 · Holds up 1 · Done would unblock 1: OPS-20'
    );
    await expect(box(page, 'iss-eng-12')).toHaveAttribute(
      'data-readiness',
      'ready'
    );
    // Pointing at ENG-12 lights what it holds up, and marks what
    // finishing it alone would unblock.
    await box(page, 'iss-eng-12').hover();
    await expect(box(page, 'iss-eng-12')).toHaveAttribute(
      'data-state',
      'active'
    );
    await expect(box(page, 'iss-eng-23')).toHaveAttribute('data-state', 'down');
    await expect(box(page, 'iss-ops-20')).toHaveAttribute('data-state', 'down');
    await expect(box(page, 'iss-eng-23')).toHaveAttribute('data-next', '');
    await expect(box(page, 'iss-eng-23').getByText('Ready next')).toBeVisible();
    await expect(readout).toHaveText(
      'ENG-12 · Ready · Nothing open blocks it · Holds up 2 · Done would unblock 1: ENG-23'
    );
    // Keyboard focus lights what it waits on, in the other style.
    await page.mouse.move(0, 0);
    await box(page, 'iss-ops-20').focus();
    await expect(box(page, 'iss-eng-23')).toHaveAttribute('data-state', 'lit');
    await expect(box(page, 'iss-eng-12')).toHaveAttribute('data-state', 'lit');
  });

  test('Critical path is kept in the URL, across a reload and to the next graph', async ({
    page,
  }) => {
    await page.goto('/graph?chain=ENG-23');
    const switcher = page.getByRole('radiogroup', { name: 'Highlight' });
    await switcher.getByRole('radio', { name: 'Critical path' }).click();
    await expect(page).toHaveURL(/\/graph\?chain=ENG-23&highlight=critical$/);
    const frame = page.locator('[data-highlight]');
    await expect(frame).toHaveAttribute('data-highlight', 'critical');
    const steps = async () =>
      Promise.all(
        ['iss-eng-12', 'iss-eng-23', 'iss-ops-20'].map((id) =>
          box(page, id).getAttribute('data-step')
        )
      );
    await expect.poll(steps).toEqual(['1', '2', '3']);
    await expect(
      page.getByRole('group', { name: 'Graph legend: Critical path' })
    ).toBeVisible();
    // Copy Mermaid follows the highlight.
    await expect(
      page.locator('pre').filter({ hasText: 'flowchart LR' })
    ).toContainText('%% Critical path:');

    await page.reload();
    await expect(frame).toHaveAttribute('data-highlight', 'critical');
    await expect.poll(steps).toEqual(['1', '2', '3']);

    // The cookie carries it to a graph whose link says nothing about it,
    // and the address bar then says so too.
    await page
      .getByRole('navigation', { name: 'Graph scope' })
      .getByRole('link', { name: 'Workspace' })
      .click();
    await expect(page).toHaveURL(
      /\/graph\?level=initiative&highlight=critical$/
    );
    await expect(
      switcher.getByRole('radio', { name: 'Critical path' })
    ).toHaveAttribute('aria-checked', 'true');

    // Status is the default: choosing it drops the parameter.
    await switcher.getByRole('radio', { name: 'Status' }).click();
    await expect(page).toHaveURL(/\/graph\?level=initiative$/);
    await expect(frame).toHaveAttribute('data-highlight', 'status');
    await page.goto('/graph');
    await expect(page).toHaveURL(/\/graph$/);
    await expect(frame).toHaveAttribute('data-highlight', 'status');
  });

  test('the three highlights redraw every box in place', async ({ page }) => {
    await page.goto('/graph?level=issue');
    const frame = page.locator('[data-highlight]');
    const switcher = page.getByRole('radiogroup', { name: 'Highlight' });
    // Where each box sits on the canvas: a highlight never moves one.
    const places = () =>
      page
        .locator('[data-graph-node]')
        .evaluateAll((els) =>
          els.map((el) =>
            el instanceof HTMLElement
              ? `${el.dataset.graphNode}@${el.style.left},${el.style.top}`
              : ''
          )
        );
    const before = await places();
    expect(before).toHaveLength(51);
    for (const [label, id] of [
      ['Risk', 'risk'],
      ['Critical path', 'critical'],
      ['Status', 'status'],
    ] as const) {
      await switcher.getByRole('radio', { name: label }).click();
      await expect(frame).toHaveAttribute('data-highlight', id);
      await expect(
        page.getByRole('group', { name: `Graph legend: ${label}` })
      ).toBeVisible();
      expect(await places()).toEqual(before);
      if (id === 'critical') {
        // At rest the longest chain is numbered: ENG-12 → ENG-23 → OPS-20.
        await expect
          .poll(() =>
            Promise.all(
              ['iss-eng-12', 'iss-eng-23', 'iss-ops-20'].map((node) =>
                box(page, node).getAttribute('data-step')
              )
            )
          )
          .toEqual(['1', '2', '3']);
        await expect(page.locator('[data-graph-readout]')).toContainText(
          'Critical path: 3 issues, each waiting on the one before: ENG-12 → ENG-23 → OPS-20.'
        );
      }
    }
    // Pointing at ENG-12 lights what it holds up across the frames.
    await box(page, 'iss-eng-12').hover();
    await expect(box(page, 'iss-eng-23')).toHaveAttribute('data-state', 'down');
    await expect(box(page, 'iss-ops-20')).toHaveAttribute('data-state', 'down');
  });

  test('switching the highlight never moves the switch or the drawing on the page', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1366, height: 900 });
    await page.goto('/graph?level=issue');
    const switcher = page.getByRole('radiogroup', { name: 'Highlight' });
    // Page positions, not canvas ones: each mode's legend (under the
    // drawing) has its own height, which must not move anything. (Critical
    // path scrolls the frame only when no step of its path shows; here
    // ENG-12, its step 1, does.)
    const where = () =>
      page.evaluate(() => {
        const top = (selector: string) =>
          Math.round(
            document.querySelector(selector)?.getBoundingClientRect().top ?? -1
          );
        return [
          top('[role="radiogroup"][aria-label="Highlight"]'),
          top('[data-graph-node="iss-eng-12"]'),
          top('[data-graph-viewport]'),
        ];
      });
    // The drawing is on the page (streamed in) before anything is measured.
    await expect(box(page, 'iss-eng-12')).toBeVisible();
    const before = await where();
    for (const label of ['Risk', 'Critical path', 'Status', 'Critical path']) {
      await switcher.getByRole('radio', { name: label }).click();
      await expect(
        page.getByRole('group', { name: `Graph legend: ${label}` })
      ).toBeVisible();
      expect(await where()).toEqual(before);
    }
  });

  test('Back and Forward show the highlight each history entry says', async ({
    page,
  }) => {
    // Wide enough that the switch stays clear of the issue drawer.
    await page.setViewportSize({ width: 1920, height: 1000 });
    const frame = page.locator('[data-highlight]');
    const switcher = page.getByRole('radiogroup', { name: 'Highlight' });
    // Pick Risk, leave for the timeline, come back: Risk, as the entry says.
    await page.goto('/graph?level=issue');
    await switcher.getByRole('radio', { name: 'Risk' }).click();
    await expect(page).toHaveURL(/\/graph\?level=issue&highlight=risk$/);
    await page.getByRole('link', { name: 'Timeline' }).first().click();
    await expect(page).toHaveURL(/\/timeline/);
    await page.goBack();
    await expect(page).toHaveURL(/\/graph\?level=issue&highlight=risk$/);
    await expect(frame).toHaveAttribute('data-highlight', 'risk');
    // Arrive on a shared Critical path link, pick Status, leave, come back:
    // Status, never the first render's Critical path.
    await page.goto('/graph?level=issue&highlight=critical');
    await expect(frame).toHaveAttribute('data-highlight', 'critical');
    await switcher.getByRole('radio', { name: 'Status' }).click();
    await expect(page).toHaveURL(/\/graph\?level=issue$/);
    await page.getByRole('link', { name: 'Timeline' }).first().click();
    await expect(page).toHaveURL(/\/timeline/);
    await page.goBack();
    await expect(page).toHaveURL(/\/graph\?level=issue$/);
    await expect(frame).toHaveAttribute('data-highlight', 'status');
    // Inside the issue drawer: switch there, close, then Back to it.
    await switcher.getByRole('radio', { name: 'Risk' }).click();
    // A click locks the box, a second click opens it.
    await box(page, 'iss-eng-23').click();
    await box(page, 'iss-eng-23').click();
    await expect(page).toHaveURL(/issue=ENG-23/);
    await expect(page.getByRole('dialog')).toContainText('Typo tolerance');
    await switcher.getByRole('radio', { name: 'Critical path' }).click();
    await expect(page).toHaveURL(/issue=ENG-23&highlight=critical$/);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /close/i })
      .first()
      .click();
    await expect(page).not.toHaveURL(/issue=/);
    await page.goBack();
    await expect(page).toHaveURL(/issue=ENG-23&highlight=critical$/);
    await expect(frame).toHaveAttribute('data-highlight', 'critical');
  });

  test('a switch while the drawer is on its way never cancels it', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1000 });
    await page.goto('/graph?level=issue');
    // Hold the drawer's server round trip back, then switch inside it.
    await page.route('**/*', async (route) => {
      if (route.request().headers().rsc === '1') {
        await new Promise((resolve) => setTimeout(resolve, 900));
      }
      await route.continue();
    });
    await box(page, 'iss-eng-23').click();
    await box(page, 'iss-eng-23').click();
    await page
      .getByRole('radiogroup', { name: 'Highlight' })
      .getByRole('radio', { name: 'Risk' })
      .click();
    await expect(page.getByRole('dialog')).toContainText('Typo tolerance');
    await expect(page).toHaveURL(/issue=ENG-23&highlight=risk$/);
    await expect(page.locator('[data-highlight]')).toHaveAttribute(
      'data-highlight',
      'risk'
    );
  });

  test('a mode from a shared link survives a level tab; an explicit Status survives a reload', async ({
    page,
    context,
  }) => {
    // No cookie: a shared Critical path link, then a level tab.
    await page.goto('/graph?level=issue&highlight=critical');
    await page
      .getByRole('navigation', { name: 'Graph level' })
      .getByRole('link', { name: 'Milestones' })
      .click();
    await expect(page).toHaveURL(/\/graph\?highlight=critical$/);
    await expect(page.locator('[data-highlight]')).toHaveAttribute(
      'data-highlight',
      'critical'
    );
    // A device that remembers Risk, opening a link that says Status.
    await context.addCookies([
      {
        name: 'graph-highlight',
        value: 'risk',
        url: new URL('/graph', page.url()).toString(),
      },
    ]);
    await page.goto('/graph?level=issue&highlight=status');
    await expect(page).toHaveURL(/\/graph\?level=issue&highlight=status$/);
    await page.reload();
    await expect(page.locator('[data-highlight]')).toHaveAttribute(
      'data-highlight',
      'status'
    );
  });

  test('?highlight= is read leniently and written back canonically', async ({
    page,
  }) => {
    await page.goto('/graph?highlight=RISK');
    await expect(page).toHaveURL(/\/graph\?highlight=risk$/);
    await expect(page.locator('[data-highlight]')).toHaveAttribute(
      'data-highlight',
      'risk'
    );
    // Opening it from a link is not a switch: nothing is remembered, and
    // a value that is no highlight reads as the default and is dropped.
    await page.goto('/graph?level=issue&highlight=nonsense');
    await expect(page).toHaveURL(/\/graph\?level=issue$/);
    await expect(page.locator('[data-highlight]')).toHaveAttribute(
      'data-highlight',
      'status'
    );
  });
});

// On a touch screen a tap locks a box (nothing opens) and a second tap on
// the locked box opens it (owner request 2026-10-23, "lock on"; it used to
// be a pin that only traced).
test.describe('graph lock on a touch screen', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('a tap locks, a second tap opens the issue', async ({ page }) => {
    await page.goto('/graph?chain=ENG-23');
    const eng12 = page.locator('[data-graph-node="iss-eng-12"]');
    await eng12.tap();
    await expect(eng12).toHaveAttribute('data-locked', '');
    await expect(eng12).toHaveAttribute('data-state', 'active');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('[data-graph-readout]')).toContainText(
      'Locked on ENG-12'
    );
    await expect(page).toHaveURL(/\/graph\?chain=ENG-23&lock=ENG-12$/);
    // Slower than a double tap: the second tap opens it.
    await page.waitForTimeout(400);
    await eng12.tap();
    await expect(page).toHaveURL(/issue=ENG-12/);
    await expect(page.getByRole('dialog')).toBeVisible();
  });

  test('a locked box is marked, and Escape or a tap on the background unlocks it', async ({
    page,
  }) => {
    await page.goto('/graph?chain=ENG-23');
    const eng23 = page.locator('[data-graph-node="iss-eng-23"]');
    await eng23.tap();
    await expect(eng23).toHaveAttribute('data-state', 'active');
    // The box being read gets the accent flood on touch too, and the lock
    // its strip.
    await expect(eng23).toHaveAttribute('data-pointed', '');
    await expect(
      page.locator('[data-graph-lock-strip="iss-eng-23"]')
    ).toBeVisible();
    await expect(
      page.locator('[data-graph-node="iss-eng-12"]')
    ).toHaveAttribute('data-state', 'lit');
    await page.keyboard.press('Escape');
    await expect(eng23).not.toHaveAttribute('data-state', /./);
    await expect(eng23).not.toHaveAttribute('data-pointed', /.*/);
    await expect(
      page.locator('[data-graph-node="iss-eng-12"]')
    ).not.toHaveAttribute('data-state', /./);
    await expect(page).toHaveURL(/\/graph\?chain=ENG-23$/);
    await eng23.tap();
    await expect(eng23).toHaveAttribute('data-locked', '');
    const viewport = page.locator('[data-graph-viewport]');
    const frame = await viewport.boundingBox();
    if (frame === null) throw new Error('no frame');
    await page.touchscreen.tap(frame.x + frame.width - 12, frame.y + 12);
    await expect(eng23).not.toHaveAttribute('data-locked', /.*/);
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
    await expect(page.locator('[data-graph-node]')).toHaveCount(4);
    await expect(page.locator('[data-graph-cluster]')).toHaveCount(0);
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
