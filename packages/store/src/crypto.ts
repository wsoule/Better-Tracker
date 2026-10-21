// Secrets at rest. OAuth tokens are encrypted with AES-256-GCM before they
// reach the database, and session cookie tokens are only ever stored as their
// SHA-256 hash, so a database dump alone never yields a usable credential.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SESSION_TOKEN_BYTES = 32;
const FORMAT_VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';

// Standard or URL-safe base64, optionally padded. Node's decoder silently
// skips characters outside the alphabet, so the shape is checked up front.
const BASE64_PATTERN = /^[A-Za-z0-9+/_-]+={0,2}$/;

/**
 * Decodes TOKEN_ENCRYPTION_KEY (32 random bytes, base64) into raw key bytes.
 * Throws a descriptive error for anything else, so a misconfigured
 * deployment fails at boot instead of on the first token write.
 */
export function parseEncryptionKey(base64Key: string): Buffer {
  const trimmed = base64Key.trim();
  if (trimmed === '' || !BASE64_PATTERN.test(trimmed)) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY must be 32 random bytes encoded as base64 (e.g. `openssl rand -base64 32`); the value is not valid base64'
    );
  }
  const key = Buffer.from(trimmed, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `TOKEN_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes (got ${key.length}); generate one with \`openssl rand -base64 32\``
    );
  }
  return key;
}

/**
 * Encrypts one secret as `v1:<iv>:<tag>:<ciphertext>` (each part base64url)
 * with a fresh random 12-byte IV, so equal tokens never encrypt alike.
 */
export function encryptToken(plaintext: string, key: Uint8Array): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_BYTES,
  });
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    FORMAT_VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join(':');
}

/**
 * Reverses encryptToken. Throws when the value is malformed, was encrypted
 * with another key, or was modified (GCM authentication fails).
 */
export function decryptToken(value: string, key: Uint8Array): string {
  const parts = value.split(':');
  if (parts.length !== 4 || parts[0] !== FORMAT_VERSION) {
    throw new Error(
      'Malformed encrypted token: expected v1:<iv>:<tag>:<ciphertext>'
    );
  }
  const [, ivPart = '', tagPart = '', cipherPart = ''] = parts;
  const iv = Buffer.from(ivPart, 'base64url');
  const tag = Buffer.from(tagPart, 'base64url');
  // GCM accepts truncated tags unless told otherwise; insist on the full
  // 16 bytes so a shortened tag cannot weaken authentication.
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('Malformed encrypted token: bad IV or tag length');
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(cipherPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch (error) {
    throw new Error(
      'Could not decrypt token: wrong TOKEN_ENCRYPTION_KEY or the stored value was tampered with',
      { cause: error }
    );
  }
}

/** SHA-256 (hex) of a session cookie token: the only form that is stored. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A new opaque session cookie token: 32 random bytes, base64url. */
export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}
