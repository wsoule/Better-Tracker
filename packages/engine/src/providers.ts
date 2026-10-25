// How the engine gets LinearGateways (architecture §7.1).
//
// The real provider builds a gateway over stored OAuth tokens. Access tokens
// last 24 h and refresh tokens rotate (the old pair stops working), so a
// refresh happens 5 minutes before expiry, single-flight under the store's
// row lock, and re-reads the tokens inside the lock: when another process
// already refreshed, its tokens are used instead of refreshing again. A
// grant Linear rejects (invalid_grant) is dead for good: a session must
// sign in again, and the installation is revoked as 'grant_dead' (its
// credentials wiped) so it shows as needing a reinstall and the worker
// stops trying it. Members keep their sessions: their own grants do not
// depend on the app's, and /setup tells them a reinstall is needed.
//
// The fixture provider serves in-memory gateways over one shared
// FixtureStore, so demo-mode writes from the app actor and from signed-in
// "humans" all land in the same fictional workspace.

import {
  createFixtureGateway,
  createLinearGateway,
  type FetchLike,
  type FixtureStore,
  isInvalidGrant,
  type LinearGateway,
  type OAuthClientConfig,
  refreshTokens,
} from '@better-tracker/linear';
import type { Logger } from '@better-tracker/logger';
import {
  type Installation,
  isStoreNotFoundError,
  type Session,
  type Store,
  type StoredTokens,
} from '@better-tracker/store';

import { DEFAULT_APP_NAME } from './config';
import { NOT_INSTALLED_MESSAGE } from './runtime';
import { EngineAuthError, type LinearProvider } from './types';

/** Refresh an access token this long before it expires. */
export const REFRESH_MARGIN_MS: number = 5 * 60 * 1000;

export interface LinearProviderOptions {
  store: Store;
  oauth: OAuthClientConfig;
  logger: Logger;
  /** Clock for expiry checks; defaults to the system clock. */
  now?: () => Date;
  /** fetch for token refreshes and the gateways; defaults to global fetch. */
  fetch?: FetchLike;
  /** Overrides REFRESH_MARGIN_MS (tests). */
  refreshMarginMs?: number;
  /**
   * Additive: the display name in not-installed errors (config.appName),
   * so they read like the rest of the engine's. Defaults to
   * DEFAULT_APP_NAME.
   */
  appName?: string;
}

/**
 * True when `tokens` expire within `marginMs` of `now` (or carry an expiry
 * that does not parse). Tokens without an expiry never need a refresh.
 */
export function needsRefresh(
  tokens: StoredTokens,
  now: Date,
  marginMs: number = REFRESH_MARGIN_MS
): boolean {
  if (tokens.expiresAt === null) return false;
  const expiresMs = Date.parse(tokens.expiresAt);
  if (Number.isNaN(expiresMs)) return true;
  return expiresMs - now.getTime() <= marginMs;
}

// Error codes per token owner: a dead installation needs a reinstall, a
// dead session needs the person to sign in again.
type TokenOwner = 'installation' | 'session';

const DEAD_TOKEN_CODE: Record<TokenOwner, EngineAuthError['code']> = {
  installation: 'not_installed',
  session: 'not_signed_in',
};
const SESSION_EXPIRED_MESSAGE = 'Your Linear sign-in expired. Sign in again.';

/**
 * Thrown by refresh() when the grant itself is dead (invalid_grant, or an
 * expired token with no refresh token): the owner's EngineAuthError, marked
 * so forApp can tell it from "already revoked" and record the reinstall.
 */
class DeadGrantError extends EngineAuthError {}

// Whether two token sets are the same grant (both credentials equal).
function sameGrant(a: StoredTokens, b: StoredTokens): boolean {
  return a.accessToken === b.accessToken && a.refreshToken === b.refreshToken;
}

/** The real provider over stored OAuth tokens. */
export function createLinearProvider(
  options: LinearProviderOptions
): LinearProvider {
  const clock = options.now ?? ((): Date => new Date());
  const marginMs = options.refreshMarginMs ?? REFRESH_MARGIN_MS;
  const appName = options.appName ?? DEFAULT_APP_NAME;
  const notInstalled = (): EngineAuthError =>
    new EngineAuthError(
      'not_installed',
      NOT_INSTALLED_MESSAGE.missing(appName)
    );
  const lostAccess = (): EngineAuthError =>
    new EngineAuthError(
      'not_installed',
      NOT_INSTALLED_MESSAGE.lostAccess(appName)
    );
  const deadTokenMessage = (owner: TokenOwner): string =>
    owner === 'installation'
      ? NOT_INSTALLED_MESSAGE.lostAccess(appName)
      : SESSION_EXPIRED_MESSAGE;

  // Refreshes `tokens` with Linear. invalid_grant (or no refresh token at
  // all) means the grant is dead: logged at error and turned into the
  // owner's EngineAuthError. Other failures (network, 5xx) are rethrown as
  // is so the caller fails without discarding a still-valid grant.
  async function refresh(
    tokens: StoredTokens,
    owner: TokenOwner,
    log: Logger
  ): Promise<StoredTokens> {
    if (tokens.refreshToken === null) {
      log.error('linear token expired and has no refresh token', { owner });
      throw new DeadGrantError(DEAD_TOKEN_CODE[owner], deadTokenMessage(owner));
    }
    try {
      const fresh = await refreshTokens(
        options.oauth,
        tokens.refreshToken,
        options.fetch,
        // Expiry counted on the provider's clock, not the wall clock.
        { now: () => clock().getTime() }
      );
      log.info('refreshed linear tokens', {
        owner,
        expiresAt: fresh.expiresAt,
      });
      return {
        accessToken: fresh.accessToken,
        // Linear always rotates; keep the old one only if it sent none.
        refreshToken: fresh.refreshToken ?? tokens.refreshToken,
        expiresAt: fresh.expiresAt,
        scopes: fresh.scopes.length > 0 ? fresh.scopes : [...tokens.scopes],
      };
    } catch (error) {
      if (isInvalidGrant(error)) {
        log.error('linear refresh token rejected (invalid_grant)', { owner });
        throw new DeadGrantError(
          DEAD_TOKEN_CODE[owner],
          deadTokenMessage(owner)
        );
      }
      throw error;
    }
  }

  // Records a dead installation grant as revoked ('grant_dead', the
  // credentials wiped), so Settings and /setup show that a reinstall is
  // needed and the worker (listWorkspaceIds skips revoked installations)
  // stops retrying it every tick. 'grant_dead' keeps member sessions and
  // is never purged automatically: no admin asked for anything. Runs
  // after the row lock is released (the lock's transaction owns PGlite's
  // only connection), so it re-reads the row first: when a reinstall saved
  // a new grant in between, that grant is left alone; and the revoke only
  // applies while the row's last update is still the dead grant's (a
  // reinstall racing the re-read moves it). Never throws: the caller's
  // EngineAuthError is what matters.
  async function markDeadInstallation(
    workspaceId: string,
    dead: Installation,
    log: Logger
  ): Promise<void> {
    try {
      const current = await options.store.getInstallation(workspaceId);
      if (
        current === null ||
        current.revokedAt !== null ||
        !sameGrant(current.tokens, dead.tokens)
      ) {
        return;
      }
      const revoked = await options.store.revokeInstallation(
        workspaceId,
        'grant_dead',
        clock().toISOString(),
        { ifUpdatedBefore: dead.updatedAt }
      );
      if (!revoked) return;
      log.error(
        'linear installation grant is dead; marked for reinstall and skipped until then'
      );
    } catch (error) {
      log.error('could not mark the dead linear installation', { error });
    }
  }

  function gateway(accessToken: string, log: Logger): LinearGateway {
    return createLinearGateway({
      accessToken,
      fetch: options.fetch,
      logger: log,
    });
  }

  return {
    mode: 'linear',

    async forApp(workspaceId: string): Promise<LinearGateway> {
      const log = options.logger.child({ workspaceId, actor: 'app' });
      const installation = await options.store.getInstallation(workspaceId);
      if (installation === null) {
        throw notInstalled();
      }
      if (installation.revokedAt !== null) {
        log.error('linear installation is revoked; reinstall needed');
        throw lostAccess();
      }
      // A blank token is an api_key-mode binding row (or one adopted from
      // an earlier install): this OAuth process has no grant to act with.
      if (installation.tokens.accessToken === '') {
        log.error('linear installation has no token (bound by api_key mode)');
        throw lostAccess();
      }
      let tokens = installation.tokens;
      if (needsRefresh(tokens, clock(), marginMs)) {
        // The row whose grant the refresh tried, when Linear said it is
        // dead (a holder, since the lock callback sets it).
        const failed: { dead: Installation | null } = { dead: null };
        try {
          tokens = await options.store.withInstallationLock(
            workspaceId,
            async (locked) => {
              if (locked.revokedAt !== null) {
                throw lostAccess();
              }
              // Another process may have refreshed while we waited.
              if (!needsRefresh(locked.tokens, clock(), marginMs)) {
                return { result: locked.tokens };
              }
              try {
                const fresh = await refresh(locked.tokens, 'installation', log);
                return { result: fresh, tokens: fresh };
              } catch (error) {
                if (error instanceof DeadGrantError) {
                  failed.dead = locked;
                }
                throw error;
              }
            }
          );
        } catch (error) {
          if (failed.dead !== null) {
            await markDeadInstallation(workspaceId, failed.dead, log);
          }
          if (isStoreNotFoundError(error, 'installation')) {
            throw notInstalled();
          }
          throw error;
        }
      }
      return gateway(tokens.accessToken, log);
    },

    // Actor.session carries redacted tokens (see auth.ts), so the session's
    // tokens are always read from its row, under the lock that also guards
    // a refresh.
    async forSession(session: Session): Promise<LinearGateway> {
      const log = options.logger.child({
        workspaceId: session.workspaceId,
        userId: session.userId,
        actor: 'user',
      });
      let tokens: StoredTokens;
      try {
        tokens = await options.store.withSessionLock(
          session.id,
          async (locked) => {
            if (!needsRefresh(locked.tokens, clock(), marginMs)) {
              return { result: locked.tokens };
            }
            const fresh = await refresh(locked.tokens, 'session', log);
            return { result: fresh, tokens: fresh };
          }
        );
      } catch (error) {
        // The store throws StoreNotFoundError before calling us when the
        // row is gone (signed out elsewhere, or expired and cleaned up).
        if (isStoreNotFoundError(error, 'session')) {
          throw new EngineAuthError('not_signed_in', 'Sign in again.');
        }
        throw error;
      }
      return gateway(tokens.accessToken, log);
    },
  };
}

/**
 * The demo-mode provider: gateways over one shared in-memory FixtureStore.
 * The app actor writes as the fixture's app user, a session as its user.
 * Any other workspace id reads as not installed.
 */
export function createFixtureLinearProvider(
  fixture: FixtureStore
): LinearProvider {
  function check(workspaceId: string): void {
    if (workspaceId !== fixture.data.workspaceId) {
      throw new EngineAuthError(
        'not_installed',
        'The demo workspace is the only workspace in demo mode.'
      );
    }
  }
  return {
    mode: 'fixture',
    forApp(workspaceId: string): Promise<LinearGateway> {
      return new Promise((resolve) => {
        check(workspaceId);
        resolve(createFixtureGateway(fixture, { kind: 'app' }));
      });
    },
    forSession(session: Session): Promise<LinearGateway> {
      return new Promise((resolve) => {
        check(session.workspaceId);
        resolve(
          createFixtureGateway(fixture, {
            kind: 'user',
            userId: session.userId,
          })
        );
      });
    },
  };
}
