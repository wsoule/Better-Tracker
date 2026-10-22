import { Skeleton, SkeletonRows } from '@better-tracker/ui';

import css from './page.module.css';

/* /settings while the engine loads: the page's real layout — the sub-nav
   column and a section's title, lead and setting rows. */
export default function SettingsLoading() {
  return (
    <div className={css.set}>
      <div className={css.setNav} aria-hidden="true">
        <div className={css.skeletonNav}>
          <Skeleton width="40%" height={9} />
          {[72, 84, 76, 62, 92, 58].map((width) => (
            <Skeleton key={width} width={`${width}%`} height={14} />
          ))}
        </div>
      </div>
      <div className={css.setIn}>
        <div className={css.skeletonHead} aria-hidden="true">
          <Skeleton width="28%" height={18} />
          <Skeleton width="70%" height={10} />
        </div>
        <div className={css.skeletonRows}>
          <SkeletonRows rows={5} label="Loading settings" />
        </div>
      </div>
    </div>
  );
}
