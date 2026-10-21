'use client';

import { X } from 'lucide-react';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';

import { saveErrorMessage } from '../edit/save-state';
import styles from './task-relation-list.module.css';

/**
 * A relation row's remove button. When `onRemove` returns a promise the
 * button is busy (and the row muted) until it settles; a rejection prints
 * its message under the row. When the removal lands the row goes away, and
 * focus moves to a neighbouring row's remove button instead of being lost
 * with it.
 */
export function RelationRemoveButton({
  taskKey,
  removeLabel,
  notSavedLabel,
  onRemove,
}: {
  taskKey: string;
  removeLabel: string;
  notSavedLabel: string;
  onRemove: () => void | Promise<unknown>;
}): ReactNode {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const mounted = useRef(true);

  // Runs while the row is still in the document (layout cleanups precede
  // the DOM removal), so the neighbours can still be found.
  useLayoutEffect(() => {
    mounted.current = true;
    const button = buttonRef.current;
    return () => {
      mounted.current = false;
      if (button === null || document.activeElement !== button) return;
      const item = button.closest('li');
      const pick = (sibling: Element | null | undefined) =>
        sibling?.querySelector<HTMLButtonElement>('[data-relation-remove]');
      const next =
        pick(item?.nextElementSibling) ?? pick(item?.previousElementSibling);
      next?.focus({ preventScroll: true });
    };
  }, []);

  function remove(): void {
    if (pending) return;
    setError(null);
    let result: void | Promise<unknown>;
    try {
      result = onRemove();
    } catch (thrown) {
      result = Promise.reject(thrown);
    }
    if (result === undefined) return;
    setPending(true);
    void result.then(
      () => {
        if (mounted.current) setPending(false);
      },
      (rejection: unknown) => {
        if (!mounted.current) return;
        setPending(false);
        setError(saveErrorMessage(rejection, 'Could not remove.'));
      }
    );
  }

  const name = `${removeLabel} ${taskKey}`;
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={styles.remove}
        aria-label={name}
        title={name}
        // aria-disabled, not disabled: the button keeps focus while busy.
        aria-disabled={pending ? 'true' : undefined}
        aria-busy={pending ? 'true' : undefined}
        data-relation-remove=""
        onClick={remove}
      >
        <X size={14} strokeWidth={1.5} aria-hidden="true" />
      </button>
      {error !== null ? (
        <span className={styles.removeError} role="alert">
          <span className={styles.removeErrorKey}>{notSavedLabel}</span>
          <span dir="auto">{error}</span>
        </span>
      ) : null}
    </>
  );
}
