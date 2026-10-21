// createEngineFromEnv (§7.1, §10): builds the same engine for the web app
// and the worker from environment variables. Demo mode (LINEAR_FIXTURE=1)
// runs entirely in memory over the fictional fixture workspace; real mode
// talks to Linear through stored OAuth tokens.

import {
  defaultSettings,
  type IsoDateTime,
  todayIn,
} from '@better-tracker/core';
import {
  createFixtureStore,
  type FetchLike,
  FIXTURE_APP_USER_ID,
  FIXTURE_MILESTONE_META,
  FIXTURE_PM_USER_IDS,
  FIXTURE_WORKSPACE,
  type FixtureStore,
} from '@better-tracker/linear';
import {
  createLogger,
  type Logger,
  type LogLevel,
} from '@better-tracker/logger';
import {
  createOutboxChannel,
  createSlackChannel,
  type NotificationChannel,
} from '@better-tracker/notify';
import { openStore, type Store } from '@better-tracker/store';
import { randomBytes } from 'node:crypto';

import {
  DEFAULT_PGLITE_DIR,
  type EngineEnv,
  isFixtureEnv,
  loadEngineConfigFromEnv,
} from './config';
import { createEngine } from './engine';
import { createFixtureLinearProvider, createLinearProvider } from './providers';
import type { Engine, LinearProvider } from './types';

/** Optional injections for createEngineFromEnv (worker logger, tests). */
export interface CreateEngineFromEnvOptions {
  /** Defaults to a JSON logger named `engine` at LOG_LEVEL. */
  logger?: Logger;
  /** Clock for the engine, the store and the fixture workspace. */
  now?: () => Date;
  /** fetch for Linear and OAuth calls; defaults to the global fetch. */
  fetch?: FetchLike;
  /** Overrides the channel chosen from SLACK_BOT_TOKEN. */
  channel?: NotificationChannel;
}

// The env's LOG_LEVEL when it names a level (already validated).
function logLevel(env: EngineEnv): LogLevel | undefined {
  const value = env['LOG_LEVEL']?.trim();
  return value === 'debug' ||
    value === 'info' ||
    value === 'warn' ||
    value === 'error'
    ? value
    : undefined;
}

function read(env: EngineEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Seeds demo mode: the fake installation (acting as FIXTURE_APP_USER_ID),
 * settings (PMs and watchers = the fixture PMs, dry run, preview) and the
 * fixture's "done means…"/weight meta, each only where nothing is saved
 * yet, then a full sync from the fixture workspace.
 */
export async function seedDemoWorkspace(input: {
  engine: Engine;
  store: Store;
  defaultTimezone: string;
  now: () => Date;
}): Promise<void> {
  const { store } = input;
  const workspaceId = FIXTURE_WORKSPACE.id;
  const at: IsoDateTime = input.now().toISOString();
  // An earlier boot over the same PGLITE_DIR may have encrypted the row
  // with another ephemeral key; it is overwritten below either way.
  const existing = await store.getInstallation(workspaceId).catch(() => null);
  await store.saveInstallation({
    workspaceId,
    workspaceName: FIXTURE_WORKSPACE.name,
    urlKey: FIXTURE_WORKSPACE.urlKey,
    appUserId: FIXTURE_APP_USER_ID,
    installedByUserId: FIXTURE_PM_USER_IDS[0] ?? 'user-ana',
    revokedAt: null,
    tokens: {
      accessToken: 'fixture',
      refreshToken: null,
      expiresAt: null,
      scopes: ['read', 'write'],
    },
    createdAt: existing?.createdAt ?? at,
    updatedAt: at,
  });
  if ((await store.getSettings(workspaceId)) === null) {
    await store.saveSettings({
      ...defaultSettings(workspaceId, input.defaultTimezone),
      pmUserIds: [...FIXTURE_PM_USER_IDS],
      watcherUserIds: [...FIXTURE_PM_USER_IDS],
      allocationMode: 'dry_run',
      warningsMode: 'preview',
    });
  }
  const saved = new Set(
    (await store.listMilestoneMeta(workspaceId)).map((meta) => meta.milestoneId)
  );
  for (const meta of FIXTURE_MILESTONE_META) {
    if (saved.has(meta.milestoneId)) continue;
    await store.upsertMilestoneMeta(workspaceId, {
      milestoneId: meta.milestoneId,
      weight: meta.weight,
      doneMeans: meta.doneMeans,
      updatedAt: at,
      updatedBy: null,
    });
  }
  await input.engine.fullSync(workspaceId);
}

/**
 * Opens the store, runs migrations and returns a ready engine. Throws one
 * Error listing every configuration problem before touching anything.
 */
export async function createEngineFromEnv(
  env: EngineEnv,
  options: CreateEngineFromEnvOptions = {}
): Promise<Engine> {
  const config = loadEngineConfigFromEnv(env);
  const fixture = isFixtureEnv(env);
  const now = options.now ?? ((): Date => new Date());
  const logger =
    options.logger ?? createLogger({ name: 'engine', level: logLevel(env) });

  const providedKey = read(env, 'TOKEN_ENCRYPTION_KEY');
  // Demo tokens are fake, so an ephemeral key is fine there.
  const encryptionKey = providedKey ?? randomBytes(32).toString('base64');
  const pgliteDir = read(env, 'PGLITE_DIR');
  const store = await openStore({
    // Demo data never goes to a real database.
    databaseUrl: fixture ? undefined : read(env, 'DATABASE_URL'),
    pgliteDir: fixture ? pgliteDir : (pgliteDir ?? DEFAULT_PGLITE_DIR),
    encryptionKey,
    logger,
    now,
  });

  try {
    await store.migrate();
    let linear: LinearProvider;
    let fixtureStore: FixtureStore | null = null;
    if (fixture) {
      fixtureStore = createFixtureStore(todayIn(config.defaultTimezone, now()));
      fixtureStore.now = now;
      linear = createFixtureLinearProvider(fixtureStore);
      if (providedKey === undefined && pgliteDir !== undefined) {
        // Sessions saved by an earlier boot were encrypted with another
        // ephemeral key and can no longer be read; drop them all.
        await store.deleteExpiredSessions('9999-12-31T23:59:59.999Z');
      }
    } else {
      if (config.oauth === null) {
        throw new Error(
          'LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET are required'
        );
      }
      linear = createLinearProvider({
        store,
        oauth: config.oauth,
        logger,
        now,
        fetch: options.fetch,
        appName: config.appName,
      });
    }

    const slackToken = read(env, 'SLACK_BOT_TOKEN');
    const channel =
      options.channel ??
      (!fixture && slackToken !== undefined
        ? createSlackChannel({ botToken: slackToken, logger })
        : createOutboxChannel());

    const engine = createEngine({
      store,
      linear,
      channel,
      logger,
      config,
      now,
      fetch: options.fetch,
    });
    if (fixtureStore !== null) {
      await seedDemoWorkspace({
        engine,
        store,
        defaultTimezone: config.defaultTimezone,
        now,
      });
    }
    logger.info('engine ready', {
      mode: engine.mode,
      channel: channel.name,
      appUrl: config.appUrl,
    });
    return engine;
  } catch (error) {
    await store.close().catch(() => undefined);
    throw error;
  }
}
