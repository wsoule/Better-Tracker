// Permission checks shared by every PM-only operation. The UI never decides
// permissions; these run on the server for each request.

import { type Actor, EngineAuthError } from './types';

/** Throws EngineAuthError('not_pm') unless the actor is a configured PM. */
export function requirePm(actor: Actor): void {
  if (!actor.isPm) {
    throw new EngineAuthError(
      'not_pm',
      'Only PMs can change milestones, project leads and settings.'
    );
  }
}

/**
 * Throws EngineAuthError('needs_write_scope') unless the actor's Linear
 * token may write, so Linear edits are attributed to the person making them.
 */
export function requireWriteScope(actor: Actor): void {
  if (!actor.canWriteLinear) {
    throw new EngineAuthError(
      'needs_write_scope',
      'Allow the planner to edit Linear on your behalf first (grant write access).'
    );
  }
}
