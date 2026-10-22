// Permission checks shared by the engine's write operations. The UI never
// decides permissions; these run on the server for each request. There are
// no roles (owner decision 2026-10-22): any signed-in person may make every
// edit, and only an edit written to Linear needs requireWriteScope, since it
// goes out with that person's own token. The one exception comes from
// Linear itself: a Linear guest is read-only (owner decision 2026-10-22,
// "Guests limited to read only"), and requireWritable is the single guard
// every mutating engine method calls first (engine.ts lists them).

import { type Actor, EngineAuthError } from './types';

/** What a read-only person (a Linear guest) is told when they try a change. */
export const READ_ONLY_MESSAGE =
  'Guests in Linear can look but not change anything here.';

/**
 * Throws EngineAuthError('read_only') when the actor is read-only (a
 * Linear guest, or someone the mirror does not know: Actor.readOnly). The
 * first check of every engine method that changes something for a person,
 * and of the web routes that start actor-less jobs for one (resync, the
 * digest preview), so a guest can look but never change anything.
 */
export function requireWritable(actor: Actor): void {
  if (actor.readOnly) {
    throw new EngineAuthError('read_only', READ_ONLY_MESSAGE);
  }
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
