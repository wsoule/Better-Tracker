import { Skeleton, SkeletonRows } from '@better-tracker/ui';

import styles from './loading.module.css';

/* The fallback while an (app) page reads the workspace: shimmer skeletons
   in the pages' common layout (Gr8r skeletons) — a title and its
   subtitle, then a section heading over a panel of rows — instead of a
   spinner. Routes with their own layout ship their own loading.tsx. */
export default function Loading() {
  return (
    <div className="page">
      <div className={styles.head} aria-hidden="true">
        <Skeleton width="min(280px, 70%)" height={20} />
        <Skeleton width="min(480px, 90%)" height={10} />
      </div>
      <section className="block" aria-label="Loading">
        <div className={styles.bar} aria-hidden="true">
          <Skeleton width={140} height={12} />
        </div>
        <div className={styles.rows}>
          <SkeletonRows rows={8} label="Loading the page" />
        </div>
      </section>
    </div>
  );
}
