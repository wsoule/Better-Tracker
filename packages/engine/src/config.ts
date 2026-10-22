// Reads the engine's configuration from environment variables
// (docs/architecture.md §7.1 and §10). Every problem is collected first and
// reported in one Error, so a misconfigured deploy shows the whole list at
// once instead of failing one variable per restart.

import { isValidTimeZone } from '@better-tracker/core';
import { parseEncryptionKey } from '@better-tracker/store';

import type { EngineConfig } from './types';

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

const MAX_SESSION_DAYS = 365;

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
 * Whether `LINEAR_FIXTURE` turns on demo mode. Accepts `1`/`true` (on) and
 * `0`/`false`/unset (off); anything else is reported by
 * loadEngineConfigFromEnv, and reads as off here.
 */
export function isFixtureEnv(env: EngineEnv): boolean {
  const value = read(env, 'LINEAR_FIXTURE')?.toLowerCase();
  return value === '1' || value === 'true';
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
 * the engine reads. Demo mode (`LINEAR_FIXTURE=1`) needs nothing: APP_URL
 * defaults to http://localhost:3000 and OAuth is off. Otherwise APP_URL,
 * TOKEN_ENCRYPTION_KEY, LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET are
 * required. Throws one Error listing every missing or invalid variable.
 */
export function loadEngineConfigFromEnv(env: EngineEnv): EngineConfig {
  const problems: string[] = [];
  const fixture = isFixtureEnv(env);

  const fixtureRaw = read(env, 'LINEAR_FIXTURE')?.toLowerCase() ?? null;
  if (
    fixtureRaw !== null &&
    !['1', 'true', '0', 'false'].includes(fixtureRaw)
  ) {
    problems.push('LINEAR_FIXTURE must be 1 (demo mode) or 0');
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

  const key = read(env, 'TOKEN_ENCRYPTION_KEY');
  if (key === null) {
    if (!fixture) {
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

  const clientId = read(env, 'LINEAR_CLIENT_ID');
  const clientSecret = read(env, 'LINEAR_CLIENT_SECRET');
  if (!fixture) {
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
  const rawSessionDays = read(env, 'SESSION_DAYS');
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

  if (problems.length > 0) {
    throw new Error(
      `Invalid environment for ${appName}:\n${problems.map((p) => `- ${p}`).join('\n')}`
    );
  }

  return {
    appName,
    appUrl,
    defaultTimezone,
    bootstrapWatcherEmails,
    oauth:
      fixture || clientId === null || clientSecret === null
        ? null
        : {
            clientId,
            clientSecret,
            redirectUri: `${appUrl}${OAUTH_CALLBACK_PATH}`,
          },
    sessionDays,
  };
}
