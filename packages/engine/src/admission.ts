// Admission (owner decision 2026-10-25; architecture §7 "Admission"): which
// Linear workspaces an OAuth-mode planner serves. It gates workspaces, never
// people, so it is not a permission distinction.
//
// - The operator block list (store `blocked_workspaces`) wins: a block by
//   org id, or by URL key, which is turned into a block by id the first
//   time it matches (URL keys can be renamed in Linear).
// - Then LINEAR_WORKSPACES (EngineConfig.workspaces): `installed` (unset)
//   admits only workspaces with an installation row; `any` (`*`) admits
//   every workspace; a `list` admits an entry equal to the org id, or a URL
//   key entry pinned (store `admitted_workspaces`) to the org it first
//   admitted, so after a rename it still admits that org and never another.
//   An unpinned entry is matched against the workspace's URL key (the
//   installation's, which every full sync, sign-in and cleanup identity
//   read keeps current). Only when that key matches no entry at all, and
//   only for a session that signed in after the installation's key was
//   last read from Linear (newerSignInUrlKey), is it matched against the
//   key the session signed in under: so a rename no read has seen yet does
//   not sign it out, and a key the workspace has since given up (another
//   org may hold it now) never pins. A pin always names the subject's own
//   org id.
// - `fresh` reads blocks, pins and installations from the store (sign-in,
//   install, webhooks, the worker; a store error throws, so those fail
//   closed). Otherwise (authenticate, checkSession, describeSessions) a
//   read up to ADMISSION_CACHE_MS old is reused, and on a store error the
//   last good read is (any age).
// - Demo and api_key modes admit everything: they serve one workspace.

import type {
  BlockedWorkspace,
  SessionDescription,
  WorkspaceStatus,
} from '@better-tracker/store';

import type { EngineRuntime } from './runtime';
import type { WorkspaceAdmission, WorkspaceOverview } from './types';

/** What admission says about one workspace. */
export type AdmissionVerdict = 'ok' | 'not_allowed' | 'blocked';

/** How long a non-fresh check may reuse the store's answer, in ms. */
export const ADMISSION_CACHE_MS = 30_000;

/** A Linear org id (a UUID): such an entry is never read as a URL key. */
const ORG_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The workspace an admission check is about. */
export interface AdmissionSubject {
  /** The Linear org id. */
  id: string;
  /**
   * Its current URL key, when the caller knows it (null: none known):
   * URL key blocks and unpinned LINEAR_WORKSPACES entries match it.
   */
  urlKey?: string | null;
  /**
   * For a session's workspace, the URL key the session signed in under,
   * given only when it is newer than `urlKey` (newerSignInUrlKey). An
   * unpinned LINEAR_WORKSPACES URL key entry is matched against it only
   * when `urlKey` matches no entry; blocks use `urlKey` only.
   */
  signInUrlKey?: string | null;
  /**
   * Looks both keys up (one query), called only when `urlKey` is not given
   * and a URL key block or an unpinned URL key entry needs them.
   */
  lookupUrlKeys?: () => Promise<{
    urlKey: string | null;
    signInUrlKey: string | null;
  }>;
  /** Whether it has an installation row, when the caller already knows. */
  installed?: boolean;
}

interface Cached<T> {
  value: T;
  /** rt.clock() in epoch ms when it was read. */
  at: number;
}

// What one engine instance remembers between non-fresh checks. Bounded by
// the number of blocks, LINEAR_WORKSPACES entries and known workspaces.
interface AdmissionCache {
  blocks: Cached<readonly BlockedWorkspace[]> | null;
  pins: Map<string, Cached<string | null>>;
  installed: Map<string, Cached<boolean>>;
}

const caches = new WeakMap<EngineRuntime, AdmissionCache>();

function cacheOf(rt: EngineRuntime): AdmissionCache {
  let cache = caches.get(rt);
  if (cache === undefined) {
    cache = { blocks: null, pins: new Map(), installed: new Map() };
    caches.set(rt, cache);
  }
  return cache;
}

/** Whether admission applies at all: OAuth mode only. */
export function admissionApplies(rt: EngineRuntime): boolean {
  return rt.config.auth === 'oauth';
}

/** LINEAR_WORKSPACES as configured; absent means closed to new workspaces. */
export function admissionMode(rt: EngineRuntime): WorkspaceAdmission {
  return rt.config.workspaces ?? { mode: 'installed' };
}

// A cached value read with `load`: reused when fresh is false and it is
// younger than ADMISSION_CACHE_MS; after a failed non-fresh read the last
// good value is reused whatever its age (logged). Fresh reads always go to
// the store and throw on failure; every good read refreshes the cache.
async function cachedRead<T>(
  rt: EngineRuntime,
  slot: { get(): Cached<T> | null; set(value: Cached<T>): void },
  fresh: boolean,
  load: () => Promise<T>,
  what: string
): Promise<T> {
  const now = rt.clock().getTime();
  const cached = slot.get();
  if (!fresh && cached !== null) {
    const age = now - cached.at;
    if (age >= 0 && age < ADMISSION_CACHE_MS) return cached.value;
  }
  try {
    const value = await load();
    slot.set({ value, at: now });
    return value;
  } catch (error) {
    if (fresh || cached === null) throw error;
    rt.logger.warn(`could not read ${what}; using the last one read`, {
      error,
    });
    return cached.value;
  }
}

function mapSlot<T>(
  map: Map<string, Cached<T>>,
  key: string
): { get(): Cached<T> | null; set(value: Cached<T>): void } {
  return {
    get: () => map.get(key) ?? null,
    set: (value) => {
      map.set(key, value);
    },
  };
}

/**
 * The workspace's installation row as far as admission needs it (its URL
 * key), or null when it has none. Reads one row; a row whose tokens no
 * longer decrypt (another TOKEN_ENCRYPTION_KEY) is found through
 * listWorkspaceStatus, which decrypts nothing. A store error throws.
 */
export async function installationRow(
  rt: EngineRuntime,
  workspaceId: string
): Promise<{ urlKey: string } | null> {
  try {
    const installation = await rt.store.getInstallation(workspaceId);
    return installation === null ? null : { urlKey: installation.urlKey };
  } catch {
    const status = (await rt.store.listWorkspaceStatus()).find(
      (row) => row.workspaceId === workspaceId
    );
    const summary = status?.installation ?? null;
    return summary === null ? null : { urlKey: summary.urlKey };
  }
}

/**
 * One admission pass: reads the block list at most once however many
 * workspaces it checks (listWorkspaceIds, cleanup), and decides each
 * workspace as `admission` does.
 */
export function createAdmissionPass(
  rt: EngineRuntime,
  options: { fresh: boolean }
): (subject: AdmissionSubject) => Promise<AdmissionVerdict> {
  const cache = cacheOf(rt);
  let blocks: Promise<readonly BlockedWorkspace[]> | null = null;
  const readBlocks = (): Promise<readonly BlockedWorkspace[]> => {
    blocks ??= cachedRead(
      rt,
      {
        get: () => cache.blocks,
        set: (value) => {
          cache.blocks = value;
        },
      },
      options.fresh,
      () => rt.store.listBlockedWorkspaces(),
      'the workspace block list'
    );
    return blocks;
  };

  return async (subject) => {
    if (!admissionApplies(rt)) return 'ok';
    const idKey = subject.id.toLowerCase();
    let keys: { urlKey: string | null; signInUrlKey: string | null } | null =
      subject.urlKey === undefined
        ? null
        : {
            urlKey: subject.urlKey,
            signInUrlKey: subject.signInUrlKey ?? null,
          };
    const keysOf = async (): Promise<{
      urlKey: string | null;
      signInUrlKey: string | null;
    }> => {
      keys ??= (await subject.lookupUrlKeys?.()) ?? {
        urlKey: null,
        signInUrlKey: null,
      };
      return keys;
    };
    const lower = (key: string | null): string | null =>
      key === null || key === '' ? null : key.toLowerCase();
    const urlKeyOf = async (): Promise<string | null> =>
      lower((await keysOf()).urlKey);
    // The keys an unpinned entry may match: the workspace's, then the
    // session's newer sign-in key as the fallback.
    const entryKeysOf = async (): Promise<EntryKeys> => {
      const { urlKey, signInUrlKey } = await keysOf();
      return { primary: lower(urlKey), fallback: lower(signInUrlKey) };
    };

    const blocked = await readBlocks();
    if (blocked.some((block) => block.kind === 'id' && block.key === idKey)) {
      return 'blocked';
    }
    if (blocked.some((block) => block.kind === 'url_key')) {
      const key = await urlKeyOf();
      if (
        key !== null &&
        blocked.some((block) => block.kind === 'url_key' && block.key === key)
      ) {
        await pinBlock(rt, key, subject.id);
        return 'blocked';
      }
    }

    const mode = admissionMode(rt);
    switch (mode.mode) {
      case 'any':
        return 'ok';
      case 'installed': {
        const installed =
          subject.installed ??
          (await cachedRead(
            rt,
            mapSlot(cache.installed, subject.id),
            options.fresh,
            async () => (await installationRow(rt, subject.id)) !== null,
            'whether the workspace is installed'
          ));
        return installed ? 'ok' : 'not_allowed';
      }
      case 'list':
        return (await listedIn(rt, mode.entries, subject.id, entryKeysOf, {
          fresh: options.fresh,
        }))
          ? 'ok'
          : 'not_allowed';
    }
  };
}

// Turns the URL-key block that matched into a block on the org id, so a
// rename cannot dodge it. Best effort: the workspace is refused either way.
async function pinBlock(
  rt: EngineRuntime,
  urlKey: string,
  workspaceId: string
): Promise<void> {
  try {
    if (await rt.store.pinBlockedUrlKey(urlKey, workspaceId)) {
      rt.logger.warn('a block by URL key now names its workspace by id', {
        workspaceId,
      });
    }
  } catch (error) {
    rt.logger.error('could not pin a block by URL key to its workspace', {
      workspaceId,
      error,
    });
  } finally {
    cacheOf(rt).blocks = null;
  }
}

// The pin of one LINEAR_WORKSPACES URL key entry (the org id it admits), or
// null while unpinned; cached like every non-fresh read.
function readPin(
  rt: EngineRuntime,
  entry: string,
  fresh: boolean
): Promise<string | null> {
  return cachedRead(
    rt,
    mapSlot(cacheOf(rt).pins, entry),
    fresh,
    () => rt.store.getAdmittedPin(entry),
    'a LINEAR_WORKSPACES pin'
  );
}

/**
 * The lower-cased URL keys an unpinned LINEAR_WORKSPACES entry may match:
 * the workspace's own (`primary`), and a session's newer sign-in key
 * (`fallback`), tried only when `primary` matches no URL key entry.
 */
interface EntryKeys {
  primary: string | null;
  fallback: string | null;
}

/**
 * The URL key a session signed in under, when admission may match an
 * unpinned LINEAR_WORKSPACES entry against it (AdmissionSubject
 * .signInUrlKey): only when the session signed in after the
 * installation's URL key was last read from Linear, so it is the newer of
 * the two (a sync, a sign-in or cleanup's identity read since then has
 * the current key, and the session's may be one the workspace gave up,
 * which another org may hold now). Null when the read is not recorded
 * (rows from before migration 8), at the same instant or later. A
 * workspace with no installation has only the session's key anyway.
 */
export function newerSignInUrlKey(
  described: Pick<
    SessionDescription,
    'signInUrlKey' | 'signedInAt' | 'urlKeyReadAt' | 'installed'
  >
): string | null {
  const key = described.signInUrlKey ?? null;
  if (key === null) return null;
  if (!described.installed) return key;
  const readAt = described.urlKeyReadAt ?? null;
  const signedInAt = described.signedInAt;
  if (readAt === null || signedInAt === undefined) return null;
  const readMs = Date.parse(readAt);
  const signedInMs = Date.parse(signedInAt);
  if (Number.isNaN(readMs) || Number.isNaN(signedInMs)) return null;
  return signedInMs > readMs ? key : null;
}

/**
 * Whether a LINEAR_WORKSPACES list names the workspace: an entry equal to
 * its org id, or a URL key entry pinned to it. Else an unpinned URL key
 * entry equal to the workspace's key, or (only when that key equals no URL
 * key entry, pinned or not) to the fallback key, is pinned to this
 * workspace's id here (the first pin wins, also across processes, so a
 * pin never names another org than the first one admitted, and always the
 * subject's own). Org-id-shaped entries are never read as URL keys.
 */
async function listedIn(
  rt: EngineRuntime,
  entries: readonly string[],
  workspaceId: string,
  keysOf: () => Promise<EntryKeys>,
  options: { fresh: boolean }
): Promise<boolean> {
  const idKey = workspaceId.toLowerCase();
  if (entries.includes(idKey)) return true;
  const cache = cacheOf(rt);
  const urlKeyEntries = entries.filter((entry) => !ORG_ID.test(entry));
  const unpinned: string[] = [];
  for (const entry of urlKeyEntries) {
    const pin = await readPin(rt, entry, options.fresh);
    if (pin === null) {
      unpinned.push(entry);
      continue;
    }
    if (pin.toLowerCase() === idKey) return true;
  }
  if (unpinned.length === 0) return false;
  const { primary, fallback } = await keysOf();
  const key =
    primary !== null && urlKeyEntries.includes(primary) ? primary : fallback;
  const entry = unpinned.find((candidate) => candidate === key);
  if (entry === undefined) return false;
  const pinned = await rt.store.pinAdmitted(entry, workspaceId, rt.nowIso());
  cache.pins.set(entry, { value: pinned, at: rt.clock().getTime() });
  if (pinned.toLowerCase() !== idKey) return false;
  rt.logger.info('a LINEAR_WORKSPACES URL key now names its workspace', {
    entry,
    workspaceId,
  });
  return true;
}

/**
 * The LINEAR_WORKSPACES URL key entries no workspace is pinned to yet
 * (fresh reads), when LINEAR_WORKSPACES is a list; [] otherwise. An
 * installed workspace the list refuses can still be admitted by one of
 * them once its URL key is current (cleanup's identity read).
 */
export async function unpinnedUrlKeyEntries(
  rt: EngineRuntime
): Promise<string[]> {
  const mode = admissionMode(rt);
  if (!admissionApplies(rt) || mode.mode !== 'list') return [];
  const unpinned: string[] = [];
  for (const entry of mode.entries) {
    if (ORG_ID.test(entry)) continue;
    if ((await readPin(rt, entry, true)) === null) unpinned.push(entry);
  }
  return unpinned;
}

/**
 * What admission says about one workspace (see the file header). `fresh`
 * reads the store (a store error throws); otherwise cached reads are used.
 */
export function admission(
  rt: EngineRuntime,
  subject: AdmissionSubject,
  options: { fresh: boolean }
): Promise<AdmissionVerdict> {
  return createAdmissionPass(rt, options)(subject);
}

/**
 * Whether LINEAR_WORKSPACES names the workspace in a list (blocks aside):
 * false under `*` or when it is unset. WATCHER_EMAILS uses it.
 */
export async function namedInWorkspaceList(
  rt: EngineRuntime,
  workspace: { id: string; urlKey: string | null }
): Promise<boolean> {
  const mode = admissionMode(rt);
  if (mode.mode !== 'list') return false;
  const urlKey = workspace.urlKey?.toLowerCase() ?? null;
  return listedIn(
    rt,
    mode.entries,
    workspace.id,
    () =>
      Promise.resolve({
        primary: urlKey === '' ? null : urlKey,
        fallback: null,
      }),
    { fresh: true }
  );
}

/**
 * The installed (active installation) workspaces admission admits, in the
 * store's order (least recently attempted first, never attempted first): the
 * worker's list (listWorkspaceIds). Session-only workspaces and revoked
 * installations are left out; refused ones are logged at info and left
 * out, never failures. Fresh.
 */
export async function admittedInstalledWorkspaceIds(
  rt: EngineRuntime
): Promise<string[]> {
  const statuses = await rt.store.listWorkspaceStatus();
  const check = createAdmissionPass(rt, { fresh: true });
  const ids: string[] = [];
  for (const status of statuses) {
    if (status.installation === null || status.installation.revokedAt !== null)
      continue;
    const verdict = await check({
      id: status.workspaceId,
      urlKey: status.urlKey,
      installed: true,
    });
    if (verdict !== 'ok') {
      rt.logger.info('workspace skipped: admission refuses it', {
        workspaceId: status.workspaceId,
        admission: verdict,
      });
      continue;
    }
    ids.push(status.workspaceId);
  }
  return ids;
}

/**
 * Engine.listWorkspaceStatus: every workspace the store knows (unexpired
 * sessions counted at the engine clock), in the store's order, each with
 * admission's fresh verdict. One admission pass, so the block list is read
 * once; refused workspaces are only reported here, never revoked (cleanup
 * removes blocked installations). A store error throws.
 */
export async function workspaceOverview(
  rt: EngineRuntime
): Promise<WorkspaceOverview[]> {
  const statuses = await rt.store.listWorkspaceStatus(rt.nowIso());
  const check = createAdmissionPass(rt, { fresh: true });
  const overview: WorkspaceOverview[] = [];
  for (const status of statuses) {
    const verdict = await check({
      id: status.workspaceId,
      urlKey: status.urlKey,
      installed: status.installation !== null,
    });
    overview.push({ ...status, admission: verdict });
  }
  return overview;
}

/** A workspace the store knows that admission refuses, with its status. */
export interface RefusedWorkspace {
  workspaceId: string;
  verdict: Exclude<AdmissionVerdict, 'ok'>;
  status: WorkspaceStatus;
}

/**
 * Every workspace the store knows (an installation row, sessions, or both;
 * store.listWorkspaceStatus) that admission refuses now, fresh: for
 * cleanup (handleRefusedInstallations), which removes blocked
 * installations, reads the current URL key of active ones an unpinned
 * LINEAR_WORKSPACES entry could admit, and only warns about the ones the
 * list still leaves out. [] outside OAuth mode.
 */
export async function refusedWorkspaces(
  rt: EngineRuntime
): Promise<RefusedWorkspace[]> {
  if (!admissionApplies(rt)) return [];
  const statuses = await rt.store.listWorkspaceStatus();
  const check = createAdmissionPass(rt, { fresh: true });
  const refused: RefusedWorkspace[] = [];
  for (const status of statuses) {
    const verdict = await check({
      id: status.workspaceId,
      urlKey: status.urlKey,
      installed: status.installation !== null,
    });
    if (verdict !== 'ok') {
      refused.push({ workspaceId: status.workspaceId, verdict, status });
    }
  }
  return refused;
}
