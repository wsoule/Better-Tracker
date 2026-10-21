import { ThemeToggle } from '@better-tracker/ui';

import { THEME_STORAGE_KEY } from '../../../fonts';
import TaskGallery from './task-gallery';

export const metadata = { title: 'UI gallery · task' };

/* /ui-gallery/task: the "task" family of @better-tracker/ui with fixture
   props — TaskSlideOver (open on load; ?drawer=closed starts it shut), the
   page layout with its properties rail, and every state in drawer-layout
   panes: alerts, external and resolved relations, a long description, a
   loading and a failed description, nothing related, a done task. No
   engine; links say where they would have gone. */
export default async function TaskGalleryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { drawer } = await searchParams;
  return (
    <TaskGallery
      themeToggle={<ThemeToggle storageKey={THEME_STORAGE_KEY} />}
      initialDrawerOpen={drawer !== 'closed'}
    />
  );
}
