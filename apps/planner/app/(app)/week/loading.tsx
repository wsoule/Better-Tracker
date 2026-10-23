import {
  BlockBar,
  Skeleton,
  SkeletonBlock,
  SkeletonRows,
} from '@better-tracker/ui';

import css from './page.module.css';

/* My week while the engine loads: shimmer skeletons in the page's real
   layout (header, stats strip, task table, deadlines, needs attention). */
export default function WeekLoading() {
  return (
    <>
      <header className={css.head}>
        <div className={css.skeletonHead} aria-hidden="true">
          <Skeleton width="60%" height={22} />
          <Skeleton width="90%" height={11} />
        </div>
      </header>
      <div className={css.body}>
        <SkeletonBlock height={104} label="Loading your week" />
        <div className={css.columns}>
          <div className={css.grid}>
            <div className={css.main}>
              <BlockBar title="Your issues" />
              <div className={css.skeletonPanel}>
                <SkeletonRows rows={9} label="Loading your issues" />
              </div>
            </div>
            <aside className={css.side} aria-label="Deadlines and attention">
              <div className={css.sideSection}>
                <BlockBar title="Upcoming deadlines" />
                <div className={css.skeletonPanel}>
                  <SkeletonRows rows={4} label="Loading deadlines" />
                </div>
              </div>
              <div className={css.sideSection}>
                <BlockBar title="Needs attention" />
                <div className={css.skeletonPanel}>
                  <SkeletonRows rows={2} label="Loading projects" />
                </div>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </>
  );
}
