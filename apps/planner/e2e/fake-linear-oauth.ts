// The OAuth half of the e2e's fake Linear (fake-linear.ts): what
// https://api.linear.app/oauth/token and /oauth/revoke answer, plus the
// test-only way to mint an authorization code (what Linear's authorize
// page does when someone picks a workspace and approves).
//
// - A code is bound to an organization, a person, scopes and an actor
//   ('user', or 'app' for an install, which only an admin may approve),
//   and optionally to the client id, redirect URI and PKCE challenge the
//   authorize URL carried. It works once, for ten minutes.
// - authorization_code needs the client's id and secret (form fields or
//   HTTP Basic) and a code_verifier; when the code has a challenge the
//   verifier must match it (S256 or plain), and the redirect URI must be
//   the one the code was minted for.
// - refresh_token rotates like Linear's: the old refresh token dies, a new
//   access and refresh token are issued on the same grant. An access
//   token stays valid until it expires (expires_in, default 86399 s).
// - Revoking a live access or refresh token ends its whole grant (both
//   tokens), so GraphQL with either answers 401 afterwards. A token the
//   fake does not know is a no-op 200, as RFC 7009 says.
//
// Tokens are opaque `lin_oauth_access_…` / `lin_oauth_refresh_…` strings
// (codes `lin_code_…`), so leak scans can look for the `lin_oauth_`
// prefix. Every call is recorded with its secrets left out.

import { createHash, randomBytes } from 'node:crypto';

import {
  type FakeOrg,
  type FakeOrgKey,
  fakeHandleOf,
  fakeOrg,
  fakePerson,
} from './fake-linear-data';

/** The OAuth client the fake accepts unless a test passes its own. */
export const E2E_OAUTH_CLIENT = {
  clientId: 'e2e-planner-client',
  clientSecret: 'e2e_oauth_TESTSECRET_v3Lq8Wd1Hs6Kz4Np',
} as const;

/** Every access and refresh token the fake issues starts with this. */
export const OAUTH_TOKEN_PREFIX = 'lin_oauth_';

/** Linear's access token lifetime (expires_in). */
export const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 86_399;

const CODE_TTL_MS = 10 * 60_000;

export interface FakeOAuthClient {
  clientId: string;
  clientSecret: string;
}

/** What /__requests lists for an OAuth call (never a token, code or secret). */
export interface FakeOAuthRequestRecord {
  operation: 'oauth/token' | 'oauth/revoke' | 'oauth/code';
  auth: 'oauth';
  /** The client credentials presented (null for a minted code). */
  clientAuth: 'ok' | 'missing' | 'wrong' | null;
  /** token: authorization_code | refresh_token (as sent). */
  grantType: string | null;
  status: number;
  /** The OAuth error code when refused. */
  error: string | null;
  /** The grant's organization, when the code or token was known. */
  org: FakeOrgKey | null;
  /** Its person's handle ('ana', 'gia'), or 'app' for an actor=app grant. */
  who: string | null;
  actor: 'user' | 'app' | null;
  scopes: string[] | null;
  /** code exchange: whether the PKCE verifier was there and matched. */
  pkce: 'ok' | 'missing' | 'mismatch' | null;
  /** revoke: which kind of token was revoked. */
  tokenType: 'access_token' | 'refresh_token' | null;
  /** revoke: the token_type_hint as sent. */
  hint: string | null;
  /** revoke: ended a live grant, hit a dead token, or an unknown one. */
  effect: 'revoked' | 'already_dead' | 'unknown' | null;
  /** code: the authorize URL's prompt, when the minting page passed it. */
  prompt: string | null;
  /** Whether a test API key (lin_api_…) was in the body or URL. */
  keyInBodyOrUrl: boolean;
}

/** One grant: a code exchange and every token refreshed from it. */
export interface FakeGrant {
  id: number;
  org: FakeOrgKey;
  /** The user id the tokens act as (the app user for actor=app). */
  userId: string;
  /** Its handle ('ana', 'gia'), or 'app'. */
  who: string;
  actor: 'user' | 'app';
  scopes: string[];
  /** For actor=app: the admin who approved it. */
  approvedBy: string | null;
  revoked: boolean;
  refreshes: number;
}

/** A grant as GET /__oauth/grants lists it. */
export type FakeGrantSummary = Omit<FakeGrant, 'id'> & { grant: number };

/** One revocation, for tests that check which workspace's token ended. */
export interface FakeRevocation {
  org: FakeOrgKey | null;
  who: string | null;
  actor: 'user' | 'app' | null;
  tokenType: 'access_token' | 'refresh_token' | null;
  hint: string | null;
  effect: 'revoked' | 'already_dead' | 'unknown';
}

/** What a test (or the authorize page) asks a code for. */
export interface MintCodeInput {
  /** The organization's URL key ('globex') or id. */
  org: string;
  /**
   * The person approving, as a handle ('ana') or user id; defaults to
   * the org's default person (an admin, for actor=app).
   */
  user?: string | null;
  /** Comma- or space-separated, or a list (default 'read'). */
  scope?: string | readonly string[] | null;
  actor?: 'user' | 'app' | null;
  clientId?: string | null;
  redirectUri?: string | null;
  codeChallenge?: string | null;
  codeChallengeMethod?: string | null;
  prompt?: string | null;
}

export type MintCodeResult =
  | {
      ok: true;
      code: string;
      org: FakeOrgKey;
      who: string;
      actor: 'user' | 'app';
      scopes: string[];
    }
  | { ok: false; status: number; error: string; description: string };

interface CodeEntry {
  grant: Omit<FakeGrant, 'id' | 'revoked' | 'refreshes'>;
  clientId: string | null;
  redirectUri: string | null;
  challenge: string | null;
  method: string;
  expiresAt: number;
  used: boolean;
}

interface TokenEntry {
  grant: FakeGrant;
  kind: 'access_token' | 'refresh_token';
  /** access: when it stops working. */
  expiresAt: number;
  /** refresh: replaced by a newer one. */
  rotated: boolean;
}

/** Who a bearer token acts as, or why it does not work. */
export type AccessCheck =
  | { state: 'ok'; grant: FakeGrant }
  | { state: 'revoked' | 'expired'; grant: FakeGrant }
  | { state: 'unknown'; grant: null };

/** Splits a scope value sent as "read,write", "read write" or a list. */
export function scopeList(value: string | readonly string[] | null): string[] {
  const parts = typeof value === 'string' ? value.split(/[\s,]+/) : value;
  const scopes: string[] = [];
  for (const part of parts ?? []) {
    const scope = part.trim();
    if (scope !== '' && !scopes.includes(scope)) scopes.push(scope);
  }
  return scopes;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });
}

function opaque(prefix: string, counter: number): string {
  return `${prefix}${counter}_${randomBytes(18).toString('base64url')}`;
}

// The client id a request authenticates as, and whether the secret was
// right: form fields first (what the planner sends), HTTP Basic otherwise.
function clientAuthOf(
  form: URLSearchParams,
  headers: Headers,
  client: FakeOAuthClient
): { clientAuth: 'ok' | 'missing' | 'wrong'; clientId: string | null } {
  let id = form.get('client_id');
  let secret = form.get('client_secret');
  const basic = /^Basic\s+(.+)$/i.exec(headers.get('authorization') ?? '');
  if (secret === null && basic !== null) {
    const decoded = Buffer.from(basic[1] ?? '', 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon !== -1) {
      id = decodeURIComponent(decoded.slice(0, colon));
      secret = decodeURIComponent(decoded.slice(colon + 1));
    }
  }
  if (id === null || id === '' || secret === null || secret === '') {
    return { clientAuth: 'missing', clientId: id };
  }
  return {
    clientAuth:
      id === client.clientId && secret === client.clientSecret ? 'ok' : 'wrong',
    clientId: id,
  };
}

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/**
 * The fake's OAuth server state: codes, grants and tokens, the token and
 * revoke endpoints, and the check GraphQL makes for a bearer token.
 */
export function createFakeOAuth(options: {
  client: FakeOAuthClient;
  now: () => number;
  accessTokenTtlSeconds: number;
  /** Called with every OAuth call's record, in order. */
  record: (record: FakeOAuthRequestRecord) => void;
  /** Whether a text holds a test API key (for keyInBodyOrUrl). */
  holdsApiKey: (text: string) => boolean;
}): {
  mintCode(input: MintCodeInput): MintCodeResult;
  token(request: Request): Promise<Response>;
  revoke(request: Request): Promise<Response>;
  checkAccess(token: string): AccessCheck;
  /** True when a text holds something shaped like this fake's tokens or codes. */
  holdsIssued(text: string): boolean;
  grants(): FakeGrantSummary[];
  revocations: FakeRevocation[];
} {
  const { client, now, record } = options;
  const codes = new Map<string, CodeEntry>();
  const tokens = new Map<string, TokenEntry>();
  const grants: FakeGrant[] = [];
  const revocations: FakeRevocation[] = [];
  let counter = 0;

  const blank: Omit<
    FakeOAuthRequestRecord,
    'operation' | 'status' | 'keyInBodyOrUrl'
  > = {
    auth: 'oauth',
    clientAuth: null,
    grantType: null,
    error: null,
    org: null,
    who: null,
    actor: null,
    scopes: null,
    pkce: null,
    tokenType: null,
    hint: null,
    effect: null,
    prompt: null,
  };

  function grantFields(
    grant: Pick<FakeGrant, 'org' | 'who' | 'actor' | 'scopes'>
  ): Pick<FakeOAuthRequestRecord, 'org' | 'who' | 'actor' | 'scopes'> {
    return {
      org: grant.org,
      who: grant.who,
      actor: grant.actor,
      scopes: [...grant.scopes],
    };
  }

  // Issues a new access + refresh token pair on `grant`.
  function issue(grant: FakeGrant): Response {
    counter += 1;
    const accessToken = opaque(`${OAUTH_TOKEN_PREFIX}access_`, counter);
    const refreshToken = opaque(`${OAUTH_TOKEN_PREFIX}refresh_`, counter);
    tokens.set(accessToken, {
      grant,
      kind: 'access_token',
      expiresAt: now() + options.accessTokenTtlSeconds * 1000,
      rotated: false,
    });
    tokens.set(refreshToken, {
      grant,
      kind: 'refresh_token',
      expiresAt: Number.POSITIVE_INFINITY,
      rotated: false,
    });
    return json(200, {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: options.accessTokenTtlSeconds,
      scope: grant.scopes.join(' '),
      refresh_token: refreshToken,
    });
  }

  function mintCode(input: MintCodeInput): MintCodeResult {
    const refuse = (
      status: number,
      error: string,
      description: string,
      extra: Partial<FakeOAuthRequestRecord> = {}
    ): MintCodeResult => {
      record({
        ...blank,
        ...extra,
        operation: 'oauth/code',
        status,
        error,
        prompt: input.prompt ?? null,
        keyInBodyOrUrl: false,
      });
      return { ok: false, status, error, description };
    };
    const org: FakeOrg | null = fakeOrg(input.org);
    if (org === null) {
      return refuse(400, 'invalid_request', `No workspace ${input.org}`);
    }
    if (
      input.clientId !== undefined &&
      input.clientId !== null &&
      input.clientId !== client.clientId
    ) {
      return refuse(400, 'invalid_client', 'Unknown OAuth client');
    }
    const actor = input.actor === 'app' ? 'app' : 'user';
    const approverHandle =
      input.user ??
      (actor === 'app'
        ? fakeHandleOf(org, org.admins[0] ?? '')
        : org.defaultPerson);
    const approver = fakePerson(org, approverHandle)?.id ?? null;
    if (approver === null) {
      return refuse(
        400,
        'invalid_request',
        `${approverHandle} is not in ${org.organization.name}`
      );
    }
    if (actor === 'app' && !org.admins.includes(approver)) {
      return refuse(
        403,
        'access_denied',
        `Only an admin of ${org.organization.name} can install an app`,
        { org: org.key, who: fakeHandleOf(org, approver), actor }
      );
    }
    const scopes = scopeList(input.scope ?? 'read');
    const userId = actor === 'app' ? org.appUser.id : approver;
    counter += 1;
    const code = opaque('lin_code_', counter);
    const grant: CodeEntry['grant'] = {
      org: org.key,
      userId,
      who: fakeHandleOf(org, userId),
      actor,
      scopes,
      approvedBy: actor === 'app' ? fakeHandleOf(org, approver) : null,
    };
    codes.set(code, {
      grant,
      clientId: input.clientId ?? null,
      redirectUri: input.redirectUri ?? null,
      challenge: input.codeChallenge ?? null,
      method: input.codeChallengeMethod ?? 'S256',
      expiresAt: now() + CODE_TTL_MS,
      used: false,
    });
    record({
      ...blank,
      ...grantFields(grant),
      operation: 'oauth/code',
      status: 200,
      prompt: input.prompt ?? null,
      keyInBodyOrUrl: false,
    });
    return {
      ok: true,
      code,
      org: org.key,
      who: grant.who,
      actor,
      scopes: [...scopes],
    };
  }

  async function token(request: Request): Promise<Response> {
    const body = await request.text();
    const form = new URLSearchParams(body);
    const auth = clientAuthOf(form, request.headers, client);
    const grantType = form.get('grant_type');
    const base = {
      ...blank,
      operation: 'oauth/token' as const,
      clientAuth: auth.clientAuth,
      grantType,
      keyInBodyOrUrl:
        options.holdsApiKey(body) || options.holdsApiKey(request.url),
    };
    const refuse = (
      status: number,
      error: string,
      description: string,
      extra: Partial<FakeOAuthRequestRecord> = {}
    ): Response => {
      record({ ...base, ...extra, status, error });
      return json(status, { error, error_description: description });
    };
    if (auth.clientAuth !== 'ok') {
      return refuse(401, 'invalid_client', 'Client authentication failed');
    }
    if (grantType === 'authorization_code') {
      const code = form.get('code') ?? '';
      const entry = codes.get(code);
      if (entry === undefined || entry.used || entry.expiresAt <= now()) {
        return refuse(400, 'invalid_grant', 'The code is invalid or expired');
      }
      const fields = grantFields(entry.grant);
      if (entry.clientId !== null && entry.clientId !== auth.clientId) {
        return refuse(
          400,
          'invalid_grant',
          'The code is for another client',
          fields
        );
      }
      if (
        entry.redirectUri !== null &&
        form.get('redirect_uri') !== entry.redirectUri
      ) {
        return refuse(
          400,
          'invalid_grant',
          'redirect_uri does not match',
          fields
        );
      }
      const verifier = form.get('code_verifier');
      if (verifier === null || verifier === '') {
        return refuse(400, 'invalid_request', 'code_verifier is required', {
          ...fields,
          pkce: 'missing',
        });
      }
      if (
        entry.challenge !== null &&
        (entry.method === 'plain' ? verifier : s256(verifier)) !==
          entry.challenge
      ) {
        return refuse(400, 'invalid_grant', 'code_verifier does not match', {
          ...fields,
          pkce: 'mismatch',
        });
      }
      entry.used = true;
      const grant: FakeGrant = {
        ...entry.grant,
        scopes: [...entry.grant.scopes],
        id: grants.length + 1,
        revoked: false,
        refreshes: 0,
      };
      grants.push(grant);
      record({ ...base, ...fields, status: 200, pkce: 'ok' });
      return issue(grant);
    }
    if (grantType === 'refresh_token') {
      const entry = tokens.get(form.get('refresh_token') ?? '');
      if (entry === undefined || entry.kind !== 'refresh_token') {
        return refuse(400, 'invalid_grant', 'refresh token is invalid');
      }
      const fields = grantFields(entry.grant);
      if (entry.rotated || entry.grant.revoked) {
        return refuse(400, 'invalid_grant', 'refresh token is invalid', fields);
      }
      entry.rotated = true;
      entry.grant.refreshes += 1;
      record({ ...base, ...fields, status: 200 });
      return issue(entry.grant);
    }
    return refuse(
      400,
      'unsupported_grant_type',
      `grant_type ${grantType ?? '(none)'}`
    );
  }

  async function revoke(request: Request): Promise<Response> {
    const body = await request.text();
    const form = new URLSearchParams(body);
    const auth = clientAuthOf(form, request.headers, client);
    const hint = form.get('token_type_hint');
    const base = {
      ...blank,
      operation: 'oauth/revoke' as const,
      clientAuth: auth.clientAuth,
      hint,
      keyInBodyOrUrl:
        options.holdsApiKey(body) || options.holdsApiKey(request.url),
    };
    if (auth.clientAuth !== 'ok') {
      record({ ...base, status: 401, error: 'invalid_client' });
      return json(401, {
        error: 'invalid_client',
        error_description: 'Client authentication failed',
      });
    }
    const value = form.get('token');
    if (value === null || value === '') {
      record({ ...base, status: 400, error: 'invalid_request' });
      return json(400, {
        error: 'invalid_request',
        error_description: 'token is required',
      });
    }
    const entry = tokens.get(value);
    let revocation: FakeRevocation;
    if (entry === undefined) {
      revocation = {
        org: null,
        who: null,
        actor: null,
        tokenType: null,
        hint,
        effect: 'unknown',
      };
    } else {
      const dead =
        entry.grant.revoked ||
        entry.rotated ||
        (entry.kind === 'access_token' && entry.expiresAt <= now());
      if (!dead) entry.grant.revoked = true;
      revocation = {
        org: entry.grant.org,
        who: entry.grant.who,
        actor: entry.grant.actor,
        tokenType: entry.kind,
        hint,
        effect: dead ? 'already_dead' : 'revoked',
      };
    }
    revocations.push(revocation);
    record({
      ...base,
      status: 200,
      org: revocation.org,
      who: revocation.who,
      actor: revocation.actor,
      scopes: entry === undefined ? null : [...entry.grant.scopes],
      tokenType: revocation.tokenType,
      effect: revocation.effect,
    });
    return json(200, {});
  }

  function checkAccess(value: string): AccessCheck {
    const entry = tokens.get(value);
    if (entry === undefined || entry.kind !== 'access_token') {
      return { state: 'unknown', grant: null };
    }
    if (entry.grant.revoked) return { state: 'revoked', grant: entry.grant };
    if (entry.expiresAt <= now()) {
      return { state: 'expired', grant: entry.grant };
    }
    return { state: 'ok', grant: entry.grant };
  }

  return {
    mintCode,
    token,
    revoke,
    checkAccess,
    holdsIssued: (text) =>
      text.includes(OAUTH_TOKEN_PREFIX) || text.includes('lin_code_'),
    grants: () =>
      grants.map(({ id, ...grant }) => ({
        grant: id,
        ...grant,
        scopes: [...grant.scopes],
      })),
    revocations,
  };
}
