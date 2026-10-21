'use client';

import type { ReactNode } from 'react';

import { Link } from '../lib/link';
import styles from './alert-strip.module.css';
import type { AlertStripProps } from './types';

/* The explain-panel idiom from the competitors site: a 2px accent frame,
   a mono key and one sentence, with an optional follow-up ("Overdue by 3
   days. Reschedule"). The follow-up is a link when it goes somewhere and a
   button when it acts in place (e.g. focusing the date field). */
export default function AlertStrip({
  label = 'Alert',
  children,
  action,
}: AlertStripProps): ReactNode {
  return (
    <div className={styles.strip}>
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
