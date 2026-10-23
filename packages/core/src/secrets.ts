// Linear credentials as text (LINEAR_AUTH=api_key, owner request
// 2026-10-23; architecture §4.1 "Personal API keys"). Every Linear
// credential the planner handles starts with `lin_api_` (a personal API
// key) or `lin_oauth_` (an OAuth token), per Linear's integration guide, so
// one pattern finds them in any text: log lines, error messages, stored
// planner-owned text and anything a person types. Pure functions, no I/O.

/** Prefix of a Linear personal API key (linear-solutions guide, F2). */
export const LINEAR_API_KEY_PREFIX = 'lin_api_';

/**
 * What the planner accepts as a personal API key: the prefix, then 16–200
 * URL-safe characters. Linear documents only the prefix (F3); one constant,
 * so an unexpected real format is a one-line fix and never accepted loosely.
 */
export const LINEAR_API_KEY_SHAPE: RegExp = /^lin_api_[A-Za-z0-9_-]{16,200}$/;

// A credential-shaped run: a Linear prefix and at least 16 URL-safe
// characters. Short runs ("lin_api_key", "they start with lin_api_") do not
// match. A fresh RegExp per call keeps the global flag's lastIndex out of
// shared state.
const CREDENTIAL_SOURCE = 'lin_(api|oauth)_[A-Za-z0-9_-]{16,}';

function credentialPattern(): RegExp {
  return new RegExp(CREDENTIAL_SOURCE, 'g');
}

/** True when `value` has the shape of a personal API key (LINEAR_API_KEY_SHAPE). */
export function isLinearApiKeyShape(value: string): boolean {
  return typeof value === 'string' && LINEAR_API_KEY_SHAPE.test(value);
}

/**
 * Replaces every credential-shaped run, `lin_api_` or `lin_oauth_` followed by
 * 16 or more URL-safe characters, with `lin_api_[redacted]` /
 * `lin_oauth_[redacted]`. Every Linear credential has one of these prefixes
 * (F2), so there is no `Bearer` rule: such a rule would rewrite ordinary words
 * ("Bearer token refresh fails"). Pure, idempotent, never throws; strings
 * without a match come back as the same string.
 */
export function redactLinearSecrets(text: string): string {
  if (typeof text !== 'string' || !text.includes('lin_')) return text;
  const pattern = credentialPattern();
  if (!pattern.test(text)) return text;
  pattern.lastIndex = 0;
  return text.replace(
    pattern,
    (_match, kind: string) => `lin_${kind}_[redacted]`
  );
}

/** True when `text` holds a credential-shaped run (same pattern). */
export function containsLinearCredential(text: string): boolean {
  if (typeof text !== 'string' || !text.includes('lin_')) return false;
  return credentialPattern().test(text);
}

/**
 * True when `next` holds a credential-shaped run that `previous` does not
 * (`previous` null for new text). Edits refuse only newly typed keys, so an
 * existing description that quotes one can still be edited (§7.12).
 */
export function introducesLinearCredential(
  previous: string | null,
  next: string
): boolean {
  if (!containsLinearCredential(next)) return false;
  const before = new Set(
    previous === null ? [] : (previous.match(credentialPattern()) ?? [])
  );
  return (next.match(credentialPattern()) ?? []).some(
    (run) => !before.has(run)
  );
}
