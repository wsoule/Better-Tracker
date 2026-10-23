import { BlockBar, Skeleton, SkeletonRows } from '@better-tracker/ui';

import css from './page.module.css';

/* /runs while the engine loads: shimmer skeletons in the page's real
   layout (header with the run controls top right, the register panel). */
export default function RunsLoading() {
  return (
    <>
      <header className={`${css.head} ${css.headActions}`}>
        <div className={css.skeletonHead} aria-hidden="true">
          <Skeleton width="30%" height={20} />
          <Skeleton width="85%" height={10} />
        </div>
        <div className={css.actionBar} aria-hidden="true">
          <Skeleton width={150} height={30} />
        </div>
      </header>
      <div className={css.body}>
        <div className={css.section}>
          <BlockBar title="Allocation runs" />
          <div className={css.panel}>
            <SkeletonRows rows={6} label="Loading runs" />
          </div>
        </div>
      </div>
    </>
  );
}
