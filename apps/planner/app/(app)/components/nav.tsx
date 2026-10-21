import { ThemeToggle } from '@better-tracker/ui';

import { THEME_STORAGE_KEY } from '../../fonts';
import NavLinks, { type NavLink } from './nav-links';
import styles from './nav.module.css';

/* The instrument panel: a hatched, bordered bar with orange registration
   marks at its corners that floods orange on hover (DESIGN.md §8.1). The
   brand pairs the product name with the workspace it is reading. */
export default function Nav({
  appName,
  workspaceName,
  userName,
  links,
  signedIn,
}: {
  appName: string;
  workspaceName: string | null;
  userName: string | null;
  links: NavLink[];
  signedIn: boolean;
}) {
  return (
    <div className={styles.dock}>
      <nav className={styles.bar} aria-label="Primary">
        {/* Registration marks: 11px crossed 1px arms, centred on the middle of
            the 1px border line rather than running parallel just outside it. */}
        <span className={`${styles.mark} ${styles.tl}`} aria-hidden="true" />
        <span className={`${styles.mark} ${styles.tr}`} aria-hidden="true" />
        <span className={`${styles.mark} ${styles.bl}`} aria-hidden="true" />
        <span className={`${styles.mark} ${styles.br}`} aria-hidden="true" />

        <a className={styles.brand} href={signedIn ? '/week' : '/'}>
          <span className={styles.brandName}>{appName.toUpperCase()}</span>
          {workspaceName ? (
            <>
              <span className={styles.brandRule} aria-hidden="true" />
              <span className={styles.brandDoc}>
                {workspaceName.toUpperCase()}
              </span>
            </>
          ) : null}
        </a>

        {signedIn ? <NavLinks links={links} /> : null}

        <div className={styles.end}>
          {userName ? <span className={styles.user}>{userName}</span> : null}
          {signedIn ? (
            <form method="post" action="/api/auth/logout">
              <button type="submit" className={styles.link}>
                Sign out
              </button>
            </form>
          ) : null}
          <ThemeToggle storageKey={THEME_STORAGE_KEY} />
        </div>
      </nav>
    </div>
  );
}
