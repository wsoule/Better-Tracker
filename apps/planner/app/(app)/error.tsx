'use client';

import { Button } from '@better-tracker/ui';

import { FIRST_SYNC_PENDING_HEADLINE } from '../../lib/read-only';
import MessageBlock from './components/message-block';
import { useReadOnlyReason } from './components/read-only-notice';

/* The error boundary for every (app) page: the frame stays, the page body
   says what failed and offers a retry (which re-fetches the page from the
   server). The error itself was logged on the server; production builds
   send only its digest, which is shown so a report can be matched. While
   an installed workspace's first sync has not landed (the shell's
   read-only reason is `not_synced`), every page that reads the mirror
   fails the same way, so this says that instead and points at Setup,
   where a reinstall stays open. */
export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const reason = useReadOnlyReason();
  if (reason === 'not_synced') {
    return (
      <MessageBlock
        index="SYNC"
        title="First sync pending"
        headline={FIRST_SYNC_PENDING_HEADLINE}
        actions={
          <>
            <Button variant="primary" onClick={() => retry()}>
              Try again
            </Button>
            <Button href="/setup">Open Setup</Button>
          </>
        }
      >
        <p>
          The planner reads everything from its copy of the Linear workspace,
          and that copy has not arrived yet: the first sync after the install
          failed or is still running. It is retried on every page and every
          worker run; the web service&apos;s logs say why it failed. When the
          cause is the app&apos;s grant (for example the initiative:read scope
          missing), a workspace admin can reinstall from Setup.
          {error.digest !== undefined
            ? ` Error reference: ${error.digest}.`
            : ''}
        </p>
      </MessageBlock>
    );
  }
  return (
    <MessageBlock
      index="ERR"
      title="Page failed"
      headline="This page could not load."
      actions={
        <>
          <Button variant="primary" onClick={() => retry()}>
            Try again
          </Button>
          <Button href="/week">Go to My week</Button>
        </>
      }
    >
      <p>
        The planner hit an error while reading the workspace, so nothing on this
        page changed. If it keeps happening, Linear may be unreachable or the
        planner&apos;s database may be down.
        {error.digest !== undefined ? ` Error reference: ${error.digest}.` : ''}
      </p>
    </MessageBlock>
  );
}
