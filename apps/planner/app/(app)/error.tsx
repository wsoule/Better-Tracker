'use client';

import { Button } from '@better-tracker/ui';
import { CloudAlert, RefreshCw, RefreshCwOff } from 'lucide-react';

import {
  API_KEY_NOT_SYNCED_NOTICE,
  FIRST_SYNC_PENDING_HEADLINE,
} from '../../lib/read-only';
import MessageBlock from './components/message-block';
import {
  useApiKeyMode,
  useReadOnlyReason,
} from './components/read-only-notice';

/* The error boundary for every (app) page: the frame stays, the page body
   says what failed and offers a retry (which re-fetches the page from the
   server). The error itself was logged on the server; production builds
   send only its digest, which is shown (as the error reference) so a
   report can be matched. While
   an installed workspace's first sync has not landed (the shell's
   read-only reason is `not_synced`), every page that reads the mirror
   fails the same way, so this says that instead and points at Setup,
   where a reinstall stays open. With personal API keys there is nothing
   to install: the copy waits for a member's key and links home. */
export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const reason = useReadOnlyReason();
  const apiKeyMode = useApiKeyMode();
  if (reason === 'not_synced' && apiKeyMode) {
    return (
      <MessageBlock
        label="No copy of Linear yet"
        headline="Waiting for a workspace member's key."
        icon={<RefreshCwOff strokeWidth={1.8} />}
        tone="warning"
        reference={error.digest}
        actions={
          <>
            <Button
              variant="primary"
              icon={<RefreshCw size={14} strokeWidth={1.8} />}
              onClick={() => retry()}
            >
              Try again
            </Button>
            <Button href="/">Go home</Button>
          </>
        }
      >
        <p>{API_KEY_NOT_SYNCED_NOTICE}</p>
      </MessageBlock>
    );
  }
  if (reason === 'not_synced') {
    return (
      <MessageBlock
        label="First sync pending"
        headline={FIRST_SYNC_PENDING_HEADLINE}
        icon={<RefreshCwOff strokeWidth={1.8} />}
        tone="warning"
        reference={error.digest}
        actions={
          <>
            <Button
              variant="primary"
              icon={<RefreshCw size={14} strokeWidth={1.8} />}
              onClick={() => retry()}
            >
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
        </p>
      </MessageBlock>
    );
  }
  return (
    <MessageBlock
      label="Page failed"
      headline="This page could not load."
      icon={<CloudAlert strokeWidth={1.8} />}
      tone="danger"
      reference={error.digest}
      actions={
        <>
          <Button
            variant="primary"
            icon={<RefreshCw size={14} strokeWidth={1.8} />}
            onClick={() => retry()}
          >
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
      </p>
    </MessageBlock>
  );
}
