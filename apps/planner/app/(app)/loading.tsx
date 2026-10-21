import { Skeleton, SkeletonRows } from '@better-tracker/ui';

import styles from './loading.module.css';

/* The fallback while an (app) page reads the workspace: hatched skeletons
   in the pages' common layout — a heading and receipts line, then a block
   bar over register rows — instead of a spinner (Gr8r skeletons). Routes
   with their own layout ship their own loading.tsx. */
export default function Loading() {
  return (
    <div className="page">
      <div className={styles.head} aria-hidden="true">
        <Skeleton width="min(320px, 70%)" height={22} />
        <Skeleton width="min(520px, 90%)" height={10} />
      </div>
      <section className="block" aria-label="Loading">
        <div className="blockBar" aria-hidden="true">
          <Skeleton width={18} height={9} />
          <Skeleton width={120} height={9} />
        </div>
        <div className={styles.rows}>
          <SkeletonRows rows={8} label="Loading the page" />
        </div>
      </section>
    </div>
  );
}
