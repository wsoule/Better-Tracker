import { Skeleton, SkeletonRows, SkeletonText } from '@better-tracker/ui';

import css from './page.module.css';

/* The issue page while the engine and Linear answer: hatched skeletons in
   the task view's page layout (title, status line, the main column and
   the properties rail). */
export default function IssueLoading() {
  return (
    <div className={css.page}>
      <div className={css.skeleton} aria-hidden="true">
        <Skeleton width="min(240px, 50%)" height={10} />
        <Skeleton width="min(560px, 90%)" height={26} />
        <Skeleton width="min(200px, 40%)" height={12} />
      </div>
      <div className={css.skeletonColumns}>
        <SkeletonText lines={8} label="Loading the issue" />
        <SkeletonRows rows={7} label="Loading its properties" />
      </div>
    </div>
  );
}
