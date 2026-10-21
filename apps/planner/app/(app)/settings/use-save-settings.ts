'use client';

import { useToast } from '@better-tracker/ui';
import { useRouter } from 'next/navigation';
import {
  type RefObject,
  useCallback,
  useRef,
  useState,
  useTransition,
} from 'react';

import {
  RESET_OUTCOME,
  type SaveOutcome,
} from '../../../lib/adapters/settings';
import { sendJson } from '../../../lib/api-client';

/** A refused save: the route's error code and its sentence. */
export interface SaveError {
  code: string;
  message: string;
}

/**
 * Saving one settings section: PATCH /api/settings with that section's
 * fields only, a toast either way, then router.refresh() so every server
 * view (and the shell) re-reads the saved settings. `saving` stays true
 * until that refresh has landed, so the form never shows the old values
 * as "unsaved" in between.
 *
 * Keyboard focus: Save (and the fields) disable while saving, which would
 * drop focus to <body>, so the save first moves focus to the form's status
 * line (`statusRef`, a tabIndex=-1 live region) and the line then says
 * how it went. `onError` may claim a refusal (return true) to show it on
 * its field instead of in a toast. Resolves true when the save went
 * through. `discarded` records a Reset, so the line (which Reset also
 * focuses) says "Changes discarded" rather than the last save's "Saved".
 */
export function useSaveSettings(label: string): {
  saving: boolean;
  outcome: SaveOutcome | null;
  statusRef: RefObject<HTMLParagraphElement | null>;
  save: (
    patch: Record<string, unknown>,
    savedMessage: string,
    onError?: (error: SaveError) => boolean
  ) => Promise<boolean>;
  discarded: () => void;
} {
  const router = useRouter();
  const { toast } = useToast();
  const [sending, setSending] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [outcome, setOutcome] = useState<SaveOutcome | null>(null);
  const statusRef = useRef<HTMLParagraphElement | null>(null);
  const save = useCallback(
    async (
      patch: Record<string, unknown>,
      savedMessage: string,
      onError?: (error: SaveError) => boolean
    ) => {
      setSending(true);
      setOutcome(null);
      statusRef.current?.focus();
      const result = await sendJson('PATCH', '/api/settings', patch);
      setSending(false);
      if (!result.ok) {
        if (
          onError?.({ code: result.code, message: result.message }) === true
        ) {
          return false;
        }
        setOutcome({ kind: 'error', text: `Not saved: ${result.message}` });
        toast({ kind: 'error', label, message: result.message });
        return false;
      }
      setOutcome({ kind: 'saved', text: 'Saved' });
      toast({ kind: 'info', label, message: savedMessage });
      startRefresh(() => router.refresh());
      return true;
    },
    [label, router, toast]
  );
  const discarded = useCallback(() => setOutcome(RESET_OUTCOME), []);
  return { saving: sending || refreshing, outcome, statusRef, save, discarded };
}
