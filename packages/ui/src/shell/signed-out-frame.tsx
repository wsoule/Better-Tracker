import type { ReactNode } from 'react';

import ThemeToggle from '../components/theme-toggle';
import { Link } from '../lib/link';
import styles from './signed-out-frame.module.css';
import type { SignedOutFrameProps } from './types';

/* The frame for signed-out pages (sign in, errors): the Analytics nav bar
   itself — a hatched, bordered strip with orange registration marks at its
   four corners that floods orange on hover — carrying only the brand and
   the theme toggle, above a centred content column. */
export default function SignedOutFrame({
  appName,
  brandHref,
  label,
  themeStorageKey,
  actions,
  mainId = 'main',
  children,
}: SignedOutFrameProps): ReactNode {
  return (
    <div className={styles.frame}>
      <Link href={`#${mainId}`} className="skipLink">
        Skip to content
      </Link>
      <div className={styles.dock}>
        <header className={styles.bar}>
          <span className={`${styles.mark} ${styles.tl}`} aria-hidden="true" />
          <span className={`${styles.mark} ${styles.tr}`} aria-hidden="true" />
          <span className={`${styles.mark} ${styles.bl}`} aria-hidden="true" />
          <span className={`${styles.mark} ${styles.br}`} aria-hidden="true" />
          <Link href={brandHref} className={styles.brand}>
            <span className={styles.brandName}>{appName}</span>
            {label !== undefined && label !== '' ? (
              <>
                <span className={styles.brandRule} aria-hidden="true" />
                <span className={styles.brandLabel}>{label}</span>
              </>
            ) : null}
          </Link>
          <div className={styles.end}>
            {actions}
            {themeStorageKey !== undefined ? (
              <ThemeToggle storageKey={themeStorageKey} />
            ) : null}
          </div>
        </header>
      </div>
      <main id={mainId} tabIndex={-1} className={styles.main}>
        {children}
      </main>
    </div>
  );
}
