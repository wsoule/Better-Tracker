// The e2e's fake Linear in OAuth mode (e2e/fake-linear.ts,
// e2e/fake-linear-oauth.ts, e2e/linear-authorize.ts), in-process: the
// linear package's real OAuth client and gateway against its token,
// revoke and GraphQL endpoints (PKCE, refresh rotation, revocation,
// per-organization bearer routing, Ana a guest in Globex), the authorize
// page's chooser and redirects without a browser, and a real OAuth engine
// signing in to and installing both organizations over it.

import { createEngineFromEnv, type Engine } from '@better-tracker/engine';
import {
  buildAuthorizeUrl,
  createLinearGateway,
  createOAuthState,
  createPkcePair,
  exchangeCode,
  LinearApiError,
  OAuthError,
  refreshTokens,
  revokeToken,
  type TokenSet,
} from '@better-tracker/linear';
import { createLogger } from '@better-tracker/logger';
import { afterAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createFakeLinear,
  type FakeRequestRecord,
  isBearerRecord,
  isOAuthRecord,
} from '../e2e/fake-linear';
import type { FakeOrgKey } from '../e2e/fake-linear-data';
import {
  graphqlOperations,
  readFakeGrants,
  readFakeRequests,
} from '../e2e/fake-linear-log';
import { E2E_OAUTH_CLIENT, OAUTH_TOKEN_PREFIX } from '../e2e/fake-linear-oauth';
import {
  answerAuthorize,
  type AuthorizeBehaviour,
  authorizeRedirectUrl,
  bridgeRedirect,
  DEFAULT_AUTHORIZE_BEHAVIOUR,
  isLinearAuthorizeUrl,
  LINEAR_AUTHORIZE_URL_PATTERN,
  routeLinearAuthorize,
  withBehaviour,
} from '../e2e/linear-authorize';

const TODAY = new Date().toISOString().slice(0, 10);
const APP = 'http://localhost:3399';
const CONFIG = {
  ...E2E_OAUTH_CLIENT,
  redirectUri: `${APP}/api/auth/callback`,
};

type Fake = ReturnType<typeof createFakeLinear>;

const noSleep = (): Promise<void> => Promise.resolve();

function gateway(fake: Fake, accessToken: string) {
  return createLinearGateway({
    accessToken,
    fetch: fake.fetch,
    sleep: noSleep,
    maxRetries: 0,
  });
}

/** An authorize URL as the planner builds it, with its PKCE verifier. */
function authorizeUrl(
  scopes: string[] = ['read'],
  extra: { actor?: 'user' | 'app'; prompt?: 'consent' } = {}
): { url: string; verifier: string; state: string } {
  const pkce = createPkcePair();
  const state = createOAuthState();
  return {
    url: buildAuthorizeUrl(CONFIG, {
      state,
      scopes,
      codeChallenge: pkce.challenge,
      ...extra,
    }),
    verifier: pkce.verifier,
    state,
  };
}

const inProcessMint =
  (fake: Fake) => (input: Parameters<Fake['mintCode']>[0]) =>
    Promise.resolve(fake.mintCode(input));

/** The chooser's form, as the browser posts it for `org` (as `user`). */
function choose(org: FakeOrgKey, user?: string): URLSearchParams {
  const form = new URLSearchParams({ workspace: org });
  if (user !== undefined) form.set(`as_${org}`, user);
  return form;
}

/**
 * Signs in through the authorize page (picking `org` as `user`) and the
 * real code exchange; returns the tokens.
 */
async function signIn(
  fake: Fake,
  org: FakeOrgKey,
  user?: string,
  scopes: string[] = ['read'],
  actor?: 'app'
): Promise<TokenSet> {
  const start = authorizeUrl(scopes, actor === undefined ? {} : { actor });
  const answer = await answerAuthorize(
    { url: start.url, method: 'POST', form: choose(org, user) },
    DEFAULT_AUTHORIZE_BEHAVIOUR,
    inProcessMint(fake)
  );
  expect(answer.status).toBe(302);
  const back = new URL(answer.headers['location'] ?? '');
  expect(back.searchParams.get('state')).toBe(start.state);
  return exchangeCode(
    CONFIG,
    { code: back.searchParams.get('code') ?? '', codeVerifier: start.verifier },
    fake.fetch
  );
}

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

async function post(
  fake: Fake,
  path: string,
  form: Record<string, string>
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fake.fetch(`https://api.linear.app${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

function oauthCalls(requests: FakeRequestRecord[]) {
  return requests.filter(isOAuthRecord);
}

describe('fake Linear: the OAuth token and revoke endpoints', () => {
  test('a code exchanges once, with the verifier of the challenge it was minted for', async () => {
    const fake = createFakeLinear({ today: TODAY });
    const start = authorizeUrl(['read', 'write']);
    const answer = await answerAuthorize(
      { url: start.url, method: 'POST', form: choose('globex') },
      DEFAULT_AUTHORIZE_BEHAVIOUR,
      inProcessMint(fake)
    );
    const code =
      new URL(answer.headers['location'] ?? '').searchParams.get('code') ?? '';
    expect(code.startsWith('lin_code_')).toBe(true);

    const missing = await post(fake, '/oauth/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: CONFIG.redirectUri,
      client_id: CONFIG.clientId,
      client_secret: CONFIG.clientSecret,
    });
    expect(missing).toEqual({
      status: 400,
      body: {
        error: 'invalid_request',
        error_description: 'code_verifier is required',
      },
    });
    const wrongVerifier = await caught(
      exchangeCode(
        CONFIG,
        { code, codeVerifier: createPkcePair().verifier },
        fake.fetch
      )
    );
    expect((wrongVerifier as OAuthError).code).toBe('invalid_grant');
    const wrongSecret = await caught(
      exchangeCode(
        { ...CONFIG, clientSecret: 'nope' },
        { code, codeVerifier: start.verifier },
        fake.fetch
      )
    );
    expect((wrongSecret as OAuthError).code).toBe('invalid_client');
    const wrongRedirect = await caught(
      exchangeCode(
        { ...CONFIG, redirectUri: `${APP}/elsewhere` },
        { code, codeVerifier: start.verifier },
        fake.fetch
      )
    );
    expect((wrongRedirect as OAuthError).code).toBe('invalid_grant');

    const tokens = await exchangeCode(
      CONFIG,
      { code, codeVerifier: start.verifier },
      fake.fetch
    );
    expect(tokens.accessToken.startsWith(`${OAUTH_TOKEN_PREFIX}access_`)).toBe(
      true
    );
    expect(
      tokens.refreshToken?.startsWith(`${OAUTH_TOKEN_PREFIX}refresh_`)
    ).toBe(true);
    expect(tokens.scopes).toEqual(['read', 'write']);
    expect(Date.parse(tokens.expiresAt ?? '') - Date.now()).toBeGreaterThan(
      86_000_000
    );
    const again = await caught(
      exchangeCode(CONFIG, { code, codeVerifier: start.verifier }, fake.fetch)
    );
    expect((again as OAuthError).code).toBe('invalid_grant');

    expect(
      oauthCalls(fake.requests).map((r) => [
        r.operation,
        r.status,
        r.error,
        r.pkce,
        r.clientAuth,
      ])
    ).toEqual([
      ['oauth/code', 200, null, null, null],
      ['oauth/token', 400, 'invalid_request', 'missing', 'ok'],
      ['oauth/token', 400, 'invalid_grant', 'mismatch', 'ok'],
      ['oauth/token', 401, 'invalid_client', null, 'wrong'],
      ['oauth/token', 400, 'invalid_grant', null, 'ok'],
      ['oauth/token', 200, null, 'ok', 'ok'],
      ['oauth/token', 400, 'invalid_grant', null, 'ok'],
    ]);
    expect(fake.grants()).toEqual([
      {
        grant: 1,
        org: 'globex',
        userId: 'gx-user-ana',
        who: 'ana',
        actor: 'user',
        scopes: ['read', 'write'],
        approvedBy: null,
        revoked: false,
        refreshes: 0,
      },
    ]);
  });

  test('a refresh rotates: the old refresh token dies, the old access token lives until it expires', async () => {
    let clock = Date.now();
    const fake = createFakeLinear({
      today: TODAY,
      now: () => clock,
      accessTokenTtlSeconds: 60,
    });
    const first = await signIn(fake, 'acme');
    expect(first.expiresAt).not.toBeNull();
    const second = await refreshTokens(
      CONFIG,
      first.refreshToken ?? '',
      fake.fetch
    );
    expect(second.accessToken).not.toBe(first.accessToken);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.scopes).toEqual(['read']);
    const reused = await caught(
      refreshTokens(CONFIG, first.refreshToken ?? '', fake.fetch)
    );
    expect((reused as OAuthError).code).toBe('invalid_grant');
    expect((await gateway(fake, first.accessToken).whoAmI()).user.id).toBe(
      'user-ana'
    );

    clock += 61_000;
    const expired = await caught(gateway(fake, second.accessToken).whoAmI());
    expect((expired as LinearApiError).kind).toBe('unauthorized');
    const third = await refreshTokens(
      CONFIG,
      second.refreshToken ?? '',
      fake.fetch
    );
    expect((await gateway(fake, third.accessToken).whoAmI()).user.id).toBe(
      'user-ana'
    );
    expect(fake.grants().map((g) => g.refreshes)).toEqual([2]);
    expect(
      fake.requests
        .filter(isBearerRecord)
        .map((r) => [r.who, r.org, r.status, r.refused])
    ).toEqual([
      ['ana', 'acme', 200, null],
      ['ana', 'acme', 401, 'expired'],
      ['ana', 'acme', 200, null],
    ]);
  });

  test('revoking a refresh token ends its grant only: 401 on GraphQL, invalid_grant on refresh', async () => {
    const fake = createFakeLinear({ today: TODAY });
    const acme = await signIn(fake, 'acme');
    const globex = await signIn(fake, 'globex');
    await revokeToken(
      CONFIG,
      globex.refreshToken ?? '',
      'refresh_token',
      fake.fetch
    );
    const refused = await caught(gateway(fake, globex.accessToken).whoAmI());
    expect((refused as LinearApiError).kind).toBe('unauthorized');
    const refresh = await caught(
      refreshTokens(CONFIG, globex.refreshToken ?? '', fake.fetch)
    );
    expect((refresh as OAuthError).code).toBe('invalid_grant');
    expect((await gateway(fake, acme.accessToken).whoAmI()).workspace.id).toBe(
      'org-acme'
    );
    // A second revoke of the same token, and one the fake never issued.
    await revokeToken(
      CONFIG,
      globex.refreshToken ?? '',
      'refresh_token',
      fake.fetch
    );
    await revokeToken(
      CONFIG,
      `${OAUTH_TOKEN_PREFIX}refresh_never`,
      'refresh_token',
      fake.fetch
    );
    expect(fake.revocations).toEqual([
      {
        org: 'globex',
        who: 'ana',
        actor: 'user',
        tokenType: 'refresh_token',
        hint: 'refresh_token',
        effect: 'revoked',
      },
      {
        org: 'globex',
        who: 'ana',
        actor: 'user',
        tokenType: 'refresh_token',
        hint: 'refresh_token',
        effect: 'already_dead',
      },
      {
        org: null,
        who: null,
        actor: null,
        tokenType: null,
        hint: 'refresh_token',
        effect: 'unknown',
      },
    ]);
    expect(fake.grants().map((g) => [g.org, g.revoked])).toEqual([
      ['acme', false],
      ['globex', true],
    ]);
    const wrongClient = await post(fake, '/oauth/revoke', {
      token: acme.refreshToken ?? '',
      client_id: CONFIG.clientId,
      client_secret: 'nope',
    });
    expect(wrongClient.status).toBe(401);
    expect(fake.grants()[0]?.revoked).toBe(false);
  });
});

describe('fake Linear: bearer tokens read their own organization', () => {
  test('Globex for a Globex token, Acme for an Acme one: same keys, other ids and titles', async () => {
    const fake = createFakeLinear({ today: TODAY });
    const acmeAna = await signIn(fake, 'acme', 'ana');
    const globexAna = await signIn(fake, 'globex', 'ana');
    const globexGia = await signIn(fake, 'globex', 'gia');

    const inAcme = await gateway(fake, acmeAna.accessToken).whoAmI();
    expect(inAcme.workspace).toEqual({
      id: 'org-acme',
      name: 'Acme',
      urlKey: 'acme',
    });
    expect(inAcme.user.id).toBe('user-ana');
    expect(inAcme.user.guest).toBe(false);
    const inGlobex = await gateway(fake, globexAna.accessToken).whoAmI();
    expect(inGlobex.workspace).toEqual({
      id: 'org-globex',
      name: 'Globex',
      urlKey: 'globex',
    });
    expect(inGlobex.user).toMatchObject({
      id: 'gx-user-ana',
      name: 'Ana Ruiz',
      email: 'user-ana@example.com',
      guest: true,
      app: false,
    });

    const acme = await gateway(fake, acmeAna.accessToken).fetchWorkspace();
    expect(acme.workspaceId).toBe('org-acme');
    expect(acme.issues.find((i) => i.identifier === 'ENG-1')).toMatchObject({
      id: 'iss-eng-1',
      title: 'Ship the billing export',
    });
    expect(acme.teams.map((t) => t.key).sort()).toEqual(['ENG', 'MOB', 'SEC']);

    // Ana is a guest in Globex: only her own team, and only the relation
    // whose both ends she sees.
    const guest = await gateway(fake, globexAna.accessToken).fetchWorkspace();
    expect(guest.workspaceId).toBe('org-globex');
    expect(guest.teams.map((t) => t.key)).toEqual(['ENG']);
    expect(guest.issues.map((i) => [i.identifier, i.title])).toEqual([
      ['ENG-1', 'Launch the Globex storefront'],
      ['ENG-2', 'Take card payments at checkout'],
    ]);
    expect(guest.issues.find((i) => i.identifier === 'ENG-1')?.id).toBe(
      'gx-iss-eng-1'
    );
    expect(guest.relations.map((r) => r.id)).toEqual(['gx-rel-1']);
    expect(guest.users.map((u) => [u.id, u.guest === true])).toEqual([
      ['gx-user-gia', false],
      ['gx-user-hal', false],
      ['gx-user-ana', true],
      ['gx-user-app', false],
    ]);
    expect(guest.users.find((u) => u.id === 'gx-user-app')?.app).toBe(true);
    const member = await gateway(fake, globexGia.accessToken).fetchWorkspace();
    expect(member.teams.map((t) => t.key)).toEqual(['ENG', 'OPS']);
    expect(member.relations.map((r) => r.id)).toEqual(['gx-rel-1', 'gx-rel-2']);
    // No Acme id anywhere in Globex's answers, and the other way round.
    expect(JSON.stringify(member)).not.toContain('"iss-');
    expect(JSON.stringify(acme)).not.toContain('gx-');
    expect(
      fake.requests
        .filter(isBearerRecord)
        .filter((r) => r.operation === 'ProjectIssues')
        .map((r) => [r.org, r.who])
    ).toEqual([
      ['acme', 'ana'],
      ['globex', 'ana'],
      ['globex', 'gia'],
    ]);
  });

  test('an install token acts as the app user and sees every team; only an admin may approve one', async () => {
    const fake = createFakeLinear({ today: TODAY });
    const app = await signIn(
      fake,
      'globex',
      'gia',
      ['read', 'write', 'initiative:read'],
      'app'
    );
    const identity = await gateway(fake, app.accessToken).whoAmI();
    expect(identity.user).toMatchObject({ id: 'gx-user-app', app: true });
    expect(identity.workspace.id).toBe('org-globex');
    const data = await gateway(fake, app.accessToken).fetchWorkspace();
    expect(data.teams.map((t) => t.key)).toEqual(['ENG', 'OPS']);
    expect(data.issues).toHaveLength(4);
    expect(fake.grants()[0]).toMatchObject({
      who: 'app',
      actor: 'app',
      approvedBy: 'gia',
    });

    expect(
      fake.mintCode({ org: 'globex', user: 'ana', actor: 'app', scope: 'read' })
    ).toEqual({
      ok: false,
      status: 403,
      error: 'access_denied',
      description: 'Only an admin of Globex can install an app',
    });
    expect(
      fake.mintCode({ org: 'globex', user: 'ben', scope: 'read' })
    ).toMatchObject({ ok: false, error: 'invalid_request' });
    expect(fake.mintCode({ org: 'acme', actor: 'app' })).toMatchObject({
      ok: true,
      org: 'acme',
      who: 'app',
      actor: 'app',
    });
  });

  test('writes need the write scope and stay in the token’s organization', async () => {
    const fake = createFakeLinear({ today: TODAY });
    const reader = await signIn(fake, 'globex', 'gia');
    const writer = await signIn(fake, 'globex', 'gia', ['read', 'write']);
    const acme = await signIn(fake, 'acme', 'ana', ['read', 'write']);

    const scope = await caught(
      gateway(fake, reader.accessToken).updateIssueFields('gx-iss-eng-1', {
        title: 'Nope',
      })
    );
    expect((scope as LinearApiError).kind).toBe('forbidden');
    const updated = await gateway(fake, writer.accessToken).updateIssueFields(
      'gx-iss-eng-1',
      { title: 'Launch on Monday' }
    );
    expect(updated.title).toBe('Launch on Monday');
    // An Acme id with a Globex token: Linear knows no such issue there.
    expect(
      await caught(
        gateway(fake, writer.accessToken).updateIssueFields('iss-eng-1', {
          title: 'Wrong workspace',
        })
      )
    ).toBeInstanceOf(LinearApiError);
    expect(
      (await gateway(fake, acme.accessToken).fetchIssue('iss-eng-1'))?.title
    ).toBe('Ship the billing export');

    const milestone = await gateway(
      fake,
      writer.accessToken
    ).updateMilestoneTargetDate('gx-ms-eng-1', '2027-01-15');
    expect(milestone.targetDate).toBe('2027-01-15');
    const project = await gateway(fake, writer.accessToken).updateProjectLead(
      'gx-proj-eng',
      'gx-user-hal'
    );
    expect(project.leadId).toBe('gx-user-hal');
    const relation = await gateway(
      fake,
      writer.accessToken
    ).createBlockingRelation('gx-iss-ops-2', 'gx-iss-eng-1');
    expect(relation).toEqual({
      id: 'gx-rel-new-1',
      blockerId: 'gx-iss-ops-2',
      blockedId: 'gx-iss-eng-1',
    });
    await gateway(fake, writer.accessToken).deleteRelation('gx-rel-new-1');
    const after = await gateway(fake, writer.accessToken).fetchWorkspace();
    expect(after.relations.map((r) => r.id)).toEqual(['gx-rel-1', 'gx-rel-2']);
    expect(
      after.milestones.find((m) => m.id === 'gx-ms-eng-1')?.targetDate
    ).toBe('2027-01-15');

    const updates = fake.requests
      .filter(isBearerRecord)
      .filter((r) => r.operation === 'IssueUpdate');
    expect(updates.map((r) => [r.org, r.who, r.status])).toEqual([
      ['globex', 'gia', 200],
      ['globex', 'gia', 200],
      ['globex', 'gia', 200],
    ]);
    expect(updates.some((r) => r.org === 'acme')).toBe(false);
  });

  test('the request log names org, person and actor, never a token, code, verifier or secret', async () => {
    const fake = createFakeLinear({ today: TODAY });
    const tokens = await signIn(fake, 'globex', 'gia');
    await gateway(fake, tokens.accessToken).whoAmI();
    await refreshTokens(CONFIG, tokens.refreshToken ?? '', fake.fetch);
    await caught(gateway(fake, `${OAUTH_TOKEN_PREFIX}access_forged`).whoAmI());
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: fake.handle,
    });
    try {
      const listed = (await (
        await fetch(`http://127.0.0.1:${server.port}/__requests`)
      ).json()) as FakeRequestRecord[];
      expect(listed).toEqual(fake.requests);
      const text = JSON.stringify(listed);
      for (const secret of [
        OAUTH_TOKEN_PREFIX,
        'lin_code_',
        CONFIG.clientSecret,
        tokens.accessToken,
      ]) {
        expect(text).not.toContain(secret);
      }
      expect(listed.filter(isBearerRecord)).toEqual([
        {
          operation: 'Identity',
          auth: 'bearer',
          who: 'gia',
          org: 'globex',
          actor: 'user',
          status: 200,
          refused: null,
          keyInBodyOrUrl: false,
          tokenInBodyOrUrl: false,
        },
        {
          operation: 'Identity',
          auth: 'bearer',
          who: 'unknown',
          org: null,
          actor: null,
          status: 401,
          refused: 'unknown',
          keyInBodyOrUrl: false,
          tokenInBodyOrUrl: false,
        },
      ]);
      const grants = (await (
        await fetch(`http://127.0.0.1:${server.port}/__oauth/grants`)
      ).json()) as unknown[];
      expect(grants).toEqual(fake.grants());
    } finally {
      await server.stop(true);
    }
  });
});

describe('fake Linear: the authorize page', () => {
  const fake = createFakeLinear({ today: TODAY });
  const mint = inProcessMint(fake);

  test('the chooser lists Acme and Globex and posts back to the same URL', async () => {
    const start = authorizeUrl(['read', 'write'], { prompt: 'consent' });
    const answer = await answerAuthorize(
      { url: start.url, method: 'GET', form: null },
      DEFAULT_AUTHORIZE_BEHAVIOUR,
      mint
    );
    expect(answer.status).toBe(200);
    expect(answer.headers['content-type']).toContain('text/html');
    expect(answer.body).toContain('<form method="post">');
    expect(answer.body).toContain(
      '<button type="submit" name="workspace" value="acme">Acme</button>'
    );
    expect(answer.body).toContain(
      '<button type="submit" name="workspace" value="globex">Globex</button>'
    );
    expect(answer.body).toContain(
      '<option value="ana" selected>Ana Ruiz (ana)</option>'
    );
    expect(answer.body).toContain('<select name="as_globex">');
    expect(answer.body).toContain('<dd data-testid="scopes">read,write</dd>');
    expect(answer.body).toContain('<dd data-testid="prompt">consent</dd>');
    expect(answer.body).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(answer.visit).toMatchObject({
      answer: 'chooser',
      scopes: ['read', 'write'],
      actor: 'user',
      prompt: 'consent',
      clientId: CONFIG.clientId,
      redirectUri: CONFIG.redirectUri,
    });
  });

  test('picking a workspace redirects to redirect_uri?code=…&state=…, as Linear does', async () => {
    const start = authorizeUrl();
    const answer = await answerAuthorize(
      { url: start.url, method: 'POST', form: choose('globex', 'gia') },
      DEFAULT_AUTHORIZE_BEHAVIOUR,
      mint
    );
    expect(answer.status).toBe(302);
    const location = answer.headers['location'] ?? '';
    expect(location.startsWith(`${CONFIG.redirectUri}?code=lin_code_`)).toBe(
      true
    );
    const back = new URL(location);
    expect([...back.searchParams.keys()]).toEqual(['code', 'state']);
    expect(back.searchParams.get('state')).toBe(start.state);
    expect(answer.visit).toMatchObject({
      answer: 'code',
      org: 'globex',
      who: 'gia',
    });
    const tokens = await exchangeCode(
      CONFIG,
      {
        code: back.searchParams.get('code') ?? '',
        codeVerifier: start.verifier,
      },
      fake.fetch
    );
    expect((await gateway(fake, tokens.accessToken).whoAmI()).user.id).toBe(
      'gx-user-gia'
    );
  });

  test('Cancel, a guest’s install and a bad response_type come back on the redirect URI; a bad redirect_uri or client stays on Linear', async () => {
    const start = authorizeUrl();
    const cancel = await answerAuthorize(
      {
        url: start.url,
        method: 'POST',
        form: new URLSearchParams({ decision: 'deny' }),
      },
      DEFAULT_AUTHORIZE_BEHAVIOUR,
      mint
    );
    expect(cancel.headers['location']).toBe(
      `${CONFIG.redirectUri}?error=access_denied&error_description=The+user+denied+the+request&state=${start.state}`
    );
    const install = authorizeUrl(['read', 'write'], {
      actor: 'app',
      prompt: 'consent',
    });
    const guest = await answerAuthorize(
      { url: install.url, method: 'POST', form: choose('globex', 'ana') },
      DEFAULT_AUTHORIZE_BEHAVIOUR,
      mint
    );
    expect(guest.status).toBe(302);
    expect(
      new URL(guest.headers['location'] ?? '').searchParams.get('error')
    ).toBe('access_denied');
    expect(guest.visit).toMatchObject({
      answer: 'denied',
      org: 'globex',
      who: 'ana',
      actor: 'app',
    });
    const token = new URL(start.url);
    token.searchParams.set('response_type', 'token');
    const badType = await answerAuthorize(
      { url: token.toString(), method: 'GET', form: null },
      DEFAULT_AUTHORIZE_BEHAVIOUR,
      mint
    );
    expect(
      new URL(badType.headers['location'] ?? '').searchParams.get('error')
    ).toBe('unsupported_response_type');
    const noRedirect = new URL(start.url);
    noRedirect.searchParams.delete('redirect_uri');
    const stays = await answerAuthorize(
      { url: noRedirect.toString(), method: 'GET', form: null },
      DEFAULT_AUTHORIZE_BEHAVIOUR,
      mint
    );
    expect(stays.status).toBe(400);
    expect(stays.headers['location']).toBeUndefined();
    const otherClient = new URL(start.url);
    otherClient.searchParams.set('client_id', 'someone-else');
    const refused = await answerAuthorize(
      { url: otherClient.toString(), method: 'POST', form: choose('acme') },
      DEFAULT_AUTHORIZE_BEHAVIOUR,
      mint
    );
    expect(refused.status).toBe(400);
    expect(refused.visit.error).toBe('invalid_client');
  });

  test('presets: on_consent authorizes the open workspace unless prompt=consent; never always does', async () => {
    const onConsent: AuthorizeBehaviour = withBehaviour(
      DEFAULT_AUTHORIZE_BEHAVIOUR,
      { open: 'acme', chooser: 'on_consent', signedInAs: { acme: 'ben' } }
    );
    const plain = await answerAuthorize(
      { url: authorizeUrl().url, method: 'GET', form: null },
      onConsent,
      mint
    );
    expect(plain.status).toBe(302);
    expect(plain.visit).toMatchObject({
      answer: 'code',
      org: 'acme',
      who: 'ben',
    });
    const consent = await answerAuthorize(
      {
        url: authorizeUrl(['read'], { prompt: 'consent' }).url,
        method: 'GET',
        form: null,
      },
      onConsent,
      mint
    );
    expect(consent.visit.answer).toBe('chooser');
    expect(consent.body).toContain('Acme <small>open in this browser</small>');
    const never = await answerAuthorize(
      {
        url: authorizeUrl(['read'], { prompt: 'consent' }).url,
        method: 'GET',
        form: null,
      },
      withBehaviour(onConsent, { chooser: 'never' }),
      mint
    );
    expect(never.visit).toMatchObject({ answer: 'code', org: 'acme' });
    expect(() =>
      withBehaviour(onConsent, { open: 'initech' as FakeOrgKey })
    ).toThrow('open: no workspace initech');
    expect(() =>
      withBehaviour(onConsent, { signedInAs: { initech: 'x' } as never })
    ).toThrow('signedInAs: no workspace initech');
  });

  test('authorizeRedirectUrl keeps the redirect URI’s own query and leaves out a missing state', () => {
    expect(
      authorizeRedirectUrl(`${APP}/cb?from=setup`, { code: 'c1' }, 's1')
    ).toBe(`${APP}/cb?from=setup&code=c1&state=s1`);
    expect(authorizeRedirectUrl(`${APP}/cb`, { code: 'c2' }, null)).toBe(
      `${APP}/cb?code=c2`
    );
    expect(
      authorizeRedirectUrl(`${APP}/cb`, { error: 'access_denied' }, 's3')
    ).toBe(`${APP}/cb?error=access_denied&state=s3`);
  });

  test('routeLinearAuthorize routes Linear’s URL and mints over HTTP on the fake server; the fake serves the same page itself', async () => {
    const served = createFakeLinear({ today: TODAY });
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: served.handle,
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      type Handler = (route: unknown) => Promise<void>;
      const routes = new Map<string, Handler>();
      const target = {
        route: (url: string, fn: Handler) => {
          routes.set(url, fn);
          return Promise.resolve();
        },
        unroute: (url: string) => {
          routes.delete(url);
          return Promise.resolve();
        },
      };
      const linear = await routeLinearAuthorize(
        target as unknown as Parameters<typeof routeLinearAuthorize>[0],
        base,
        { signedInAs: { globex: 'hal' }, appBaseUrl: APP }
      );
      expect([...routes.keys()]).toEqual([
        LINEAR_AUTHORIZE_URL_PATTERN,
        `${APP}/api/auth/linear**`,
      ]);
      const fulfilled: {
        status?: number;
        headers?: Record<string, string>;
        body?: string;
        response?: unknown;
      }[] = [];
      const routed = async (
        pattern: string,
        url: string,
        method: string,
        body = '',
        upstream: {
          status: number;
          headers: { name: string; value: string }[];
        } = {
          status: 200,
          headers: [],
        }
      ) => {
        const route = {
          request: () => ({
            url: () => url,
            method: () => method,
            postData: () => body,
          }),
          fetch: () =>
            Promise.resolve({
              status: () => upstream.status,
              headersArray: () => upstream.headers,
            }),
          fulfill: (response: (typeof fulfilled)[number]) => {
            fulfilled.push(response);
            return Promise.resolve();
          },
        };
        const handler = routes.get(pattern);
        if (handler === undefined) throw new Error('not routed');
        await handler(route);
      };
      const visit = (url: string, method: string, body = '') =>
        routed(LINEAR_AUTHORIZE_URL_PATTERN, url, method, body);
      const start = authorizeUrl();
      await visit(start.url, 'GET');
      await visit(start.url, 'POST', 'workspace=globex');
      expect(fulfilled.map((r) => r.status)).toEqual([200, 302]);
      expect(linear.visits.map((v) => [v.answer, v.org, v.who])).toEqual([
        ['chooser', null, null],
        ['code', 'globex', 'hal'],
      ]);
      const code =
        new URL(fulfilled[1]?.headers?.['location'] ?? '').searchParams.get(
          'code'
        ) ?? '';
      const tokens = await exchangeCode(
        CONFIG,
        { code, codeVerifier: start.verifier },
        served.fetch
      );
      expect((await gateway(served, tokens.accessToken).whoAmI()).user.id).toBe(
        'gx-user-hal'
      );
      linear.set({ open: 'acme', chooser: 'never' });
      await visit(authorizeUrl().url, 'GET');
      expect(fulfilled[2]?.status).toBe(302);
      expect(linear.behaviour().open).toBe('acme');

      // The planner's 303 to Linear becomes a page that goes there itself,
      // with its cookies; anything else passes through.
      const bridge = `${APP}/api/auth/linear**`;
      const linearUrl = authorizeUrl().url;
      await routed(bridge, `${APP}/api/auth/linear?intent=signin`, 'GET', '', {
        status: 303,
        headers: [
          { name: 'Location', value: linearUrl },
          { name: 'Set-Cookie', value: 'mp_oauth=a; Path=/; HttpOnly' },
          { name: 'Set-Cookie', value: 'mp_other=b; Path=/' },
        ],
      });
      expect(fulfilled[3]?.status).toBe(200);
      expect(fulfilled[3]?.headers?.['set-cookie']).toBe(
        'mp_oauth=a; Path=/; HttpOnly\nmp_other=b; Path=/'
      );
      expect(fulfilled[3]?.headers?.['location']).toBeUndefined();
      expect(fulfilled[3]?.body).toContain(
        `<meta http-equiv="refresh" content="0;url=${linearUrl.replaceAll('&', '&amp;')}">`
      );
      await routed(bridge, `${APP}/api/auth/linear?intent=signin`, 'GET', '', {
        status: 303,
        headers: [{ name: 'location', value: '/setup' }],
      });
      expect(fulfilled[4]).toHaveProperty('response');
      await linear.unroute();
      expect(routes.size).toBe(0);

      // The fake's own /oauth/authorize: the chooser, then a code.
      const own = new URL(authorizeUrl().url);
      const chooser = await fetch(`${base}/oauth/authorize${own.search}`);
      expect(chooser.status).toBe(200);
      expect(await chooser.text()).toContain('value="globex">Globex</button>');
      const picked = await fetch(`${base}/oauth/authorize${own.search}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'workspace=acme',
        redirect: 'manual',
      });
      expect(picked.status).toBe(302);
      expect(picked.headers.get('location')).toStartWith(
        `${CONFIG.redirectUri}?code=lin_code_`
      );
      const behaviour = await fetch(`${base}/__oauth/authorize-behaviour`, {
        method: 'POST',
        body: JSON.stringify({ open: 'globex', chooser: 'never' }),
      });
      expect(((await behaviour.json()) as AuthorizeBehaviour).open).toBe(
        'globex'
      );
      const auto = await fetch(`${base}/oauth/authorize${own.search}`, {
        redirect: 'manual',
      });
      expect(auto.status).toBe(302);
      const minted = await fetch(
        `${base}/__oauth/code?org=globex&user=gia&scope=read,write&actor=user`
      );
      expect(await minted.json()).toMatchObject({
        org: 'globex',
        who: 'gia',
        actor: 'user',
        scopes: ['read', 'write'],
      });
    } finally {
      await server.stop(true);
    }
  });
});

describe('fake Linear: what a Playwright spec loads', () => {
  test('bridgeRedirect rewrites only a redirect to Linear’s authorize page', () => {
    const to = (location: string) => [{ name: 'location', value: location }];
    expect(
      bridgeRedirect(302, to('https://linear.app/oauth/authorize?a=1'), APP)
    ).toMatchObject({ status: 200 });
    expect(
      bridgeRedirect(200, to('https://linear.app/oauth/authorize'), APP)
    ).toBeNull();
    expect(bridgeRedirect(303, to('/week'), APP)).toBeNull();
    expect(
      bridgeRedirect(303, to('https://linear.app/acme/issue/ENG-1'), APP)
    ).toBeNull();
    expect(
      bridgeRedirect(
        303,
        to('https://linear.app.evil.example/oauth/authorize'),
        APP
      )
    ).toBeNull();
    expect(bridgeRedirect(303, [], APP)).toBeNull();
    expect(isLinearAuthorizeUrl('https://linear.app/oauth/authorize?x')).toBe(
      true
    );
    expect(isLinearAuthorizeUrl('http://linear.app/oauth/authorize')).toBe(
      false
    );
  });

  test('the log readers and graphqlOperations work over HTTP', async () => {
    const fake = createFakeLinear({ today: TODAY });
    const globex = await signIn(fake, 'globex', 'gia', ['read', 'write']);
    await gateway(fake, globex.accessToken).updateIssueFields('gx-iss-eng-2', {
      title: 'Cards and wallets',
    });
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: fake.handle,
    });
    try {
      const base = `http://127.0.0.1:${server.port}`;
      const log = await readFakeRequests(base);
      expect(graphqlOperations(log, 'globex')).toEqual(['IssueUpdate']);
      expect(graphqlOperations(log, 'acme')).toEqual([]);
      expect(await readFakeGrants(base)).toEqual(fake.grants());
    } finally {
      await server.stop(true);
    }
  });

  // The Playwright runner cannot load the workspace packages (their
  // exports have no require condition), so what a spec imports must not
  // reach them, even through a helper.
  test('the spec-facing modules import no workspace package at runtime', () => {
    const dir = join(import.meta.dir, '..', 'e2e');
    const allowed = new Set([
      'node:crypto',
      '@playwright/test',
      './fake-linear-data',
      './fake-linear-oauth',
      './leak-needles',
    ]);
    const offenders: string[] = [];
    for (const file of [
      'fake-linear-data.ts',
      'fake-linear-oauth.ts',
      'fake-linear-log.ts',
      'linear-authorize.ts',
      'leak-needles.ts',
      'csp-nonce.ts',
    ]) {
      const text = readFileSync(join(dir, file), 'utf8');
      for (const match of text.matchAll(
        /^(import|export)(?! type)[^;]*?from '([^']+)';/gms
      )) {
        const source = match[2] ?? '';
        if (!allowed.has(source)) offenders.push(`${file}: ${source}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('a real OAuth engine over the fake', () => {
  const dirs: string[] = [];
  const engines: Engine[] = [];
  const logLines: string[] = [];

  afterAll(async () => {
    for (const engine of engines) await engine.close();
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  test('signs in to and installs Acme and Globex; Ana is a member in one and a guest in the other', async () => {
    const fake = createFakeLinear({ today: TODAY });
    const dir = await mkdtemp(join(tmpdir(), 'planner-oauth-fake-'));
    dirs.push(dir);
    const engine = await createEngineFromEnv(
      {
        APP_URL: APP,
        TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
        LINEAR_CLIENT_ID: E2E_OAUTH_CLIENT.clientId,
        LINEAR_CLIENT_SECRET: E2E_OAUTH_CLIENT.clientSecret,
        // Both fake workspaces are new to this planner, and an unset list is
        // closed to new workspaces (admission, owner decision 2026-10-25).
        LINEAR_WORKSPACES: 'acme,globex',
        PGLITE_DIR: join(dir, 'pglite'),
      },
      {
        fetch: fake.fetch,
        logger: createLogger({
          name: 'test',
          level: 'debug',
          sink: (_level, line) => logLines.push(line),
        }),
      }
    );
    engines.push(engine);

    // The browser's round trip: the engine's authorize URL, the chooser's
    // pick, the callback's code.
    const authorize = async (
      intent: 'signin' | 'install',
      org: FakeOrgKey,
      user: string
    ): Promise<{ code: string; codeVerifier: string }> => {
      const start = engine.startOAuth(intent);
      expect(start.url.startsWith('https://linear.app/oauth/authorize?')).toBe(
        true
      );
      const answer = await answerAuthorize(
        { url: start.url, method: 'POST', form: choose(org, user) },
        DEFAULT_AUTHORIZE_BEHAVIOUR,
        inProcessMint(fake)
      );
      const back = new URL(answer.headers['location'] ?? '');
      expect(back.searchParams.get('state')).toBe(start.state);
      return {
        code: back.searchParams.get('code') ?? '',
        codeVerifier: start.codeVerifier,
      };
    };

    const acmeAna = await engine.finishSignIn({
      ...(await authorize('signin', 'acme', 'ana')),
      intent: 'signin',
    });
    expect(acmeAna.session.workspaceId).toBe('org-acme');
    expect(acmeAna.needsInstall).toBe(true);
    const acmeActor = await engine.authenticate(acmeAna.sessionToken);
    if (acmeActor === null) throw new Error('Ana is not signed in to Acme');
    const acmeInstall = await engine.finishInstall({
      ...(await authorize('install', 'acme', 'ana')),
      actor: acmeActor,
    });
    expect(acmeInstall.appUserId).toBe('user-acme-app');
    const acme = await engine.load('org-acme');
    expect(acme.snapshot.issues.get('iss-eng-1')?.title).toBe(
      'Ship the billing export'
    );
    expect(acme.snapshot.teams.has('team-sec')).toBe(true);

    const globexGia = await engine.finishSignIn({
      ...(await authorize('signin', 'globex', 'gia')),
      intent: 'signin',
    });
    const giaActor = await engine.authenticate(globexGia.sessionToken);
    if (giaActor === null) throw new Error('Gia is not signed in to Globex');
    const globexInstall = await engine.finishInstall({
      ...(await authorize('install', 'globex', 'gia')),
      actor: giaActor,
    });
    expect(globexInstall).toMatchObject({
      workspaceId: 'org-globex',
      workspaceName: 'Globex',
      urlKey: 'globex',
      appUserId: 'gx-user-app',
    });
    const globex = await engine.load('org-globex');
    expect(
      [...globex.snapshot.issues.keys()].every((id) => id.startsWith('gx-'))
    ).toBe(true);
    expect(globex.snapshot.issues.get('gx-iss-eng-1')?.identifier).toBe(
      'ENG-1'
    );

    const globexAna = await engine.finishSignIn({
      ...(await authorize('signin', 'globex', 'ana')),
      intent: 'signin',
    });
    expect(globexAna.needsInstall).toBe(false);
    const guest = await engine.authenticate(globexAna.sessionToken);
    expect(guest).toMatchObject({ readOnly: true, readOnlyReason: 'guest' });
    expect(guest?.session.userId).toBe('gx-user-ana');
    expect((await engine.authenticate(acmeAna.sessionToken))?.readOnly).toBe(
      false
    );

    await engine.signOut(globexAna.sessionToken);
    expect(fake.revocations).toEqual([
      expect.objectContaining({
        org: 'globex',
        who: 'ana',
        actor: 'user',
        tokenType: 'refresh_token',
        effect: 'revoked',
      }),
    ]);
    expect(
      fake.grants().map((g) => [g.org, g.who, g.actor, g.revoked])
    ).toEqual([
      ['acme', 'ana', 'user', false],
      ['acme', 'app', 'app', false],
      ['globex', 'gia', 'user', false],
      ['globex', 'app', 'app', false],
      ['globex', 'ana', 'user', true],
    ]);
    expect(logLines.join('\n')).not.toContain(OAUTH_TOKEN_PREFIX);
  });
});
