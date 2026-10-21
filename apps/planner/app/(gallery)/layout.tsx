import { themeScript } from '@better-tracker/ui';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { geist, jetbrainsMono, THEME_STORAGE_KEY } from '../fonts';

import '@better-tracker/ui/styles.css';

/* A second root layout for /ui-gallery: renders @better-tracker/ui
   components with fixture props and no engine, so the component library
   can be built, reviewed and screenshotted on its own. Never served in
   production unless demo mode is on. */
export default function GalleryLayout({ children }: { children: ReactNode }) {
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.LINEAR_FIXTURE !== '1'
  ) {
    notFound();
  }
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geist.variable} ${jetbrainsMono.variable}`}
    >
      <body>
        <script
          dangerouslySetInnerHTML={{ __html: themeScript(THEME_STORAGE_KEY) }}
        />
        {children}
      </body>
    </html>
  );
}
