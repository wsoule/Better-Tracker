import { E2E_OAUTH_CLIENT } from './fake-linear-oauth';

// The OAuth e2e's server secrets and leak needles (architecture §11,
// playwright.oauth.config.ts). Every secret is an obvious fake
// (TESTSECRET, TESTONLY). The needles are what must never show up in a
// response, the server's log, its database or its temp files: the
// prefixes every token and code the fake Linear issues starts with (the
// logger's redaction leaves `lin_oauth_[redacted]`, which matches
// neither), the OAuth client secret, and the planner's own secrets.
// Session tokens are random, so the suite collects them from the
// Set-Cookie headers it sees and checks them separately.

/** SESSION_SECRET and TOKEN_ENCRYPTION_KEY of the planners under test. */
export const E2E_OAUTH_SERVER = {
  sessionSecret: 'e2e_session_TESTSECRET_x4Tq9Lm2Wd7Rk5Hz8Vb3',
  /** 32 bytes ('e2e-oauth-encrypt-key-TESTONLY!!'), base64. */
  tokenEncryptionKey: Buffer.from(
    'e2e-oauth-encrypt-key-TESTONLY!!',
    'utf8'
  ).toString('base64'),
} as const;

/** The fixed needles (see the file comment), deduplicated. */
export const OAUTH_LEAK_NEEDLES: readonly string[] = [
  ...new Set([
    'lin_oauth_access_',
    'lin_oauth_refresh_',
    'lin_code_',
    E2E_OAUTH_CLIENT.clientSecret,
    E2E_OAUTH_CLIENT.clientSecret.slice('e2e_oauth_'.length),
    E2E_OAUTH_SERVER.sessionSecret,
    E2E_OAUTH_SERVER.tokenEncryptionKey,
    'e2e-oauth-encrypt-key-TESTONLY!!',
  ]),
];

/** The fixed needles `text` holds (empty: clean). */
export function oauthNeedlesIn(text: string): string[] {
  return OAUTH_LEAK_NEEDLES.filter((needle) => text.includes(needle));
}
