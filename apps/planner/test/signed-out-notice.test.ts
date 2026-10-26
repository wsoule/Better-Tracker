import { describe, expect, test } from 'bun:test';

import {
  SIGNED_OUT_NOTICE_TTL_MS,
  signedOutNoticeValue,
  verifiedSignedOutName,
} from '../lib/signed-out-notice';

// /week's "Signed out of <A>" value (OAuth mode): signed for five minutes
// and bound to the browser it was issued to, so a value copied into a
// link puts no words of anyone's choosing into another person's /week.

const SECRET = 's'.repeat(32);
const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const KEPT = 'kept-session-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER = 'other-session-token-bbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('the signed-out notice value', () => {
  test('names the workspace only for the session it was bound to, while fresh', () => {
    const value = signedOutNoticeValue('Globex', KEPT, SECRET, NOW) ?? '';
    expect(verifiedSignedOutName(value, KEPT, SECRET, NOW)).toBe('Globex');
    expect(verifiedSignedOutName(value, OTHER, SECRET, NOW)).toBeNull();
    expect(verifiedSignedOutName(value, undefined, SECRET, NOW)).toBeNull();
    expect(
      verifiedSignedOutName(
        value,
        KEPT,
        SECRET,
        NOW + SIGNED_OUT_NOTICE_TTL_MS + 1
      )
    ).toBeNull();
    expect(verifiedSignedOutName(`${value}x`, KEPT, SECRET, NOW)).toBeNull();
    expect(verifiedSignedOutName(value, KEPT, 't'.repeat(32), NOW)).toBeNull();
  });

  test('never carries the session token, and no name means no value', () => {
    const value = signedOutNoticeValue('Globex', KEPT, SECRET, NOW) ?? '';
    const payload = Buffer.from(
      value.split('.')[0] ?? '',
      'base64url'
    ).toString('utf8');
    expect(payload).not.toContain(KEPT);
    expect(value).not.toContain(KEPT);
    expect(signedOutNoticeValue(null, KEPT, SECRET, NOW)).toBeNull();
    expect(signedOutNoticeValue('', KEPT, SECRET, NOW)).toBeNull();
  });
});
