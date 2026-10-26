import type { Engine } from '@better-tracker/engine';

import type { PublicFacts } from './adapters/public-pages';

const HOUR_MS = 3_600_000;

/**
 * What the public pages and the landing page's lines depend on, from the
 * engine's configuration and where a live digest goes now
 * (engine.digestChannel(): Slack only while a Slack channel is active and
 * the Slack fail-safe lets it carry digests). No session is read and
 * Linear is never called.
 */
export async function loadPublicFacts(engine: Engine): Promise<PublicFacts> {
  const { config } = engine;
  const mode =
    engine.mode === 'fixture' || config.auth === 'demo'
      ? 'demo'
      : config.auth === 'api_key'
        ? 'api_key'
        : 'oauth';
  const apiKey = mode === 'api_key' ? config.apiKey : null;
  return {
    appName: config.appName,
    mode,
    operator: config.operator ?? { name: null, email: null, url: null },
    demoUrl: config.demoUrl ?? null,
    sessionDays: config.sessionDays,
    slack: (await engine.digestChannel()) === 'slack',
    apiKeyHours:
      apiKey === null
        ? null
        : {
            idle: Math.round(apiKey.idleMs / HOUR_MS),
            max: Math.round(apiKey.absoluteMs / HOUR_MS),
          },
  };
}
