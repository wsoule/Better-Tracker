import { ThemeToggle } from '@better-tracker/ui';

import { THEME_STORAGE_KEY } from '../../../fonts';
import TasksGallery from './tasks-gallery';

export const metadata = { title: 'UI gallery · tasks' };

/* /ui-gallery/tasks: the "tasks" family of @better-tracker/ui rendered with
   fixture props: a My week composition (stats strip, grouped task table,
   upcoming deadlines), the Projects / Runs / Settings registers and a
   primitives sampler. No engine; links go through a gallery link that
   records where they would have gone. */
export default function TasksGalleryPage() {
  return (
    <TasksGallery
      themeToggle={<ThemeToggle storageKey={THEME_STORAGE_KEY} />}
    />
  );
}
