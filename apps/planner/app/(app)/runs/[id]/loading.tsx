import {
  BlockBar,
  Skeleton,
  SkeletonBlock,
  SkeletonRows,
} from '@better-tracker/ui';

import css from '../page.module.css';

/* /runs/[id] while the engine loads: header, the stats strip, and one
   project section of rows. */
export default function RunLoading() {
  return (
    <>
      <header className={css.head}>
        <div className={css.skeletonHead} aria-hidden="true">
          <Skeleton width="55%" height={20} />
          <Skeleton width="70%" height={10} />
        </div>
      </header>
      <div className={css.body}>
        <SkeletonBlock height={88} label="Loading the run summary" />
        <div className={css.section}>
          <BlockBar title="Projects" />
          <div className={css.panel}>
            <SkeletonRows rows={5} label="Loading the run log" />
          </div>
        </div>
      </div>
    </>
  );
}
