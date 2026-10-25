import { Button } from '@better-tracker/ui';
import { LogOut } from 'lucide-react';

import { SIGN_OUT_ALL_LABEL } from '../../../lib/workspace-copy';
import css from './sign-out-all-form.module.css';

/* "Sign out of all workspaces" (OAuth mode, owner decision 2026-10-25:
   Settings → Status, /setup and the /week sign-out notice): a plain form
   posting scope=all to /api/auth/logout, which ends every session this
   browser holds (each revoking its Linear grant) and clears both cookies.
   Signing out changes nothing in Linear or the planner, so it is offered
   to everyone, read-only people included. A Gr8r secondary button with
   the shell's sign-out icon; `inline` drops the row's top margin (inside
   a notice). */
export default function SignOutAllForm({
  inline = false,
}: {
  inline?: boolean;
}) {
  return (
    <form
      method="post"
      action="/api/auth/logout"
      className={inline ? css.inline : css.row}
    >
      <input type="hidden" name="scope" value="all" />
      <Button
        type="submit"
        variant="secondary"
        size={inline ? 'sm' : undefined}
        icon={<LogOut size={14} strokeWidth={1.8} />}
      >
        {SIGN_OUT_ALL_LABEL}
      </Button>
    </form>
  );
}
