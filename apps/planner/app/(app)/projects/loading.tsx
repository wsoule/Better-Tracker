import { BlockBar, Skeleton, SkeletonRows } from '@better-tracker/ui';

import css from './page.module.css';

/* The projects register while the engine loads: hatched skeletons in the
   page's real layout (header, toolbar, one initiative block of rows). */
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
          <Skeleton width={260} height={36} />
          <Skeleton width={320} height={28} />
        </div>
      </div>
      <div className={`${css.blocks} ${css.collapse}`}>
        <BlockBar index="01" title="Projects" />
        <SkeletonRows rows={6} label="Loading projects" />
      </div>
    </>
  );
}
