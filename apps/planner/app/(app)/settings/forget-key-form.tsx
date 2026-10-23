import { Button } from '@better-tracker/ui';
import { LogOut } from 'lucide-react';

import css from './page.module.css';

/* Settings → Status with personal API keys: "Forget my key and sign out",
   a plain form posting to /api/auth/logout, which forgets every connected
   key of the person (every device). Signing out changes nothing in Linear
   or the planner, so it is offered to everyone, read-only people too. A
   Gr8r secondary button with the shell's sign-out icon. */
export default function ForgetKeyForm() {
  return (
    <form method="post" action="/api/auth/logout" className={css.forgetKey}>
      <Button
        type="submit"
        variant="secondary"
        icon={<LogOut size={14} strokeWidth={1.8} />}
      >
        Forget my key and sign out
      </Button>
    </form>
  );
}
