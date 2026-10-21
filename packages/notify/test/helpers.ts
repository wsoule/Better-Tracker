// Hand-built digest fixtures and a recording fake fetch for the notify tests.
// Nothing here talks to the network: every Slack answer is scripted.

import type {
  Digest,
  DigestItem,
  Notice,
  NoticeKind,
} from '@better-tracker/core';

import type { DeliveryContext } from '../src/types';

export const CONTEXT: DeliveryContext = {
  appName: 'Milestone Planner',
  appUrl: 'https://planner.example.com',
};

export const TOKEN = 'xoxb-test-token-123';

export interface ItemOverrides {
  kind?: NoticeKind;
  daysLeft?: number | null;
  targetDate?: string | null;
  projectName?: string;
  milestoneName?: string | null;
  lines?: string[];
  openCount?: number;
  unassignedCount?: number;
  url?: string;
  id?: string;
}

/** One digest item with sensible defaults (an at-risk milestone). */
export function makeItem(overrides: ItemOverrides = {}): DigestItem {
  const id = overrides.id ?? 'ms-1';
  const kind = overrides.kind ?? 'at_risk';
  const isProject = kind === 'allocation_blocked';
  const notice: Notice = {
    kind,
    subjectKind: isProject ? 'project' : 'milestone',
    subjectId: isProject ? 'proj-1' : id,
    projectId: 'proj-1',
    milestoneId: isProject ? null : id,
    key: `${kind}:2026-10-23`,
    targetDate:
      overrides.targetDate === undefined ? '2026-10-23' : overrides.targetDate,
    daysLeft: overrides.daysLeft === undefined ? 2 : overrides.daysLeft,
    reasons: [],
    gaps: [],
    blockReason: isProject ? 'no_lead' : null,
    openIssueIds: [],
    unassignedIssueIds: [],
    recipientIds: ['user-1'],
    occurrence: 1,
  };
  return {
    notice,
    projectName: overrides.projectName ?? 'Orion',
    milestoneName:
      overrides.milestoneName === undefined ? 'Beta' : overrides.milestoneName,
    leadName: 'Ana',
    openCount: overrides.openCount ?? 4,
    unassignedCount: overrides.unassignedCount ?? 3,
    lines: overrides.lines ?? [
      '3 open issues unassigned',
      '3/7 done with 2 days left',
    ],
    url:
      overrides.url ??
      `https://planner.example.com/timeline?milestone=${encodeURIComponent(id)}`,
  };
}

export function makeDigest(
  items: DigestItem[],
  overrides: Partial<Omit<Digest, 'items'>> = {}
): Digest {
  return {
    recipientId: 'user-1',
    recipientName: 'Ana Lima',
    recipientEmail: 'ana@example.com',
    day: '2026-10-21',
    items,
    ...overrides,
  };
}

/** A request as the fake fetch saw it. */
export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/**
 * A scripted answer: a Slack JSON body, a raw response, a thrown error, or
 * no answer at all until the request's signal aborts it.
 */
export type FakeReply =
  | { json: unknown; status?: number; headers?: Record<string, string> }
  | { text: string; status: number; headers?: Record<string, string> }
  | { throws: Error }
  | { hangs: true };

// Copies a RequestInit's headers into a plain lower-cased record so tests
// can assert on them regardless of how the code built them.
function headersOf(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

/**
 * A fake fetch that records every request and answers from `replies` in
 * order. Running out of replies fails the test loudly.
 */
export function fakeFetch(replies: FakeReply[]): {
  fetch: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const queue = [...replies];
  const impl = (
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    requests.push({
      url,
      method: init?.method ?? 'GET',
      headers: headersOf(init),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    const reply = queue.shift();
    if (reply === undefined) {
      return Promise.reject(new Error(`unexpected request to ${url}`));
    }
    if ('throws' in reply) return Promise.reject(reply.throws);
    if ('hangs' in reply) {
      // Settles only when the caller aborts, like a stuck connection.
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) return;
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      });
    }
    if ('text' in reply) {
      return Promise.resolve(
        new Response(reply.text, {
          status: reply.status,
          headers: reply.headers,
        })
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(reply.json), {
        status: reply.status ?? 200,
        headers: { 'content-type': 'application/json', ...reply.headers },
      })
    );
  };
  return {
    fetch: Object.assign(impl, { preconnect: () => {} }),
    requests,
  };
}

/**
 * A fake clock: `sleep` records each wait, advances `now` by it and resolves
 * immediately; `advance` moves time forward as if work took that long.
 */
export function fakeSleep(): {
  sleep: (ms: number) => Promise<void>;
  waits: number[];
  now: () => number;
  advance: (ms: number) => void;
} {
  const waits: number[] = [];
  let clock = 1_000_000;
  return {
    sleep: (ms: number) => {
      waits.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    waits,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

export interface LogLine {
  level: 'info' | 'warn' | 'error';
  message: string;
  fields: Record<string, unknown> | undefined;
}

/** A logger that keeps every line, so tests can check levels and redaction. */
export function recordingLogger(): {
  logger: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
  };
  lines: LogLine[];
} {
  const lines: LogLine[] = [];
  return {
    logger: {
      info: (message, fields) => lines.push({ level: 'info', message, fields }),
      warn: (message, fields) => lines.push({ level: 'warn', message, fields }),
      error: (message, fields) =>
        lines.push({ level: 'error', message, fields }),
    },
    lines,
  };
}

export const LOOKUP_OK: FakeReply = {
  json: { ok: true, user: { id: 'U123', name: 'ana' } },
};

export const POST_OK: FakeReply = {
  json: { ok: true, channel: 'D456', ts: '1729500000.000100' },
};
