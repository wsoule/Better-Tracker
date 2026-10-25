// Linear's authorize page, faked for the browser tests (architecture §11).
// The planner sends the browser to https://linear.app/oauth/authorize;
// routeLinearAuthorize installs a Playwright route there that answers
// instead of Linear, with a small workspace chooser (Acme, Globex).
// Approving mints a code on the fake Linear (GET /__oauth/code) for the
// chosen workspace, as the person the browser is signed in to Linear as
// there, with the scope, actor, PKCE challenge and prompt the URL asked
// for, and redirects to `redirect_uri?code=…&state=…` exactly as Linear
// does; Cancel redirects with `error=access_denied`. The fake Linear
// serves the same page at its own /oauth/authorize (fake-linear.ts).
//
// What the page does is an AuthorizeBehaviour a test can change between
// steps:
// - signedInAs: who the browser is signed in to Linear as, per workspace
//   (a handle: 'ana', 'gia'). The chooser offers each workspace's people
//   in a select labelled "<Workspace> account", preset to this.
// - open: the workspace open in the browser's Linear tab, and chooser:
//   'always' shows the chooser every time (the default); 'on_consent'
//   authorizes `open` at once unless the URL has prompt=consent, as
//   Linear does for someone already in a workspace; 'never' authorizes
//   `open` at once even with prompt=consent ("Linear authorizes whichever
//   workspace is open"). Without an open workspace the chooser shows.
// - An install (actor=app) approved by someone who is not that
//   workspace's admin comes back as error=access_denied.
//
// Playwright never routes the hop a server redirect leads to, so the
// planner's own 303 to linear.app is bridged (bridgeRedirect: pass
// `appBaseUrl`); the chooser's 302 back to the planner needs no route.
// Everything but routeLinearAuthorize is plain functions, so the URL
// rules are unit-tested without a browser (test/fake-linear-oauth.test.ts).

import type { BrowserContext, Page, Route } from '@playwright/test';

import { FAKE_ORGS, type FakeOrgKey, isFakeOrgKey } from './fake-linear-data';
import type { MintCodeInput, MintCodeResult } from './fake-linear-oauth';

/** The authorize page's title (the chooser and its error pages). */
export const AUTHORIZE_TITLE = 'Authorize · Linear (fake)';

/** The URL glob Linear's authorize page answers on. */
export const LINEAR_AUTHORIZE_URL_PATTERN =
  'https://linear.app/oauth/authorize**';

/** How the fake authorize page answers (see the file comment). */
export interface AuthorizeBehaviour {
  signedInAs: Record<FakeOrgKey, string>;
  open: FakeOrgKey | null;
  chooser: 'always' | 'on_consent' | 'never';
  /** The workspaces the chooser lists, in order. */
  workspaces: FakeOrgKey[];
}

/** A change to an AuthorizeBehaviour: signedInAs merges per workspace. */
export type AuthorizeBehaviourChange = Partial<
  Omit<AuthorizeBehaviour, 'signedInAs'>
> & { signedInAs?: Partial<Record<FakeOrgKey, string>> };

export const DEFAULT_AUTHORIZE_BEHAVIOUR: Readonly<AuthorizeBehaviour> = {
  signedInAs: { acme: 'ana', globex: 'ana' },
  open: null,
  chooser: 'always',
  workspaces: ['acme', 'globex'],
};

/**
 * `base` with `changes` applied (signedInAs merged per workspace). Throws
 * on an unknown workspace or chooser mode, so a typo fails the test.
 */
export function withBehaviour(
  base: Readonly<AuthorizeBehaviour>,
  changes: AuthorizeBehaviourChange = {}
): AuthorizeBehaviour {
  const next: AuthorizeBehaviour = {
    signedInAs: { ...base.signedInAs },
    open: base.open,
    chooser: base.chooser,
    workspaces: [...base.workspaces],
  };
  for (const [org, handle] of Object.entries(changes.signedInAs ?? {})) {
    if (!isFakeOrgKey(org) || typeof handle !== 'string') {
      throw new Error(`signedInAs: no workspace ${org}`);
    }
    next.signedInAs[org] = handle;
  }
  if (changes.open !== undefined) {
    if (changes.open !== null && !isFakeOrgKey(changes.open)) {
      throw new Error(`open: no workspace ${String(changes.open)}`);
    }
    next.open = changes.open;
  }
  if (changes.chooser !== undefined) {
    if (!['always', 'on_consent', 'never'].includes(changes.chooser)) {
      throw new Error(`chooser: unknown mode ${String(changes.chooser)}`);
    }
    next.chooser = changes.chooser;
  }
  if (changes.workspaces !== undefined) {
    if (!changes.workspaces.every(isFakeOrgKey)) {
      throw new Error('workspaces: unknown workspace');
    }
    next.workspaces = [...changes.workspaces];
  }
  return next;
}

/** An authorize URL's parameters, as Linear reads them. */
export interface AuthorizeRequest {
  clientId: string | null;
  redirectUri: string | null;
  responseType: string | null;
  /** `scope`, split on commas (and spaces). */
  scopes: string[];
  state: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  actor: 'user' | 'app';
  prompt: string | null;
}

export function parseAuthorizeUrl(url: string): AuthorizeRequest {
  const params = new URL(url).searchParams;
  return {
    clientId: params.get('client_id'),
    redirectUri: params.get('redirect_uri'),
    responseType: params.get('response_type'),
    scopes: (params.get('scope') ?? '')
      .split(/[\s,]+/)
      .filter((scope) => scope !== ''),
    state: params.get('state'),
    codeChallenge: params.get('code_challenge'),
    codeChallengeMethod: params.get('code_challenge_method'),
    actor: params.get('actor') === 'app' ? 'app' : 'user',
    prompt: params.get('prompt'),
  };
}

/**
 * Where Linear sends the browser back: `redirect_uri` with `code` (or
 * `error` and `error_description`) and then `state` added to its query,
 * `state` left out when the authorize URL had none.
 */
export function authorizeRedirectUrl(
  redirectUri: string,
  result: { code: string } | { error: string; description?: string },
  state: string | null
): string {
  const url = new URL(redirectUri);
  if ('code' in result) {
    url.searchParams.set('code', result.code);
  } else {
    url.searchParams.set('error', result.error);
    if (result.description !== undefined) {
      url.searchParams.set('error_description', result.description);
    }
  }
  if (state !== null) url.searchParams.set('state', state);
  return url.toString();
}

/** One visit to the authorize page, for assertions (no code or state). */
export interface AuthorizeVisit {
  method: string;
  scopes: string[];
  actor: 'user' | 'app';
  prompt: string | null;
  clientId: string | null;
  redirectUri: string | null;
  /** What the page did: showed the chooser, redirected with a code or an error, or showed an error page. */
  answer: 'chooser' | 'code' | 'denied' | 'error';
  org: FakeOrgKey | null;
  /** Who approved (a handle), when a code or refusal came back. */
  who: string | null;
  /** The OAuth error, for 'denied' and 'error'. */
  error: string | null;
}

/** The page's answer: a Response's parts, and what happened. */
export interface AuthorizeAnswer {
  status: number;
  headers: Record<string, string>;
  body: string;
  visit: AuthorizeVisit;
}

/** Mints a code on the fake Linear (in-process, or over HTTP). */
export type MintCode = (input: MintCodeInput) => Promise<MintCodeResult>;

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// A whole HTML page's response parts (no styles: it stands in for Linear's).
function htmlPage(
  status: number,
  title: string,
  main: string
): Omit<AuthorizeAnswer, 'visit'> {
  return {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
    body: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body>
<main>
${main}
</main>
</body>
</html>
`,
  };
}

/**
 * The chooser: each listed workspace with a select of its people (preset
 * to signedInAs) and a submit button named after it, then Cancel. The
 * form posts back to the same URL, query included.
 */
export function chooserHtml(
  request: AuthorizeRequest,
  behaviour: Readonly<AuthorizeBehaviour>
): string {
  const sections = behaviour.workspaces.map((key) => {
    const org = FAKE_ORGS[key];
    const name = escapeHtml(org.organization.name);
    const options = org.people
      .map(({ handle, name: person }) => {
        const selected =
          behaviour.signedInAs[key] === handle ? ' selected' : '';
        return `<option value="${escapeHtml(handle)}"${selected}>${escapeHtml(`${person} (${handle})`)}</option>`;
      })
      .join('');
    const open =
      behaviour.open === key ? ' <small>open in this browser</small>' : '';
    return `<section data-workspace="${key}">
<h2>${name}${open}</h2>
<label>${name} account <select name="as_${key}">${options}</select></label>
<button type="submit" name="workspace" value="${key}">${name}</button>
</section>`;
  });
  return htmlPage(
    200,
    AUTHORIZE_TITLE,
    `<h1>Choose a workspace</h1>
<p>An app is asking for access to a Linear workspace.</p>
<dl>
<dt>Scopes</dt><dd data-testid="scopes">${escapeHtml(request.scopes.join(','))}</dd>
<dt>Actor</dt><dd data-testid="actor">${request.actor}</dd>
<dt>Prompt</dt><dd data-testid="prompt">${escapeHtml(request.prompt ?? '')}</dd>
</dl>
<form method="post">
${sections.join('\n')}
<button type="submit" name="decision" value="deny">Cancel</button>
</form>`
  ).body;
}

function redirect(location: string): Omit<AuthorizeAnswer, 'visit'> {
  return {
    status: 302,
    headers: { location, 'cache-control': 'no-store' },
    body: '',
  };
}

/**
 * Answers one request to the authorize page: GET shows the chooser (or,
 * per the behaviour, authorizes the open workspace at once); POST is the
 * chooser's form (`workspace`, `as_<workspace>`, or `decision=deny`). A
 * bad redirect_uri or client is an error page, as on Linear; a refusal
 * after that redirects with `error`.
 */
export async function answerAuthorize(
  input: { url: string; method: string; form: URLSearchParams | null },
  behaviour: Readonly<AuthorizeBehaviour>,
  mint: MintCode
): Promise<AuthorizeAnswer> {
  const request = parseAuthorizeUrl(input.url);
  const visit: AuthorizeVisit = {
    method: input.method,
    scopes: [...request.scopes],
    actor: request.actor,
    prompt: request.prompt,
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    answer: 'error',
    org: null,
    who: null,
    error: null,
  };
  const errorPage = (
    status: number,
    error: string,
    text: string
  ): AuthorizeAnswer => ({
    ...htmlPage(
      status,
      AUTHORIZE_TITLE,
      `<h1>Something went wrong</h1>\n<p data-testid="error">${escapeHtml(error)}: ${escapeHtml(text)}</p>`
    ),
    visit: { ...visit, answer: 'error', error },
  });
  const redirectUri = request.redirectUri;
  if (redirectUri === null || !URL.canParse(redirectUri)) {
    return errorPage(
      400,
      'invalid_request',
      'redirect_uri is missing or invalid'
    );
  }
  if (request.clientId === null || request.clientId === '') {
    return errorPage(400, 'invalid_client', 'client_id is missing');
  }
  const deny = (
    error: string,
    description: string,
    org: FakeOrgKey | null,
    who: string | null
  ): AuthorizeAnswer => ({
    ...redirect(
      authorizeRedirectUrl(redirectUri, { error, description }, request.state)
    ),
    visit: { ...visit, answer: 'denied', error, org, who },
  });
  if (request.responseType !== 'code') {
    return deny(
      'unsupported_response_type',
      'response_type must be code',
      null,
      null
    );
  }

  let org: FakeOrgKey;
  let user: string;
  if (input.method === 'POST') {
    const form = input.form ?? new URLSearchParams();
    if (form.get('decision') === 'deny') {
      return deny('access_denied', 'The user denied the request', null, null);
    }
    const chosen = form.get('workspace');
    if (!isFakeOrgKey(chosen) || !behaviour.workspaces.includes(chosen)) {
      return errorPage(400, 'invalid_request', 'Pick a workspace');
    }
    org = chosen;
    user = form.get(`as_${chosen}`) ?? behaviour.signedInAs[chosen];
  } else {
    const auto =
      behaviour.open !== null &&
      (behaviour.chooser === 'never' ||
        (behaviour.chooser === 'on_consent' && request.prompt !== 'consent'));
    if (!auto || behaviour.open === null) {
      return {
        ...htmlPage(200, AUTHORIZE_TITLE, ''),
        body: chooserHtml(request, behaviour),
        visit: { ...visit, answer: 'chooser' },
      };
    }
    org = behaviour.open;
    user = behaviour.signedInAs[org];
  }

  const minted = await mint({
    org,
    user,
    scope: request.scopes,
    actor: request.actor,
    clientId: request.clientId,
    redirectUri,
    codeChallenge: request.codeChallenge,
    codeChallengeMethod: request.codeChallengeMethod,
    prompt: request.prompt,
  });
  if (!minted.ok) {
    if (minted.error === 'access_denied') {
      return deny(minted.error, minted.description, org, user);
    }
    return errorPage(minted.status, minted.error, minted.description);
  }
  return {
    ...redirect(
      authorizeRedirectUrl(redirectUri, { code: minted.code }, request.state)
    ),
    visit: {
      ...visit,
      answer: 'code',
      org,
      who: minted.actor === 'app' ? user : minted.who,
    },
  };
}

/** A MintCode that calls the fake Linear's GET /__oauth/code at `fakeBaseUrl`. */
export function mintCodeOver(fakeBaseUrl: string): MintCode {
  return async (input) => {
    const params = new URLSearchParams({ org: input.org });
    const set = (name: string, value: string | null | undefined): void => {
      if (value !== null && value !== undefined) params.set(name, value);
    };
    set('user', input.user);
    set(
      'scope',
      typeof input.scope === 'string' ? input.scope : input.scope?.join(',')
    );
    set('actor', input.actor);
    set('client_id', input.clientId);
    set('redirect_uri', input.redirectUri);
    set('code_challenge', input.codeChallenge);
    set('code_challenge_method', input.codeChallengeMethod);
    set('prompt', input.prompt);
    const response = await fetch(
      new URL(`/__oauth/code?${params.toString()}`, fakeBaseUrl)
    );
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      const text = (field: string): string => {
        const value = body[field];
        return typeof value === 'string' ? value : '';
      };
      return {
        ok: false,
        status: response.status,
        error: text('error') === '' ? 'server_error' : text('error'),
        description: text('error_description'),
      };
    }
    return {
      ok: true,
      ...(body as Omit<Extract<MintCodeResult, { ok: true }>, 'ok'>),
    };
  };
}

/** What routeLinearAuthorize hands back to the test. */
export interface LinearAuthorizeRoute {
  /** Every visit so far, oldest first. */
  visits: AuthorizeVisit[];
  /** Changes how the page answers from the next visit on. */
  set(changes: AuthorizeBehaviourChange): void;
  behaviour(): AuthorizeBehaviour;
  /** Removes the route. */
  unroute(): Promise<void>;
}

/** The part of a Playwright Route the authorize handler uses. */
export type AuthorizeRoute = Pick<Route, 'request' | 'fulfill'>;

/** Answers one routed request (exported so tests can drive it with a stub Route). */
export async function fulfillAuthorize(
  route: AuthorizeRoute,
  behaviour: Readonly<AuthorizeBehaviour>,
  mint: MintCode
): Promise<AuthorizeVisit> {
  const request = route.request();
  const method = request.method();
  const answer = await answerAuthorize(
    {
      url: request.url(),
      method,
      form:
        method === 'POST'
          ? new URLSearchParams(request.postData() ?? '')
          : null,
    },
    behaviour,
    mint
  );
  await route.fulfill({
    status: answer.status,
    headers: answer.headers,
    body: answer.body,
  });
  return answer.visit;
}

/** The URL a redirect from the planner to Linear's authorize page names. */
export function isLinearAuthorizeUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const parsed = new URL(url);
  return (
    parsed.origin === 'https://linear.app' &&
    parsed.pathname === '/oauth/authorize'
  );
}

/**
 * Playwright never routes the request a server redirect leads to (its
 * Chromium network manager continues every redirected request), so the
 * planner's 303 to https://linear.app/oauth/authorize would go to the
 * real Linear. The bridge turns that one response into a page that goes
 * there itself (a meta refresh: a new navigation, which the authorize
 * route answers), keeping the planner's other headers, Set-Cookie (the
 * state and PKCE stash) included. Returns null for any other response,
 * which passes through unchanged.
 */
export function bridgeRedirect(
  status: number,
  headers: readonly { name: string; value: string }[],
  requestUrl: string
): { status: number; headers: Record<string, string>; body: string } | null {
  if (status < 300 || status > 399) return null;
  const location = headers.find(
    (header) => header.name.toLowerCase() === 'location'
  )?.value;
  if (location === undefined || !URL.canParse(location, requestUrl)) {
    return null;
  }
  const target = new URL(location, requestUrl).toString();
  if (!isLinearAuthorizeUrl(target)) return null;
  const kept: Record<string, string> = {};
  for (const { name, value } of headers) {
    const key = name.toLowerCase();
    if (
      [
        'location',
        'content-length',
        'content-encoding',
        'content-type',
      ].includes(key)
    ) {
      continue;
    }
    // Several Set-Cookie headers travel as one, one cookie per line.
    kept[key] = kept[key] === undefined ? value : `${kept[key]}\n${value}`;
  }
  kept['content-type'] = 'text/html; charset=utf-8';
  kept['cache-control'] = 'no-store';
  const escaped = escapeHtml(target);
  return {
    status: 200,
    headers: kept,
    body: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=${escaped}">
<title>Redirecting to Linear</title>
</head>
<body><p><a href="${escaped}">Continue to Linear</a></p></body>
</html>
`,
  };
}

/** Options for routeLinearAuthorize: the behaviour, and the bridge. */
export type LinearAuthorizeOptions = AuthorizeBehaviourChange & {
  /**
   * The planner's origin (e.g. http://localhost:3393). With it, the
   * planner's redirects to Linear's authorize page from `bridgePaths` go
   * through bridgeRedirect, so the authorize route can answer them. Leave
   * it out only when the planner sends the browser to the fake's own
   * /oauth/authorize instead of linear.app.
   */
  appBaseUrl?: string;
  /** The planner paths that redirect to Linear (default /api/auth/linear). */
  bridgePaths?: readonly string[];
};

/**
 * Routes https://linear.app/oauth/authorize in `target` (a page, or every
 * page of a context) to the fake chooser, minting codes on the fake
 * Linear at `fakeBaseUrl` (its origin, e.g. http://127.0.0.1:3395), and,
 * with `appBaseUrl`, bridges the planner's redirects there.
 */
export async function routeLinearAuthorize(
  target: Page | BrowserContext,
  fakeBaseUrl: string,
  options: LinearAuthorizeOptions = {}
): Promise<LinearAuthorizeRoute> {
  const { appBaseUrl, bridgePaths, ...behaviour } = options;
  let current = withBehaviour(DEFAULT_AUTHORIZE_BEHAVIOUR, behaviour);
  const mint = mintCodeOver(fakeBaseUrl);
  const visits: AuthorizeVisit[] = [];
  const handler = async (route: Route): Promise<void> => {
    visits.push(await fulfillAuthorize(route, current, mint));
  };
  const bridge = async (route: Route): Promise<void> => {
    const response = await route.fetch({ maxRedirects: 0 });
    const rewritten = bridgeRedirect(
      response.status(),
      response.headersArray(),
      route.request().url()
    );
    await route.fulfill(rewritten ?? { response });
  };
  const bridgePatterns =
    appBaseUrl === undefined
      ? []
      : (bridgePaths ?? ['/api/auth/linear']).map(
          (path) => `${new URL(path, appBaseUrl).toString()}**`
        );
  await target.route(LINEAR_AUTHORIZE_URL_PATTERN, handler);
  for (const pattern of bridgePatterns) await target.route(pattern, bridge);
  return {
    visits,
    set(changes) {
      current = withBehaviour(current, changes);
    },
    behaviour: () => withBehaviour(current),
    unroute: async () => {
      await target.unroute(LINEAR_AUTHORIZE_URL_PATTERN, handler);
      for (const pattern of bridgePatterns) {
        await target.unroute(pattern, bridge);
      }
    },
  };
}
