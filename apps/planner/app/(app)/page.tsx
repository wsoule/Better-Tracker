import type { Engine } from '@better-tracker/engine';
import { Button, Chip, InitialsAvatar, Notice } from '@better-tracker/ui';
import {
  BellRing,
  CalendarCheck,
  ChartGantt,
  ChevronRight,
  CircleAlert,
  ListChecks,
  Network,
  UserRoundCheck,
} from 'lucide-react';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import {
  authErrorMessage,
  DEMO_GUEST_NOTE,
  type DemoUserRow,
  demoUserRows,
  firstParam,
  LANDING_FEATURES,
} from '../../lib/adapters/landing';
import {
  DEFAULT_RETURN_TO,
  sanitizeReturnTo,
  signInHref,
} from '../../lib/auth-cookies';
import { getPageContext } from '../../lib/load';
import DemoNotice from './components/demo-notice';
import MessageBlock from './components/message-block';
import { PageCrumb } from './components/page-crumb';
import Receipts from './components/receipts';
import styles from './page.module.css';

export const metadata = { title: 'Sign in' };

/** Each feature card's icon, by LANDING_FEATURES key (the sidebar's
    icons for the screens that have one). */
const FEATURE_ICONS: Record<string, ReactNode> = {
  'my-week': <CalendarCheck strokeWidth={1.8} />,
  timeline: <ChartGantt strokeWidth={1.8} />,
  dependencies: <Network strokeWidth={1.8} />,
  allocation: <UserRoundCheck strokeWidth={1.8} />,
  warnings: <BellRing strokeWidth={1.8} />,
  rubric: <ListChecks strokeWidth={1.8} />,
};

/** The demo workspace's people and name. */
async function loadDemo(
  engine: Engine
): Promise<{ rows: DemoUserRow[]; workspaceName: string }> {
  const [users, workspaceIds] = await Promise.all([
    engine.listDemoUsers(),
    engine.listWorkspaceIds(),
  ]);
  const rows = demoUserRows(users);
  const workspaceId = workspaceIds[0];
  if (workspaceId === undefined) return { rows, workspaceName: 'the demo' };
  const installation = await engine.getInstallation(workspaceId);
  return { rows, workspaceName: installation?.workspaceName ?? 'the demo' };
}

/* "/": signed in → My week. Signed out → Gr8r's sign-in card (or, in
   demo mode, a list of fictional people to sign in as, each a button)
   and what the tool does. A failed sign-in comes back here as
   ?auth_error=<code> and is said in words (a red alert in the card); a
   signed-in person who hit one (install, write access) gets it as a
   full-page state instead of being bounced to My week. ?returnTo=<path> (a page opened signed out, such as a digest's
   timeline link) is passed on to the sign-in, so it lands there instead
   of on My week. */
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
  const returnTo = sanitizeReturnTo(
    firstParam(params.returnTo),
    DEFAULT_RETURN_TO
  );

  if (actor !== null) {
    if (errorMessage === null) redirect(returnTo);
    return (
      <MessageBlock
        label="Linear sign-in"
        headline="Linear did not finish."
        icon={<CircleAlert strokeWidth={1.8} />}
        tone="danger"
        actions={
          <>
            <Button href="/setup">Open Setup</Button>
            <Button href="/week" variant="primary">
              Go to My week
            </Button>
          </>
        }
      >
        <p role="alert">{errorMessage}</p>
        <PageCrumb label="Linear sign-in" />
      </MessageBlock>
    );
  }

  const demo = engine.mode === 'fixture' ? await loadDemo(engine) : null;

  return (
    <div className={styles.auth}>
      {demo !== null ? (
        <div className={styles.demoNotice}>
          <DemoNotice />
        </div>
      ) : null}

      <section className={styles.card} aria-labelledby="signin-title">
        {errorMessage !== null ? (
          <Notice label="Sign-in did not finish" tone="danger" role="alert">
            {errorMessage}
          </Notice>
        ) : null}
        <header className={styles.cardHead}>
          <h1 id="signin-title" className={styles.title}>
            Your week, from Linear.
          </h1>
          <p className={styles.sub}>
            {demo !== null
              ? `A fictional workspace, ${demo.workspaceName}: nothing here touches a real Linear account. Pick anyone to sign in as.`
              : 'Sign in with the Linear account you use at work.'}
          </p>
        </header>
        {demo !== null ? (
          <>
            <ul className={styles.people} aria-label="Demo people">
              {demo.rows.map((row) => (
                <li key={row.id}>
                  <DemoPerson row={row} returnTo={returnTo} />
                </li>
              ))}
            </ul>
            <p className={styles.foot}>
              Everyone can re-date milestones, set project leads, edit issues,
              change settings and run allocation, and every edit is in the audit
              log under that person’s name. The guest, as in Linear, sees only
              their own team, and can look but not change anything.
            </p>
          </>
        ) : (
          <>
            <Button
              href={signInHref(returnTo)}
              variant="primary"
              size="lg"
              block
            >
              Sign in with Linear
            </Button>
            <p className={styles.foot}>
              The planner reads issues, projects and milestones from Linear. It
              writes back only an issue&apos;s assignee and state when it
              allocates, a comment saying why, and the edits you make yourself
              (milestone dates, project leads, issues), always as you.
            </p>
          </>
        )}
      </section>

      <section className={styles.features} aria-labelledby="features-title">
        <header className={styles.featuresHead}>
          <h2 id="features-title" className={styles.featuresTitle}>
            What it does
          </h2>
          <p className={styles.featuresSub}>
            Linear stays the source of truth.
          </p>
        </header>
        <Receipts
          items={LANDING_FEATURES.map((feature) => ({
            ...feature,
            icon: FEATURE_ICONS[feature.key],
          }))}
          label="What the planner does"
        />
      </section>
    </div>
  );
}

/* One demo person as a full-width secondary button (Gr8r's account row):
   round initials, the name (with a Guest chip for a Linear guest) over
   the email, a chevron. It posts the demo sign-in form; the visible name
   is inside the accessible name ("Sign in as Ana Moreno …"). */
function DemoPerson({ row, returnTo }: { row: DemoUserRow; returnTo: string }) {
  return (
    <form method="post" action="/api/auth/demo">
      <input type="hidden" name="userId" value={row.id} />
      {returnTo !== DEFAULT_RETURN_TO ? (
        <input type="hidden" name="returnTo" value={returnTo} />
      ) : null}
      <button type="submit" className={`button ${styles.person}`}>
        <InitialsAvatar name={row.name} size="md" />
        <span className={styles.personText}>
          <span className={styles.personName}>
            <span className="srOnly">Sign in as </span>
            {row.name}
            {row.label !== null ? <Chip>{row.label}</Chip> : null}
          </span>
          <span className={styles.personMeta}>
            {row.label !== null
              ? DEMO_GUEST_NOTE
              : (row.email ?? 'No email in Linear')}
          </span>
        </span>
        <ChevronRight
          className={styles.chevron}
          size={16}
          strokeWidth={1.8}
          aria-hidden="true"
        />
      </button>
    </form>
  );
}
