'use client';

import { Notice } from '@better-tracker/ui';
import { createContext, type ReactNode, useContext } from 'react';

import {
  READ_ONLY_LABEL,
  type ReadOnlyReasonCopy,
  readOnlyNotice,
} from '../../../lib/read-only';

/* Why the signed-in person is read-only (Actor.readOnlyReason), provided
   once by the planner shell so every notice below it can say so without
   threading the reason through each page's model. Without a provider (a
   test rendering one screen) the notice reads as for a Linear guest. */
const ReadOnlyReasonContext = createContext<ReadOnlyReasonCopy | undefined>(
  undefined
);

export function ReadOnlyReasonProvider({
  reason,
  children,
}: {
  reason: ReadOnlyReasonCopy | undefined;
  children: ReactNode;
}) {
  return (
    <ReadOnlyReasonContext.Provider value={reason}>
      {children}
    </ReadOnlyReasonContext.Provider>
  );
}

/** Actor.readOnlyReason as the shell provided it (undefined when not
    read-only, or outside the shell). */
export function useReadOnlyReason(): ReadOnlyReasonCopy | undefined {
  return useContext(ReadOnlyReasonContext);
}

/* The one quiet notice a read-only person sees where edits, runs or
   previews would be (owner decision 2026-10-22, "Guests limited to read
   only"). The routes and the engine refuse their changes whatever the
   page shows. */
export default function ReadOnlyNotice() {
  const reason = useReadOnlyReason();
  return (
    <Notice label={READ_ONLY_LABEL} tone="default">
      {readOnlyNotice(reason)}
    </Notice>
  );
}
