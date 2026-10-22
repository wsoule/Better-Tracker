'use client';

import { X } from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from 'react';

import styles from './bulk-bar.module.css';
import type { BulkBarProps } from './types';

/* Gr8r's bulk bar (.bulkbar in task-list.js): an inverted toolbar that
   springs up at the bottom centre while rows are selected. "{n} selected",
   the host's action triggers (pickers with appearance 'bar'), then ✕.

   - The count is a polite live region; while a change is being sent its
     place says so ("Moving 12 issues…") and the actions are disabled
     (they sit in a <fieldset>, so every host control in it is disabled
     natively). A `note` ("At most 100 at a time") disables them too.
   - `confirm` replaces the actions with an inline confirmation: the
     sentence, a primary button that takes focus, and Cancel. When the
     confirmation goes, focus returns to the first action.
   - Esc anywhere in the bar (a picker inside handles its own Esc first)
     clears the selection; the host then puts focus back in the list.
     ← and → move between the bar's buttons.
   - While it is up, the toasts stack above it (its height is published
     as --bulk-bar-h on the root element). */
export function BulkBar({
  count,
  countLabel,
  children,
  onClear,
  clearLabel = 'Clear selection',
  busy = null,
  note = null,
  confirm = null,
  label,
}: BulkBarProps): ReactNode {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<HTMLFieldSetElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const confirming = confirm !== null;
  const wasConfirming = useRef(false);

  // Into the confirmation: its primary button. Out of it (Cancel, or the
  // host dropping it): the first action, when focus was in the bar or
  // fell to <body> with the strip's buttons.
  // While the bar is up, the toasts stack above it (toast.module.css reads
  // --bulk-bar-h on the root element): an Undo toast must not cover the
  // selection's actions or ✕. The height follows the bar (a confirmation
  // can wrap on a phone).
  const shown = count > 0;
  useEffect(() => {
    const bar = barRef.current;
    if (!shown || bar === null) return undefined;
    const root = document.documentElement;
    const measure = () => {
      root.style.setProperty(
        '--bulk-bar-h',
        `${Math.round(bar.getBoundingClientRect().height)}px`
      );
    };
    measure();
    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(bar);
    return () => {
      observer?.disconnect();
      root.style.removeProperty('--bulk-bar-h');
    };
  }, [shown]);

  useEffect(() => {
    if (confirming && !wasConfirming.current) {
      confirmRef.current?.focus();
    } else if (!confirming && wasConfirming.current) {
      const active = document.activeElement;
      const inBar =
        active === null ||
        active === document.body ||
        barRef.current?.contains(active) === true;
      if (inBar) {
        actionsRef.current
          ?.querySelector<HTMLElement>('button:not(:disabled)')
          ?.focus();
      }
    }
    wasConfirming.current = confirming;
  }, [confirming]);

  if (count <= 0) return null;

  const isBusy = busy !== null && busy !== '';
  const hasNote = note !== null && note !== '';
  const name =
    label ??
    `Actions for ${count} selected ${count === 1 ? 'issue' : 'issues'}`;

  // Esc clears (or cancels the confirmation); ← and → move between the
  // bar's own buttons, as in any toolbar. Keys inside an open picker are
  // the picker's.
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    if (target.closest('[data-picker-popup]') !== null) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (confirm !== null) confirm.onCancel();
      else onClear();
      return;
    }
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const buttons = Array.from(
      barRef.current?.querySelectorAll<HTMLButtonElement>(
        'button:not(:disabled)'
      ) ?? []
    ).filter((button) => button.closest('[data-picker-popup]') === null);
    const at = buttons.indexOf(target as HTMLButtonElement);
    if (at < 0) return;
    const next = buttons[at + (event.key === 'ArrowRight' ? 1 : -1)];
    if (next !== undefined) {
      event.preventDefault();
      next.focus();
    }
  }

  return (
    <div
      ref={barRef}
      className={styles.bar}
      role="toolbar"
      aria-label={name}
      data-bulk-bar="true"
      data-busy={isBusy ? 'true' : undefined}
      onKeyDown={onKeyDown}
    >
      <span className={styles.count} role="status">
        {isBusy ? busy : (countLabel ?? `${count} selected`)}
      </span>
      <span className={styles.sep} aria-hidden="true" />
      {confirm !== null ? (
        <span className={styles.confirm}>
          <span className={styles.message}>{confirm.message}</span>
          <span className={styles.confirmActions}>
            <button
              ref={confirmRef}
              type="button"
              className={styles.primary}
              onClick={confirm.onConfirm}
            >
              {confirm.confirmLabel}
            </button>
            <button
              type="button"
              className={styles.ghost}
              onClick={confirm.onCancel}
            >
              {confirm.cancelLabel ?? 'Cancel'}
            </button>
          </span>
        </span>
      ) : (
        <>
          <fieldset
            ref={actionsRef}
            className={styles.actions}
            disabled={isBusy || hasNote}
          >
            {children}
          </fieldset>
          {hasNote ? <span className={styles.note}>{note}</span> : null}
        </>
      )}
      <span className={styles.sep} aria-hidden="true" />
      <button
        type="button"
        className={styles.close}
        aria-label={clearLabel}
        title={clearLabel}
        onClick={onClear}
      >
        <X size={14} strokeWidth={1.8} aria-hidden="true" />
      </button>
    </div>
  );
}
