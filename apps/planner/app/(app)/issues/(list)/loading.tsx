import { Skeleton, SkeletonRows } from '@better-tracker/ui';

import css from './page.module.css';

/* The Issues page while the engine loads: shimmer skeletons in the
   page's real layout (header, preset tabs, the toolbar row, the grouped
   list's panel). It sits in the (list) route group, so /issues/[id] never
   shows it. */
export default function IssuesLoading() {
  return (
    <>
      <header className={css.head}>
        <div className={css.skeletonHead} aria-hidden="true">
          <Skeleton width="30%" height={22} />
          <Skeleton width="60%" height={11} />
          <Skeleton width="45%" height={11} />
        </div>
      </header>
      <div className={css.tabs} aria-hidden="true">
        <div className={css.skeletonTabs}>
          <Skeleton width={420} height={36} />
        </div>
      </div>
      <div className={css.toolbarWrap} aria-hidden="true">
        <div className={css.skeletonToolbar}>
          <Skeleton width={220} height={26} />
          <Skeleton width={300} height={20} />
        </div>
      </div>
      <div className={css.list}>
        <div className={css.skeletonList}>
          <SkeletonRows rows={10} label="Loading issues" />
        </div>
      </div>
    </>
  );
}
