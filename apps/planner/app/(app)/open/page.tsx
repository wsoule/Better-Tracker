import { Button } from '@better-tracker/ui';
import { Link2 } from 'lucide-react';
import { redirect } from 'next/navigation';

import { firstParam } from '../../../lib/adapters/landing';
import {
  connectHref,
  DEFAULT_RETURN_TO,
  sanitizeReturnTo,
  signInLocation,
} from '../../../lib/auth-cookies';
import { heldFor } from '../../../lib/held-sessions';
import { getPageContext, loadHeldSessions } from '../../../lib/load';
import {
  CONNECT_LABEL,
  OPEN_UNKNOWN_MESSAGE,
  openHeldMessage,
  switchToLabel,
} from '../../../lib/workspace-copy';
import MessageBlock from '../components/message-block';
import { PageCrumb } from '../components/page-crumb';
import WorkspaceGuard from '../components/workspace-guard';

export const metadata = { title: 'Open link' };

/** What a `ws` value can be (an org id); anything else matches nothing. */
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,100}$/;

/* /open?ws=<org id>&to=<path> (architecture §8.4 "Open"): the
   interstitial proxy.ts sends a page link that names a workspace to (a
   digest's links do, §7), before any of that page's data loads. When `ws`
   is the active session's workspace it goes straight to `to`; when the
   browser holds a session for it, "This link is for <name>." with a
   "Switch to <name>" form (POST /api/auth/switch, returnTo=`to`); else it
   says the browser is not signed in to that workspace and links to
   /setup/connect (carrying `to`). The `ws` value is never rendered: names
   come from the engine's description of the browser's own sessions. `to`
   is sanitised (a same-site path, else My week). Demo mode and personal
   API keys hold one workspace: the link just opens `to` (signed-out
   visitors via the sign-in page). */
export default async function OpenLinkPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ engine, actor }, params] = await Promise.all([
    getPageContext(),
    searchParams,
  ]);
  const to = sanitizeReturnTo(firstParam(params.to), DEFAULT_RETURN_TO);
  const raw = firstParam(params.ws) ?? '';
  const ws = WORKSPACE_ID.test(raw) ? raw : null;
  const oauth = engine.mode !== 'fixture' && engine.config.auth !== 'api_key';
  if (!oauth) redirect(actor === null ? signInLocation(to) : to);
  if (actor !== null && actor.session.workspaceId === ws) redirect(to);

  const held = await loadHeldSessions();
  const target = ws === null ? null : heldFor(held, ws);
  if (target !== null) {
    const name = target.workspaceName ?? 'this workspace';
    return (
      <MessageBlock
        label="Open link"
        headline={openHeldMessage(name)}
        icon={<Link2 strokeWidth={1.8} />}
        actions={
          <>
            <form method="post" action="/api/auth/switch">
              <input
                type="hidden"
                name="workspace"
                value={target.workspaceId}
              />
              <input type="hidden" name="returnTo" value={to} />
              <Button type="submit" variant="primary">
                {switchToLabel(name)}
              </Button>
            </form>
            {actor === null ? null : <Button href="/week">Stay here</Button>}
          </>
        }
      >
        <p>
          This browser is signed in to it. Switching opens the page there; you
          can switch back from the workspace menu.
        </p>
        <PageCrumb label="Open link" />
        <WorkspaceGuard />
      </MessageBlock>
    );
  }
  return (
    <MessageBlock
      label="Open link"
      headline={OPEN_UNKNOWN_MESSAGE}
      icon={<Link2 strokeWidth={1.8} />}
      actions={
        <>
          <Button href={connectHref(to)} variant="primary">
            {CONNECT_LABEL}
          </Button>
          {actor === null ? null : <Button href="/week">Go to My week</Button>}
        </>
      }
    >
      <p>
        Connect that workspace with Linear to open the link there. Linear
        connects the workspace you have open at linear.app.
      </p>
      <PageCrumb label="Open link" />
      <WorkspaceGuard />
    </MessageBlock>
  );
}
