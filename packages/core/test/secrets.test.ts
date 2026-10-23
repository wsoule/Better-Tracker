import { describe, expect, test } from 'bun:test';

import {
  containsLinearCredential,
  introducesLinearCredential,
  isLinearApiKeyShape,
  LINEAR_API_KEY_PREFIX,
  redactLinearSecrets,
} from '../src/index';

// Obviously fake keys (architecture §11 "Test keys"): never real secrets.
const KEYS = [
  'lin_api_TESTKEY_member_q7Wz3Kp9Vx2Lm8Rt5Yb1Nc',
  'lin_api_TESTKEY_second_f2Jg8Qs4Wn7Xc1Zv5Bk9Mp',
  'lin_api_TESTKEY_readonly_h5Rk2Dw9Lp4Gs7Fz1Jx8',
  'lin_api_TESTKEY_guest_m3Nb6Vq1Yt8Ke4Xa9Pu2Ws7',
  'lin_api_TESTKEY_otherorg_c9Fh4Tz7Lw2Mq5Jn8Sb1',
  'lin_api_TESTKEY_revoked_p6Ux1Gr8Hc3Wv5Ny9Bt2Z',
];
const KEY = KEYS[0] ?? '';

describe('isLinearApiKeyShape', () => {
  test('accepts every test key', () => {
    for (const key of KEYS) expect(isLinearApiKeyShape(key)).toBe(true);
    expect(KEY.startsWith(LINEAR_API_KEY_PREFIX)).toBe(true);
  });

  test('refuses anything else', () => {
    for (const value of [
      '',
      'lin_api_',
      'lin_api_short',
      'lin_api_TESTKEY has_a_space_q7Wz3',
      'lin_api_TESTKEY_newline\nq7Wz3Kp9Vx2',
      'lin_api_TESTKEY+plus_q7Wz3Kp9Vx2Lm8',
      'lin_api_TESTKEY/slash_q7Wz3Kp9Vx2Lm8',
      'lin_api_TESTKEY%25pct_q7Wz3Kp9Vx2Lm8',
      'lin_oauth_TESTKEY_member_q7Wz3Kp9Vx2Lm8',
      `Bearer ${KEY}`,
      `lin_api_${'a'.repeat(201)}`,
    ]) {
      expect(isLinearApiKeyShape(value)).toBe(false);
    }
    expect(isLinearApiKeyShape(`lin_api_${'a'.repeat(200)}`)).toBe(true);
  });
});

describe('redactLinearSecrets', () => {
  test('redacts a key in text, JSON, a URL query and a header line', () => {
    expect(redactLinearSecrets(`the key ${KEY} leaked`)).toBe(
      'the key lin_api_[redacted] leaked'
    );
    expect(redactLinearSecrets(JSON.stringify({ apiKey: KEY }))).toBe(
      '{"apiKey":"lin_api_[redacted]"}'
    );
    expect(redactLinearSecrets(`/issues?q=${KEY}&x=1`)).toBe(
      '/issues?q=lin_api_[redacted]&x=1'
    );
    expect(redactLinearSecrets(`Authorization: ${KEY}`)).toBe(
      'Authorization: lin_api_[redacted]'
    );
  });

  test('redacts an OAuth token too', () => {
    expect(redactLinearSecrets('Bearer lin_oauth_abcdefghijklmnop1234')).toBe(
      'Bearer lin_oauth_[redacted]'
    );
  });

  test('is idempotent and never throws', () => {
    const once = redactLinearSecrets(`${KEY} and ${KEYS[1]}`);
    expect(redactLinearSecrets(once)).toBe(once);
    expect(once).not.toContain('TESTKEY');
  });

  test('leaves ordinary text untouched', () => {
    for (const text of [
      'lint api',
      'linear_api',
      'lin_apix',
      'lin_api_key',
      'they start with lin_api_.',
      'Bearer token refresh fails',
      'Support Bearer tokens',
      'bearer of bad news',
    ]) {
      expect(redactLinearSecrets(text)).toBe(text);
    }
  });
});

describe('containsLinearCredential / introducesLinearCredential', () => {
  test('finds a run, and only new runs count as introduced', () => {
    expect(containsLinearCredential(`x ${KEY}`)).toBe(true);
    expect(containsLinearCredential('they start with lin_api_.')).toBe(false);
    expect(introducesLinearCredential(null, `x ${KEY}`)).toBe(true);
    expect(introducesLinearCredential('plain', `x ${KEY}`)).toBe(true);
    expect(introducesLinearCredential(`old ${KEY}`, `new ${KEY} text`)).toBe(
      false
    );
    expect(introducesLinearCredential(`old ${KEY}`, `${KEY} ${KEYS[1]}`)).toBe(
      true
    );
    expect(introducesLinearCredential(null, 'no key here')).toBe(false);
  });
});
