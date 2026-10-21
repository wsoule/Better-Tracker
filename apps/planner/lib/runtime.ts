import { createEngineFromEnv, type Engine } from '@better-tracker/engine';

// One engine per server process. Cached on globalThis because Next dev
// re-evaluates modules on every edit; without this each reload would open a
// new database pool (or, with PGlite, fight over the same data directory).
const holder = globalThis as typeof globalThis & {
  __milestonePlannerEngine?: Promise<Engine>;
};

/** The process-wide engine: store opened and migrated on first use. */
export function getEngine(): Promise<Engine> {
  holder.__milestonePlannerEngine ??= createEngineFromEnv(process.env).catch(
    (error: unknown) => {
      // Do not cache a failed boot; the next request retries.
      holder.__milestonePlannerEngine = undefined;
      throw error;
    }
  );
  return holder.__milestonePlannerEngine;
}
