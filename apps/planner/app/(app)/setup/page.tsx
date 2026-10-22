import {
  BlockBar,
  Button,
  Notice,
  PropertyList,
  StatusMark,
} from '@better-tracker/ui';

import {
  INSTALL_STEPS,
  installationFacts,
  setupState,
} from '../../../lib/adapters/setup';
import { formatInstant } from '../../../lib/format';
import { loadInstallation, requirePageActor } from '../../../lib/load';
import { PageCrumb } from '../components/page-crumb';
import ReadOnlyNotice from '../components/read-only-notice';
import Receipts from '../components/receipts';
import styles from './page.module.css';

export const metadata = { title: 'Setup' };

const INSTALL_HREF = '/api/auth/linear?intent=install';

/** The installer's name and the workspace timezone, when the mirror has them. */
async function installContext(
  engine: Awaited<ReturnType<typeof requirePageActor>>['engine'],
  workspaceId: string,
  installerId: string
): Promise<{ installerName: string | null; timeZone: string }> {
  try {
    const loaded = await engine.load(workspaceId);
    return {
      installerName: loaded.snapshot.users.get(installerId)?.name ?? null,
      timeZone: loaded.settings.timezone,
    };
  } catch {
    return { installerName: null, timeZone: engine.config.defaultTimezone };
  }
}

/* /setup (architecture §8.1): installing the app into the signed-in
   person's Linear workspace. Three states: installed (the facts and a way
   to the timeline), installed but revoked (Linear rejected the app's
   grant: reinstall), and not installed (what an install does, then the
   button). Installing itself is Linear's admin consent screen. A Linear
   guest is offered no install or reinstall (owner decision 2026-10-22,
   "Guests limited to read only"; Linear would not let one approve it
   either), only the read-only notice. While an installed workspace's
   first sync has not landed nobody can be placed, so everyone is
   read-only, but Reinstall stays (readOnlyReason `not_synced`). */
export default async function SetupPage() {
  const { engine, actor } = await requirePageActor('/setup');
  const workspaceId = actor.session.workspaceId;
  const installation = await loadInstallation(engine, workspaceId);
  const state = setupState(installation);

  if (installation !== null && state === 'installed') {
    const { installerName, timeZone } = await installContext(
      engine,
      workspaceId,
      installation.installedByUserId
    );
    const facts = installationFacts(installation, installerName, timeZone);
    // Demo mode has no OAuth: the install link would only bounce home.
    // Anyone signed in may reinstall (no roles); Linear asks for an admin.
    const demo = engine.mode === 'fixture';
    // While the first sync has not landed everyone is read-only, but a
    // reinstall stays open (the engine's requireCanInstall): it is how an
    // admin fixes a grant that makes that sync fail.
    const notSynced = actor.readOnlyReason === 'not_synced';
    const readOnly = actor.readOnly && !notSynced;
    return (
      <div className="page">
        <header className={styles.head}>
          <h1 className={styles.title}>Setup</h1>
          <p className={styles.receipts}>
            {installation.workspaceName} · installed{' '}
            {formatInstant(installation.createdAt, timeZone)}
          </p>
        </header>
        <section className="block" aria-label="Linear installation">
          <BlockBar
            index="01"
            title="Linear installation"
            meta={<StatusMark status="done" label="Installed" showLabel />}
          />
          <div className={styles.panel}>
            <PropertyList
              label="Installation details"
              items={facts.map((fact) => ({
                id: fact.id,
                label: fact.label,
                value: fact.value,
              }))}
            />
            <div className={styles.actions}>
              <Button href="/timeline" variant="primary">
                Open the timeline
              </Button>
              {demo || readOnly ? null : (
                <Button href={INSTALL_HREF}>Reinstall to change teams</Button>
              )}
            </div>
            {notSynced ? (
              <Notice label="FIRST SYNC PENDING" role="status">
                The first sync from Linear has not landed, so changes are paused
                for everyone. It is retried on every page and every worker run.
                If it keeps failing, the web service&apos;s logs say why; when
                the cause is the app&apos;s grant (for example the
                initiative:read scope missing), a workspace admin can reinstall.
              </Notice>
            ) : readOnly ? (
              <ReadOnlyNotice />
            ) : demo ? (
              <p className={styles.note}>
                Demo mode installs its fictional workspace when the server
                starts; there is no Linear app to reinstall.
              </p>
            ) : (
              <p className={styles.note}>
                Reinstalling asks Linear for the app&apos;s grant again, so a
                workspace admin can change which teams the planner sees.
              </p>
            )}
          </div>
        </section>
        <PageCrumb label={installation.workspaceName} />
      </div>
    );
  }

  const revoked = installation !== null && state === 'revoked';
  return (
    <div className="page">
      <header className={styles.head}>
        <h1 className={styles.title}>
          {revoked ? 'Reinstall the app' : 'Install the app'}
        </h1>
        <p className={styles.receipts}>
          {revoked
            ? `${installation.workspaceName} · reinstall needed`
            : 'Your Linear workspace · not installed yet'}
        </p>
      </header>
      {revoked && installation.revokedAt !== null ? (
        <div className="block">
          <Notice label="REINSTALL NEEDED" role="status">
            Linear rejected the app&apos;s grant for{' '}
            {installation.workspaceName} on{' '}
            {formatInstant(
              installation.revokedAt,
              engine.config.defaultTimezone
            )}
            : the app was uninstalled in Linear, or Linear refused its token
            when the planner renewed it. Until a workspace admin reinstalls it,
            nothing syncs, nothing is allocated and no warnings go out.
          </Notice>
        </div>
      ) : null}
      <section className="block" aria-label="What installing does">
        <BlockBar
          index="01"
          title={revoked ? 'Reinstall' : 'Install'}
          meta="Linear admin consent"
        />
        <Receipts items={INSTALL_STEPS} label="What installing does" />
        <div className={styles.panel}>
          {actor.readOnly ? (
            <ReadOnlyNotice />
          ) : (
            <>
              <div className={styles.actions}>
                <Button href={INSTALL_HREF} variant="primary">
                  {revoked ? 'Reinstall in Linear' : 'Install in Linear'}
                </Button>
              </div>
              <p className={styles.note}>
                Not a Linear admin? Send this page to one: the button works for
                them once they sign in.
              </p>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
