// Connecting, authenticating and signing out with personal API keys
// (LINEAR_AUTH=api_key, owner request 2026-10-23; architecture §7
// "API-key mode"). A person pastes their own Linear key; the planner asks
// Linear whose it is (viewer and organization, the only validation call),
// binds the workspace on the first member's connect (or checks the
// LINEAR_WORKSPACE pin), and holds the key in the vault (key-vault.ts),
// in this process's memory only. Nothing here logs, stores or returns the
// key: the Session handed out carries blank tokens, and errors are fixed
// sentences that never include the input.

import { isLinearApiKeyShape, type IsoDateTime } from '@better-tracker/core';
import type { Installation, Session, Store } from '@better-tracker/store';

import { mirrorForPerson, readOnlyReasonFor } from './auth';
import { VaultFullError, type VaultSession } from './key-vault';
import { isLinearApiError } from './linear-errors';
import type { EngineRuntime } from './runtime';
import { fullSync } from './sync';
import {
  type Actor,
  type ApiKeyConnectResult,
  type ApiKeyDeps,
  EngineAuthError,
  EngineInputError,
  type KeyConnectionStatus,
  type ReadOnlyReason,
  type SignOutResult,
} from './types';

/** The connect form's refusal of anything not shaped like a key (fixed text). */
export const KEY_SHAPE_MESSAGE =
  'That does not look like a Linear personal API key (they start with lin_api_).';
const KEYS_OFF_MESSAGE = 'Personal API keys are off on this server.';
const WRONG_WORKSPACE_MESSAGE =
  'That key belongs to a different Linear workspace from the one this planner serves.';
/** How recent a sync must be for a connect not to start another (§7.7). */
const CONNECT_SYNC_FRESH_MS = 60_000;

/**
 * Which `installations` row is the workspace binding (§5.2). With the pin
 * (LINEAR_WORKSPACE): the row whose workspace id equals it, or whose URL
 * key equals it case-insensitively; it may not exist yet. Without it
 * (local runs and tests): the oldest row this mode wrote (`appUserId` ''),
 * so a leftover OAuth or demo row never binds just by being oldest.
 */
export async function bindingFor(
  store: Store,
  pin: string | null
): Promise<Installation | null> {
  const rows = await store.listInstallations();
  if (pin !== null) {
    const lower = pin.toLowerCase();
    return (
      rows.find(
        (row) => row.workspaceId === pin || row.urlKey.toLowerCase() === lower
      ) ?? null
    );
  }
  return rows.find((row) => row.appUserId === '') ?? null;
}

// Whether an organization is the one the pin names.
function matchesPin(
  organization: { id: string; urlKey: string },
  pin: string
): boolean {
  return (
    organization.id === pin ||
    organization.urlKey.toLowerCase() === pin.toLowerCase()
  );
}

function iso(ms: number): IsoDateTime {
  return new Date(ms).toISOString();
}

/**
 * The Session a vault entry stands for (Actor.session): its internal id,
 * never the cookie, and blank tokens always. Scopes say whether Linear
 * refused this key a write (`read` only then).
 */
export function vaultSessionToSession(entry: VaultSession): Session {
  const expiresAt = iso(entry.expiresAtMs);
  return {
    id: entry.id,
    workspaceId: entry.workspaceId,
    userId: entry.userId,
    userName: entry.userName,
    createdAt: iso(entry.connectedAtMs),
    expiresAt,
    tokens: {
      accessToken: '',
      refreshToken: null,
      expiresAt,
      scopes: entry.writeRefused ? ['read'] : ['read', 'write'],
    },
  };
}

// The api_key-mode pieces, or the error every other mode gets.
function keysOf(rt: EngineRuntime): ApiKeyDeps {
  if (rt.config.auth !== 'api_key' || rt.keys === null) {
    throw new EngineInputError('invalid', KEYS_OFF_MESSAGE);
  }
  return rt.keys;
}

// The pin, as configured (null when unpinned).
function pinOf(rt: EngineRuntime): string | null {
  return rt.config.apiKey?.workspacePin ?? null;
}

// Saves the binding row for `organization` (§5.2): blank tokens and
// appUserId '', adopting an existing row of that org (an earlier OAuth
// install), whose createdAt and installer are kept. `installerId` is the
// connecting person, or '' for a guest: a guest is never the binder (who
// reads first and is the default watcher), so on a pinned planner a guest
// who connects first leaves it blank and the first member to connect
// fills it. A binding that is already current is left alone.
async function saveBinding(
  rt: EngineRuntime,
  organization: { id: string; name: string; urlKey: string },
  installerId: string
): Promise<void> {
  const existing = await rt.store.getInstallation(organization.id);
  const installer =
    existing === null || existing.installedByUserId === ''
      ? installerId
      : existing.installedByUserId;
  if (
    existing !== null &&
    existing.appUserId === '' &&
    existing.revokedAt === null &&
    existing.tokens.accessToken === '' &&
    existing.tokens.refreshToken === null &&
    existing.workspaceName === organization.name &&
    existing.urlKey === organization.urlKey &&
    existing.installedByUserId === installer
  ) {
    return;
  }
  const now = rt.nowIso();
  await rt.store.saveInstallation({
    workspaceId: organization.id,
    workspaceName: organization.name,
    urlKey: organization.urlKey,
    appUserId: '',
    installedByUserId: installer,
    revokedAt: null,
    tokens: {
      accessToken: '',
      refreshToken: null,
      expiresAt: null,
      scopes: [],
    },
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
  if (existing === null || existing.appUserId !== '') {
    rt.logger.info('bound the planner to a Linear workspace', {
      workspaceId: organization.id,
      adopted: existing !== null,
    });
  } else if (existing.installedByUserId === '' && installer !== '') {
    rt.logger.info('the first workspace member connected; they read first', {
      workspaceId: organization.id,
      userId: installer,
    });
  }
}

/** connectApiKey (§7.2): see the file comment. */
export async function connectApiKey(
  rt: EngineRuntime,
  input: { apiKey: string }
): Promise<ApiKeyConnectResult> {
  const keys = keysOf(rt);
  const factory = rt.deps.apiKeyGateway;
  if (factory === undefined) {
    throw new EngineInputError('invalid', KEYS_OFF_MESSAGE);
  }
  const apiKey = typeof input?.apiKey === 'string' ? input.apiKey.trim() : '';
  // Never zod, never the input in a message: issues can carry the value.
  if (!isLinearApiKeyShape(apiKey)) {
    throw new EngineInputError('invalid', KEY_SHAPE_MESSAGE);
  }

  let identity;
  try {
    identity = await factory(() => apiKey).whoAmI();
  } catch (error) {
    if (isLinearApiError(error)) {
      switch (error.kind) {
        case 'unauthorized':
          throw new EngineAuthError(
            'key_rejected',
            'Linear did not accept that key: it may be mistyped, revoked or expired.'
          );
        case 'forbidden':
          throw new EngineAuthError(
            'key_cannot_read',
            'That key cannot read Linear. The planner needs a key with at least Read access.'
          );
        case 'rate_limited':
          throw new EngineInputError(
            'rate_limited',
            error.retryAt === null
              ? "Linear's rate limit was reached; try again in a minute."
              : `Linear's rate limit was reached; try again after ${error.retryAt}.`,
            { retryAt: error.retryAt }
          );
        default:
          throw error;
      }
    }
    throw error;
  }
  const { user, workspace } = identity;
  if (user.app || !user.active) {
    rt.logger.warn('refused an API key connect', {
      workspaceId: workspace.id,
      userId: user.id,
      reason: user.app ? 'app user' : 'deactivated user',
    });
    throw new EngineAuthError(
      'not_signed_in',
      user.app
        ? 'App users cannot sign in; sign in with your own Linear account.'
        : 'Your Linear account is deactivated.'
    );
  }
  const guest = user.guest === true;
  // A guest never becomes the binder (saveBinding).
  const installerId = guest ? '' : user.id;

  // Two first connects must not both bind: one at a time in this process.
  await rt.serialize('api-key-binding', async () => {
    const pin = pinOf(rt);
    if (pin !== null) {
      if (!matchesPin(workspace, pin)) {
        throw new EngineAuthError('wrong_workspace', WRONG_WORKSPACE_MESSAGE);
      }
      await saveBinding(rt, workspace, installerId);
      return;
    }
    const bound = await bindingFor(rt.store, null);
    if (bound !== null) {
      if (bound.workspaceId !== workspace.id) {
        throw new EngineAuthError('wrong_workspace', WRONG_WORKSPACE_MESSAGE);
      }
      await saveBinding(rt, workspace, installerId);
      return;
    }
    if (guest) {
      throw new EngineAuthError(
        'guest_cannot_bind',
        'A member of the workspace has to connect first; a guest cannot choose the workspace this planner serves.'
      );
    }
    await saveBinding(rt, workspace, user.id);
  });

  let added: { token: string; session: VaultSession };
  try {
    added = keys.vault.add({
      apiKey,
      workspaceId: workspace.id,
      userId: user.id,
      userName: user.name,
      guest,
    });
  } catch (error) {
    if (error instanceof VaultFullError) {
      throw new EngineInputError(
        'conflict',
        'Too many people are connected to the planner right now. Try again later.'
      );
    }
    throw error;
  }

  // From here on the vault holds the key, but the person has no cookie
  // yet: anything that fails forgets it again, so a connect they are told
  // failed never leaves their key behind (for background syncs to use).
  try {
    const syncAfter = await syncForConnect(rt, workspace.id, user.id);
    rt.logger.info('connected a Linear API key', {
      workspaceId: workspace.id,
      userId: user.id,
      sessionId: added.session.id,
      guest,
    });
    return {
      sessionToken: added.token,
      session: vaultSessionToSession(added.session),
      needsInstall: false,
      syncAfter,
    };
  } catch (error) {
    keys.vault.remove(added.session.id);
    rt.logger.warn('a connect failed after the key was held; forgot it', {
      workspaceId: workspace.id,
      userId: user.id,
      sessionId: added.session.id,
    });
    throw error;
  }
}

// The sync a connect needs (§7.7), so the person is placed before their
// first page: sync now when the mirror is missing or does not know them
// yet (its failure is only logged); else true, telling the route to sync
// after responding, unless a sync landed in the last minute. Reading the
// mirror can throw (a database error), which the caller turns into a
// failed connect.
async function syncForConnect(
  rt: EngineRuntime,
  workspaceId: string,
  userId: string
): Promise<boolean> {
  const view = await rt.mirror.current(workspaceId);
  if (view === null || !view.snapshot.users.has(userId)) {
    try {
      await fullSync(rt, workspaceId);
    } catch (error) {
      const noReader =
        error instanceof EngineAuthError && error.code === 'no_reader';
      const fields = { workspaceId, error };
      if (noReader) rt.logger.info('no reader for the first sync yet', fields);
      else rt.logger.warn('the sync after a connect failed', fields);
    }
    return false;
  }
  const last = view.syncState.lastFullSyncAt;
  return (
    last === null ||
    rt.clock().getTime() - Date.parse(last) >= CONNECT_SYNC_FRESH_MS
  );
}

/** authenticate in api_key mode (§7.3): the vault entry, then the mirror. */
export async function authenticateWithKey(
  rt: EngineRuntime,
  sessionToken: string | undefined
): Promise<Actor | null> {
  const keys = rt.keys;
  if (keys === null) return null;
  if (typeof sessionToken !== 'string' || sessionToken === '') return null;
  const entry = keys.vault.use(sessionToken);
  if (entry === null) return null;

  const { view } = await mirrorForPerson(rt, entry.workspaceId);
  const mirrored = view?.snapshot.users.get(entry.userId);
  if (mirrored !== undefined && (!mirrored.active || mirrored.app)) {
    rt.logger.warn('forgot the key of a deactivated Linear user', {
      workspaceId: entry.workspaceId,
      userId: entry.userId,
    });
    keys.vault.remove(entry.id);
    return null;
  }
  // Linear made a connected member a guest: their key stops reading the
  // shared mirror at once (§7.6), on every device they connected.
  if (mirrored?.guest === true && !entry.guest) {
    keys.vault.markGuest(entry.workspaceId, entry.userId);
    rt.logger.warn(
      'a connected member is now a Linear guest; their key no longer reads',
      {
        workspaceId: entry.workspaceId,
        userId: entry.userId,
      }
    );
  }

  let reason: ReadOnlyReason | null = readOnlyReasonFor(
    view?.snapshot ?? null,
    entry.userId,
    true
  );
  // A guest per Linear (at connect) is read-only even before the mirror says so.
  if (reason === null && entry.guest) reason = 'guest';
  if (reason === null && entry.writeRefused) reason = 'read_only_key';
  return {
    session: vaultSessionToSession(entry),
    canWriteLinear: reason === null,
    readOnly: reason !== null,
    ...(reason === null ? {} : { readOnlyReason: reason }),
  };
}

/**
 * signOut in api_key mode (§7.3). `everyDevice` (the logout route) forgets
 * every entry of the person, found even when this browser's own entry
 * already ended on its own (vault.forgetPerson); without it (a reconnect
 * replacing its cookie) only this one. Says whether the token named
 * anyone, so the route never claims a sign-out it could not do. There is
 * nothing to revoke: Linear has no API for it (F5), so the key keeps
 * working in Linear until its owner revokes it.
 */
export function signOutWithKey(
  rt: EngineRuntime,
  sessionToken: string,
  options: { everyDevice?: boolean } = {}
): SignOutResult {
  const keys = rt.keys;
  if (keys === null) return { known: false, keysForgotten: 0 };
  if (typeof sessionToken !== 'string' || sessionToken === '') {
    return { known: false, keysForgotten: 0 };
  }
  if (options.everyDevice === true) {
    const { person, dropped } = keys.vault.forgetPerson(sessionToken);
    rt.logger.info('forgot a Linear API key (signed out)', {
      everyDevice: true,
      known: person !== null,
      ...person,
      entries: dropped,
    });
    return { known: person !== null, keysForgotten: dropped };
  }
  const removed = keys.vault.removeByToken(sessionToken);
  rt.logger.info('forgot a Linear API key (signed out)', {
    everyDevice: false,
    entries: removed ? 1 : 0,
  });
  return { known: removed, keysForgotten: removed ? 1 : 0 };
}

/** getKeyConnection (§7.10): the actor's key status, without any secret. */
export async function getKeyConnection(
  rt: EngineRuntime,
  actor: Actor
): Promise<KeyConnectionStatus | null> {
  if (rt.config.auth !== 'api_key' || rt.keys === null) return null;
  const entry = rt.keys.vault.peek(actor.session.id);
  if (entry === null) return null;
  const binding = await bindingFor(rt.store, pinOf(rt));
  const reader =
    binding === null
      ? undefined
      : rt.keys.vault.readers(binding.workspaceId, {
          preferUserId: binding.installedByUserId,
        })[0];
  return {
    connectedAt: iso(entry.connectedAtMs),
    expiresAt: iso(entry.expiresAtMs),
    idleMinutes: Math.round((rt.config.apiKey?.idleMs ?? 0) / 60_000),
    reader:
      reader === undefined
        ? null
        : { userId: reader.userId, userName: reader.userName },
  };
}
