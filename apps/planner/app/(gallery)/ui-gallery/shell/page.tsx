import { sidebarCollapseScript } from '@better-tracker/ui';
import { headers } from 'next/headers';

import { THEME_STORAGE_KEY } from '../../../fonts';
import { SIDEBAR_STORAGE_KEY } from './fixtures';
import ShellGallery from './shell-gallery';

export const metadata = { title: 'UI gallery · shell' };

/* /ui-gallery/shell: the "shell" family of @better-tracker/ui with fixture
   props — AppShell around a dummy project page, the command palette (static
   items + a lazily loaded "Jump to" list), toasts, and a slide-over with
   the property list and alert strip. No engine; links toast where they
   would have gone. /ui-gallery/shell/signed-out shows the SignedOutFrame;
   ?switcher=1 draws the brand row as the workspace switcher (three
   workspaces, one a guest's) with the palette's Workspaces section.

   The inline script applies a remembered collapsed rail before first paint,
   as a host layout would next to themeScript(), with the request's CSP
   nonce (proxy.ts, every page in every mode). */
export default async function ShellGalleryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  const switcher = (await searchParams).switcher === '1';
  return (
    <>
      <script
        nonce={nonce}
        suppressHydrationWarning
        dangerouslySetInnerHTML={{
          __html: sidebarCollapseScript(SIDEBAR_STORAGE_KEY),
        }}
      />
      <ShellGallery themeStorageKey={THEME_STORAGE_KEY} switcher={switcher} />
    </>
  );
}
