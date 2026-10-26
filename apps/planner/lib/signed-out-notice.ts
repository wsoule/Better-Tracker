import { createHash } from 'node:crypto';

import { signValue, verifyValue } from './signed-cookie';

// The value /week?signed_out=1&from=<it> reads the name of the workspace
// just signed out from (OAuth mode, owner decision 2026-10-25): "Signed
// out of <A>. Still signed in to <B>." The name is the Linear workspace's,
// which whoever administers that workspace chooses, so the value is
// signed with SESSION_SECRET for five minutes and bound to the browser it
// was issued to: it carries a digest of the session token the sign-out
// left active, and /week accepts the name only when the request's active
// cookie matches. A value copied out of one browser's address bar into a
// link names nothing in another browser (it reads "Signed out."), so no
// one can put words of their choosing into someone else's /week.

/** How long the value stays valid. */
export const SIGNED_OUT_NOTICE_TTL_MS = 5 * 60 * 1000;

/**
 * The digest that binds the value to a browser: SHA-256 of the session
 * token the sign-out left active, with this purpose's own prefix (so it
 * is never the store's token hash), cut to 128 bits. The token itself
 * never goes into the URL.
 */
function holderOf(activeToken: string): string {
  return createHash('sha256')
    .update('milestone-planner signed-out notice\0')
    .update(activeToken)
    .digest('base64url')
    .slice(0, 22);
}

/**
 * The signed value for `name`, bound to the browser whose active session
 * is now `activeToken`; null without a name.
 */
export function signedOutNoticeValue(
  name: string | null,
  activeToken: string,
  secret: string,
  now: number = Date.now()
): string | null {
  if (name === null || name === '') return null;
  return signValue(
    { signedOut: name.slice(0, 200), holder: holderOf(activeToken) },
    secret,
    now + SIGNED_OUT_NOTICE_TTL_MS
  );
}

/**
 * The workspace name a value names, or null when it is missing, expired,
 * tampered, or was issued to another browser (the request's active
 * session token, `activeToken`, is not the one it was bound to).
 */
export function verifiedSignedOutName(
  value: string | undefined,
  activeToken: string | undefined,
  secret: string,
  now: number = Date.now()
): string | null {
  if (value === undefined || value === '' || activeToken === undefined) {
    return null;
  }
  const record = verifyValue(value, secret, now);
  const name = record?.signedOut;
  if (typeof name !== 'string' || name === '') return null;
  return record?.holder === holderOf(activeToken) ? name : null;
}
