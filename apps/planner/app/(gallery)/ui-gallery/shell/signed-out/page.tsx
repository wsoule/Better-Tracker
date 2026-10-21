import { BlockBar, Link, SignedOutFrame } from '@better-tracker/ui';

import { THEME_STORAGE_KEY } from '../../../../fonts';
import styles from '../page.module.css';

export const metadata = { title: 'UI gallery · signed-out frame' };

/* /ui-gallery/shell/signed-out: the SignedOutFrame around a sign-in block,
   as the planner's "/" renders it before a session exists. */
export default function SignedOutGalleryPage() {
  return (
    <SignedOutFrame
      appName="Milestone Planner"
      brandHref="/ui-gallery/shell"
      label="Northwind"
      themeStorageKey={THEME_STORAGE_KEY}
    >
      <div className="page">
        <section className="block" aria-labelledby="signin-title">
          <BlockBar index="01" title="Sign in" meta="Linear OAuth" />
          <div className={styles.signIn}>
            <h1 id="signin-title" className={styles.title}>
              Your week, from Linear.
            </h1>
            <p className={styles.signInLead}>
              Sign in with the Linear account you use at Northwind. The planner
              reads your issues and milestones; it never edits them without a
              PM&apos;s say-so.
            </p>
            <Link href="/ui-gallery/shell" className="buttonPrimary">
              Sign in with Linear
            </Link>
          </div>
        </section>
      </div>
    </SignedOutFrame>
  );
}
