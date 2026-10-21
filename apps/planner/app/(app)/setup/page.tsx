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
   button). Installing itself is Linear's admin consent screen. */
export default async function SetupPage() {
  const { engine, actor } = await requirePageActor();
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
    const demo = engine.mode === 'fixture';
    const canReinstall = actor.isPm && !demo;
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
              {canReinstall ? (
                <Button href={INSTALL_HREF}>Reinstall to change teams</Button>
              ) : null}
            </div>
            {canReinstall ? (
              <p className={styles.note}>
                Reinstalling asks Linear for the app&apos;s grant again, so a
                workspace admin can change which teams the planner sees.
              </p>
            ) : null}
            {demo ? (
              <p className={styles.note}>
                Demo mode installs its fictional workspace when the server
                starts; there is no Linear app to reinstall.
              </p>
            ) : null}
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
          <div className={styles.actions}>
            <Button href={INSTALL_HREF} variant="primary">
              {revoked ? 'Reinstall in Linear' : 'Install in Linear'}
            </Button>
          </div>
          <p className={styles.note}>
            Not a Linear admin? Send this page to one: the button works for them
            once they sign in.
          </p>
        </div>
      </section>
    </div>
  );
}
