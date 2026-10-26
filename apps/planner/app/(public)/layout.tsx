import { SignedOutFrame, themeScript } from '@better-tracker/ui';
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { connection } from 'next/server';
import type { ReactNode } from 'react';

import AppProviders from '../(app)/components/app-providers';
import {
  POLICY_LINKS,
  POLICY_LINKS_LABEL,
} from '../../lib/adapters/public-pages';
import { getEngine } from '../../lib/runtime';
import { geist, geistMono, THEME_STORAGE_KEY } from '../fonts';

import '@better-tracker/ui/styles.css';

// Static metadata cannot await the engine; read the same env var it uses.
const envAppName = process.env.APP_NAME?.trim();
const APP_NAME =
  envAppName !== undefined && envAppName !== ''
    ? envAppName
    : 'Milestone Planner';

export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
};

/* A third root layout for the public pages (/privacy, /terms, /contact;
   owner decision 2026-10-25, before strangers use the planner;
   architecture §8.4 "Public pages"): readable by anyone, signed in or
   not, so it never reads a session (no getPageContext, no cookies) and
   never calls Linear; the pages read only the engine's configuration.
   connection() renders every request anew, which the nonce
   Content-Security-Policy needs (proxy.ts puts a fresh nonce on every
   page); the pre-paint theme script carries it (`x-nonce`). The frame is
   the signed-out one with the privacy · terms · contact footer. A link
   from here into the app is a full page load (another root layout). */
export default async function PublicLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  await connection();
  const nonce = (await headers()).get('x-nonce') ?? undefined;
  const engine = await getEngine();
  return (
    <html
      lang="en"
      suppressHydrationWarning
      data-scroll-behavior="smooth"
      className={`${geist.variable} ${geistMono.variable}`}
    >
      <body>
        <script
          nonce={nonce}
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: themeScript(THEME_STORAGE_KEY) }}
        />
        <AppProviders>
          <SignedOutFrame
            appName={engine.config.appName}
            brandHref="/"
            label={engine.mode === 'fixture' ? 'Demo' : undefined}
            themeStorageKey={THEME_STORAGE_KEY}
            footerLinks={POLICY_LINKS}
            footerLabel={POLICY_LINKS_LABEL}
          >
            {children}
          </SignedOutFrame>
        </AppProviders>
      </body>
    </html>
  );
}
