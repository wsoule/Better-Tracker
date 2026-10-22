import { themeScript } from '@better-tracker/ui';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import type { ReactNode } from 'react';

import { geist, geistMono, THEME_STORAGE_KEY } from '../fonts';

import '@better-tracker/ui/styles.css';

/* A second root layout for /ui-gallery: renders @better-tracker/ui
   components with fixture props and no engine, so the component library
   can be built, reviewed and screenshotted on its own. Never served in
   production unless demo mode is on. The gate is read per request
   (connection() keeps these pages out of the build's prerendering, which
   would otherwise bake the build machine's LINEAR_FIXTURE into them). */
export default async function GalleryLayout({
  children,
}: {
  children: ReactNode;
}) {
  await connection();
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
      className={`${geist.variable} ${geistMono.variable}`}
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
