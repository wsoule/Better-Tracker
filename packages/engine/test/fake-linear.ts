// A fake of the Linear endpoints the engine calls itself: the OAuth token
// and revoke endpoints and the GraphQL identity query. Tokens are opaque
// strings mapped to identities; refresh tokens rotate like Linear's.

import type { User } from '@better-tracker/core';
import type { FetchLike } from '@better-tracker/linear';

export interface FakeIdentity {
  user: User;
  workspace: { id: string; name: string; urlKey: string };
}

export interface FakeLinear {
  fetch: FetchLike;
  /** Registers an authorization code that yields tokens for `identity`. */
  addCode(code: string, identity: FakeIdentity, scope: string): void;
  /** Registers a refresh token; `invalid` makes Linear answer invalid_grant. */
  addRefreshToken(
    token: string,
    identity: FakeIdentity,
    options?: { invalid?: boolean }
  ): void;
  /** Registers an access token the GraphQL endpoint accepts. */
  addAccessToken(token: string, identity: FakeIdentity): void;
  refreshCalls: string[];
  revoked: { token: string; hint: string | null }[];
  graphqlTokens: string[];
  /** When set, the revoke endpoint answers HTTP 500. */
  failRevoke: boolean;
  /** When set, the token endpoint's refresh grant fails with a network error. */
  networkDownForRefresh: boolean;
}

export function person(
  id: string,
  name: string,
  options: { app?: boolean; active?: boolean; guest?: boolean } = {}
): User {
  return {
    id,
    name,
    displayName: name.toLowerCase(),
    email: options.app === true ? null : `${id}@acme.example`,
    avatarUrl: null,
    active: options.active ?? true,
    app: options.app ?? false,
    // Only when asked for, so other tests' identities stay as they were.
    ...(options.guest === undefined ? {} : { guest: options.guest }),
  };
}

export const ACME: FakeIdentity['workspace'] = {
  id: 'org-acme',
  name: 'Acme',
  urlKey: 'acme',
};
export const OTHER: FakeIdentity['workspace'] = {
  id: 'org-other',
  name: 'Other Co',
  urlKey: 'other',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function createFakeLinear(): FakeLinear {
  const codes = new Map<string, { identity: FakeIdentity; scope: string }>();
  const refresh = new Map<
    string,
    { identity: FakeIdentity; invalid: boolean }
  >();
  const access = new Map<string, FakeIdentity>();
  let counter = 0;

  const fake: FakeLinear = {
    refreshCalls: [],
    revoked: [],
    graphqlTokens: [],
    failRevoke: false,
    networkDownForRefresh: false,
    addCode(code, identity, scope) {
      codes.set(code, { identity, scope });
    },
    addRefreshToken(token, identity, options = {}) {
      refresh.set(token, { identity, invalid: options.invalid === true });
    },
    addAccessToken(token, identity) {
      access.set(token, identity);
    },
    fetch: async (url: string, init: RequestInit): Promise<Response> => {
      const body = typeof init.body === 'string' ? init.body : '';
      if (url === 'https://api.linear.app/oauth/token') {
        const form = new URLSearchParams(body);
        const grant = form.get('grant_type');
        let identity: FakeIdentity;
        let scope = 'read,write';
        if (grant === 'authorization_code') {
          const entry = codes.get(form.get('code') ?? '');
          if (entry === undefined || form.get('code_verifier') === null) {
            return json(400, { error: 'invalid_grant' });
          }
          codes.delete(form.get('code') ?? '');
          identity = entry.identity;
          scope = entry.scope;
        } else if (grant === 'refresh_token') {
          const token = form.get('refresh_token') ?? '';
          fake.refreshCalls.push(token);
          if (fake.networkDownForRefresh) throw new TypeError('fetch failed');
          const entry = refresh.get(token);
          if (entry === undefined || entry.invalid) {
            return json(400, {
              error: 'invalid_grant',
              error_description: 'refresh token is invalid',
            });
          }
          refresh.delete(token); // rotation: the old one dies
          identity = entry.identity;
        } else {
          return json(400, { error: 'unsupported_grant_type' });
        }
        counter += 1;
        const accessToken = `lin_access_${counter}`;
        const refreshToken = `lin_refresh_${counter}`;
        access.set(accessToken, identity);
        refresh.set(refreshToken, { identity, invalid: false });
        // Yield once so concurrent refreshers really overlap.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return json(200, {
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 86_399,
          scope,
          refresh_token: refreshToken,
        });
      }
      if (url === 'https://api.linear.app/oauth/revoke') {
        const form = new URLSearchParams(body);
        if (fake.failRevoke) return json(500, { error: 'server_error' });
        fake.revoked.push({
          token: form.get('token') ?? '',
          hint: form.get('token_type_hint'),
        });
        return json(200, {});
      }
      if (url === 'https://api.linear.app/graphql') {
        const header = new Headers(init.headers).get('Authorization') ?? '';
        const token = header.replace(/^Bearer /, '');
        fake.graphqlTokens.push(token);
        const identity = access.get(token);
        if (identity === undefined) {
          return json(401, {
            errors: [
              {
                message: 'Authentication required',
                extensions: { code: 'AUTHENTICATION_ERROR' },
              },
            ],
          });
        }
        return json(200, {
          data: { viewer: identity.user, organization: identity.workspace },
        });
      }
      return json(404, { error: `unexpected ${url}` });
    },
  };
  return fake;
}
