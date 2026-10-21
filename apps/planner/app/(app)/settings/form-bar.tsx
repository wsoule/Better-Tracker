'use client';

import { Button } from '@better-tracker/ui';

import css from './page.module.css';

/* The foot of a section form: Save and Reset, and a line saying whether
   anything is unsaved (or why it cannot be saved yet). */
export default function FormBar({
  dirty,
  saving,
  blocked,
  onReset,
}: {
  dirty: boolean;
  saving: boolean;
  /** Why Save is off despite changes (a field to fix), or null. */
  blocked?: string | null;
  onReset: () => void;
}) {
  const status = saving
    ? 'Saving…'
    : blocked != null && blocked !== ''
      ? blocked
      : dirty
        ? 'Unsaved changes'
        : 'No changes';
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
        onClick={onReset}
      >
        Reset
      </Button>
      <p
        className={dirty && !saving ? css.formStatusDirty : css.formStatus}
        aria-live="polite"
      >
        {status}
      </p>
    </div>
  );
}
