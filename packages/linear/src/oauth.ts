// Linear OAuth 2.0 (architecture §4.1): authorize URL with PKCE (S256),
// code exchange, refresh (refresh tokens rotate), and revocation. Token
// endpoint calls are form-encoded; failures surface as OAuthError carrying
// the OAuth `error` code so the engine can tell "sign in again"
// (invalid_grant) from transient trouble.

import type { IsoDateTime } from '@better-tracker/core';
import { createHash, randomBytes } from 'node:crypto';

import type { FetchLike } from './client';
import type { OAuthClientConfig, TokenSet } from './gateway';
import {
  isRecord,
  type JsonObject,
  optionalNumber,
  optionalString,
} from './json';

export const LINEAR_AUTHORIZE_URL = 'https://linear.app/oauth/authorize';
export const LINEAR_TOKEN_URL = 'https://api.linear.app/oauth/token';
export const LINEAR_REVOKE_URL = 'https://api.linear.app/oauth/revoke';

/**
 * A failed OAuth call. `code` is the OAuth `error` value when Linear sent
 * one (`invalid_grant`, `invalid_client`, `invalid_request`, …); otherwise
 * `server_error` (HTTP 5xx or an unexpected status), `network_error` (fetch
 * threw) or `invalid_response` (the body was not a token response).
 */
export class OAuthError extends Error {
  readonly code: string;
  /** HTTP status, or null when the request never got a response. */
  readonly status: number | null;
  readonly description: string | null;

  constructor(
    code: string,
    message: string,
    options: {
      status?: number | null;
      description?: string | null;
      cause?: unknown;
    } = {}
  ) {
    super(message, { cause: options.cause });
    this.name = 'OAuthError';
    this.code = code;
    this.status = options.status ?? null;
    this.description = options.description ?? null;
  }
}

/** True for the error that means the grant (refresh token / code) is dead. */
export function isInvalidGrant(error: unknown): boolean {
  return error instanceof OAuthError && error.code === 'invalid_grant';
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

/**
 * A PKCE pair: a 43-character base64url verifier from 32 random bytes and
 * its S256 challenge (base64url of the verifier's SHA-256).
 */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** An unguessable `state` value for the authorize round trip. */
export function createOAuthState(): string {
  return base64url(randomBytes(32));
}

/**
 * The URL to send the browser to. Scopes are comma-separated as Linear
 * expects; `actor=app` (install) and `prompt=consent` are added only when
 * asked for.
 */
export function buildAuthorizeUrl(
  config: OAuthClientConfig,
  input: {
    state: string;
    scopes: string[];
    codeChallenge: string;
    actor?: 'user' | 'app';
    prompt?: 'consent';
  }
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: input.scopes.join(','),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
  });
  if (input.actor === 'app') params.set('actor', 'app');
  if (input.prompt === 'consent') params.set('prompt', 'consent');
  return `${LINEAR_AUTHORIZE_URL}?${params.toString()}`;
}

/** Splits a `scope` value Linear sends as "read write", "read,write" or a list. */
export function parseScopes(value: unknown): string[] {
  const parts: unknown[] = Array.isArray(value)
    ? (value as unknown[])
    : typeof value === 'string'
      ? value.split(/[\s,]+/)
      : [];
  const scopes: string[] = [];
  for (const part of parts) {
    if (typeof part !== 'string') continue;
    const scope = part.trim();
    if (scope !== '' && !scopes.includes(scope)) scopes.push(scope);
  }
  return scopes;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    return text === '' ? null : (JSON.parse(text) as unknown);
  } catch {
    return null;
  }
}

// Turns a non-2xx token-endpoint response into an OAuthError, keeping the
// OAuth error code when the body has one.
function errorFromResponse(
  response: Response,
  body: unknown,
  action: string
): OAuthError {
  const obj: JsonObject = isRecord(body) ? body : {};
  const code = optionalString(obj, 'error') ?? 'server_error';
  const description = optionalString(obj, 'error_description');
  return new OAuthError(
    code,
    `Linear OAuth ${action} failed (${response.status} ${code})${description === null ? '' : `: ${description}`}`,
    { status: response.status, description }
  );
}

// POSTs a form to a Linear OAuth endpoint; network failures become
// OAuthError('network_error'), error statuses become their OAuth code.
async function postForm(
  url: string,
  form: Record<string, string>,
  fetchImpl: FetchLike,
  action: string
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(form).toString(),
    });
  } catch (cause) {
    throw new OAuthError(
      'network_error',
      `Linear OAuth ${action} request failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause }
    );
  }
  const body = await readJson(response);
  if (!response.ok) throw errorFromResponse(response, body, action);
  return body;
}

// Narrows a token response. Linear returns access_token, token_type,
// expires_in (~86399 s), scope and refresh_token.
function toTokenSet(body: unknown, nowMs: number, action: string): TokenSet {
  if (!isRecord(body)) {
    throw new OAuthError(
      'invalid_response',
      `Linear OAuth ${action} returned no JSON body`
    );
  }
  if (optionalString(body, 'error') !== null) {
    throw new OAuthError(
      optionalString(body, 'error') ?? 'server_error',
      `Linear OAuth ${action} failed: ${optionalString(body, 'error_description') ?? 'error'}`,
      { description: optionalString(body, 'error_description') }
    );
  }
  const accessToken = optionalString(body, 'access_token');
  if (accessToken === null || accessToken === '') {
    throw new OAuthError(
      'invalid_response',
      `Linear OAuth ${action} returned no access_token`
    );
  }
  const expiresIn = optionalNumber(body, 'expires_in');
  const expiresAt: IsoDateTime | null =
    expiresIn === null
      ? null
      : new Date(nowMs + expiresIn * 1000).toISOString();
  const refreshToken = optionalString(body, 'refresh_token');
  return {
    accessToken,
    refreshToken: refreshToken === '' ? null : refreshToken,
    expiresAt,
    scopes: parseScopes(body['scope']),
  };
}

/** Exchanges an authorization code (with its PKCE verifier) for tokens. */
export async function exchangeCode(
  config: OAuthClientConfig,
  input: { code: string; codeVerifier: string },
  fetchImpl: FetchLike = globalThis.fetch
): Promise<TokenSet> {
  const body = await postForm(
    LINEAR_TOKEN_URL,
    {
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code_verifier: input.codeVerifier,
    },
    fetchImpl,
    'code exchange'
  );
  return toTokenSet(body, Date.now(), 'code exchange');
}

/**
 * Refreshes an access token. Linear rotates refresh tokens: the returned
 * pair replaces the old one, which stops working, so callers must persist
 * the result before using it (and refresh single-flight).
 */
export async function refreshTokens(
  config: OAuthClientConfig,
  refreshToken: string,
  fetchImpl: FetchLike = globalThis.fetch
): Promise<TokenSet> {
  const body = await postForm(
    LINEAR_TOKEN_URL,
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    },
    fetchImpl,
    'refresh'
  );
  return toTokenSet(body, Date.now(), 'refresh');
}

/** Revokes an access or refresh token (sign-out, uninstall). */
export async function revokeToken(
  config: OAuthClientConfig,
  token: string,
  hint: 'access_token' | 'refresh_token',
  fetchImpl: FetchLike = globalThis.fetch
): Promise<void> {
  await postForm(
    LINEAR_REVOKE_URL,
    {
      token,
      token_type_hint: hint,
      client_id: config.clientId,
      client_secret: config.clientSecret,
    },
    fetchImpl,
    'revoke'
  );
}
