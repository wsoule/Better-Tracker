import type { Engine } from '@better-tracker/engine';
import {
  BlockBar,
  Button,
  Chip,
  Notice,
  Register,
  RegisterCell,
  RegisterRow,
} from '@better-tracker/ui';
import { redirect } from 'next/navigation';

import {
  authErrorMessage,
  type DemoUserRow,
  demoUserRows,
  firstParam,
  LANDING_FEATURES,
} from '../../lib/adapters/landing';
import { getPageContext } from '../../lib/load';
import DemoNotice from './components/demo-notice';
import { PageCrumb } from './components/page-crumb';
import Receipts from './components/receipts';
import styles from './page.module.css';

export const metadata = { title: 'Sign in' };

/** The demo workspace's people, PMs (from its settings) and name. */
async function loadDemo(
  engine: Engine
): Promise<{ rows: DemoUserRow[]; workspaceName: string }> {
  const [users, workspaceIds] = await Promise.all([
    engine.listDemoUsers(),
    engine.listWorkspaceIds(),
  ]);
  const workspaceId = workspaceIds[0];
  if (workspaceId === undefined) {
    return { rows: demoUserRows(users, []), workspaceName: 'the demo' };
  }
  const [loaded, installation] = await Promise.all([
    engine.load(workspaceId),
    engine.getInstallation(workspaceId),
  ]);
  return {
    rows: demoUserRows(users, loaded.settings.pmUserIds),
    workspaceName: installation?.workspaceName ?? 'the demo',
  };
}

/* "/": signed in → My week. Signed out → the sign-in block (or, in demo
   mode, a picker of fictional people) and what the tool does. A failed
   sign-in comes back here as ?auth_error=<code> and is said in words;
   a signed-in person who hit one (install, write access) sees it too
   instead of being bounced to My week. */
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ engine, actor }, params] = await Promise.all([
    getPageContext(),
    searchParams,
  ]);
  const errorMessage = authErrorMessage(firstParam(params.auth_error));

  if (actor !== null) {
    if (errorMessage === null) redirect('/week');
    return (
      <div className="page">
        <div className="block">
          <Notice
            label="LINEAR DID NOT FINISH"
            role="alert"
            action={
              <span className={styles.noticeActions}>
                <Button href="/setup" size="sm">
                  Open Setup
                </Button>
                <Button href="/week" size="sm">
                  Go to My week
                </Button>
              </span>
            }
          >
            {errorMessage}
          </Notice>
        </div>
        <PageCrumb label="Linear sign-in" />
      </div>
    );
  }

  const demo = engine.mode === 'fixture' ? await loadDemo(engine) : null;

  return (
    <div className="page">
      {errorMessage !== null ? (
        <div className="block">
          <Notice label="SIGN-IN DID NOT FINISH" role="alert">
            {errorMessage}
          </Notice>
        </div>
      ) : null}
      {demo !== null ? (
        <div className="block">
          <DemoNotice />
        </div>
      ) : null}

      <section className="block" aria-labelledby="signin-title">
        <BlockBar
          index="01"
          title="Sign in"
          meta={demo !== null ? 'Demo mode · pick a person' : 'Linear OAuth'}
        />
        <div className={styles.signIn}>
          <h1 id="signin-title" className={styles.title}>
            Your week, from Linear.
          </h1>
          {demo !== null ? (
            <p className={styles.lead}>
              This server runs on a fictional workspace, {demo.workspaceName},
              so nothing here touches a real Linear account. Pick a person to
              sign in as. PMs can re-date milestones, set project leads and run
              allocation; everyone else sees the same screens without the edit
              controls.
            </p>
          ) : (
            <>
              <p className={styles.lead}>
                Sign in with the Linear account you use at work. The planner
                reads issues, projects and milestones from Linear. It writes
                back only an issue&apos;s assignee and state when it allocates,
                a comment saying why, and the milestone dates and project leads
                a PM changes.
              </p>
              <div className={styles.actions}>
                <Button href="/api/auth/linear?intent=signin" variant="primary">
                  Sign in with Linear
                </Button>
              </div>
            </>
          )}
        </div>
        {demo !== null ? (
          <Register
            label="Demo people"
            columns="minmax(0, 1.3fr) 96px minmax(0, 1fr) 190px"
            header={[
              { id: 'name', label: 'Person' },
              { id: 'role', label: 'Role' },
              { id: 'email', label: 'Email' },
              { id: 'action', label: 'Sign in', align: 'end' },
            ]}
            stackedColumns="88px minmax(0, 1fr)"
          >
            {demo.rows.map((row) => (
              <RegisterRow key={row.id}>
                <RegisterCell variant="name">{row.name}</RegisterCell>
                <RegisterCell label="Role" variant="mono">
                  {row.isPm ? <Chip tone="inverse">PM</Chip> : 'Member'}
                </RegisterCell>
                <RegisterCell label="Email" tone="muted">
                  {row.email ?? 'No email'}
                </RegisterCell>
                <RegisterCell align="end">
                  <form method="post" action="/api/auth/demo">
                    <input type="hidden" name="userId" value={row.id} />
                    <Button
                      type="submit"
                      size="sm"
                      variant={row.isPm ? 'primary' : 'secondary'}
                    >
                      {row.action}
                    </Button>
                  </form>
                </RegisterCell>
              </RegisterRow>
            ))}
          </Register>
        ) : null}
      </section>

      <section className="block" aria-label="What it does">
        <BlockBar
          index="02"
          title="What it does"
          meta="Linear stays the source of truth"
        />
        <Receipts items={LANDING_FEATURES} label="What the planner does" />
      </section>
    </div>
  );
}
