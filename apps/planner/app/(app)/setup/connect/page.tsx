import { BlockBar, Button, Notice } from '@better-tracker/ui';
import { notFound } from 'next/navigation';

import { firstParam } from '../../../../lib/adapters/landing';
import {
  addWorkspaceHref,
  DEFAULT_RETURN_TO,
  sanitizeReturnTo,
} from '../../../../lib/auth-cookies';
import { heldCount } from '../../../../lib/held-sessions';
import { getPageContext, loadHeldSessions } from '../../../../lib/load';
import { MAX_HELD_WORKSPACES } from '../../../../lib/session-cookies';
import { CONNECT_HINT, CONNECT_LABEL } from '../../../../lib/workspace-copy';
import { PageCrumb } from '../../components/page-crumb';
import WorkspaceGuard from '../../components/workspace-guard';
import styles from '../page.module.css';

export const metadata = { title: 'Connect another workspace' };

/* /setup/connect (OAuth mode, owner decision 2026-10-25; architecture
   §8.4): what connecting another Linear workspace does, then "Continue to
   Linear", a plain link to /api/auth/linear?intent=add_workspace (with the
   sanitised ?returnTo= when the open interstitial passed one). Linear
   connects whichever workspace is open at linear.app, so the page says to
   open the one to add there first. Signed in or out, and without
   JavaScript; the workspace menu, the palette, the interstitial and the
   landing link here. While the browser holds 10 workspaces it says to
   sign out of one first instead (the start route refuses too). Demo mode
   and personal API keys have one workspace: 404. */
export default async function ConnectWorkspacePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ engine }, params] = await Promise.all([
    getPageContext(),
    searchParams,
  ]);
  if (engine.mode === 'fixture' || engine.config.auth === 'api_key') {
    notFound();
  }
  const held = await loadHeldSessions();
  const full = heldCount(held) >= MAX_HELD_WORKSPACES;
  const returnTo = sanitizeReturnTo(
    firstParam(params.returnTo),
    DEFAULT_RETURN_TO
  );
  return (
    <div className="page">
      <header className={styles.head}>
        <h1 className={styles.title}>{CONNECT_LABEL}</h1>
        <p className={styles.receipts}>Sign in with Linear</p>
      </header>
      <section className="block" aria-label={CONNECT_LABEL}>
        <div className={styles.column}>
          <BlockBar title="Which workspace" meta="Linear consent" />
          {full ? (
            <Notice label="Ten workspaces" tone="warning" role="status">
              This browser is signed in to 10 workspaces, the most it holds.
              Sign out of a workspace first, then connect another.
            </Notice>
          ) : null}
          <div className={styles.panel}>
            <div className={styles.facts}>
              <p className={styles.note}>{CONNECT_HINT}</p>
            </div>
            <div className={styles.foot}>
              <div className={styles.actions}>
                {full ? null : (
                  <Button href={addWorkspaceHref(returnTo)} variant="primary">
                    Continue to Linear
                  </Button>
                )}
                <Button href={returnTo}>Cancel</Button>
              </div>
              <p className={styles.note}>
                The planner asks for read access. Each workspace keeps its own
                sign-in; switch between them from the workspace menu.
              </p>
            </div>
          </div>
        </div>
      </section>
      <PageCrumb label={CONNECT_LABEL} />
      <WorkspaceGuard />
    </div>
  );
}
