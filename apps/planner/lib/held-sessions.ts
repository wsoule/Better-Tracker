import type { Engine, SessionDescription } from '@better-tracker/engine';

import {
  type CookieScheme,
  type CookieSource,
  MAX_STASHED_SESSIONS,
  activeSessionToken,
  sessionCookies,
  stashTokens,
} from './session-cookies';

// The sessions one browser holds (OAuth mode, owner decision 2026-10-25):
// the active cookie's and the stash's, described by the engine in one
// store query (engine.describeSessions: no Linear call, no credential),
// and how a sign-in, a switch or a sign-out rearranges them. The
// arrangements are pure, so the routes' rules are unit-tested without the
// engine: whatever an arrangement leaves out of the cookies is in its
// `signOut` list, and the routes end those sessions (revoking their
// Linear grants) in after(), so no grant outlives its cookie.
//
// A HeldSessions value carries session tokens: it is for route handlers
// and server components only, and nothing built from it for the browser
// (the shell frame, the landing page) may include a token.

/** The fields of a held session an arrangement needs. */
export interface CookieSession {
  token: string;
  workspaceId: string;
  expiresAt: string;
}

/** What this browser's cookies hold, as the engine sees it now. */
export interface HeldSessions {
  /** The active cookie's token as sent (undefined when there is none). */
  activeToken: string | undefined;
  /** The active cookie's session, when it is live and admitted. */
  active: SessionDescription | null;
  /**
   * The stash's live sessions, most recently active first: one per
   * workspace, never the active session's workspace.
   */
  stash: SessionDescription[];
  /**
   * Tokens the cookies hold that name no live session here (expired, ended,
   * refused by admission, or a second session for a workspace already
   * held): an arrangement leaves them out and signs them out.
   */
  dropped: string[];
}

/** No sessions: what a browser without cookies holds. */
export const NO_HELD_SESSIONS: HeldSessions = {
  activeToken: undefined,
  active: null,
  stash: [],
  dropped: [],
};

/**
 * Reads and describes the browser's sessions. Outside OAuth mode there is
 * no stash and describeSessions answers nothing, so only `activeToken` is
 * set (demo and api_key mode hold one session).
 */
export async function readHeldSessions(
  engine: Pick<Engine, 'describeSessions'>,
  source: CookieSource,
  scheme: CookieScheme
): Promise<HeldSessions> {
  const activeToken = activeSessionToken(source, scheme);
  if (scheme.mode !== 'oauth') {
    return { ...NO_HELD_SESSIONS, activeToken };
  }
  const stashed = stashTokens(source, scheme);
  const tokens =
    activeToken === undefined ? stashed : [activeToken, ...stashed];
  if (tokens.length === 0) return { ...NO_HELD_SESSIONS };
  const described = await engine.describeSessions(tokens);
  const dropped: string[] = [];
  const seen = new Set<string>();
  let active: SessionDescription | null = null;
  const stash: SessionDescription[] = [];
  for (const [index, token] of tokens.entries()) {
    const entry = described[index] ?? null;
    if (
      entry === null ||
      entry.token !== token ||
      seen.has(entry.workspaceId)
    ) {
      dropped.push(token);
      continue;
    }
    seen.add(entry.workspaceId);
    if (index === 0 && activeToken !== undefined) active = entry;
    else stash.push(entry);
  }
  return { activeToken, active, stash, dropped };
}

/** Every live held session, the active one first. */
export function allHeld(held: HeldSessions): SessionDescription[] {
  return held.active === null ? held.stash : [held.active, ...held.stash];
}

/** The held live session for a workspace, active or stashed. */
export function heldFor(
  held: HeldSessions,
  workspaceId: string
): SessionDescription | null {
  return allHeld(held).find((s) => s.workspaceId === workspaceId) ?? null;
}

/** How many workspaces the browser holds a live session for. */
export function heldCount(held: HeldSessions): number {
  return allHeld(held).length;
}

/** The cookies' sessions after a change, and the tokens it leaves out. */
export interface Arrangement {
  active: CookieSession | null;
  /** Most recently active first, at most MAX_STASHED_SESSIONS. */
  stash: CookieSession[];
  /** Tokens to sign out (in after()): none of them is in the cookies. */
  signOut: string[];
}

/**
 * Makes `next` the active session (a sign-in, a switch, an install by a
 * stashed session): the previous active one goes first in the stash, any
 * other session held for next's workspace is left out (a sign-in again
 * replaces it), and the stash keeps the 9 most recent (the oldest beyond
 * them are signed out, not just dropped).
 */
export function activate(held: HeldSessions, next: CookieSession): Arrangement {
  const signOut = held.dropped.filter((token) => token !== next.token);
  const stash: CookieSession[] = [];
  for (const session of allHeld(held)) {
    if (session.token === next.token) continue;
    if (session.workspaceId === next.workspaceId) {
      signOut.push(session.token);
      continue;
    }
    stash.push(session);
  }
  for (const overflow of stash.slice(MAX_STASHED_SESSIONS)) {
    signOut.push(overflow.token);
  }
  return {
    active: next,
    stash: stash.slice(0, MAX_STASHED_SESSIONS),
    signOut,
  };
}

/**
 * Leaves one held session out (sign-out of one workspace; a switch target
 * whose session ended): when it was the active one, the most recently
 * active stashed session takes its place. `token` itself is not in the
 * result's signOut list: the caller ends it (inline, or in after()).
 */
export function without(held: HeldSessions, token: string): Arrangement {
  const signOut = held.dropped.filter((dropped) => dropped !== token);
  const stash = held.stash.filter((session) => session.token !== token);
  if (held.active === null || held.active.token !== token) {
    return { active: held.active, stash, signOut };
  }
  const [promoted = null, ...rest] = stash;
  return { active: promoted, stash: rest, signOut };
}

/** The held sessions as they are, minus what no longer names a session. */
export function unchanged(held: HeldSessions): Arrangement {
  return {
    active: held.active,
    stash: [...held.stash],
    signOut: [...held.dropped],
  };
}

/** The Set-Cookie headers for an arrangement (OAuth and demo mode). */
export function arrangementCookies(
  arrangement: Arrangement,
  scheme: CookieScheme,
  nowMs: number
): string[] {
  return sessionCookies(
    { active: arrangement.active, stash: arrangement.stash },
    scheme,
    nowMs
  );
}
