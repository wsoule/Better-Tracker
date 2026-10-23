// createEngineFromEnv (§7.1, §10): builds the same engine for the web app
// and the worker from environment variables. Demo mode (LINEAR_FIXTURE=1,
// or LINEAR_FIXTURE=showcase for the larger showcase workspace) runs
// entirely in memory over a fictional demo workspace; OAuth mode talks to
// Linear through stored OAuth tokens; api_key mode (LINEAR_AUTH=api_key,
// owner request 2026-10-23) through each person's own personal API key,
// held only in this process's memory over a credential-free store.

import {
  defaultSettings,
  type IsoDateTime,
  todayIn,
} from '@better-tracker/core';
import {
  createDemoStore,
  createLinearGateway,
  demoMilestoneMeta,
  type FetchLike,
  FIXTURE_APP_USER_ID,
  FIXTURE_INSTALLER_USER_ID,
  FIXTURE_MILESTONE_META,
  FIXTURE_WATCHER_USER_IDS,
  FIXTURE_WORKSPACE,
  type FixtureStore,
  type LinearGateway,
  LINEAR_GRAPHQL_ENDPOINT,
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
  apiKeyUnusedEnvVariables,
  DEFAULT_PGLITE_DIR,
  type EngineEnv,
  fixtureDatasetFromEnv,
  loadEngineConfigFromEnv,
  RETIRED_ENV_VARIABLES,
  retiredEnvVariables,
} from './config';
import { createEngine } from './engine';
import { bindingFor } from './key-auth';
import { createApiKeyLinearProvider } from './key-provider';
import {
  createKeySyncScheduler,
  type KeySyncScheduler,
  type KeySyncTimers,
} from './key-sync';
import { createKeyVault } from './key-vault';
import { createFixtureLinearProvider, createLinearProvider } from './providers';
import type { Engine, EngineConfig, LinearProvider } from './types';

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
  /** api_key mode: overrides process.execArgv for the flag check (tests). */
  execArgv?: readonly string[];
  /**
   * The process only migrates and never handles a key (the worker's
   * `migrate`): api_key mode then skips its deployed-only checks (the
   * workspace pin, an https APP_URL, the process flags).
   */
  migrateOnly?: boolean;
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
 * Seeds demo mode: the fake installation (acting as FIXTURE_APP_USER_ID,
 * installed by FIXTURE_INSTALLER_USER_ID), settings (watchers = the
 * fixture's watchers, dry run, preview) and the demo workspace's "done
 * means…"/weight meta (`milestoneMeta`, the base fixture's by default;
 * both demo workspaces share the installation, people and watchers), each
 * only where nothing is saved yet, then a full sync from the workspace.
 */
export async function seedDemoWorkspace(input: {
  engine: Engine;
  store: Store;
  defaultTimezone: string;
  now: () => Date;
  milestoneMeta?: readonly (typeof FIXTURE_MILESTONE_META)[number][];
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
    installedByUserId: FIXTURE_INSTALLER_USER_ID,
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
      watcherUserIds: [...FIXTURE_WATCHER_USER_IDS],
      allocationMode: 'dry_run',
      warningsMode: 'preview',
    });
  }
  const saved = new Set(
    (await store.listMilestoneMeta(workspaceId)).map((meta) => meta.milestoneId)
  );
  for (const meta of input.milestoneMeta ?? FIXTURE_MILESTONE_META) {
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
 * The api_key-mode engine over an open store (§2.3 step 4): the key vault,
 * the provider that reads keys from it, and the background sync scheduler,
 * wired so the vault's first entry starts the scheduler's timer and its
 * last one stops it. `apiKeyGateway` builds the gateway around a key
 * getter (the real GraphQL gateway at boot; the fixture in tests).
 */
export function createApiKeyEngine(input: {
  store: Store;
  config: EngineConfig;
  logger: Logger;
  now: () => Date;
  apiKeyGateway: (credential: () => string | null) => LinearGateway;
  channel?: NotificationChannel;
  /** Injected timers for the scheduler (tests); defaults to unref'd ones. */
  timers?: KeySyncTimers;
  fetch?: FetchLike;
}): Engine {
  const { config, store, logger } = input;
  const apiKey = config.apiKey;
  if (config.auth !== 'api_key' || apiKey === null) {
    throw new Error('createApiKeyEngine needs an api_key config');
  }
  const pin = apiKey.workspacePin;
  let scheduler: KeySyncScheduler | null = null;
  const vault = createKeyVault({
    idleMs: apiKey.idleMs,
    absoluteMs: apiKey.absoluteMs,
    now: () => input.now().getTime(),
    gateway: input.apiKeyGateway,
    onSizeChange: (size) => scheduler?.onSizeChange(size),
  });
  const linear = createApiKeyLinearProvider({
    vault,
    logger,
    appName: config.appName,
    binding: () => bindingFor(store, pin),
  });
  let engine: Engine | null = null;
  scheduler = createKeySyncScheduler({
    vault,
    intervalMs: apiKey.syncIntervalMs,
    now: () => input.now().getTime(),
    timers: input.timers,
    workspaceId: async () =>
      (await bindingFor(store, pin))?.workspaceId ?? null,
    runSync: (workspaceId) =>
      engine === null ? Promise.resolve() : engine.fullSync(workspaceId),
    logger,
  });
  engine = createEngine({
    store,
    linear,
    // Digests are off with personal keys: the outbox only.
    channel: input.channel ?? createOutboxChannel(),
    logger,
    config,
    now: input.now,
    fetch: input.fetch,
    keys: { vault, scheduler },
    apiKeyGateway: input.apiKeyGateway,
  });
  return engine;
}

// The api_key-mode boot (§2.3): warnings for unused variables, the
// credential-free store, migrations (nothing is purged), then the engine.
async function createApiKeyEngineFromEnv(
  env: EngineEnv,
  config: EngineConfig,
  options: CreateEngineFromEnvOptions,
  logger: Logger,
  now: () => Date
): Promise<Engine> {
  const apiKey = config.apiKey;
  if (apiKey === null) throw new Error('api_key config is missing');
  for (const variable of apiKeyUnusedEnvVariables(env)) {
    logger.warn(`${variable} is unused when LINEAR_AUTH=api_key`, {
      variable,
    });
  }
  if (apiKey.endpoint !== LINEAR_GRAPHQL_ENDPOINT) {
    logger.error(
      `LINEAR_API_URL is set: Linear keys go to ${new URL(apiKey.endpoint).origin}, a local test server`
    );
  }
  const databaseUrl = read(env, 'DATABASE_URL');
  const pgliteDir = read(env, 'PGLITE_DIR') ?? DEFAULT_PGLITE_DIR;
  if (apiKey.deployed && databaseUrl === undefined) {
    // A container's disk is replaced on every deploy (Railway): the keys
    // are meant to go, but the planner's own data is not.
    logger.warn(
      `PGlite at ${pgliteDir} on a deployed planner: unless that directory is on a volume, every deploy erases the settings, weights, "done means…" and the audit log; set DATABASE_URL`,
      { pgliteDir }
    );
  }
  // The credential-free store: TOKEN_ENCRYPTION_KEY is never passed, so
  // nothing in it can be decrypted and no token can be written.
  const store = await openStore({
    databaseUrl,
    pgliteDir,
    encryptionKey: null,
    logger,
    now,
  });
  try {
    await store.migrate();
    const endpoint = apiKey.endpoint;
    const engine = createApiKeyEngine({
      store,
      config,
      logger,
      now,
      channel: options.channel,
      fetch: options.fetch,
      apiKeyGateway: (credential) =>
        createLinearGateway({
          apiKey: credential,
          endpoint,
          fetch: options.fetch,
          logger,
        }),
    });
    logger.info('engine ready', {
      mode: engine.mode,
      auth: 'api_key',
      deployed: apiKey.deployed,
      pinned: apiKey.workspacePin !== null,
      appUrl: config.appUrl,
    });
    return engine;
  } catch (error) {
    await store.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Opens the store, runs migrations and returns a ready engine. Throws one
 * Error listing every configuration problem before touching anything.
 */
export async function createEngineFromEnv(
  env: EngineEnv,
  options: CreateEngineFromEnvOptions = {}
): Promise<Engine> {
  const config = loadEngineConfigFromEnv(env, {
    execArgv: options.execArgv,
    migrateOnly: options.migrateOnly,
  });
  const dataset = fixtureDatasetFromEnv(env);
  const fixture = dataset !== null;
  const now = options.now ?? ((): Date => new Date());
  const logger =
    options.logger ?? createLogger({ name: 'engine', level: logLevel(env) });
  // One warning per retired variable a deploy still sets (PM_EMAILS).
  for (const variable of retiredEnvVariables(env)) {
    logger.warn(RETIRED_ENV_VARIABLES[variable] ?? `${variable} is unused`, {
      variable,
    });
  }
  if (config.auth === 'api_key') {
    return createApiKeyEngineFromEnv(env, config, options, logger, now);
  }

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
    if (dataset !== null) {
      const fixtureStore: FixtureStore = createDemoStore(
        todayIn(config.defaultTimezone, now()),
        dataset
      );
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
    if (dataset !== null) {
      await seedDemoWorkspace({
        engine,
        store,
        defaultTimezone: config.defaultTimezone,
        now,
        milestoneMeta: demoMilestoneMeta(dataset),
      });
    }
    logger.info('engine ready', {
      mode: engine.mode,
      ...(dataset === null ? {} : { demoWorkspace: dataset }),
      channel: channel.name,
      appUrl: config.appUrl,
    });
    return engine;
  } catch (error) {
    await store.close().catch(() => undefined);
    throw error;
  }
}
