// Test harness: engines over in-memory PGlite and the fixture workspace,
// with an adjustable clock, a recording notification channel, a recording
// logger, and hooks to wrap the gateways the engine receives.

import type { Digest, IsoDate, Issue } from '@better-tracker/core';
import { todayIn } from '@better-tracker/core';
import {
  createFixtureGateway,
  createFixtureStore,
  FIXTURE_WORKSPACE,
  type FixtureStore,
  type LinearGateway,
} from '@better-tracker/linear';
import { createLogger, type Logger } from '@better-tracker/logger';
import type {
  DeliveryResult,
  NotificationChannel,
} from '@better-tracker/notify';
import { openStore, type Session, type Store } from '@better-tracker/store';
import { setDefaultTimeout } from 'bun:test';

import { seedDemoWorkspace } from '../src/boot';
import { createEngine } from '../src/engine';
import type { Actor, Engine, EngineConfig, LinearProvider } from '../src/types';

// Opening and migrating a PGlite instance takes 1–2 s.
setDefaultTimeout(60_000);

/** A valid TOKEN_ENCRYPTION_KEY (32 bytes, base64). */
export const TEST_KEY: string = Buffer.alloc(32, 9).toString('base64');
export const WORKSPACE_ID: string = FIXTURE_WORKSPACE.id;
/** 15:00 UTC on the fixed test day. */
export const START: string = '2026-10-21T15:00:00.000Z';

export interface TestClock {
  now: () => Date;
  set(iso: string): void;
  advanceDays(days: number): void;
  today(): IsoDate;
}

export function createClock(start: string = START): TestClock {
  let ms = Date.parse(start);
  return {
    now: () => new Date(ms),
    set(iso: string) {
      ms = Date.parse(iso);
    },
    advanceDays(days: number) {
      ms += days * 86_400_000;
    },
    today: () => todayIn('UTC', new Date(ms)),
  };
}

/** A channel that records every digest it is asked to send. */
export function recordingChannel(
  options: {
    delivers?: boolean;
    result?: (digest: Digest) => DeliveryResult;
  } = {}
): NotificationChannel & { sent: Digest[] } {
  const sent: Digest[] = [];
  return {
    name: 'slack',
    delivers: options.delivers ?? true,
    sent,
    send(digest: Digest): Promise<DeliveryResult> {
      sent.push(digest);
      return Promise.resolve(
        options.result?.(digest) ?? {
          status: 'sent',
          channel: 'slack',
          detail: null,
        }
      );
    },
  };
}

/** A logger that keeps every JSON line it writes. */
export function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return {
    logger: createLogger({
      name: 'engine-test',
      level: 'debug',
      sink: (_level, line) => {
        lines.push(line);
      },
    }),
    lines,
  };
}

export const TEST_CONFIG: EngineConfig = {
  appName: 'Milestone Planner',
  appUrl: 'https://planner.example',
  defaultTimezone: 'UTC',
  bootstrapPmEmails: [],
  bootstrapWatcherEmails: [],
  oauth: null,
  sessionDays: 30,
};

export async function openTestStore(clock: TestClock): Promise<Store> {
  const store = await openStore({ encryptionKey: TEST_KEY, now: clock.now });
  await store.migrate();
  return store;
}

export type GatewayWrapper = (
  gateway: LinearGateway,
  actor: 'app' | { userId: string }
) => LinearGateway;

/**
 * A provider over `fixture`. mode 'linear' makes the engine behave as if
 * it talked to real Linear (webhooks are processed) while still serving
 * the in-memory workspace.
 */
export function fixtureProvider(
  fixture: FixtureStore,
  options: { mode?: 'linear' | 'fixture'; wrap?: GatewayWrapper } = {}
): LinearProvider {
  const wrap: GatewayWrapper = options.wrap ?? ((gateway) => gateway);
  return {
    mode: options.mode ?? 'fixture',
    forApp: (workspaceId: string) => {
      if (workspaceId !== fixture.data.workspaceId) {
        return Promise.reject(new Error(`unexpected workspace ${workspaceId}`));
      }
      return Promise.resolve(
        wrap(createFixtureGateway(fixture, { kind: 'app' }), 'app')
      );
    },
    forSession: (session: Session) =>
      Promise.resolve(
        wrap(
          createFixtureGateway(fixture, {
            kind: 'user',
            userId: session.userId,
          }),
          {
            userId: session.userId,
          }
        )
      ),
  };
}

export interface DemoHarness {
  engine: Engine;
  store: Store;
  fixture: FixtureStore;
  clock: TestClock;
  channel: NotificationChannel & { sent: Digest[] };
  logs: string[];
  close(): Promise<void>;
}

/**
 * A seeded demo engine (installation, settings, fixture meta, first full
 * sync) over a fresh PGlite store and fixture workspace dated around the
 * clock's today.
 */
export async function createDemoHarness(
  options: {
    mode?: 'linear' | 'fixture';
    wrap?: GatewayWrapper;
    channel?: NotificationChannel & { sent: Digest[] };
    clock?: TestClock;
  } = {}
): Promise<DemoHarness> {
  const clock = options.clock ?? createClock();
  const store = await openTestStore(clock);
  const fixture = createFixtureStore(clock.today());
  fixture.now = clock.now;
  const channel = options.channel ?? recordingChannel();
  const { logger, lines } = recordingLogger();
  const engine = createEngine({
    store,
    linear: fixtureProvider(fixture, {
      mode: options.mode,
      wrap: options.wrap,
    }),
    channel,
    logger,
    config: TEST_CONFIG,
    now: clock.now,
  });
  await seedDemoWorkspace({
    engine,
    store,
    defaultTimezone: 'UTC',
    now: clock.now,
  });
  return {
    engine,
    store,
    fixture,
    clock,
    channel,
    logs: lines,
    close: () => store.close(),
  };
}

/**
 * A signed-in Actor for a fixture user. In fixture mode this goes through
 * devSignIn + authenticate; in 'linear' mode the session is created
 * directly (there is no OAuth in tests) and authenticated.
 */
export async function actorFor(
  harness: DemoHarness,
  userId: string
): Promise<Actor> {
  let token: string;
  if (harness.engine.mode === 'fixture') {
    token = (await harness.engine.devSignIn(userId)).sessionToken;
  } else {
    const user = harness.fixture.data.users.find((u) => u.id === userId);
    token = (
      await harness.store.createSession({
        workspaceId: WORKSPACE_ID,
        userId,
        userName: user?.name ?? userId,
        tokens: {
          accessToken: `user-token-${userId}`,
          refreshToken: null,
          expiresAt: null,
          scopes: ['read', 'write'],
        },
        expiresAt: '2099-01-01T00:00:00.000Z',
      })
    ).token;
  }
  const actor = await harness.engine.authenticate(token);
  if (actor === null) throw new Error(`could not sign in ${userId}`);
  return actor;
}

/**
 * `base` with some methods replaced: every other member is forwarded to the
 * real store (bound to it), so a test can make one call misbehave or wait.
 */
export function storeWith(base: Store, overrides: Partial<Store>): Store {
  return new Proxy(base, {
    get(target, prop) {
      if (typeof prop === 'string' && Object.hasOwn(overrides, prop)) {
        return overrides[prop as keyof Store];
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}

/** The fixture issue with `id`, or a thrown error. */
export function fixtureIssue(fixture: FixtureStore, id: string): Issue {
  const issue = fixture.data.issues.find((i) => i.id === id);
  if (issue === undefined) throw new Error(`no fixture issue ${id}`);
  return issue;
}

/** The error a promise rejects with; fails the test if it resolves. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject, but it resolved');
}

/** The message of the error a promise rejects with. */
export async function rejectionMessage(
  promise: Promise<unknown>
): Promise<string> {
  const error = await rejection(promise);
  return error instanceof Error ? error.message : String(error);
}
