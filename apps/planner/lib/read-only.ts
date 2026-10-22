// The read-only planner's copy (owner decision 2026-10-22, "Guests limited
// to read only"): a Linear guest sees what Linear lets them see, and every
// place that would offer an edit, a run, a resync or a preview shows this
// one quiet notice instead. Plain strings, so server pages, client islands
// and the adapters' tests share them.

import type { ReadOnlyReason } from '@better-tracker/engine';

/** The notice's mono key. */
export const READ_ONLY_LABEL = 'Read only';

/** The notice's sentence, the same everywhere. */
export const READ_ONLY_NOTICE =
  'You are a guest in Linear, so this view is read-only.';

/** Why the planner is read-only for someone (Actor.readOnlyReason). */
export type ReadOnlyReasonCopy = ReadOnlyReason;

/** The headline every page shows while the first sync has not landed. */
export const FIRST_SYNC_PENDING_HEADLINE =
  'The first sync from Linear has not landed yet.';

/**
 * The notice's sentence for a reason: a Linear guest is told they are one
 * (READ_ONLY_NOTICE); someone the mirror does not know yet, and everyone
 * in a workspace whose first sync has not landed, are told what is
 * actually going on instead of being called a guest.
 */
export function readOnlyNotice(reason: ReadOnlyReasonCopy | undefined): string {
  switch (reason) {
    case 'unknown':
      return 'The planner has not seen your Linear account yet, so this view is read-only until a sync from Linear includes you.';
    case 'not_synced':
      return `${FIRST_SYNC_PENDING_HEADLINE} Changes are paused until it does; reload in a minute, and if this stays, a workspace admin can reinstall from Setup.`;
    default:
      return READ_ONLY_NOTICE;
  }
}
