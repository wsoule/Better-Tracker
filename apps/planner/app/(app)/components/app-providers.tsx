'use client';

import { ToastProvider, UiLinkProvider } from '@better-tracker/ui';
import type { ReactNode } from 'react';

import NextUiLink from './next-ui-link';

/* Providers every (app) page renders under, signed in or not: ui links go
   through next/link, and the toast stack is available to any client
   island (mutations report failures there). The command palette lives in
   PlannerShell, since only signed-in people have one. */
export default function AppProviders({ children }: { children: ReactNode }) {
  return (
    <UiLinkProvider link={NextUiLink}>
      <ToastProvider>{children}</ToastProvider>
    </UiLinkProvider>
  );
}
