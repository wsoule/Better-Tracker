import { BlockBar, Skeleton, SkeletonRows } from '@better-tracker/ui';

import css from './page.module.css';

/* /runs while the engine loads: hatched skeletons in the page's real
   layout (header, the run controls, the register). */
export default function RunsLoading() {
  return (
    <>
      <header className={css.head}>
        <div className={css.skeletonHead} aria-hidden="true">
          <Skeleton width="30%" height={22} />
          <Skeleton width="85%" height={11} />
        </div>
      </header>
      <div className={css.body}>
        <div className={css.actionBar} aria-hidden="true">
          <Skeleton width={180} height={36} />
          <Skeleton width={320} height={11} />
        </div>
        <div className={css.collapse}>
          <BlockBar index="01" title="Allocation runs" />
          <SkeletonRows rows={6} label="Loading runs" />
        </div>
      </div>
    </>
  );
}
