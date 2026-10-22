// Permission checks shared by the engine's write operations. The UI never
// decides permissions; these run on the server for each request. There are
// no roles (owner decision 2026-10-22): any signed-in person may make every
// edit, and only an edit written to Linear needs requireWriteScope, since it
// goes out with that person's own token. The one exception comes from
// Linear itself: a Linear guest is read-only (owner decision 2026-10-22,
// "Guests limited to read only"), and requireWritable is the single guard
// every mutating engine method calls first (engine.ts lists them).

import { type Actor, EngineAuthError, type ReadOnlyReason } from './types';

/** What a read-only person (a Linear guest) is told when they try a change. */
export const READ_ONLY_MESSAGE =
  'Guests in Linear can look but not change anything here.';

/** What a read-only person is told, per Actor.readOnlyReason. */
const READ_ONLY_MESSAGES: Record<ReadOnlyReason, string> = {
  guest: READ_ONLY_MESSAGE,
  unknown:
    'The planner has not seen your Linear account yet, so you can look but not change anything until a sync from Linear includes you.',
  not_synced:
    'The first sync from Linear has not landed yet, so changes are paused until it does.',
};

/**
 * Throws EngineAuthError('read_only') when the actor is read-only (a
 * Linear guest, or someone the mirror does not know: Actor.readOnly). The
 * first check of every engine method that changes something for a person,
 * and of the web routes that start actor-less jobs for one (resync, the
 * digest preview), so a guest can look but never change anything.
 */
export function requireWritable(actor: Actor): void {
  if (actor.readOnly) {
    throw new EngineAuthError(
      'read_only',
      READ_ONLY_MESSAGES[actor.readOnlyReason ?? 'guest']
    );
  }
}

/**
 * The guard on finishInstall: requireWritable, except that a workspace
 * whose first sync has not landed (readOnlyReason `not_synced`) can still
 * be installed again. Nobody can be placed without a mirror, but a
 * reinstall is how an admin fixes a grant that makes that sync fail, and
 * Linear lets only a workspace admin approve an actor=app install.
 */
export function requireCanInstall(actor: Actor): void {
  if (actor.readOnlyReason === 'not_synced') return;
  requireWritable(actor);
}

/**
 * Throws EngineAuthError('needs_write_scope') unless the actor's Linear
 * token may write, so Linear edits are attributed to the person making
 * them. Anyone signed in but a guest can get write scope (the grant_write
 * upgrade).
 */
export function requireWriteScope(actor: Actor): void {
  if (!actor.canWriteLinear) {
    throw new EngineAuthError(
      'needs_write_scope',
      'Allow the planner to edit Linear on your behalf first (grant write access).'
    );
  }
}
