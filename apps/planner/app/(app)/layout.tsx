import {
  SignedOutFrame,
  sidebarCollapseScript,
  themeScript,
} from '@better-tracker/ui';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { SIDEBAR_STORAGE_KEY } from '../../lib/adapters/shell';
import { getPageContext, loadShellFrame } from '../../lib/load';
import { geist, geistMono, THEME_STORAGE_KEY } from '../fonts';
import AppProviders from './components/app-providers';
import DemoNotice from './components/demo-notice';
import PlannerShell from './components/planner-shell';

import '@better-tracker/ui/styles.css';

// Static metadata cannot await the engine; read the same env var it uses.
const envAppName = process.env.APP_NAME?.trim();
const APP_NAME =
  envAppName !== undefined && envAppName !== ''
    ? envAppName
    : 'Milestone Planner';

export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  description:
    'My week, the milestone timeline, and the dependency graph for a Linear workspace, with auto-allocation and one-week warnings.',
};

/* The root layout of every app route (architecture §8.3). Signed in: the
   sidebar shell (nav with this week's count, the Projects list, breadcrumb,
   palette, phone tabs). Signed out: the plain auth frame (brand row and
   theme toggle on the warm page), around the landing page or an error.
   The two inline scripts apply the saved theme
   and the collapsed rail before first paint. Pages decide on /setup
   redirects themselves (lib/load.ts); the frame only renders. */
export default async function AppLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const { engine, actor } = await getPageContext();
  const demo = engine.mode === 'fixture';

  let body: ReactNode;
  if (actor === null) {
    body = (
      <SignedOutFrame
        appName={engine.config.appName}
        brandHref="/"
        label={demo ? 'Demo' : undefined}
        themeStorageKey={THEME_STORAGE_KEY}
      >
        {children}
      </SignedOutFrame>
    );
  } else {
    const frame = await loadShellFrame(engine, actor);
    body = (
      <PlannerShell
        frame={frame}
        banner={demo ? <DemoNotice /> : undefined}
        themeStorageKey={THEME_STORAGE_KEY}
      >
        {children}
      </PlannerShell>
    );
  }

  return (
    <html
      lang="en"
      suppressHydrationWarning
      // The ui tokens set `scroll-behavior: smooth` on <html>; this tells
      // Next to switch it off during route changes, so a new page starts
      // at the top instead of animating there.
      data-scroll-behavior="smooth"
      className={`${geist.variable} ${geistMono.variable}`}
    >
      <body>
        <script
          dangerouslySetInnerHTML={{ __html: themeScript(THEME_STORAGE_KEY) }}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: sidebarCollapseScript(SIDEBAR_STORAGE_KEY),
          }}
        />
        <AppProviders>{body}</AppProviders>
      </body>
    </html>
  );
}
