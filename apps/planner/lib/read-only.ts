// The read-only planner's copy (owner decision 2026-10-22, "Guests limited
// to read only"): a Linear guest sees what Linear lets them see, and every
// place that would offer an edit, a run, a resync or a preview shows this
// one quiet notice instead. Plain strings, so server pages, client islands
// and the adapters' tests share them.

/** The notice's mono key. */
export const READ_ONLY_LABEL = 'Read only';

/** The notice's sentence, the same everywhere. */
export const READ_ONLY_NOTICE =
  'You are a guest in Linear, so this view is read-only.';
