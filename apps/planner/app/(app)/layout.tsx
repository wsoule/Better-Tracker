import { themeScript } from '@better-tracker/ui';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { getRequestContext } from '../../lib/session';
import { geist, jetbrainsMono, THEME_STORAGE_KEY } from '../fonts';
import Nav from './components/nav';

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

const NAV_LINKS = [
  { href: '/week', label: 'My week' },
  { href: '/timeline', label: 'Timeline' },
  { href: '/graph', label: 'Graph' },
  { href: '/runs', label: 'Runs' },
  { href: '/settings', label: 'Settings' },
];

export default async function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const { engine, actor } = await getRequestContext();
  const installation = actor
    ? await engine.getInstallation(actor.session.workspaceId)
    : null;

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
        <a className="skipLink" href="#main">
          Skip to content
        </a>
        <Nav
          appName={engine.config.appName}
          workspaceName={installation?.workspaceName ?? null}
          userName={actor?.session.userName ?? null}
          links={NAV_LINKS}
          signedIn={actor !== null}
        />
        {engine.mode === 'fixture' ? (
          <div className="block">
            <p className="notice">
              <span className="key">DEMO</span>
              <span>
                Demo data, not connected to Linear. Every name, date and issue
                on these screens is fictional; edits only change this
                process&apos;s in-memory copy.
              </span>
            </p>
          </div>
        ) : null}
        <main id="main" className="page">
          {children}
        </main>
      </body>
    </html>
  );
}
