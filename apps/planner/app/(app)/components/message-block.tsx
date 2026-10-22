import type { UiTone } from '@better-tracker/ui';
import type { ReactNode } from 'react';

import styles from './message-block.module.css';

/* A one-message page for not-found and error states, as Gr8r's full-page
   state (.fullstate): a quiet 22px icon, a short sentence-case label, the
   headline, one or two sentences, the error reference to match in the
   server log (mono: it is an id), and the way forward. Centred in the
   space below the topbar. Server- and client-safe (error.tsx is a client
   component). */
export default function MessageBlock({
  label,
  headline,
  icon,
  tone = 'default',
  reference,
  children,
  actions,
}: {
  /** What happened, in two or three words ("Not found", "Page failed"). */
  label: string;
  headline: string;
  /** A 22px lucide icon (strokeWidth 1.8). */
  icon?: ReactNode;
  /** The icon's colour: danger for a failure, warning for a pause. */
  tone?: Extract<UiTone, 'default' | 'warning' | 'danger'>;
  /** The error digest a production build sends, when there is one. */
  reference?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page">
      <section className={styles.state} aria-labelledby="message-title">
        <div className={styles.box}>
          {icon !== undefined ? (
            <span className={styles.glyph} data-tone={tone} aria-hidden="true">
              {icon}
            </span>
          ) : null}
          <p className={styles.label}>{label}</p>
          <h1 id="message-title" className={styles.headline}>
            {headline}
          </h1>
          <div className={styles.copy}>{children}</div>
          {reference !== undefined && reference !== '' ? (
            <p className={styles.reference}>
              Error reference <code className={styles.code}>{reference}</code>
            </p>
          ) : null}
          {actions !== undefined ? (
            <div className={styles.actions}>{actions}</div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
