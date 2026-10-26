import { Link, SignedOutFrame } from '@better-tracker/ui';

import { THEME_STORAGE_KEY } from '../../../../fonts';
import styles from '../page.module.css';

export const metadata = { title: 'UI gallery · signed-out frame' };

/* /ui-gallery/shell/signed-out: the SignedOutFrame around a sign-in card,
   as the planner's "/" renders it before a session exists, with its
   footer links (privacy · terms · contact). */
export default function SignedOutGalleryPage() {
  return (
    <SignedOutFrame
      appName="Milestone Planner"
      brandHref="/ui-gallery/shell"
      label="Demo"
      themeStorageKey={THEME_STORAGE_KEY}
      footerLinks={[
        { label: 'Privacy', href: '/ui-gallery/shell' },
        { label: 'Terms', href: '/ui-gallery/shell/signed-out' },
        { label: 'Contact', href: '/ui-gallery' },
      ]}
    >
      <section className={styles.signIn} aria-labelledby="signin-title">
        <h1 id="signin-title" className={styles.title}>
          Your week, from Linear.
        </h1>
        <p className={styles.signInLead}>
          Sign in with the Linear account you use at Northwind. The planner
          reads your issues and milestones; the edits you make here go to Linear
          as you.
        </p>
        <Link href="/ui-gallery/shell" className="buttonPrimary">
          Sign in with Linear
        </Link>
      </section>
    </SignedOutFrame>
  );
}
