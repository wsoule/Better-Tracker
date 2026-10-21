import { BlockBar } from '@better-tracker/ui';
import type { ReactNode } from 'react';

import styles from './message-block.module.css';

/* A one-block page for not-found and error states: the hatched bar, a
   plain headline, one or two sentences and the way forward. Server- and
   client-safe (error.tsx is a client component). */
export default function MessageBlock({
  index,
  title,
  headline,
  children,
  actions,
}: {
  /** Mono key in the bar ("404", "ERR"). */
  index: string;
  /** Bar title ("Not found"). */
  title: string;
  headline: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page">
      <section className="block" aria-labelledby="message-title">
        <BlockBar index={index} title={title} />
        <div className={styles.body}>
          <h1 id="message-title" className={styles.headline}>
            {headline}
          </h1>
          <div className={styles.copy}>{children}</div>
          {actions !== undefined ? (
            <div className={styles.actions}>{actions}</div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
