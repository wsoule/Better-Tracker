import { expect, type Response } from '@playwright/test';

// The nonce check every browser suite runs on its pages (architecture §11;
// owner decision 2026-10-25: proxy.ts sends the nonce
// Content-Security-Policy on every page in every mode). Spec-facing: it
// imports only @playwright/test, so any suite may use it (the OAuth suite
// adds it on merge).
//
//   const response = await page.goto('/week');
//   await expectScriptsNonced(response, '/week');
//
// It reads the page's own response: the nonce from its CSP header (the
// static policy of next.config.ts arrives alongside and names none), then
// every <script> tag of the raw HTML, which must carry exactly that nonce
// (browsers hide the attribute from the DOM, so the HTML is the place to
// look). At least one script must be there, so an empty body never passes.

/** The Content-Security-Policy headers of a response, as sent. */
async function policies(response: Response): Promise<string[]> {
  return (await response.headersArray())
    .filter((header) => header.name.toLowerCase() === 'content-security-policy')
    .map((header) => header.value);
}

/** The single nonce a response's Content-Security-Policy names. */
export async function cspNonce(response: Response): Promise<string> {
  const nonces = new Set<string>();
  for (const policy of await policies(response)) {
    for (const match of policy.matchAll(/'nonce-([^']+)'/g)) {
      nonces.add(match[1] ?? '');
    }
  }
  expect(nonces.size, 'one nonce in the Content-Security-Policy').toBe(1);
  return [...nonces][0] ?? '';
}

/**
 * Fails unless every <script> in the page's HTML carries the nonce its
 * response's CSP names. `label` names the page in the failure message.
 */
export async function expectScriptsNonced(
  response: Response | null,
  label: string
): Promise<void> {
  if (response === null) throw new Error(`no response for ${label}`);
  const nonce = await cspNonce(response);
  expect(nonce, `${label}: a nonce`).not.toBe('');
  expect(
    (await policies(response)).join(' , '),
    `${label}: strict-dynamic`
  ).toContain("'strict-dynamic'");
  const html = await response.text();
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
  expect(scripts.length, `${label}: scripts on the page`).toBeGreaterThan(0);
  const unnonced = scripts.filter((tag) => !tag.includes(`nonce="${nonce}"`));
  expect(unnonced, `${label}: scripts without this response's nonce`).toEqual(
    []
  );
}
