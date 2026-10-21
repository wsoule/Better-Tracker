import { sidebarCollapseScript } from '@better-tracker/ui';

import { THEME_STORAGE_KEY } from '../../../fonts';
import { SIDEBAR_STORAGE_KEY } from './fixtures';
import ShellGallery from './shell-gallery';

export const metadata = { title: 'UI gallery · shell' };

/* /ui-gallery/shell: the "shell" family of @better-tracker/ui with fixture
   props — AppShell around a dummy project page, the command palette (static
   items + a lazily loaded "Jump to" list), toasts, and a slide-over with
   the property list and alert strip. No engine; links toast where they
   would have gone. /ui-gallery/shell/signed-out shows the SignedOutFrame.

   The inline script applies a remembered collapsed rail before first paint,
   as a host layout would next to themeScript(). */
export default function ShellGalleryPage() {
  return (
    <>
      <script
        dangerouslySetInnerHTML={{
          __html: sidebarCollapseScript(SIDEBAR_STORAGE_KEY),
        }}
      />
      <ShellGallery themeStorageKey={THEME_STORAGE_KEY} />
    </>
  );
}
