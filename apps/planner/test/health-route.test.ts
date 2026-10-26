import type { Engine } from '@better-tracker/engine';
import { afterAll, describe, expect, test } from 'bun:test';

import { GET } from '../app/api/health/route';

// GET /api/health (architecture §8.1): the engine boots and the store
// answers its ping (engine.ping(), 2026-10-25), else 503, never cached.

const holder = globalThis as typeof globalThis & {
  __milestonePlannerEngine?: Promise<Engine>;
};
const savedEngine = holder.__milestonePlannerEngine;

afterAll(() => {
  holder.__milestonePlannerEngine = savedEngine;
});

function engineWithPing(answer: boolean): Engine {
  return {
    ping: () => Promise.resolve(answer),
    listWorkspaceIds: () => Promise.reject(new Error('not the probe')),
  } as unknown as Engine;
}

describe('GET /api/health', () => {
  test('200 { ok, db } when the store answers the ping', async () => {
    holder.__milestonePlannerEngine = Promise.resolve(engineWithPing(true));
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: true, db: 'ok' });
  });

  test('503 when the ping says the database is gone', async () => {
    holder.__milestonePlannerEngine = Promise.resolve(engineWithPing(false));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ ok: false, db: 'error' });
  });

  test('503 when the engine cannot boot', async () => {
    holder.__milestonePlannerEngine = Promise.reject(new Error('no database'));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, db: 'error' });
  });
});
