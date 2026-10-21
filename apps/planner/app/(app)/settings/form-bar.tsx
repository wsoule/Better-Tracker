'use client';

import { Button } from '@better-tracker/ui';
import type { RefObject } from 'react';

import {
  formStatusText,
  type SaveOutcome,
} from '../../../lib/adapters/settings';
import css from './page.module.css';

/* The foot of a section form: Save and Reset, and a line saying whether
   anything is unsaved, why it cannot be saved yet, or how the last save
   went. Both buttons disable once nothing is unsaved, so the status line
   (a live region that takes focus, tabIndex=-1) is where keyboard focus
   goes on save (useSaveSettings) and on reset, instead of falling to
   <body>. */
export default function FormBar({
  dirty,
  saving,
  blocked = null,
  outcome = null,
  statusRef,
  onReset,
  onDiscarded,
}: {
  dirty: boolean;
  saving: boolean;
  /** Why Save is off despite changes (a field to fix), or null. */
  blocked?: string | null;
  /** How the last save went (from useSaveSettings). */
  outcome?: SaveOutcome | null;
  statusRef: RefObject<HTMLParagraphElement | null>;
  onReset: () => void;
  /** useSaveSettings' `discarded`: the line then says "Changes discarded". */
  onDiscarded: () => void;
}) {
  return (
    <div className={css.formBar}>
      <Button
        type="submit"
        variant="primary"
        size="sm"
        disabled={!dirty || saving}
      >
        {saving ? 'Saving…' : 'Save'}
      </Button>
      <Button
        variant="quiet"
        size="sm"
        disabled={!dirty || saving}
        onClick={() => {
          onReset();
          onDiscarded();
          statusRef.current?.focus();
        }}
      >
        Reset
      </Button>
      <p
        ref={statusRef}
        tabIndex={-1}
        className={dirty && !saving ? css.formStatusDirty : css.formStatus}
        aria-live="polite"
      >
        {formStatusText({ dirty, saving, blocked, outcome })}
      </p>
    </div>
  );
}
