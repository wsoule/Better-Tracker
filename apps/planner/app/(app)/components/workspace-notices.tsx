import { Notice } from '@better-tracker/ui';
import { cookies } from 'next/headers';

import { sessionSecret } from '../../../lib/auth-cookies';
import { getEngine } from '../../../lib/runtime';
import { activeSessionToken, cookieScheme } from '../../../lib/session-cookies';
import { verifiedSignedOutName } from '../../../lib/signed-out-notice';
import { weekWorkspaceNotices } from '../../../lib/workspace-copy';
import SignOutAllForm from './sign-out-all-form';
import css from './workspace-notices.module.css';

/**
 * The signed-out workspace's name in a verified `from` value issued to
 * this browser (its active session is the one the sign-out left active),
 * or null.
 */
function verifiedName(
  value: string | undefined,
  activeToken: string | undefined
): string | null {
  try {
    return verifiedSignedOutName(value, activeToken, sessionSecret(false));
  } catch {
    return null;
  }
}

/* /week's notices after a workspace change (OAuth mode, owner decision
   2026-10-25; lib/workspace-copy.ts weekWorkspaceNotices): Linear
   connected a workspace this browser already had, one workspace was
   signed out while another stays (with "Sign out of all workspaces"), or
   a switch did not happen. Neutral bordered notices (default tone, never
   the blue info tone), a failed switch red; role="status" for what just
   changed, "alert" for the failure. Names come from the engine, or from a
   value the logout route signed for this browser (bound to its active
   session, lib/signed-out-notice.ts), never from the URL as such. */
export default async function WorkspaceNotices({
  params,
  workspaceName,
}: {
  params: Readonly<Record<string, string | string[] | undefined>>;
  workspaceName: string;
}) {
  const first: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(params)) {
    first[key] = Array.isArray(value) ? value[0] : value;
  }
  let activeToken: string | undefined;
  if (first.signed_out === '1' && first.from !== undefined) {
    const [jar, engine] = await Promise.all([cookies(), getEngine()]);
    activeToken = activeSessionToken(jar, cookieScheme(engine));
  }
  const notices = weekWorkspaceNotices({
    params: first,
    workspaceName,
    verifiedName: (value) => verifiedName(value, activeToken),
  });
  if (notices.length === 0) return null;
  return (
    <div className={css.notices}>
      {notices.map((notice) => (
        <Notice
          key={notice.id}
          label={notice.label}
          tone={notice.tone}
          role={notice.tone === 'danger' ? 'alert' : 'status'}
          action={notice.signOutAll ? <SignOutAllForm inline /> : undefined}
        >
          {notice.message}
        </Notice>
      ))}
    </div>
  );
}
