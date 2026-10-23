// The read-only planner's copy (owner decision 2026-10-22, "Guests limited
// to read only"): a Linear guest sees what Linear lets them see, and every
// place that would offer an edit, a run, a resync or a preview shows this
// one quiet notice instead. Plain strings, so server pages, client islands
// and the adapters' tests share them.

import type { ReadOnlyReason } from '@better-tracker/engine';

/** The notice's lead-in word. */
export const READ_ONLY_LABEL = 'Read only';

/** The notice's sentence, the same everywhere. */
export const READ_ONLY_NOTICE =
  'You are a guest in Linear, so this view is read-only.';

/** Why the planner is read-only for someone (Actor.readOnlyReason). */
export type ReadOnlyReasonCopy = ReadOnlyReason;

/** The headline every page shows while the first sync has not landed. */
export const FIRST_SYNC_PENDING_HEADLINE =
  'The first sync from Linear has not landed yet.';

/** api_key mode: the planner has no copy of Linear and no member's key to read one. */
export const API_KEY_NOT_SYNCED_NOTICE =
  "The planner has no copy of Linear yet. It reads Linear with a workspace member's key: once a member connects, reload.";

/** api_key mode: Linear refused a write as out of the key's scope. */
export const READ_ONLY_KEY_NOTICE =
  'Your Linear API key only allows reading, so you can look but not change anything here. Connect a key with Write access to edit.';

/**
 * The notice's sentence for a reason: a Linear guest is told they are one
 * (READ_ONLY_NOTICE); someone the mirror does not know yet, and everyone
 * in a workspace whose first sync has not landed, are told what is
 * actually going on instead of being called a guest. With personal API
 * keys (`apiKeyMode`) a read-only key says so, and "no copy yet" says a
 * member has to connect instead of mentioning a reinstall.
 */
export function readOnlyNotice(
  reason: ReadOnlyReasonCopy | undefined,
  options: { apiKeyMode?: boolean } = {}
): string {
  switch (reason) {
    case 'unknown':
      return 'The planner has not seen your Linear account yet, so this view is read-only until a sync from Linear includes you.';
    case 'not_synced':
      return options.apiKeyMode === true
        ? API_KEY_NOT_SYNCED_NOTICE
        : `${FIRST_SYNC_PENDING_HEADLINE} Changes are paused until it does; reload in a minute, and if this stays, a workspace admin can reinstall from Setup.`;
    case 'read_only_key':
      return READ_ONLY_KEY_NOTICE;
    default:
      return READ_ONLY_NOTICE;
  }
}
