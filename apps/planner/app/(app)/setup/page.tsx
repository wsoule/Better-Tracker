import { PURGE_AFTER_DAYS } from '@better-tracker/engine';
import {
  BlockBar,
  Button,
  Chip,
  Notice,
  PropertyList,
} from '@better-tracker/ui';

import { WORKSPACE_ID_PURPOSE } from '../../../lib/adapters/settings';
import {
  INSTALL_STEPS,
  installationFacts,
  revokedNotice,
  setupState,
} from '../../../lib/adapters/setup';
import { formatInstant } from '../../../lib/format';
import { heldCount } from '../../../lib/held-sessions';
import {
  loadHeldSessions,
  loadInstallation,
  requirePageActor,
} from '../../../lib/load';
import { installHref } from '../../../lib/oauth-links';
import { FIRST_SYNC_RETRY_SENTENCE } from '../../../lib/read-only';
import { UNNAMED_WORKSPACE } from '../../../lib/workspace-copy';
import { PageCrumb } from '../components/page-crumb';
import PolicyLinks from '../components/policy-links';
import ReadOnlyNotice from '../components/read-only-notice';
import Receipts from '../components/receipts';
import SignOutAllForm from '../components/sign-out-all-form';
import WorkspaceGuard from '../components/workspace-guard';
import WorkspaceNotices from '../components/workspace-notices';
import styles from './page.module.css';

export const metadata = { title: 'Setup' };

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
   read-only, but Reinstall stays (readOnlyReason `not_synced`). With
   personal API keys (LINEAR_AUTH=api_key) there is nothing to install:
   one sentence, the workspace the planner serves, and the way home.
   In OAuth mode (owner decision 2026-10-25) the page names the session's
   workspace even before an install, a revoked installation says why
   (uninstalled in Linear, removed by the person who runs the planner, or
   a token Linear refused) and, for the first two, when its data is
   deleted, and with two or more workspaces held it offers "Sign out of
   all workspaces". Every state shows the workspace's Linear id (what
   LINEAR_WORKSPACES names to admit it) and ends with the privacy · terms
   · contact links; a first sync that keeps failing points at the person
   who runs the planner (their logs say why) through /contact. A page that
   sends a workspace without a working installation here keeps /week's
   workspace notices in the query (requireInstalledActor), and the
   not-installed and revoked states show them under the head: a sign-out,
   connect or switch that left such a workspace active still says what
   happened, with "Sign out of all workspaces" beside a sign-out. */
export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ engine, actor }, params] = await Promise.all([
    requirePageActor('/setup'),
    searchParams,
  ]);
  const workspaceId = actor.session.workspaceId;
  const [installation, held] = await Promise.all([
    loadInstallation(engine, workspaceId),
    loadHeldSessions(),
  ]);
  const oauth = engine.mode !== 'fixture' && engine.config.auth !== 'api_key';
  // The session's own description: its workspace's name before any
  // install, and why an installation was revoked.
  const current = held.active?.workspaceId === workspaceId ? held.active : null;
  const signOutAll = oauth && heldCount(held) >= 2 ? <SignOutAllForm /> : null;

  if (engine.config.auth === 'api_key') {
    return (
      <div className="page">
        <header className={styles.head}>
          <h1 className={styles.title}>Setup</h1>
          <p className={styles.receipts}>
            {installation === null
              ? 'No workspace bound yet'
              : `${installation.workspaceName} · linear.app/${installation.urlKey}`}
          </p>
        </header>
        <section className="block" aria-label="Personal API keys">
          <div className={styles.column}>
            <BlockBar
              title="Personal API keys"
              meta={<Chip tone="muted">Memory only</Chip>}
            />
            <div className={styles.panel}>
              {installation === null ? null : (
                <div className={styles.facts}>
                  <PropertyList
                    label="Workspace"
                    items={[
                      {
                        id: 'workspace',
                        label: 'Workspace',
                        value: installation.workspaceName,
                      },
                      {
                        id: 'url',
                        label: 'URL key',
                        value: `linear.app/${installation.urlKey}`,
                      },
                    ]}
                  />
                </div>
              )}
              <div className={styles.foot}>
                <div className={styles.actions}>
                  <Button href="/" variant="primary">
                    Go home
                  </Button>
                </div>
                <p className={styles.note}>
                  This planner uses personal API keys: there is nothing to
                  install.
                </p>
              </div>
            </div>
            <PolicyLinks />
          </div>
        </section>
        <PageCrumb label="Setup" />
        <WorkspaceGuard />
      </div>
    );
  }
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
          <div className={styles.column}>
            <BlockBar
              title="Linear installation"
              meta={<Chip tone="success">Installed</Chip>}
            />
            {notSynced ? (
              <Notice label="First sync pending" tone="warning" role="status">
                The first sync from Linear has not landed, so changes are paused
                for everyone. {FIRST_SYNC_RETRY_SENTENCE} If it keeps failing,
                the person who runs this planner can see why (
                <a className="accentLink" href="/contact">
                  how to reach them
                </a>
                ); when the cause is the app&apos;s grant (for example the
                initiative:read scope missing), a workspace admin can reinstall.
              </Notice>
            ) : readOnly ? (
              <ReadOnlyNotice />
            ) : null}
            <div className={styles.panel}>
              <div className={styles.facts}>
                <PropertyList
                  label="Installation details"
                  items={[
                    ...facts.map((fact) => ({
                      id: fact.id,
                      label: fact.label,
                      value: fact.value,
                    })),
                    {
                      id: 'workspace-id',
                      label: 'Workspace id',
                      value: <span className="mono">{workspaceId}</span>,
                    },
                  ]}
                />
              </div>
              <div className={styles.foot}>
                <div className={styles.actions}>
                  <Button href="/timeline" variant="primary">
                    Open the timeline
                  </Button>
                  {demo || readOnly ? null : (
                    <Button href={installHref(workspaceId)}>
                      Reinstall to change teams
                    </Button>
                  )}
                </div>
                {notSynced || readOnly ? null : demo ? (
                  <p className={styles.note}>
                    Demo mode installs its fictional workspace when the server
                    starts; there is no Linear app to reinstall.
                  </p>
                ) : (
                  <p className={styles.note}>
                    Reinstalling asks Linear for the app&apos;s grant again, so
                    a workspace admin can change which teams the planner sees.
                  </p>
                )}
              </div>
            </div>
            <PolicyLinks />
          </div>
          {signOutAll}
        </section>
        <PageCrumb label={installation.workspaceName} />
        <WorkspaceGuard />
      </div>
    );
  }

  const revoked = installation !== null && state === 'revoked';
  const workspaceName =
    installation?.workspaceName ?? current?.workspaceName ?? null;
  return (
    <div className="page">
      <header className={styles.head}>
        <h1 className={styles.title}>
          {revoked ? 'Reinstall the app' : 'Install the app'}
        </h1>
        <p className={styles.receipts}>
          {revoked
            ? `${installation.workspaceName} · reinstall needed`
            : `${workspaceName ?? 'Your Linear workspace'} · not installed yet`}
        </p>
      </header>
      {oauth ? (
        <WorkspaceNotices
          params={params}
          workspaceName={workspaceName ?? UNNAMED_WORKSPACE}
        />
      ) : null}
      {revoked && installation.revokedAt !== null ? (
        <div className="block">
          <div className={styles.column}>
            <Notice label="Reinstall needed" tone="danger" role="status">
              {revokedNotice({
                reason: current?.revokedReason ?? null,
                revokedAt: installation.revokedAt,
                workspaceName: installation.workspaceName,
                timeZone: engine.config.defaultTimezone,
                purgeAfterDays: PURGE_AFTER_DAYS,
              })}
            </Notice>
          </div>
        </div>
      ) : null}
      <section className="block" aria-label="What installing does">
        <div className={styles.column}>
          <BlockBar
            title={revoked ? 'Reinstall' : 'Install'}
            meta="Linear admin consent"
          />
          <Receipts
            items={INSTALL_STEPS}
            label="What installing does"
            variant="steps"
          />
          {actor.readOnly ? (
            <ReadOnlyNotice />
          ) : (
            <div className={styles.installRow}>
              <Button href={installHref(workspaceId)} variant="primary">
                {revoked ? 'Reinstall in Linear' : 'Install in Linear'}
              </Button>
              <p className={styles.note}>
                Not a Linear admin? Send this page to one: the button works for
                them once they sign in.
              </p>
            </div>
          )}
          {oauth ? (
            <p className={styles.note}>
              Workspace id: <span className="mono">{workspaceId}</span> (
              {WORKSPACE_ID_PURPOSE}).
            </p>
          ) : null}
          {signOutAll}
          <PolicyLinks />
        </div>
      </section>
      {workspaceName === null ? null : <PageCrumb label={workspaceName} />}
      <WorkspaceGuard />
    </div>
  );
}
