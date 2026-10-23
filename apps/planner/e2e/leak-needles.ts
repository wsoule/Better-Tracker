import { createHash } from 'node:crypto';

// The api-key e2e's test keys and leak needles (architecture §11 "Test
// keys"). Every key is obviously fake (TESTKEY) with a distinctive,
// non-repeating body, so window needles cannot hit padding by chance and
// no body has the 40-alphanumeric shape of push protection's scanners.
// The scanners look for every needle of every key: the key, its body, a
// middle window, its tail, its base64 and base64url, and its SHA-256 hex
// (with a 12-character prefix).

export const E2E_KEYS = {
  member: 'lin_api_TESTKEY_member_q7Wz3Kp9Vx2Lm8Rt5Yb1Nc',
  second: 'lin_api_TESTKEY_second_f2Jg8Qs4Wn7Xc1Zv5Bk9Mp',
  readonly: 'lin_api_TESTKEY_readonly_h5Rk2Dw9Lp4Gs7Fz1Jx8',
  guest: 'lin_api_TESTKEY_guest_m3Nb6Vq1Yt8Ke4Xa9Pu2Ws7',
  otherorg: 'lin_api_TESTKEY_otherorg_c9Fh4Tz7Lw2Mq5Jn8Sb1',
  revoked: 'lin_api_TESTKEY_revoked_p6Ux1Gr8Hc3Wv5Ny9Bt2Z',
} as const;

export type E2EKeyLabel = keyof typeof E2E_KEYS;

/** Every needle of one key (see the file comment). */
export function needlesFor(key: string): string[] {
  const body = key.slice('lin_api_'.length);
  const middle = Math.max(0, Math.floor(body.length / 2) - 6);
  const sha = createHash('sha256').update(key, 'utf8').digest('hex');
  return [
    key,
    body,
    body.slice(middle, middle + 12),
    key.slice(-12),
    Buffer.from(key, 'utf8').toString('base64'),
    Buffer.from(key, 'utf8').toString('base64url'),
    sha,
    sha.slice(0, 12),
  ];
}

/** TESTKEY and every needle of every test key, deduplicated. */
export const LEAK_NEEDLES: readonly string[] = [
  ...new Set(['TESTKEY', ...Object.values(E2E_KEYS).flatMap(needlesFor)]),
];

/** The needles of one text that hold any needle (empty: clean). */
export function needlesIn(text: string): string[] {
  return LEAK_NEEDLES.filter((needle) => text.includes(needle));
}
