'use client';

import { Button, SignedOutFrame } from '@better-tracker/ui';
import { useEffect } from 'react';

import MessageBlock from './(app)/components/message-block';
import { geist, jetbrainsMono, THEME_STORAGE_KEY } from './fonts';

import '@better-tracker/ui/styles.css';

/**
 * Applies the saved theme (else the OS preference) when html[data-theme]
 * is missing. This page replaces the root layout, whose pre-paint theme
 * script may never have run, and inline scripts React renders on the
 * client do not execute, so it is done after mount instead.
 */
function useSavedTheme(storageKey: string): void {
  useEffect(() => {
    const root = document.documentElement;
    if (root.dataset.theme === 'dark' || root.dataset.theme === 'light') {
      return;
    }
    let theme = 'light';
    try {
      const saved = localStorage.getItem(storageKey);
      theme =
        saved === 'dark' || saved === 'light'
          ? saved
          : window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light';
    } catch {
      // Storage blocked: light, like the theme script's own fallback.
    }
    root.dataset.theme = theme;
  }, [storageKey]);
}

/* The last-resort error page (Next's global-error): shown when the root
   layout itself fails, which (app)/error.tsx cannot catch. In practice
   that is the engine failing to start or to read the session (database
   unreachable, configuration incomplete), so there is no frame, no
   person and no app name from the server, only the signed-out bar, what
   happened, the error reference to match in the server log, and a retry.
   It renders its own document and imports the styles itself. */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useSavedTheme(THEME_STORAGE_KEY);
  return (
    <html
      lang="en"
      suppressHydrationWarning
      data-scroll-behavior="smooth"
      className={`${geist.variable} ${jetbrainsMono.variable}`}
    >
      <body>
        <title>Planner unavailable</title>
        <SignedOutFrame
          appName="Milestone Planner"
          brandHref="/"
          themeStorageKey={THEME_STORAGE_KEY}
        >
          <MessageBlock
            index="500"
            title="Planner unavailable"
            headline="The planner could not load."
            actions={
              <Button variant="primary" onClick={() => retry()}>
                Try again
              </Button>
            }
          >
            <p>
              It failed before it could read anything, so nothing changed. This
              usually means its database is unreachable or its configuration is
              incomplete; the server log says which.
              {error.digest !== undefined
                ? ` Error reference: ${error.digest}.`
                : ''}
            </p>
          </MessageBlock>
        </SignedOutFrame>
      </body>
    </html>
  );
}
