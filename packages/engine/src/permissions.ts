// Permission checks shared by the engine's write operations. The UI never
// decides permissions; these run on the server for each request. There are
// no roles (owner decision 2026-10-22): any signed-in person may make every
// edit, and only an edit written to Linear needs requireWriteScope, since it
// goes out with that person's own token.

import { type Actor, EngineAuthError } from './types';

/**
 * Throws EngineAuthError('needs_write_scope') unless the actor's Linear
 * token may write, so Linear edits are attributed to the person making
 * them. Anyone signed in can get write scope (the grant_write upgrade).
 */
export function requireWriteScope(actor: Actor): void {
  if (!actor.canWriteLinear) {
    throw new EngineAuthError(
      'needs_write_scope',
      'Allow the planner to edit Linear on your behalf first (grant write access).'
    );
  }
}
