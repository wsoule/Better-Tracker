// The connect route's rate limits (LINEAR_AUTH=api_key, architecture §8.1
// "Security"), in memory, per process. They stop the planner being used
// as an oracle for which Linear keys are valid, and keep repeated tries
// from driving Linear calls and memory:
//
// - per client IP (Railway's `X-Real-IP`; `X-Forwarded-For` is never
//   read, since a client can set it): 10 failures per 10 minutes, every
//   failure counting;
// - globally: 60 failures per 10 minutes, counting only failures that
//   reached Linear. It refuses only clients that failed themselves in the
//   window, so one source filling it never locks out everyone re-pasting
//   their key after a redeploy: a client with no failure of its own
//   always gets its try (and its failure then counts).
//
// A try is counted when it starts (begin), before Linear is called, so
// concurrent posts cannot all slip past the limits while Linear answers;
// finish then keeps it for a failure that counts and takes it back for a
// success or an outcome that does not count (Linear unreachable, an
// internal error). Successes count toward neither window (the vault's
// per-person cap bounds a valid key's connects). The per-IP map is
// LRU-capped and prunes expired windows as it goes.

import { clientIp } from './rate-limit';

/** Railway's client IP header (the only one read; lib/rate-limit.ts). */
export { CLIENT_IP_HEADER } from './rate-limit';
/** The shared bucket for requests without a usable client IP. */
export const NO_IP_BUCKET = 'no-ip';

/** Every way a connect can fail that counts, by the auth_error code it answers. */
export type ConnectFailure =
  | 'invalid_request'
  | 'key_shape'
  | 'key_rejected'
  | 'key_cannot_read'
  | 'key_wrong_workspace'
  | 'guest_cannot_bind';

/** The failures that count toward the per-IP window. */
const COUNTED: ReadonlySet<string> = new Set<ConnectFailure>([
  'invalid_request',
  'key_shape',
  'key_rejected',
  'key_cannot_read',
  'key_wrong_workspace',
  'guest_cannot_bind',
]);

/** The failures that reached Linear (they count toward the global window too). */
const LINEAR_FAILURES: ReadonlySet<string> = new Set<ConnectFailure>([
  'key_rejected',
  'key_cannot_read',
  'key_wrong_workspace',
  'guest_cannot_bind',
]);

export interface ConnectLimitOptions {
  /** Epoch ms. */
  now: () => number;
  perIpLimit?: number;
  globalLimit?: number;
  windowMs?: number;
  /** Most client IPs remembered (LRU). */
  maxEntries?: number;
}

/** A try that may go ahead; call finish once with how it ended. */
export interface ConnectAttempt {
  ok: true;
  /**
   * The outcome: `success`, a failure code (ConnectFailure counts, any
   * other code such as `linear_unreachable` or `internal` does not).
   */
  finish(outcome: string): void;
}

export type ConnectCheck =
  | ConnectAttempt
  | { ok: false; scope: 'ip' | 'global'; retryAfterSeconds: number };

export interface ConnectLimiter {
  /**
   * Counts a try from this client now, or refuses it: over its own limit,
   * or over the global one when it failed itself in the window.
   */
  begin(client: string): ConnectCheck;
  /** Client IPs remembered (tests). */
  size(): number;
}

/**
 * The rate-limit bucket of a request: its X-Real-IP (read as
 * lib/rate-limit.ts reads it), or the shared one. Unlike the other limits,
 * the connect form's keep one bucket for requests without a client IP
 * (api_key mode is unchanged by the 2026-10-25 limits).
 */
export function connectClientKey(request: Request): string {
  return clientIp(request) ?? NO_IP_BUCKET;
}

// One counted try (pending until finish keeps or drops it). An object, so
// a try is taken back by identity even after older ones were pruned.
interface Mark {
  at: number;
}

/** Builds a limiter (see the file comment). */
export function createConnectLimiter(
  options: ConnectLimitOptions
): ConnectLimiter {
  const perIpLimit = options.perIpLimit ?? 10;
  const globalLimit = options.globalLimit ?? 60;
  const windowMs = options.windowMs ?? 10 * 60_000;
  const maxEntries = options.maxEntries ?? 10_000;
  // Tries per client, oldest first; Map order is least recently used first.
  const byClient = new Map<string, Mark[]>();
  const global: Mark[] = [];

  function live(marks: Mark[], now: number): Mark[] {
    while (marks.length > 0 && now - (marks[0]?.at ?? 0) >= windowMs) {
      marks.shift();
    }
    return marks;
  }

  // Drops expired clients from the least recently used end.
  function prune(now: number): void {
    for (const [client, marks] of byClient) {
      if (live(marks, now).length > 0) break;
      byClient.delete(client);
    }
  }

  function retryAfter(marks: Mark[], now: number): number {
    const oldest = marks[0]?.at ?? now;
    return Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
  }

  function takeBack(marks: Mark[] | undefined, mark: Mark): void {
    if (marks === undefined) return;
    const index = marks.indexOf(mark);
    if (index >= 0) marks.splice(index, 1);
  }

  return {
    begin(client) {
      const now = options.now();
      prune(now);
      const own = live(byClient.get(client) ?? [], now);
      if (own.length >= perIpLimit) {
        return {
          ok: false,
          scope: 'ip',
          retryAfterSeconds: retryAfter(own, now),
        };
      }
      if (own.length > 0 && live(global, now).length >= globalLimit) {
        return {
          ok: false,
          scope: 'global',
          retryAfterSeconds: retryAfter(global, now),
        };
      }
      const mark: Mark = { at: now };
      own.push(mark);
      byClient.delete(client);
      byClient.set(client, own);
      while (byClient.size > maxEntries) {
        const oldest = byClient.keys().next();
        if (oldest.done === true) break;
        byClient.delete(oldest.value);
      }
      global.push(mark);
      if (global.length > globalLimit) global.shift();
      let finished = false;
      return {
        ok: true,
        finish(outcome) {
          if (finished) return;
          finished = true;
          if (!COUNTED.has(outcome)) {
            const marks = byClient.get(client);
            takeBack(marks, mark);
            if (marks !== undefined && marks.length === 0) {
              byClient.delete(client);
            }
          }
          if (!LINEAR_FAILURES.has(outcome)) takeBack(global, mark);
        },
      };
    },

    size() {
      return byClient.size;
    },
  };
}

// One limiter per server process, kept across Next dev's module reloads.
const holder = globalThis as typeof globalThis & {
  __milestonePlannerConnectLimiter?: ConnectLimiter;
};

/** The process-wide limiter the connect route uses. */
export function processConnectLimiter(): ConnectLimiter {
  holder.__milestonePlannerConnectLimiter ??= createConnectLimiter({
    now: () => Date.now(),
  });
  return holder.__milestonePlannerConnectLimiter;
}
