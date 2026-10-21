'use client';

import { X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';

import {
  PHONE_QUERY,
  REDUCED_MOTION_QUERY,
  trapTab,
  useDialogFocus,
  useMediaQuery,
  useScrollLock,
} from './dom';
import styles from './slide-over.module.css';
import type { SlideOverProps } from './types';

const EXIT_MS = 320;

/**
 * Gr8r's slide-over drawer in the Analytics skin: a right-hand panel
 * (min(560px, 100vw)) with a 2px accent left rule, a hatched header bar
 * (breadcrumb, actions, close) above the title, and a scrolling body.
 *
 * Desktop: no scrim, the page stays usable beside it (clicking another row
 * can swap its content), while Tab cycles inside the panel. Phone: a scrim
 * and a scroll lock make it modal. Esc closes from anywhere; focus returns
 * to whatever opened it. It stays mounted for the exit slide, then unmounts.
 */
export default function SlideOver({
  open,
  onClose,
  title,
  breadcrumb,
  actions,
  closeLabel = 'Close',
  initialFocusRef,
  children,
}: SlideOverProps): ReactNode {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const isPhone = useMediaQuery(PHONE_QUERY);
  const reduceMotion = useMediaQuery(REDUCED_MOTION_QUERY);

  // Mounted while open and during the exit animation. Set during render
  // (not in an effect) so the first open frame already has the panel.
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true);
  const closing = present && !open;

  useEffect(() => {
    if (!closing) return undefined;
    const timer = setTimeout(
      () => setPresent(false),
      reduceMotion ? 0 : EXIT_MS
    );
    return () => clearTimeout(timer);
  }, [closing, reduceMotion]);

  useDialogFocus(panelRef, open, initialFocusRef);
  useScrollLock(open && isPhone);

  // Esc closes from anywhere on the page, unless something nearer (the
  // palette, an open menu) already handled it.
  useEffect(() => {
    if (!open) return undefined;
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!present) return null;

  return (
    <>
      {isPhone ? (
        <div
          className={styles.scrim}
          data-state={closing ? 'closing' : 'open'}
          aria-hidden="true"
          onClick={onClose}
        />
      ) : null}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal={isPhone ? 'true' : undefined}
        aria-labelledby={titleId}
        aria-hidden={closing ? 'true' : undefined}
        inert={closing}
        tabIndex={-1}
        className={styles.panel}
        data-state={closing ? 'closing' : 'open'}
        onKeyDown={(event) => {
          if (panelRef.current !== null) trapTab(event, panelRef.current);
        }}
        onAnimationEnd={(event) => {
          if (closing && event.target === event.currentTarget)
            setPresent(false);
        }}
      >
        <header className={styles.header}>
          <div className={styles.bar}>
            <div className={styles.crumb}>{breadcrumb}</div>
            <div className={styles.actions}>
              {actions}
              <button
                type="button"
                className={styles.close}
                aria-label={closeLabel}
                title={`${closeLabel} (Esc)`}
                onClick={onClose}
              >
                <X size={16} strokeWidth={1.5} aria-hidden="true" />
              </button>
            </div>
          </div>
          <h2 id={titleId} className={styles.title}>
            {title}
          </h2>
        </header>
        <div className={styles.body}>{children}</div>
      </div>
    </>
  );
}
