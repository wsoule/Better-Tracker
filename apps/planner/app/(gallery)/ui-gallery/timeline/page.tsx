import { ThemeToggle } from '@better-tracker/ui';

import { THEME_STORAGE_KEY } from '../../../fonts';
import TimelineGallery from './timeline-gallery';

export const metadata = { title: 'UI gallery · timeline' };

/* /ui-gallery/timeline: the "timeline" family of @better-tracker/ui with
   fixture props: the editable chart (weeks/months, dependencies, drag and
   keyboard re-dating against a fake 400ms save that can be made to fail),
   a read-only months view with a focused lane, and the empty state. */
export default function TimelineGalleryPage() {
  return (
    <TimelineGallery
      themeToggle={<ThemeToggle storageKey={THEME_STORAGE_KEY} />}
    />
  );
}
