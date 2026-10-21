// Slack delivery over the Web API with plain fetch (no SDK), per
// docs/architecture.md §6: look the person up by their Linear email, then DM
// them through chat.postMessage with channel=<user id> (the app's Messages
// tab). Every Slack answer is checked for `ok` because Slack reports most
// errors as HTTP 200. The bot token only ever goes into the Authorization
// header; it is never logged or put into a result.

import type { Digest } from '@better-tracker/core';

import { renderDigest } from './render';
import type {
  DeliveryContext,
  DeliveryResult,
  NotificationChannel,
} from './types';

/** The logging surface the channel needs (structurally a subset of Logger). */
export interface SlackChannelLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface SlackChannelOptions {
  /** Bot token (`xoxb-…`) with chat:write, users:read, users:read.email. */
  botToken: string;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  logger?: SlackChannelLogger;
  /** Injected for tests; defaults to a setTimeout-based wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Upper bound on a Retry-After wait before the single retry (default 30). */
  maxRetryAfterSeconds?: number;
  /**
   * Minimum gap between chat.postMessage calls, in ms (default 1000):
   * digests go out one at a time at about 1/s (§6), even when send() is
   * called concurrently.
   */
  minPostIntervalMs?: number;
  /** Abort a Slack request with no complete answer after this many ms (default 15000). */
  requestTimeoutMs?: number;
  /** Injected for tests; defaults to Date.now. Used only for post pacing. */
  now?: () => number;
}

const SLACK_API = 'https://slack.com/api';
const DEFAULT_MAX_RETRY_AFTER_SECONDS = 30;
const DEFAULT_MIN_POST_INTERVAL_MS = 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/** Used when a rate-limited answer has no usable Retry-After header. */
const DEFAULT_RETRY_AFTER_SECONDS = 1;

/** Token/app problems: nobody can be reached until someone fixes the setup. */
const CONFIG_ERRORS: ReadonlySet<string> = new Set([
  'invalid_auth',
  'not_authed',
  'account_inactive',
  'token_revoked',
  'token_expired',
  'missing_scope',
]);

/** This one person cannot be reached on Slack. */
const PERSON_ERRORS: ReadonlySet<string> = new Set([
  'users_not_found',
  'user_not_found',
  'user_disabled',
  'channel_not_found',
  'messages_tab_disabled',
]);

/** Slack-side hiccups; a later run may succeed. */
const TRANSIENT_ERRORS: ReadonlySet<string> = new Set([
  'service_unavailable',
  'fatal_error',
  'request_timeout',
  'internal_error',
  'network_error',
]);

const RATE_LIMIT_ERRORS: ReadonlySet<string> = new Set([
  'ratelimited',
  'rate_limited',
]);

type SlackMethod = 'users.lookupByEmail' | 'chat.postMessage';

/** A Slack call that did not succeed. */
interface CallError {
  kind: 'error';
  /** Slack's error code, or a local one (network_error, http_503…). */
  code: string;
  /** Extra context safe to show (never the token). */
  note: string | null;
}

/** Outcome of one Slack Web API call after the optional retry. */
type CallOutcome = { kind: 'ok'; body: Record<string, unknown> } | CallError;

/** Outcome of one HTTP attempt, before rate-limit handling. */
type AttemptOutcome =
  | CallOutcome
  | { kind: 'rate_limited'; retryAfterSeconds: number | null };

const noopLogger: SlackChannelLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Reads a JSON body defensively: anything that is not a JSON object is null.
function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Retry-After is whole seconds on Slack; a blank or unparseable value is
// treated as missing (Number('') would otherwise read as "retry now").
function parseRetryAfter(header: string | null): number | null {
  const trimmed = header === null ? '' : header.trim();
  if (trimmed === '') return null;
  const seconds = Number(trimmed);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Creates the Slack DM channel. One instance caches email → Slack user id
 * for its lifetime, so a run that sends several digests to the same person
 * (or a long-lived worker) looks each address up once.
 */
export function createSlackChannel(
  options: SlackChannelOptions
): NotificationChannel {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const logger = options.logger ?? noopLogger;
  const sleep = options.sleep ?? defaultSleep;
  const maxRetryAfterSeconds = Math.max(
    0,
    options.maxRetryAfterSeconds ?? DEFAULT_MAX_RETRY_AFTER_SECONDS
  );
  const minPostIntervalMs = Math.max(
    0,
    options.minPostIntervalMs ?? DEFAULT_MIN_POST_INTERVAL_MS
  );
  const requestTimeoutMs = Math.max(
    1,
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  );
  const now = options.now ?? Date.now;
  const authorization = `Bearer ${options.botToken}`;
  const userIdByEmail = new Map<string, string>();
  // Post pacing state: when the previous chat.postMessage finished, and the
  // tail of the queue every post waits behind.
  let lastPostAt: number | null = null;
  let postQueue: Promise<unknown> = Promise.resolve();

  /**
   * Performs one HTTP request and classifies the answer: success, a
   * rate-limit signal (HTTP 429 or `ratelimited`/`rate_limited`), or an
   * error code. Network failures, including a body cut off mid-read, become
   * `network_error`; no complete answer within requestTimeoutMs becomes
   * `request_timeout` (a hung connection must not stall the daily run).
   */
  async function attempt(
    url: string,
    init: RequestInit
  ): Promise<AttemptOutcome> {
    let status: number;
    let retryAfter: string | null;
    let text: string;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(url, {
        ...init,
        signal: controller.signal,
      });
      status = response.status;
      retryAfter = response.headers.get('retry-after');
      text = await response.text();
    } catch (error) {
      if (controller.signal.aborted) {
        return {
          kind: 'error',
          code: 'request_timeout',
          note: `no answer within ${requestTimeoutMs} ms`,
        };
      }
      return {
        kind: 'error',
        code: 'network_error',
        note: errorMessage(error),
      };
    } finally {
      clearTimeout(timer);
    }

    if (status === 429) {
      return {
        kind: 'rate_limited',
        retryAfterSeconds: parseRetryAfter(retryAfter),
      };
    }
    const body = parseJsonObject(text);
    if (body !== null && body.ok === true) return { kind: 'ok', body };
    if (body !== null && typeof body.error === 'string') {
      if (RATE_LIMIT_ERRORS.has(body.error)) {
        return {
          kind: 'rate_limited',
          retryAfterSeconds: parseRetryAfter(retryAfter),
        };
      }
      // missing_scope says which scope is needed; worth surfacing to admins.
      const note =
        typeof body.needed === 'string' ? `needed ${body.needed}` : null;
      return { kind: 'error', code: body.error, note };
    }
    if (status < 200 || status >= 300) {
      return { kind: 'error', code: `http_${status}`, note: null };
    }
    return { kind: 'error', code: 'invalid_response', note: null };
  }

  /**
   * Calls a Slack method, retrying exactly once after a rate limit. The wait
   * honours Retry-After but is capped at maxRetryAfterSeconds so one slow
   * answer cannot stall a whole run; a second rate limit is reported as
   * `ratelimited`.
   */
  async function call(
    method: SlackMethod,
    url: string,
    init: RequestInit
  ): Promise<CallOutcome> {
    const first = await attempt(url, init);
    if (first.kind !== 'rate_limited') return first;

    const waitSeconds = Math.min(
      first.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS,
      maxRetryAfterSeconds
    );
    logger.warn('Slack rate limited; retrying once', { method, waitSeconds });
    await sleep(waitSeconds * 1000);

    const second = await attempt(url, init);
    if (second.kind !== 'rate_limited') return second;
    return {
      kind: 'error',
      code: 'ratelimited',
      note: 'still rate limited after one retry',
    };
  }

  /**
   * Runs chat.postMessage calls one at a time, each starting at least
   * minPostIntervalMs after the previous one finished, so digests go out
   * sequentially at about 1/s (§6) however the caller schedules send().
   */
  function postPaced(init: RequestInit): Promise<CallOutcome> {
    const run = postQueue.then(async () => {
      if (lastPostAt !== null) {
        const wait = lastPostAt + minPostIntervalMs - now();
        if (wait > 0) await sleep(wait);
      }
      try {
        return await call(
          'chat.postMessage',
          `${SLACK_API}/chat.postMessage`,
          init
        );
      } finally {
        lastPostAt = now();
      }
    });
    // Later posts wait for this one whether it succeeded or not.
    postQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * Maps a Slack error to a DeliveryResult and logs it at the right level:
   * per-person codes are `undeliverable`; configuration, transient and
   * unknown codes are `failed` (configuration and unknown ones at error,
   * since they need a human).
   */
  function toResult(
    method: SlackMethod,
    outcome: CallError,
    recipientId: string
  ): DeliveryResult {
    const { code, note } = outcome;
    const detail =
      note === null ? `${code} (${method})` : `${code} (${method}; ${note})`;
    const fields = { method, code, recipientId };

    if (PERSON_ERRORS.has(code)) {
      logger.warn('Slack recipient unreachable', fields);
      return { status: 'undeliverable', channel: 'slack', detail };
    }
    if (CONFIG_ERRORS.has(code)) {
      logger.error('Slack configuration error; check the bot token', fields);
    } else if (TRANSIENT_ERRORS.has(code) || code === 'ratelimited') {
      logger.warn('Slack temporarily unavailable', { ...fields, note });
    } else {
      logger.error('Slack request failed', { ...fields, note });
    }
    return { status: 'failed', channel: 'slack', detail };
  }

  /**
   * Resolves a Slack user id from an email. Successful lookups are cached
   * per instance under the lower-cased address (Slack matches emails
   * case-insensitively); failures are not cached, so someone who joins Slack
   * later is found on the next run.
   */
  async function lookupUserId(
    email: string
  ): Promise<{ kind: 'ok'; userId: string } | CallError> {
    const cacheKey = email.toLowerCase();
    const cached = userIdByEmail.get(cacheKey);
    if (cached !== undefined) return { kind: 'ok', userId: cached };

    const url = `${SLACK_API}/users.lookupByEmail?email=${encodeURIComponent(email)}`;
    const outcome = await call('users.lookupByEmail', url, {
      method: 'GET',
      headers: { Authorization: authorization },
    });
    if (outcome.kind === 'error') return outcome;

    const user = outcome.body.user;
    const userId = isRecord(user) ? user.id : undefined;
    if (typeof userId !== 'string' || userId === '') {
      return { kind: 'error', code: 'invalid_response', note: 'no user id' };
    }
    userIdByEmail.set(cacheKey, userId);
    return { kind: 'ok', userId };
  }

  async function send(
    digest: Digest,
    context: DeliveryContext
  ): Promise<DeliveryResult> {
    const recipientId = digest.recipientId;
    const email = (digest.recipientEmail ?? '').trim();
    if (email === '') {
      logger.warn('Slack recipient has no email in Linear', { recipientId });
      return {
        status: 'undeliverable',
        channel: 'slack',
        detail: 'no email in Linear',
      };
    }

    const lookup = await lookupUserId(email);
    if (lookup.kind === 'error') {
      return toResult('users.lookupByEmail', lookup, recipientId);
    }

    const { text, blocks } = renderDigest(digest, context);
    const posted = await postPaced({
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({
        channel: lookup.userId,
        text,
        blocks,
        unfurl_links: false,
        unfurl_media: false,
      }),
    });
    if (posted.kind === 'error') {
      return toResult('chat.postMessage', posted, recipientId);
    }

    const channel =
      typeof posted.body.channel === 'string' ? posted.body.channel : '';
    const ts = typeof posted.body.ts === 'string' ? posted.body.ts : '';
    if (typeof posted.body.warning === 'string') {
      logger.warn('Slack accepted the message with a warning', {
        method: 'chat.postMessage',
        warning: posted.body.warning,
        recipientId,
      });
    }
    logger.info('Slack digest sent', {
      recipientId,
      channel,
      ts,
      items: digest.items.length,
    });
    const detail = `${channel} ${ts}`.trim();
    return {
      status: 'sent',
      channel: 'slack',
      detail: detail === '' ? null : detail,
    };
  }

  return { name: 'slack', delivers: true, send };
}
