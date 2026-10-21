import { BlockBar, StatusMark, ThemeToggle } from '@better-tracker/ui';

import { THEME_STORAGE_KEY } from '../../fonts';

export const metadata = { title: 'UI gallery' };

/* Index of the component gallery. Each component family adds a section
   (or a sub-route under /ui-gallery/<family>) rendering realistic fixture
   props in every state. */
export default function GalleryIndex() {
  return (
    <main className="page">
      <div className="block">
        <BlockBar
          index="00"
          title="UI gallery"
          meta={<ThemeToggle storageKey={THEME_STORAGE_KEY} />}
        />
        <div className="empty">
          <StatusMark status="done" label="Complete" showLabel />{' '}
          <StatusMark status="on_track" label="On track" showLabel />{' '}
          <StatusMark status="at_risk" label="At risk" showLabel />{' '}
          <StatusMark status="overdue" label="Overdue" showLabel />{' '}
          <StatusMark status="missing" label="Missing input" showLabel />
        </div>
      </div>
    </main>
  );
}
