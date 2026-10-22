'use client';

import type { ReactNode } from 'react';

import { Link } from '../lib/link';
import styles from './alert-strip.module.css';
import type { AlertStripProps } from './types';

/* Gr8r's alert: a lead-in word and one sentence, with an optional
   follow-up ("Overdue by 3 days. Reschedule"), in a box tinted by `tone`
   (data-tone, docs/architecture.md §8.2): the tone's soft fill with the
   lead-in and follow-up in its text colour, or a bordered neutral box for
   default / muted. The follow-up is a link when it goes somewhere and a
   button when it acts in place (e.g. focusing the date field). */
export default function AlertStrip({
  label = 'Alert',
  tone = 'warning',
  children,
  action,
}: AlertStripProps): ReactNode {
  return (
    <div className={styles.strip} data-tone={tone}>
      <span className={styles.key}>{label}</span>
      <p className={styles.text}>
        {children}
        {action !== undefined ? (
          <>
            {' '}
            {action.href !== undefined ? (
              <Link
                href={action.href}
                className={styles.action}
                onClick={action.onClick}
              >
                {action.label}
              </Link>
            ) : (
              <button
                type="button"
                className={styles.action}
                onClick={action.onClick}
              >
                {action.label}
              </button>
            )}
          </>
        ) : null}
      </p>
    </div>
  );
}
