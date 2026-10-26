import {
  POLICY_LINKS,
  POLICY_LINKS_LABEL,
} from '../../../lib/adapters/public-pages';
import styles from './policy-links.module.css';

/* The quiet privacy · terms · contact row Settings → Status and /setup end
   with (owner decision 2026-10-25, before strangers use the planner), the
   same links as the signed-out frame's footer. Plain anchors: the public
   pages have their own root layout, so following one is a full load. */
export default function PolicyLinks() {
  return (
    <nav aria-label={POLICY_LINKS_LABEL} className={styles.nav}>
      <ul className={styles.links}>
        {POLICY_LINKS.map((link) => (
          <li key={link.href} className={styles.item}>
            <a className={styles.link} href={link.href}>
              {link.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
