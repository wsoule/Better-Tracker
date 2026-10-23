import { BlockBar, Skeleton, SkeletonRows } from '@better-tracker/ui';

import css from './page.module.css';

/* The projects register while the engine loads: shimmer skeletons in the
   page's real layout (header, toolbar, one initiative panel of rows). */
export default function ProjectsLoading() {
  return (
    <>
      <header className={css.head}>
        <div className={css.skeletonHead} aria-hidden="true">
          <Skeleton width="40%" height={22} />
          <Skeleton width="80%" height={11} />
        </div>
      </header>
      <div className={css.toolbarWrap}>
        <div className={css.toolbar} aria-hidden="true">
          <Skeleton width={240} height={30} />
          <Skeleton width={280} height={26} />
        </div>
      </div>
      <div className={css.blocks}>
        <BlockBar title="Projects" />
        <div className={css.skeletonPanel}>
          <SkeletonRows rows={6} label="Loading projects" />
        </div>
      </div>
    </>
  );
}
