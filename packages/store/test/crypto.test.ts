import { describe, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';

import {
  decryptToken,
  encryptToken,
  generateSessionToken,
  hashSessionToken,
  parseEncryptionKey,
} from '../src/crypto';

const KEY = parseEncryptionKey(randomBytes(32).toString('base64'));
const BASE64URL = /^[A-Za-z0-9_-]*$/;

// Flips one bit of one base64url-encoded part of an encrypted token.
function tamper(value: string, partIndex: number): string {
  const parts = value.split(':');
  const bytes = Buffer.from(parts[partIndex] ?? '', 'base64url');
  bytes[0] = (bytes[0] ?? 0) ^ 0x01;
  parts[partIndex] = bytes.toString('base64url');
  return parts.join(':');
}

describe('parseEncryptionKey', () => {
  test('accepts 32 bytes as padded base64, unpadded base64 and base64url', () => {
    const raw = randomBytes(32);
    expect(parseEncryptionKey(raw.toString('base64'))).toEqual(raw);
    expect(
      parseEncryptionKey(raw.toString('base64').replace(/=+$/, ''))
    ).toEqual(raw);
    expect(parseEncryptionKey(raw.toString('base64url'))).toEqual(raw);
    expect(parseEncryptionKey(`  ${raw.toString('base64')}\n`)).toEqual(raw);
  });

  test.each([
    ['16 bytes', randomBytes(16).toString('base64')],
    ['31 bytes', randomBytes(31).toString('base64')],
    ['33 bytes', randomBytes(33).toString('base64')],
    ['64 bytes', randomBytes(64).toString('base64')],
  ])('rejects a key of %s', (_label, key) => {
    expect(() => parseEncryptionKey(key)).toThrow(/exactly 32 bytes/);
  });

  test.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['not base64', 'this is not a key!'],
    ['hex with a colon', 'ab:cd'],
  ])('rejects a malformed key (%s)', (_label, key) => {
    expect(() => parseEncryptionKey(key)).toThrow(/TOKEN_ENCRYPTION_KEY/);
  });
});

describe('encryptToken / decryptToken', () => {
  test('round-trips, including empty and unicode values', () => {
    for (const value of ['lin_oauth_abc123', '', 'tökén ✓ with: colons']) {
      expect(decryptToken(encryptToken(value, KEY), KEY)).toBe(value);
    }
  });

  test('uses the v1:<iv>:<tag>:<ciphertext> base64url format', () => {
    const encrypted = encryptToken('secret-token', KEY);
    const parts = encrypted.split(':');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
    for (const part of parts.slice(1)) {
      expect(part).toMatch(BASE64URL);
    }
    expect(Buffer.from(parts[1] ?? '', 'base64url')).toHaveLength(12);
    expect(Buffer.from(parts[2] ?? '', 'base64url')).toHaveLength(16);
    expect(encrypted).not.toContain('secret-token');
  });

  test('uses a fresh IV per value', () => {
    const a = encryptToken('same', KEY);
    const b = encryptToken('same', KEY);
    expect(a).not.toBe(b);
    expect(a.split(':')[1]).not.toBe(b.split(':')[1]);
  });

  test('detects tampering with the IV, tag or ciphertext', () => {
    const encrypted = encryptToken('lin_oauth_abc123', KEY);
    for (const part of [1, 2, 3]) {
      expect(() => decryptToken(tamper(encrypted, part), KEY)).toThrow(
        /wrong TOKEN_ENCRYPTION_KEY or the stored value was tampered/
      );
    }
  });

  test('fails with the wrong key', () => {
    const encrypted = encryptToken('lin_oauth_abc123', KEY);
    const otherKey = parseEncryptionKey(randomBytes(32).toString('base64'));
    expect(() => decryptToken(encrypted, otherKey)).toThrow(
      /Could not decrypt token/
    );
  });

  test('rejects malformed values and truncated tags', () => {
    const encrypted = encryptToken('x', KEY);
    const [, iv, tag, ciphertext] = encrypted.split(':');
    const shortTag = Buffer.from(tag ?? '', 'base64url')
      .subarray(0, 8)
      .toString('base64url');
    for (const value of [
      'plaintext',
      'v2:a:b:c',
      'v1:a:b',
      `v1:${iv}:${shortTag}:${ciphertext}`,
      `v1::${tag}:${ciphertext}`,
    ]) {
      expect(() => decryptToken(value, KEY)).toThrow(
        /Malformed encrypted token/
      );
    }
  });
});

describe('session tokens', () => {
  test('generates 32 random bytes as base64url', () => {
    const token = generateSessionToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    expect(generateSessionToken()).not.toBe(token);
  });

  test('hashes with SHA-256 (hex)', () => {
    expect(hashSessionToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toBe(
      createHash('sha256').update(token).digest('hex')
    );
  });
});
