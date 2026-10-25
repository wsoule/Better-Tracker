import { Notice } from '@better-tracker/ui';

import { sessionSecret } from '../../../lib/auth-cookies';
import { verifyValue } from '../../../lib/signed-cookie';
import { weekWorkspaceNotices } from '../../../lib/workspace-copy';
import SignOutAllForm from './sign-out-all-form';
import css from './workspace-notices.module.css';

/** The signed-out workspace's name in a verified `from` value, or null. */
function verifiedName(value: string | undefined): string | null {
  if (value === undefined || value === '') return null;
  try {
    const record = verifyValue(value, sessionSecret(false), Date.now());
    const name = record?.signedOut;
    return typeof name === 'string' && name !== '' ? name : null;
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
   value the logout route signed, never from the URL as such. */
export default function WorkspaceNotices({
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
  const notices = weekWorkspaceNotices({
    params: first,
    workspaceName,
    verifiedName,
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
