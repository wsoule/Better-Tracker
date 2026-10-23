// The key vault (LINEAR_AUTH=api_key, owner request 2026-10-23,
// architecture §7 "API-key mode"): the only place a person's personal
// Linear API key lives, in this process's memory and nowhere else. A
// connected person is an entry reached by the SHA-256 of their cookie
// token; the key itself sits in a separate map that only `liveKey` reads,
// so no entry, VaultSession or anything handed out ever references it.
// Gateways get the key through a getter they call before every request
// (the linear client's `apiKey`), so forgetting an entry stops every
// gateway built for it at its next attempt. Entries end on sign-out, after
// API_KEY_IDLE_MS without a person's own request, API_KEY_MAX_MS after
// connecting, and with the process (restart, redeploy): nothing persists.
// A connection that ends on its own (expiry, or the per-person cap) leaves
// a key-free record of whose it was, so signing out from that stale
// browser still forgets the person's other browsers (forgetPerson).
// Not exported from the engine's index, so the planner cannot reach it.

import type { LinearGateway } from '@better-tracker/linear';
import { generateSessionToken, hashSessionToken } from '@better-tracker/store';
import { randomBytes } from 'node:crypto';

/** A connected key is forgotten after this long without the person's own request. */
export const API_KEY_IDLE_MS: number = 2 * 3_600_000;
/** A connected key is forgotten this long after connecting, whatever the activity. */
export const API_KEY_MAX_MS: number = 12 * 3_600_000;
/** Live entries the vault holds at most (VaultFullError beyond). */
export const DEFAULT_VAULT_MAX_SESSIONS = 200;
/** Entries one person may hold; a further connect evicts their oldest. */
export const DEFAULT_VAULT_MAX_PER_USER = 5;
/** Ended-connection records the vault keeps at most (the oldest go first). */
export const DEFAULT_VAULT_MAX_ENDED = 2_000;

export interface KeyVaultOptions {
  idleMs: number;
  absoluteMs: number;
  /** Epoch ms (the engine's clock). */
  now: () => number;
  /** Builds a gateway around a credential getter; the only consumer of keys. */
  gateway: (credential: () => string | null) => LinearGateway;
  /** Default DEFAULT_VAULT_MAX_SESSIONS. */
  maxSessions?: number;
  /** Default DEFAULT_VAULT_MAX_PER_USER; the oldest is evicted. */
  maxPerUser?: number;
  /** Default DEFAULT_VAULT_MAX_ENDED. */
  maxEnded?: number;
  /** Called whenever the number of entries changes (starts/stops key-sync's timer). */
  onSizeChange?: (size: number) => void;
}

/** A connected person, without the key. Frozen plain data. */
export interface VaultSession {
  /** Internal id (Session.id), never the cookie. */
  readonly id: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly userName: string;
  /** Linear's viewer.guest when they connected. */
  readonly guest: boolean;
  readonly connectedAtMs: number;
  /** connectedAt + the absolute limit. */
  readonly expiresAtMs: number;
  readonly lastUsedAtMs: number;
  /** Linear refused one of this key's writes as out of its scope. */
  readonly writeRefused: boolean;
}

export interface KeyVault {
  /** Stores the key; returns the cookie token and the session. Throws VaultFullError. */
  add(input: {
    apiKey: string;
    workspaceId: string;
    userId: string;
    userName: string;
    guest: boolean;
  }): { token: string; session: VaultSession };
  /** By cookie token: drops it if expired, else touches lastUsed. */
  use(token: string): VaultSession | null;
  /** By internal id, without touching (background work, status). */
  peek(sessionId: string): VaultSession | null;
  /**
   * A gateway acting with that session's key, or null when it is gone or
   * expired. The gateway reads the key through a getter before each
   * request, so it stops working the moment the entry is forgotten.
   */
  gateway(sessionId: string): LinearGateway | null;
  markWriteRefused(sessionId: string): void;
  /**
   * Marks every entry of a person as a guest (Linear made them one while
   * they were connected): they stop being a reader at once. Returns how
   * many entries it marked.
   */
  markGuest(workspaceId: string, userId: string): number;
  /** Forgets one entry by cookie token (a reconnect replacing its cookie). */
  removeByToken(token: string): boolean;
  /**
   * Forgets every entry of the token's person (same workspace and user).
   * The person is found through the token's entry, live or expired, or,
   * when that entry already ended on its own (idle, time limit, evicted by
   * the per-person cap), through the record of whose it was. `person` is
   * null when the token names nobody the vault knows of.
   */
  forgetPerson(token: string): ForgetResult;
  remove(sessionId: string): boolean;
  /** Live member sessions of the workspace in reader order (§7.6); guests never. */
  readers(
    workspaceId: string,
    options?: { preferUserId?: string | null }
  ): VaultSession[];
  count(workspaceId?: string): number;
  /** Ended-connection records held (tests). */
  endedCount(): number;
  /** Drops every expired entry (and outdated ended records); returns how many entries. */
  sweep(): number;
  clear(): void;
}

/** What forgetPerson did. */
export interface ForgetResult {
  /** Whose entries were forgotten, or null when the token named nobody. */
  person: { workspaceId: string; userId: string } | null;
  /** How many live or expired entries were dropped. */
  dropped: number;
}

/** Thrown by KeyVault.add when it already holds maxSessions live entries. */
export class VaultFullError extends Error {
  constructor() {
    super('The key vault is full.');
    this.name = 'VaultFullError';
  }
}

// The vault's own record of a connected person (never handed out: callers
// get frozen VaultSession copies). It holds no key.
interface Entry {
  id: string;
  hash: string;
  workspaceId: string;
  userId: string;
  userName: string;
  guest: boolean;
  connectedAtMs: number;
  expiresAtMs: number;
  lastUsedAtMs: number;
  writeRefused: boolean;
}

// Whose a connection was that ended on its own, kept by its cookie hash
// until the last moment another connection of that person can still be
// alive (the end + the absolute limit). It holds no key and no token.
interface Ended {
  workspaceId: string;
  userId: string;
  untilMs: number;
}

function frozen(entry: Entry): VaultSession {
  return Object.freeze({
    id: entry.id,
    workspaceId: entry.workspaceId,
    userId: entry.userId,
    userName: entry.userName,
    guest: entry.guest,
    connectedAtMs: entry.connectedAtMs,
    expiresAtMs: entry.expiresAtMs,
    lastUsedAtMs: entry.lastUsedAtMs,
    writeRefused: entry.writeRefused,
  });
}

/** Builds an empty vault (see the file comment). */
export function createKeyVault(options: KeyVaultOptions): KeyVault {
  const maxSessions = options.maxSessions ?? DEFAULT_VAULT_MAX_SESSIONS;
  const maxPerUser = options.maxPerUser ?? DEFAULT_VAULT_MAX_PER_USER;
  const maxEnded = options.maxEnded ?? DEFAULT_VAULT_MAX_ENDED;
  const byHash = new Map<string, Entry>();
  const byId = new Map<string, Entry>();
  // The keys, by entry id: the only long-lived reference to any key.
  const keys = new Map<string, string>();
  // Connections that ended on their own, by cookie hash (oldest first).
  const ended = new Map<string, Ended>();

  function expired(entry: Entry, now: number): boolean {
    return (
      now >= entry.expiresAtMs || now - entry.lastUsedAtMs >= options.idleMs
    );
  }

  function changed(): void {
    options.onSizeChange?.(byId.size);
  }

  // Forgets one entry from all three maps (no size notification). An
  // entry that ended on its own (`endedOnItsOwn`: expiry, the per-person
  // cap) leaves a record of whose it was, so a sign-out from that browser
  // can still find the person.
  function drop(entry: Entry, endedOnItsOwn = false): void {
    byHash.delete(entry.hash);
    byId.delete(entry.id);
    keys.delete(entry.id);
    if (!endedOnItsOwn) return;
    ended.delete(entry.hash);
    ended.set(entry.hash, {
      workspaceId: entry.workspaceId,
      userId: entry.userId,
      untilMs: options.now() + options.absoluteMs,
    });
    while (ended.size > maxEnded) {
      const oldest = ended.keys().next();
      if (oldest.done === true) break;
      ended.delete(oldest.value);
    }
  }

  // The live entry for an id, dropping it (and notifying) when expired.
  function liveEntry(sessionId: string): Entry | null {
    const entry = byId.get(sessionId);
    if (entry === undefined) return null;
    if (expired(entry, options.now())) {
      drop(entry, true);
      changed();
      return null;
    }
    return entry;
  }

  // The key of a live entry, checked for expiry without touching it. The
  // getter every gateway reads before each request.
  function liveKey(sessionId: string): string | null {
    const entry = byId.get(sessionId);
    if (entry === undefined || expired(entry, options.now())) return null;
    return keys.get(sessionId) ?? null;
  }

  function sweepExpired(): number {
    const now = options.now();
    let dropped = 0;
    for (const entry of [...byId.values()]) {
      if (expired(entry, now)) {
        drop(entry, true);
        dropped += 1;
      }
    }
    for (const [hash, record] of [...ended]) {
      if (now >= record.untilMs) ended.delete(hash);
    }
    return dropped;
  }

  const vault: KeyVault = {
    add(input) {
      const swept = sweepExpired();
      const now = options.now();
      const own = [...byId.values()]
        .filter(
          (entry) =>
            entry.workspaceId === input.workspaceId &&
            entry.userId === input.userId
        )
        .sort((a, b) => a.connectedAtMs - b.connectedAtMs);
      let evicted = 0;
      while (own.length >= maxPerUser) {
        const oldest = own.shift();
        if (oldest === undefined) break;
        drop(oldest, true);
        evicted += 1;
      }
      if (byId.size >= maxSessions) {
        if (swept + evicted > 0) changed();
        throw new VaultFullError();
      }
      const token = generateSessionToken();
      const entry: Entry = {
        id: randomBytes(16).toString('hex'),
        hash: hashSessionToken(token),
        workspaceId: input.workspaceId,
        userId: input.userId,
        userName: input.userName,
        guest: input.guest,
        connectedAtMs: now,
        expiresAtMs: now + options.absoluteMs,
        lastUsedAtMs: now,
        writeRefused: false,
      };
      byHash.set(entry.hash, entry);
      byId.set(entry.id, entry);
      keys.set(entry.id, input.apiKey);
      changed();
      return { token, session: frozen(entry) };
    },

    use(token) {
      if (typeof token !== 'string' || token === '') return null;
      const entry = byHash.get(hashSessionToken(token));
      if (entry === undefined) return null;
      const now = options.now();
      if (expired(entry, now)) {
        drop(entry, true);
        changed();
        return null;
      }
      entry.lastUsedAtMs = now;
      return frozen(entry);
    },

    peek(sessionId) {
      const entry = liveEntry(sessionId);
      return entry === null ? null : frozen(entry);
    },

    gateway(sessionId) {
      if (liveKey(sessionId) === null) return null;
      return options.gateway(() => liveKey(sessionId));
    },

    markWriteRefused(sessionId) {
      const entry = byId.get(sessionId);
      if (entry !== undefined) entry.writeRefused = true;
    },

    markGuest(workspaceId, userId) {
      let marked = 0;
      for (const entry of byId.values()) {
        if (
          entry.workspaceId === workspaceId &&
          entry.userId === userId &&
          !entry.guest
        ) {
          entry.guest = true;
          marked += 1;
        }
      }
      return marked;
    },

    removeByToken(token) {
      if (typeof token !== 'string' || token === '') return false;
      const entry = byHash.get(hashSessionToken(token));
      if (entry === undefined) return false;
      drop(entry);
      changed();
      return true;
    },

    forgetPerson(token) {
      if (typeof token !== 'string' || token === '') {
        return { person: null, dropped: 0 };
      }
      const hash = hashSessionToken(token);
      const record = ended.get(hash);
      const found =
        byHash.get(hash) ??
        (record !== undefined && options.now() < record.untilMs
          ? record
          : undefined);
      if (found === undefined) return { person: null, dropped: 0 };
      const person = { workspaceId: found.workspaceId, userId: found.userId };
      let dropped = 0;
      for (const entry of [...byId.values()]) {
        if (
          entry.workspaceId === person.workspaceId &&
          entry.userId === person.userId
        ) {
          drop(entry);
          dropped += 1;
        }
      }
      if (dropped > 0) changed();
      return { person, dropped };
    },

    remove(sessionId) {
      const entry = byId.get(sessionId);
      if (entry === undefined) return false;
      drop(entry);
      changed();
      return true;
    },

    readers(workspaceId, readerOptions = {}) {
      const prefer = readerOptions.preferUserId ?? null;
      const now = options.now();
      return [...byId.values()]
        .filter(
          (entry) =>
            entry.workspaceId === workspaceId &&
            !entry.guest &&
            !expired(entry, now)
        )
        .sort((a, b) => {
          const aFirst = a.userId === prefer ? 0 : 1;
          const bFirst = b.userId === prefer ? 0 : 1;
          if (aFirst !== bFirst) return aFirst - bFirst;
          if (a.connectedAtMs !== b.connectedAtMs) {
            return a.connectedAtMs - b.connectedAtMs;
          }
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        })
        .map(frozen);
    },

    count(workspaceId) {
      const now = options.now();
      let live = 0;
      for (const entry of byId.values()) {
        if (workspaceId !== undefined && entry.workspaceId !== workspaceId) {
          continue;
        }
        if (!expired(entry, now)) live += 1;
      }
      return live;
    },

    endedCount() {
      return ended.size;
    },

    sweep() {
      const dropped = sweepExpired();
      if (dropped > 0) changed();
      return dropped;
    },

    clear() {
      const had = byId.size;
      byHash.clear();
      byId.clear();
      keys.clear();
      ended.clear();
      if (had > 0) changed();
    },
  };
  return Object.freeze(vault);
}
