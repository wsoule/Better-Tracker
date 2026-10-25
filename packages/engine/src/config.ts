// Reads the engine's configuration from environment variables
// (docs/architecture.md §7.1 and §10). Every problem is collected first and
// reported in one Error, so a misconfigured deploy shows the whole list at
// once instead of failing one variable per restart.

import { isValidTimeZone } from '@better-tracker/core';
import {
  type FixtureDataset,
  LINEAR_GRAPHQL_ENDPOINT,
} from '@better-tracker/linear';
import { parseEncryptionKey } from '@better-tracker/store';

import { API_KEY_IDLE_MS, API_KEY_MAX_MS } from './key-vault';
import type {
  EngineConfig,
  LinearAuthMode,
  OperatorContact,
  WorkspaceAdmission,
} from './types';

/** Process environment, or any plain map of variables (tests). */
export type EngineEnv = Readonly<Record<string, string | undefined>>;

/** Default display name (`APP_NAME`). */
export const DEFAULT_APP_NAME = 'Milestone Planner';
/** Base URL used in demo mode when `APP_URL` is unset. */
export const DEFAULT_DEMO_APP_URL = 'http://localhost:3000';
/** PGlite directory for real mode without `DATABASE_URL`. */
export const DEFAULT_PGLITE_DIR = '.data/pglite';
/** Session lifetime when `SESSION_DAYS` is unset. */
export const DEFAULT_SESSION_DAYS = 30;
/**
 * How long an unfinished daily claim holds before another process may take
 * it over (EngineConfig.dailyLeaseMinutes). The worker keeps every run
 * shorter than this minus ALLOCATION_RUN_STALE_MINUTES (its
 * TICK_TIMEOUT_MINUTES is at most 45 − 30 − 1 = 14), so when a dead run's
 * claim may be taken over, the allocation run it started is already stale
 * and the takeover's own run is not refused as a conflict.
 */
export const DEFAULT_DAILY_LEASE_MINUTES = 45;
/** Path of the OAuth callback route, appended to `APP_URL`. */
export const OAUTH_CALLBACK_PATH = '/api/auth/linear/callback';
/** Workspaces whose indexed mirror one process keeps (MIRROR_CACHE_WORKSPACES). */
export const DEFAULT_MIRROR_CACHE_WORKSPACES = 16;
/** The largest MIRROR_CACHE_WORKSPACES accepted (each holds a whole mirror). */
export const MAX_MIRROR_CACHE_WORKSPACES = 64;

const MAX_SESSION_DAYS = 365;
/** Minutes between background syncs in api_key mode (SYNC_INTERVAL_MINUTES). */
export const DEFAULT_API_KEY_SYNC_INTERVAL_MINUTES = 15;
const MAX_SYNC_INTERVAL_MINUTES = 1440;
/** What LINEAR_WORKSPACE may hold: a URL key or an organization id. */
const WORKSPACE_PIN = /^[A-Za-z0-9-]{1,64}$/;
/** At most this many LINEAR_WORKSPACES entries. */
export const MAX_WORKSPACE_ENTRIES = 100;
/** OPERATOR_NAME's limit, in characters. */
const MAX_OPERATOR_NAME = 120;
/** Hosts that count as this machine (APP_URL "loopback"). */
const LOOPBACK_HOSTS: readonly string[] = ['localhost', '127.0.0.1', '[::1]'];
/** The only hosts LINEAR_API_URL (test-only) may point at. */
const TEST_ENDPOINT_HOSTS: readonly string[] = ['127.0.0.1', '[::1]'];

/**
 * Variables api_key mode neither needs nor reads; boot logs one warning
 * for each one a deploy still sets (apiKeyUnusedEnvVariables).
 */
export const API_KEY_UNUSED_ENV_VARIABLES: readonly string[] = [
  'TOKEN_ENCRYPTION_KEY',
  'LINEAR_CLIENT_ID',
  'LINEAR_CLIENT_SECRET',
  'LINEAR_WEBHOOK_SECRET',
  'SESSION_SECRET',
  'SLACK_BOT_TOKEN',
  'SESSION_DAYS',
  'LINEAR_WORKSPACES',
];

/**
 * Variables earlier versions read that no longer do anything, each with the
 * sentence logged when a deploy still sets one. PM_EMAILS seeded the PM
 * list, which the owner decision of 2026-10-22 retired (there is no PM
 * role; everyone signed in can edit).
 */
export const RETIRED_ENV_VARIABLES: Readonly<Record<string, string>> = {
  PM_EMAILS:
    'PM_EMAILS is no longer used: there is no PM role, and everyone signed in can edit. Set WATCHER_EMAILS for who is warned about at-risk milestones, and remove PM_EMAILS.',
};
const LOG_LEVELS: readonly string[] = ['debug', 'info', 'warn', 'error'];

// A variable's value with surrounding whitespace removed; empty means unset.
function read(env: EngineEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? null : value;
}

/**
 * Which demo workspace `LINEAR_FIXTURE` selects, or null for real mode:
 * `1`/`true` the base workspace (`createFixtureStore`), `showcase` the
 * larger showcase (`createShowcaseStore`), `0`/`false`/unset neither, in
 * any case. Anything else is reported by loadEngineConfigFromEnv, and
 * reads as real mode here.
 */
export function fixtureDatasetFromEnv(env: EngineEnv): FixtureDataset | null {
  const value = read(env, 'LINEAR_FIXTURE')?.toLowerCase();
  if (value === '1' || value === 'true') return 'base';
  if (value === 'showcase') return 'showcase';
  return null;
}

/**
 * Whether `LINEAR_FIXTURE` turns on demo mode, with either demo workspace
 * (fixtureDatasetFromEnv). Every "is this demo mode" check goes through
 * this, so `showcase` is demo mode everywhere `1` is.
 */
export function isFixtureEnv(env: EngineEnv): boolean {
  return fixtureDatasetFromEnv(env) !== null;
}

/**
 * How the planner reaches Linear, without validating anything (the
 * webhook route, the proxy and the worker read it before or without
 * booting): `api_key` when LINEAR_AUTH is `api_key` (whatever else is
 * set; loadEngineConfigFromEnv refuses the conflict with LINEAR_FIXTURE),
 * else `demo` when LINEAR_FIXTURE turns on demo mode, else `oauth`. An
 * unknown LINEAR_AUTH reads as oauth here and is reported at boot.
 */
export function linearAuthFromEnv(env: EngineEnv): LinearAuthMode {
  if (read(env, 'LINEAR_AUTH')?.toLowerCase() === 'api_key') return 'api_key';
  return isFixtureEnv(env) ? 'demo' : 'oauth';
}

/** Whether LINEAR_AUTH=api_key (linearAuthFromEnv). */
export function isApiKeyEnv(env: EngineEnv): boolean {
  return linearAuthFromEnv(env) === 'api_key';
}

/**
 * The variables of API_KEY_UNUSED_ENV_VARIABLES this environment sets, in
 * a stable order; boot logs "X is unused when LINEAR_AUTH=api_key" for
 * each. Empty outside api_key mode.
 */
export function apiKeyUnusedEnvVariables(env: EngineEnv): string[] {
  if (!isApiKeyEnv(env)) return [];
  return API_KEY_UNUSED_ENV_VARIABLES.filter(
    (name) => read(env, name) !== null
  );
}

// Whether a URL's host is this machine (localhost, 127.0.0.1, [::1]).
function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Node flags api_key mode refuses (security S1), or null when the process
 * runs without them: any `--inspect…` or `--debug…` flag, which can open
 * a debugger onto the memory where connected keys live, and the heap
 * snapshot flags, which would write that memory to disk. When deployed,
 * `--disable-sigusr1` is also required, so a signal cannot open the
 * inspector. A speed bump, not a wall: a shell in the container can still
 * read process memory (architecture §7 "API-key mode", R7).
 */
export function processFlagProblem(input: {
  execArgv: readonly string[];
  nodeOptions: string;
  deployed: boolean;
}): string | null {
  const flags = [
    ...input.execArgv,
    ...input.nodeOptions.split(/\s+/).filter((flag) => flag !== ''),
  ];
  for (const flag of flags) {
    const name = flag.split('=')[0] ?? flag;
    if (
      name.startsWith('--inspect') ||
      name.startsWith('--debug') ||
      name === '--heapsnapshot-near-heap-limit' ||
      name === '--heapsnapshot-signal'
    ) {
      return `${flag} is refused when LINEAR_AUTH=api_key: it can expose or dump the server's memory, where connected keys live`;
    }
  }
  if (input.deployed && !flags.includes('--disable-sigusr1')) {
    return 'Set NODE_OPTIONS=--disable-sigusr1 when LINEAR_AUTH=api_key is deployed (deploy/Dockerfile sets it), so a signal cannot open the inspector';
  }
  return null;
}

// LINEAR_API_URL (test-only): a URL on 127.0.0.1 or [::1], without user
// info. Returns the endpoint, or the problem.
function parseTestEndpoint(
  value: string,
  appUrlLoopback: boolean
): { endpoint: string } | { error: string } {
  if (!appUrlLoopback) {
    return {
      error: 'LINEAR_API_URL is test-only: it needs a loopback APP_URL',
    };
  }
  const refused = {
    error:
      'LINEAR_API_URL may only point at a local test server (127.0.0.1 or [::1])',
  };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return refused;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return refused;
  }
  if (parsed.username !== '' || parsed.password !== '') return refused;
  if (!TEST_ENDPOINT_HOSTS.includes(parsed.hostname)) return refused;
  return { endpoint: value };
}

// Splits a comma-separated list, dropping blanks and repeats.
function parseList(value: string | null): string[] {
  if (value === null) return [];
  const out: string[] = [];
  for (const part of value.split(',')) {
    const item = part.trim();
    if (item !== '' && !out.includes(item)) out.push(item);
  }
  return out;
}

// Normalises APP_URL: an absolute http(s) URL without query or fragment,
// trailing slashes removed. Returns an error message instead when invalid.
function parseAppUrl(value: string): { url: string } | { error: string } {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { error: `APP_URL is not a valid URL: ${value}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'APP_URL must start with http:// or https://' };
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    return { error: 'APP_URL must not have a query string or fragment' };
  }
  return { url: value.replace(/\/+$/, '') };
}

/**
 * Whether the environment is a deployed planner: NODE_ENV=production on a
 * non-loopback APP_URL (api_key mode's `deployed`, for any mode). An
 * invalid or missing APP_URL is not deployed (loadEngineConfigFromEnv
 * reports it).
 */
export function isDeployedEnv(env: EngineEnv): boolean {
  const appUrl = read(env, 'APP_URL');
  if (read(env, 'NODE_ENV') !== 'production' || appUrl === null) return false;
  try {
    return !LOOPBACK_HOSTS.includes(new URL(appUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * LINEAR_WORKSPACES (OAuth mode, owner decision 2026-10-25): unset or
 * empty → closed to new workspaces (`installed`); exactly `*` → `any`;
 * else a comma-separated list of org ids or URL keys (letters, digits and
 * dashes, at most 64 each, at most MAX_WORKSPACE_ENTRIES), lower-cased and
 * deduplicated. Problems are added to `problems`.
 */
function readWorkspaceAdmission(
  env: EngineEnv,
  problems: string[]
): WorkspaceAdmission {
  const items = parseList(read(env, 'LINEAR_WORKSPACES'));
  if (items.length === 0) return { mode: 'installed' };
  if (items.length === 1 && items[0] === '*') return { mode: 'any' };
  const entries: string[] = [];
  for (const item of items) {
    if (item === '*') {
      problems.push(
        'LINEAR_WORKSPACES is either * on its own or a list of workspaces, not both'
      );
      continue;
    }
    if (!WORKSPACE_PIN.test(item)) {
      problems.push(
        `LINEAR_WORKSPACES has an entry that is not a Linear organization id or URL key (letters, digits and dashes, at most 64): ${item.slice(0, 80)}`
      );
      continue;
    }
    const entry = item.toLowerCase();
    if (!entries.includes(entry)) entries.push(entry);
  }
  if (entries.length > MAX_WORKSPACE_ENTRIES) {
    problems.push(
      `LINEAR_WORKSPACES lists ${entries.length} workspaces; at most ${MAX_WORKSPACE_ENTRIES} are allowed (use * to admit any)`
    );
  }
  return entries.length === 0
    ? { mode: 'installed' }
    : { mode: 'list', entries };
}

// Whether text holds a control character (C0 or DEL).
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

// An optional public http(s) URL without user info (OPERATOR_URL,
// DEMO_URL), or null when unset; a problem is added when it is malformed.
function readPublicUrl(
  env: EngineEnv,
  name: string,
  problems: string[]
): string | null {
  const value = read(env, name);
  if (value === null) return null;
  let parsed: URL | null = null;
  try {
    parsed = new URL(value);
  } catch {
    parsed = null;
  }
  if (
    parsed === null ||
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== ''
  ) {
    problems.push(`${name} must be an http:// or https:// URL`);
    return null;
  }
  return value;
}

/**
 * OPERATOR_NAME, OPERATOR_EMAIL and OPERATOR_URL (all optional): who runs
 * this planner, for the contact, privacy and terms pages. The shapes are
 * checked loosely: one line of at most 120 characters, something@something,
 * an http(s) URL.
 */
function readOperator(env: EngineEnv, problems: string[]): OperatorContact {
  const name = read(env, 'OPERATOR_NAME');
  if (
    name !== null &&
    (name.length > MAX_OPERATOR_NAME || hasControlCharacter(name))
  ) {
    problems.push(
      `OPERATOR_NAME must be one line of at most ${MAX_OPERATOR_NAME} characters`
    );
  }
  const email = read(env, 'OPERATOR_EMAIL');
  if (email !== null && !/^[^\s@]+@[^\s@]+$/.test(email)) {
    problems.push('OPERATOR_EMAIL is not an email address');
  }
  return {
    name,
    email,
    url: readPublicUrl(env, 'OPERATOR_URL', problems),
  };
}

// Validates a bootstrap email list and lowercases it for matching.
function parseEmails(
  name: string,
  value: string | null,
  problems: string[]
): string[] {
  const emails: string[] = [];
  for (const item of parseList(value)) {
    if (!/^[^\s@]+@[^\s@]+$/.test(item)) {
      problems.push(`${name} has an entry that is not an email: ${item}`);
      continue;
    }
    const email = item.toLowerCase();
    if (!emails.includes(email)) emails.push(email);
  }
  return emails;
}

// MIRROR_CACHE_WORKSPACES: a whole number from 1 to
// MAX_MIRROR_CACHE_WORKSPACES, else the default (a problem when invalid).
function readMirrorCacheWorkspaces(env: EngineEnv, problems: string[]): number {
  const raw = read(env, 'MIRROR_CACHE_WORKSPACES');
  if (raw === null) return DEFAULT_MIRROR_CACHE_WORKSPACES;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < 1 || value > MAX_MIRROR_CACHE_WORKSPACES) {
    problems.push(
      `MIRROR_CACHE_WORKSPACES must be a whole number from 1 to ${MAX_MIRROR_CACHE_WORKSPACES}`
    );
    return DEFAULT_MIRROR_CACHE_WORKSPACES;
  }
  return value;
}

/**
 * The retired variables (RETIRED_ENV_VARIABLES) this environment still
 * sets to a non-blank value, in a stable order, so boot can log one
 * warning for each instead of silently ignoring them.
 */
export function retiredEnvVariables(env: EngineEnv): string[] {
  return Object.keys(RETIRED_ENV_VARIABLES).filter(
    (name) => read(env, name) !== null
  );
}

/**
 * Builds the EngineConfig from the environment and validates every variable
 * the engine reads. Demo mode (`LINEAR_FIXTURE=1`, or `showcase` for the
 * larger demo workspace) needs nothing: APP_URL
 * defaults to http://localhost:3000 and OAuth is off. OAuth mode (the
 * default) requires APP_URL, TOKEN_ENCRYPTION_KEY, LINEAR_CLIENT_ID and
 * LINEAR_CLIENT_SECRET. `LINEAR_AUTH=api_key` needs only APP_URL (https
 * when deployed) and, when deployed, LINEAR_WORKSPACE; it refuses
 * inspector and heap-snapshot flags (processFlagProblem, read from
 * `execArgv` and NODE_OPTIONS). `migrateOnly` (the worker's migrate,
 * which never handles a key) skips those three deployed-only checks.
 * Throws one Error listing every missing or invalid variable.
 */
export function loadEngineConfigFromEnv(
  env: EngineEnv,
  options: { execArgv?: readonly string[]; migrateOnly?: boolean } = {}
): EngineConfig {
  const problems: string[] = [];
  const fixture = isFixtureEnv(env);
  const authRaw = read(env, 'LINEAR_AUTH')?.toLowerCase() ?? null;
  if (authRaw !== null && authRaw !== 'oauth' && authRaw !== 'api_key') {
    problems.push('LINEAR_AUTH must be oauth (default) or api_key');
  }
  const apiKeyMode = authRaw === 'api_key';
  if (apiKeyMode && fixture) {
    problems.push(
      'LINEAR_AUTH=api_key cannot be combined with LINEAR_FIXTURE (demo mode); unset one'
    );
  }
  // OAuth's credentials are required (and read) only in OAuth mode.
  const oauthMode = !fixture && !apiKeyMode;

  const fixtureRaw = read(env, 'LINEAR_FIXTURE')?.toLowerCase() ?? null;
  if (
    fixtureRaw !== null &&
    !['1', 'true', '0', 'false', 'showcase'].includes(fixtureRaw)
  ) {
    problems.push(
      'LINEAR_FIXTURE must be 1 (demo mode), showcase (demo mode with the larger showcase workspace) or 0'
    );
  }

  const appName = read(env, 'APP_NAME') ?? DEFAULT_APP_NAME;

  let appUrl = DEFAULT_DEMO_APP_URL;
  const rawAppUrl = read(env, 'APP_URL');
  if (rawAppUrl === null) {
    if (!fixture) problems.push('APP_URL is required');
  } else {
    const parsed = parseAppUrl(rawAppUrl);
    if ('error' in parsed) problems.push(parsed.error);
    else appUrl = parsed.url;
  }

  const key = apiKeyMode ? null : read(env, 'TOKEN_ENCRYPTION_KEY');
  if (key === null) {
    if (oauthMode) {
      problems.push(
        'TOKEN_ENCRYPTION_KEY is required (32 random bytes, base64)'
      );
    }
  } else {
    try {
      parseEncryptionKey(key);
    } catch (error) {
      problems.push(
        `TOKEN_ENCRYPTION_KEY is invalid: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const clientId = apiKeyMode ? null : read(env, 'LINEAR_CLIENT_ID');
  const clientSecret = apiKeyMode ? null : read(env, 'LINEAR_CLIENT_SECRET');
  if (oauthMode) {
    if (clientId === null) problems.push('LINEAR_CLIENT_ID is required');
    if (clientSecret === null) {
      problems.push('LINEAR_CLIENT_SECRET is required');
    }
  }

  const defaultTimezone = read(env, 'DEFAULT_TIMEZONE') ?? 'UTC';
  if (!isValidTimeZone(defaultTimezone)) {
    problems.push(
      `DEFAULT_TIMEZONE is not a known IANA timezone: ${defaultTimezone}`
    );
  }

  // PM_EMAILS is retired (retiredEnvVariables); it is neither read nor
  // validated, so an old value can never block a boot.
  const bootstrapWatcherEmails = parseEmails(
    'WATCHER_EMAILS',
    read(env, 'WATCHER_EMAILS'),
    problems
  );

  let sessionDays = DEFAULT_SESSION_DAYS;
  // Ignored with personal API keys: their limits are fixed (key-vault.ts).
  const rawSessionDays = apiKeyMode ? null : read(env, 'SESSION_DAYS');
  if (rawSessionDays !== null) {
    const parsed = Number(rawSessionDays);
    if (
      !/^\d+$/.test(rawSessionDays) ||
      parsed < 1 ||
      parsed > MAX_SESSION_DAYS
    ) {
      problems.push(
        `SESSION_DAYS must be a whole number of days from 1 to ${MAX_SESSION_DAYS}`
      );
    } else {
      sessionDays = parsed;
    }
  }

  const databaseUrl = read(env, 'DATABASE_URL');
  if (databaseUrl !== null && !fixture) {
    let protocol = '';
    try {
      protocol = new URL(databaseUrl).protocol;
    } catch {
      // Reported below without echoing the URL (it carries a password).
    }
    if (protocol !== 'postgres:' && protocol !== 'postgresql:') {
      problems.push('DATABASE_URL must be a postgres:// connection string');
    }
  }

  const logLevel = read(env, 'LOG_LEVEL');
  if (logLevel !== null && !LOG_LEVELS.includes(logLevel)) {
    problems.push('LOG_LEVEL must be one of debug, info, warn, error');
  }

  // Read in OAuth mode only: demo mode ignores it and api_key mode reports
  // it unused at boot (API_KEY_UNUSED_ENV_VARIABLES).
  const workspaces = oauthMode
    ? readWorkspaceAdmission(env, problems)
    : undefined;
  const operator = readOperator(env, problems);
  const demoUrl = readPublicUrl(env, 'DEMO_URL', problems);
  const mirrorCacheWorkspaces = readMirrorCacheWorkspaces(env, problems);

  let apiKey: EngineConfig['apiKey'] = null;
  if (apiKeyMode && !fixture) {
    apiKey = readApiKeyConfig(env, {
      appUrl: rawAppUrl === null ? null : appUrl,
      execArgv: options.execArgv ?? process.execArgv,
      migrateOnly: options.migrateOnly === true,
      problems,
    });
  }

  if (problems.length > 0) {
    throw new Error(
      `Invalid environment for ${appName}:\n${problems.map((p) => `- ${p}`).join('\n')}`
    );
  }

  return {
    auth: fixture ? 'demo' : apiKeyMode ? 'api_key' : 'oauth',
    apiKey,
    appName,
    appUrl,
    mirrorCacheWorkspaces,
    defaultTimezone,
    bootstrapWatcherEmails,
    oauth:
      !oauthMode || clientId === null || clientSecret === null
        ? null
        : {
            clientId,
            clientSecret,
            redirectUri: `${appUrl}${OAUTH_CALLBACK_PATH}`,
          },
    sessionDays,
    ...(workspaces === undefined ? {} : { workspaces }),
    operator,
    demoUrl,
  };
}

// The api_key-mode part of the config (§2.2): deployed, the workspace pin,
// the background sync interval, the test-only endpoint and the process
// flags. Problems are added to `problems`. A `migrateOnly` process (the
// worker's migrate) never handles a key, so the checks that protect keys
// on a deployed planner (an https APP_URL, the pin, the process flags)
// are skipped for it.
function readApiKeyConfig(
  env: EngineEnv,
  input: {
    appUrl: string | null;
    execArgv: readonly string[];
    migrateOnly: boolean;
    problems: string[];
  }
): NonNullable<EngineConfig['apiKey']> {
  const { problems } = input;
  const loopback = input.appUrl !== null && isLoopbackUrl(input.appUrl);
  const deployed =
    read(env, 'NODE_ENV') === 'production' &&
    input.appUrl !== null &&
    !loopback;
  const guardKeys = deployed && !input.migrateOnly;
  if (guardKeys && input.appUrl?.startsWith('https://') !== true) {
    problems.push(
      'APP_URL must be https:// when LINEAR_AUTH=api_key is deployed (keys must only travel over HTTPS)'
    );
  }

  const workspacePin = read(env, 'LINEAR_WORKSPACE');
  if (workspacePin === null) {
    if (guardKeys) {
      problems.push(
        "LINEAR_WORKSPACE is required when LINEAR_AUTH=api_key is deployed: set it to your Linear workspace's URL key (linear.app/<key>), so nobody else can bind this planner"
      );
    }
  } else if (!WORKSPACE_PIN.test(workspacePin)) {
    problems.push(
      'LINEAR_WORKSPACE must be a Linear workspace URL key or organization id (letters, digits and dashes, at most 64)'
    );
  }

  let syncMinutes = DEFAULT_API_KEY_SYNC_INTERVAL_MINUTES;
  const rawSync = read(env, 'SYNC_INTERVAL_MINUTES');
  if (rawSync !== null) {
    const value = Number(rawSync);
    if (
      !/^\d+$/.test(rawSync) ||
      value < 1 ||
      value > MAX_SYNC_INTERVAL_MINUTES
    ) {
      problems.push(
        `SYNC_INTERVAL_MINUTES must be a whole number of minutes from 1 to ${MAX_SYNC_INTERVAL_MINUTES}`
      );
    } else {
      syncMinutes = value;
    }
  }

  let endpoint = LINEAR_GRAPHQL_ENDPOINT;
  const rawEndpoint = read(env, 'LINEAR_API_URL');
  if (rawEndpoint !== null) {
    const parsed = parseTestEndpoint(rawEndpoint, loopback);
    if ('error' in parsed) problems.push(parsed.error);
    else endpoint = parsed.endpoint;
  }

  const flagProblem = input.migrateOnly
    ? null
    : processFlagProblem({
        execArgv: input.execArgv,
        nodeOptions: read(env, 'NODE_OPTIONS') ?? '',
        deployed,
      });
  if (flagProblem !== null) problems.push(flagProblem);

  return {
    idleMs: API_KEY_IDLE_MS,
    absoluteMs: API_KEY_MAX_MS,
    syncIntervalMs: syncMinutes * 60_000,
    workspacePin,
    endpoint,
    deployed,
  };
}
