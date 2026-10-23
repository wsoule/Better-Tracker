// The in-memory key vault (api_key mode, architecture §7 "API-key mode"),
// on a fake clock. Keys are obviously fake (TESTKEY).

import type { LinearGateway } from '@better-tracker/linear';
import { describe, expect, test } from 'bun:test';
import { inspect } from 'node:util';

import {
  createKeyVault,
  type KeyVault,
  VaultFullError,
} from '../src/key-vault';

const MEMBER = 'lin_api_TESTKEY_member_q7Wz3Kp9Vx2Lm8Rt5Yb1Nc';
const SECOND = 'lin_api_TESTKEY_second_f2Jg8Qs4Wn7Xc1Zv5Bk9Mp';
const GUEST = 'lin_api_TESTKEY_guest_m3Nb6Vq1Yt8Ke4Xa9Pu2Ws7';
const IDLE = 1_000;
const MAX = 10_000;

interface Harness {
  vault: KeyVault;
  clock: { ms: number };
  getters: (() => string | null)[];
  sizes: number[];
}

function harness(
  options: { maxSessions?: number; maxPerUser?: number; maxEnded?: number } = {}
): Harness {
  const clock = { ms: 1_000_000 };
  const getters: (() => string | null)[] = [];
  const sizes: number[] = [];
  const vault = createKeyVault({
    idleMs: IDLE,
    absoluteMs: MAX,
    now: () => clock.ms,
    gateway: (credential) => {
      getters.push(credential);
      return {
        whoAmI: () => Promise.reject(new Error('unused')),
      } as unknown as LinearGateway;
    },
    onSizeChange: (size) => sizes.push(size),
    ...options,
  });
  return { vault, clock, getters, sizes };
}

function add(
  h: Harness,
  apiKey: string,
  userId: string,
  extra: { guest?: boolean; workspaceId?: string } = {}
): { token: string; id: string } {
  const { token, session } = h.vault.add({
    apiKey,
    workspaceId: extra.workspaceId ?? 'ws-1',
    userId,
    userName: `Name ${userId}`,
    guest: extra.guest ?? false,
  });
  return { token, id: session.id };
}

describe('createKeyVault', () => {
  test('add returns a 43-character token that use() finds; nothing else does', () => {
    const h = harness();
    const { token, id } = add(h, MEMBER, 'u-ana');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(h.vault.use(token)?.userId).toBe('u-ana');
    expect(h.vault.use(`${token}x`)).toBeNull();
    expect(h.vault.use(id)).toBeNull();
    expect(h.vault.use('')).toBeNull();
  });

  test('idle expiry: a use just before the limit keeps it, then silence drops it', () => {
    const h = harness();
    const { token, id } = add(h, MEMBER, 'u-ana');
    h.clock.ms += IDLE - 1;
    expect(h.vault.use(token)).not.toBeNull();
    h.clock.ms += IDLE;
    expect(h.vault.peek(id)).toBeNull();
    expect(h.vault.use(token)).toBeNull();
  });

  test('absolute expiry drops it even with steady use', () => {
    const h = harness();
    const { token } = add(h, MEMBER, 'u-ana');
    const start = h.clock.ms;
    while (h.clock.ms + IDLE / 2 < start + MAX) {
      h.clock.ms += IDLE / 2;
      expect(h.vault.use(token)).not.toBeNull();
    }
    h.clock.ms = start + MAX;
    expect(h.vault.use(token)).toBeNull();
  });

  test('peek, gateway and the getter never touch lastUsed', () => {
    const h = harness();
    const { token, id } = add(h, MEMBER, 'u-ana');
    const before = h.vault.peek(id)?.lastUsedAtMs;
    h.clock.ms += IDLE - 10;
    h.vault.peek(id);
    h.vault.gateway(id);
    h.getters[0]?.();
    expect(h.vault.peek(id)?.lastUsedAtMs).toBe(before);
    h.clock.ms += 10;
    expect(h.vault.use(token)).toBeNull();
  });

  test('the getter returns the stored key, then null once it is forgotten', () => {
    const h = harness();
    const { token, id } = add(h, MEMBER, 'u-ana');
    expect(h.vault.gateway(id)).not.toBeNull();
    const getter = h.getters[0];
    expect(getter?.()).toBe(MEMBER);
    h.vault.removeByToken(token);
    expect(getter?.()).toBeNull();
    const calls = h.getters.length;
    expect(h.vault.gateway(id)).toBeNull();
    expect(h.getters.length).toBe(calls);

    const other = add(h, SECOND, 'u-ben');
    h.vault.gateway(other.id);
    const second = h.getters.at(-1);
    h.clock.ms += IDLE;
    expect(second?.()).toBeNull();
    expect(h.vault.gateway(other.id)).toBeNull();
  });

  test('sweep drops expired entries and reports sizes', () => {
    const h = harness();
    add(h, MEMBER, 'u-ana');
    add(h, SECOND, 'u-ben');
    h.clock.ms += IDLE;
    expect(h.vault.sweep()).toBe(2);
    expect(h.vault.count()).toBe(0);
    expect(h.sizes).toEqual([1, 2, 0]);
  });

  test('removeByToken, forgetPerson, remove and clear', () => {
    const h = harness();
    const a1 = add(h, MEMBER, 'u-ana');
    const a2 = add(h, MEMBER, 'u-ana');
    const b = add(h, SECOND, 'u-ben');
    const aOther = add(h, MEMBER, 'u-ana', { workspaceId: 'ws-2' });
    expect(h.vault.removeByToken(a1.token)).toBe(true);
    expect(h.vault.removeByToken(a1.token)).toBe(false);
    const a3 = add(h, MEMBER, 'u-ana');
    expect(h.vault.forgetPerson(a3.token)).toEqual({
      person: { workspaceId: 'ws-1', userId: 'u-ana' },
      dropped: 2,
    });
    expect(h.vault.forgetPerson('no-such-token')).toEqual({
      person: null,
      dropped: 0,
    });
    expect(h.vault.peek(a2.id)).toBeNull();
    expect(h.vault.peek(b.id)).not.toBeNull();
    expect(h.vault.peek(aOther.id)).not.toBeNull();
    expect(h.vault.remove(b.id)).toBe(true);
    expect(h.vault.count()).toBe(1);
    h.vault.clear();
    expect(h.vault.count()).toBe(0);
    expect(h.sizes.at(-1)).toBe(0);
  });

  test("a stale browser's sign-out still finds its person: idle, time limit, evicted, swept", () => {
    // Idle: the laptop goes quiet while the phone stays in use.
    const h = harness();
    const laptop = add(h, MEMBER, 'u-ana');
    h.clock.ms += IDLE / 2;
    const phone = add(h, MEMBER, 'u-ana');
    const ben = add(h, SECOND, 'u-ben');
    h.clock.ms += IDLE / 2 + 1;
    expect(h.vault.use(phone.token)).not.toBeNull();
    expect(h.vault.use(laptop.token)).toBeNull();
    expect(h.vault.forgetPerson(laptop.token)).toEqual({
      person: { workspaceId: 'ws-1', userId: 'u-ana' },
      dropped: 1,
    });
    expect(h.vault.peek(phone.id)).toBeNull();
    expect(h.vault.peek(ben.id)).not.toBeNull();

    // Swept (the background timer) before the click: the same.
    const s = harness();
    const old = add(s, MEMBER, 'u-ana');
    s.clock.ms += IDLE / 2;
    const fresh = add(s, MEMBER, 'u-ana');
    s.clock.ms += IDLE / 2 + 1;
    expect(s.vault.sweep()).toBe(1);
    expect(s.vault.forgetPerson(old.token).dropped).toBe(1);
    expect(s.vault.peek(fresh.id)).toBeNull();

    // The absolute limit, with the laptop in steady use.
    const a = harness();
    const steady = add(a, MEMBER, 'u-ana');
    const start = a.clock.ms;
    let late: { token: string; id: string } | null = null;
    while (a.clock.ms + IDLE / 2 < start + MAX) {
      a.clock.ms += IDLE / 2;
      a.vault.use(steady.token);
      if (late === null && a.clock.ms >= start + MAX / 2) {
        late = add(a, MEMBER, 'u-ana');
      }
      if (late !== null) a.vault.use(late.token);
    }
    a.clock.ms = start + MAX;
    expect(a.vault.use(steady.token)).toBeNull();
    expect(a.vault.forgetPerson(steady.token).dropped).toBe(1);
    expect(late === null ? null : a.vault.peek(late.id)).toBeNull();

    // Evicted by the per-person cap (the sixth connect).
    const e = harness({ maxPerUser: 2 });
    const first = add(e, MEMBER, 'u-ana');
    e.clock.ms += 1;
    const second = add(e, MEMBER, 'u-ana');
    e.clock.ms += 1;
    const third = add(e, MEMBER, 'u-ana');
    expect(e.vault.use(first.token)).toBeNull();
    expect(e.vault.forgetPerson(first.token).dropped).toBe(2);
    expect(e.vault.peek(second.id)).toBeNull();
    expect(e.vault.peek(third.id)).toBeNull();
  });

  test('the record of whose a connection was ends with the time limit, the cap and clear', () => {
    const h = harness();
    const gone = add(h, MEMBER, 'u-ana');
    h.clock.ms += IDLE;
    expect(h.vault.sweep()).toBe(1);
    expect(h.vault.endedCount()).toBe(1);
    h.clock.ms += MAX;
    const later = add(h, MEMBER, 'u-ana');
    expect(h.vault.endedCount()).toBe(0);
    expect(h.vault.forgetPerson(gone.token)).toEqual({
      person: null,
      dropped: 0,
    });
    expect(h.vault.peek(later.id)).not.toBeNull();

    // Signed out on purpose: no record (the cookie is cleared with it).
    expect(h.vault.removeByToken(later.token)).toBe(true);
    expect(h.vault.endedCount()).toBe(0);

    const capped = harness({ maxEnded: 3, maxPerUser: 1 });
    const tokens: string[] = [];
    for (let i = 0; i < 6; i++) {
      tokens.push(add(capped, MEMBER, 'u-ana').token);
      capped.clock.ms += 1;
    }
    expect(capped.vault.endedCount()).toBe(3);
    expect(capped.vault.forgetPerson(tokens[0] ?? '').person).toBeNull();
    expect(capped.vault.forgetPerson(tokens[4] ?? '').dropped).toBe(1);
    capped.vault.clear();
    expect(capped.vault.endedCount()).toBe(0);
  });

  test('markGuest takes every entry of that person off the readers', () => {
    const h = harness();
    const ana = add(h, MEMBER, 'u-ana');
    add(h, MEMBER, 'u-ana');
    h.clock.ms += 1;
    add(h, SECOND, 'u-ben');
    expect(h.vault.readers('ws-1').map((r) => r.userId)).toEqual([
      'u-ana',
      'u-ana',
      'u-ben',
    ]);
    expect(h.vault.markGuest('ws-1', 'u-ana')).toBe(2);
    expect(h.vault.markGuest('ws-1', 'u-ana')).toBe(0);
    expect(h.vault.readers('ws-1').map((r) => r.userId)).toEqual(['u-ben']);
    expect(h.vault.peek(ana.id)?.guest).toBe(true);
  });

  test('caps: the vault is full at maxSessions; a user keeps maxPerUser', () => {
    const h = harness();
    for (let i = 0; i < 200; i++) add(h, MEMBER, `u-${i}`);
    expect(() => add(h, MEMBER, 'u-extra')).toThrow(VaultFullError);

    const p = harness();
    const first = add(p, MEMBER, 'u-ana');
    for (let i = 0; i < 4; i++) {
      p.clock.ms += 1;
      add(p, MEMBER, 'u-ana');
    }
    expect(p.vault.count()).toBe(5);
    p.clock.ms += 1;
    add(p, MEMBER, 'u-ana');
    expect(p.vault.count()).toBe(5);
    expect(p.vault.peek(first.id)).toBeNull();
  });

  test('readers: members only, preferred user first, then connect time, then id', () => {
    const h = harness();
    add(h, GUEST, 'u-gus', { guest: true });
    h.clock.ms += 1;
    const ben = add(h, SECOND, 'u-ben');
    h.clock.ms += 1;
    const ana = add(h, MEMBER, 'u-ana');
    expect(h.vault.readers('ws-1').map((r) => r.userId)).toEqual([
      'u-ben',
      'u-ana',
    ]);
    expect(
      h.vault.readers('ws-1', { preferUserId: 'u-ana' }).map((r) => r.id)
    ).toEqual([ana.id, ben.id]);
    expect(h.vault.readers('ws-2')).toEqual([]);
  });

  test('markWriteRefused shows in peek', () => {
    const h = harness();
    const { id } = add(h, MEMBER, 'u-ana');
    expect(h.vault.peek(id)?.writeRefused).toBe(false);
    h.vault.markWriteRefused(id);
    expect(h.vault.peek(id)?.writeRefused).toBe(true);
  });

  test('nothing the vault returns serialises a key', () => {
    const h = harness();
    const { token, id } = add(h, MEMBER, 'u-ana');
    const session = h.vault.use(token);
    const gateway = h.vault.gateway(id);
    const values: unknown[] = [
      h.vault,
      session,
      h.vault.peek(id),
      h.vault.readers('ws-1'),
      gateway,
    ];
    for (const value of values) {
      const texts = [
        JSON.stringify(value) ?? '',
        inspect(value, { showHidden: true, depth: Infinity }),
        String(
          typeof value === 'object' && value !== null
            ? Object.getOwnPropertyNames(value).map((name) =>
                String((value as Record<string, unknown>)[name])
              )
            : value
        ),
      ];
      for (const text of texts) expect(text).not.toContain('TESTKEY');
    }
    const clone = structuredClone(session);
    expect(clone?.userId).toBe('u-ana');
    expect(JSON.stringify(clone)).not.toContain('TESTKEY');
    expect(Object.isFrozen(session)).toBe(true);
  });
});
