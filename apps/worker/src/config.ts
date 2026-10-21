// The worker's own environment variables (architecture §9, §10). The engine
// validates everything it reads itself (createEngineFromEnv); these are the
// scheduler knobs only the worker uses. Like the engine, every problem is
// collected and reported in one error.

import {
  DEFAULT_DAILY_RUN_AT,
  type DailyTime,
  parseDailyRunAt,
} from './schedule';

/** Process environment, or any plain map of variables (tests). */
export type WorkerEnv = Readonly<Record<string, string | undefined>>;

/** Default `TICK_TIMEOUT_MINUTES`. */
export const DEFAULT_TICK_TIMEOUT_MINUTES = 10;
/** Default `SYNC_INTERVAL_MINUTES` (serve). Matches the documented cron. */
export const DEFAULT_SYNC_INTERVAL_MINUTES = 15;

const MAX_TICK_TIMEOUT_MINUTES = 720;
const MAX_SYNC_INTERVAL_MINUTES = 1440;

export interface WorkerConfig {
  /** `DAILY_RUN_AT` as given (`HH:MM`), validated. */
  dailyAt: string;
  dailyTime: DailyTime;
  /** Hard limit for one tick (and for boot), in minutes. */
  tickTimeoutMinutes: number;
  /** serve: minutes between tick starts. */
  syncIntervalMinutes: number;
}

// A variable's value with surrounding whitespace removed; empty means unset.
function read(env: WorkerEnv, name: string): string | null {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? null : value;
}

// A whole number of minutes within [1, max]; the default when unset. An
// invalid value records a problem (and returns the default so the caller
// can keep collecting problems).
function readMinutes(
  env: WorkerEnv,
  name: string,
  fallback: number,
  max: number,
  problems: string[]
): number {
  const raw = read(env, name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < 1 || value > max) {
    problems.push(`${name} must be a whole number of minutes from 1 to ${max}`);
    return fallback;
  }
  return value;
}

/**
 * Reads `DAILY_RUN_AT` (default 08:00, strict `HH:MM`),
 * `TICK_TIMEOUT_MINUTES` (default 10) and `SYNC_INTERVAL_MINUTES` (default
 * 15). Throws one Error listing every invalid variable.
 */
export function loadWorkerConfig(env: WorkerEnv): WorkerConfig {
  const problems: string[] = [];
  const dailyAt = read(env, 'DAILY_RUN_AT') ?? DEFAULT_DAILY_RUN_AT;
  const dailyTime = parseDailyRunAt(dailyAt);
  if (dailyTime === null) {
    problems.push(
      `DAILY_RUN_AT must be a 24-hour time HH:MM from 00:00 to 23:59 (got ${JSON.stringify(dailyAt)})`
    );
  }
  const tickTimeoutMinutes = readMinutes(
    env,
    'TICK_TIMEOUT_MINUTES',
    DEFAULT_TICK_TIMEOUT_MINUTES,
    MAX_TICK_TIMEOUT_MINUTES,
    problems
  );
  const syncIntervalMinutes = readMinutes(
    env,
    'SYNC_INTERVAL_MINUTES',
    DEFAULT_SYNC_INTERVAL_MINUTES,
    MAX_SYNC_INTERVAL_MINUTES,
    problems
  );
  if (problems.length > 0 || dailyTime === null) {
    throw new Error(
      `Invalid worker environment:\n${problems.map((p) => `- ${p}`).join('\n')}`
    );
  }
  return { dailyAt, dailyTime, tickTimeoutMinutes, syncIntervalMinutes };
}
