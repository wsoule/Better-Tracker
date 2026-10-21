import { BlockBar, Skeleton, SkeletonBlock } from '@better-tracker/ui';

import css from './page.module.css';

/* /graph while the engine loads: hatched skeletons in the page's real
   layout (header, the graph block with its legend strip and frame). */
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
          <BlockBar index="01" title="Dependencies" />
          <SkeletonBlock height={56} label="Loading the legend" />
          <SkeletonBlock height={420} label="Loading the graph" />
        </div>
      </div>
    </>
  );
}
