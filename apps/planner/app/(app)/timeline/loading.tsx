import { Skeleton, SkeletonBlock } from '@better-tracker/ui';

import css from './page.module.css';

/* The timeline while the engine loads: shimmer skeletons in the page's
   real layout (header, the chart's toolbar row, the chart panel). */
export default function TimelineLoading() {
  return (
    <>
      <header className={css.head}>
        <div className={css.skeletonHead} aria-hidden="true">
          <Skeleton width="40%" height={22} />
          <Skeleton width="80%" height={11} />
        </div>
      </header>
      <div className={css.chartWrap}>
        <div className={css.skeletonToolbar} aria-hidden="true">
          <Skeleton width={220} height={26} />
          <Skeleton width={160} height={26} />
          <Skeleton width={120} height={26} />
          <Skeleton width={72} height={26} />
        </div>
        <SkeletonBlock height={480} label="Loading the timeline" />
      </div>
    </>
  );
}
