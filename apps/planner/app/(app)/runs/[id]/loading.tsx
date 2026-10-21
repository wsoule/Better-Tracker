import {
  BlockBar,
  Skeleton,
  SkeletonBlock,
  SkeletonRows,
} from '@better-tracker/ui';

import css from '../page.module.css';

/* /runs/[id] while the engine loads: header, the stats strip, and one
   project block of rows. */
export default function RunLoading() {
  return (
    <>
      <header className={css.head}>
        <div className={css.skeletonHead} aria-hidden="true">
          <Skeleton width="55%" height={22} />
          <Skeleton width="70%" height={11} />
        </div>
      </header>
      <div className={css.body}>
        <SkeletonBlock height={96} label="Loading the run summary" />
        <div className={css.collapse}>
          <BlockBar index="02" title="Projects" />
          <SkeletonRows rows={5} label="Loading the run log" />
        </div>
      </div>
    </>
  );
}
