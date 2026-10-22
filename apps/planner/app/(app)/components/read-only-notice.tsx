import { Notice } from '@better-tracker/ui';

import { READ_ONLY_LABEL, READ_ONLY_NOTICE } from '../../../lib/read-only';

/* The one quiet notice a Linear guest sees where edits, runs or previews
   would be (owner decision 2026-10-22, "Guests limited to read only"):
   static copy, so it needs no role. The routes and the engine refuse a
   guest's changes whatever the page shows. */
export default function ReadOnlyNotice() {
  return (
    <Notice label={READ_ONLY_LABEL} tone="default">
      {READ_ONLY_NOTICE}
    </Notice>
  );
}
