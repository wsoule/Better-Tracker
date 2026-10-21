import { BlockBar, Skeleton, SkeletonRows } from '@better-tracker/ui';

import css from './page.module.css';

/* /settings while the engine loads: the header, the sub-nav column and a
   section block of rows, in the page's real layout. */
export default function SettingsLoading() {
  return (
    <>
      <header className={css.head}>
        <div className={css.skeletonHead} aria-hidden="true">
          <Skeleton width="30%" height={22} />
          <Skeleton width="75%" height={11} />
        </div>
      </header>
      <div className={css.layout}>
        <div className={css.subnav} aria-hidden="true">
          <Skeleton width="100%" height={240} />
        </div>
        <div className={css.content}>
          <div className={css.collapse}>
            <BlockBar index="01" title="Settings" />
            <SkeletonRows rows={5} label="Loading settings" />
          </div>
        </div>
      </div>
    </>
  );
}
