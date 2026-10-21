import { describe, expect, test } from 'bun:test';

import { safeEqual, signValue, verifyValue } from '../lib/signed-cookie';

const SECRET = 'x'.repeat(32);
const NOW = 1_800_000_000_000;

describe('signed cookie values', () => {
  test('round-trips a payload before expiry', () => {
    const value = signValue({ state: 's1', intent: 'signin' }, SECRET, NOW + 1);
    expect(verifyValue(value, SECRET, NOW)).toEqual({
      state: 's1',
      intent: 'signin',
      exp: NOW + 1,
    });
  });

  test('rejects expired values', () => {
    const value = signValue({ state: 's1' }, SECRET, NOW);
    expect(verifyValue(value, SECRET, NOW)).toBeNull();
  });

  test('rejects a different secret', () => {
    const value = signValue({ state: 's1' }, SECRET, NOW + 1000);
    expect(verifyValue(value, 'y'.repeat(32), NOW)).toBeNull();
  });

  test('rejects a tampered payload', () => {
    const value = signValue({ state: 's1' }, SECRET, NOW + 1000);
    const [, sig] = value.split('.');
    const forged = Buffer.from(
      JSON.stringify({ state: 'evil', exp: NOW + 1000 })
    ).toString('base64url');
    expect(verifyValue(`${forged}.${sig}`, SECRET, NOW)).toBeNull();
  });

  test('rejects malformed values', () => {
    expect(verifyValue(undefined, SECRET, NOW)).toBeNull();
    expect(verifyValue('', SECRET, NOW)).toBeNull();
    expect(verifyValue('abc', SECRET, NOW)).toBeNull();
    expect(verifyValue('a.b.c', SECRET, NOW)).toBeNull();
  });

  test('refuses short secrets', () => {
    expect(() => signValue({}, 'short', NOW)).toThrow(/32 characters/);
  });

  test('safeEqual compares exactly', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});
