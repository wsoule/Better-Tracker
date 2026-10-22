'use client';

import type { ReactNode } from 'react';

import { Link } from '../lib/link';
import styles from './alert-strip.module.css';
import type { AlertStripProps } from './types';

/* The explain-panel idiom from the competitors site: a 2px frame, a mono
   key and one sentence, with an optional follow-up ("Overdue by 3 days.
   Reschedule"). The frame and key take the tone (data-tone: --tone for the
   frame, --tone-ink for the key): danger for overdue, warning for blocked
   or stalled, the purple accent by default. The follow-up is a link, so it
   stays in the accent whatever the tone; it is a link when it goes
   somewhere and a button when it acts in place (e.g. focusing the date
   field). */
export default function AlertStrip({
  label = 'Alert',
  tone = 'accent',
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
