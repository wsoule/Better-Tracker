import { BlockBar, Skeleton, SkeletonBlock } from '@better-tracker/ui';

import css from './page.module.css';

/* /graph while the engine loads: shimmering skeletons in the page's real
   layout (header, the section title over the graph panel, the legend's
   key rows under it). */
export default function GraphLoading() {
  return (
    <>
      <header className={css.head}>
        <div className={css.skeletonHead} aria-hidden="true">
          <Skeleton width="40%" height={22} />
          <Skeleton width="90%" height={11} />
        </div>
      </header>
      <div className={css.body}>
        <div className={css.collapse}>
          <div>
            <BlockBar title="Dependencies" />
            <SkeletonBlock height={420} label="Loading the graph" />
          </div>
          <SkeletonBlock height={48} label="Loading the legend" />
        </div>
      </div>
    </>
  );
}
