'use client';

import { Button } from '@better-tracker/ui';

import MessageBlock from './components/message-block';

/* The error boundary for every (app) page: the frame stays, the page body
   says what failed and offers a retry (which re-fetches the page from the
   server). The error itself was logged on the server; production builds
   send only its digest, which is shown so a report can be matched. */
export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
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
