import { BlockBar, Button, Notice } from '@better-tracker/ui';

import styles from './connect-key-block.module.css';

/* The landing page's connect block with personal API keys
   (LINEAR_AUTH=api_key, owner request 2026-10-23; architecture §8.4). A
   plain server-rendered HTML form, deliberately not a client component:
   no React state ever holds the key, the input never gets a value, and
   the form posts straight to the route handler /api/auth/key (never a
   Server Action, whose arguments Next logs in development). The field is
   a password input with autocomplete off and the password managers'
   ignore attributes, and the copy says to choose Never if a browser
   offers to save it anyway. */

export interface ConnectKeyBlockProps {
  /** A sanitized path to come back to, or null for the default. */
  returnTo: string | null;
  idleHours: number;
  maxHours: number;
  syncMinutes: number;
}

export default function ConnectKeyBlock({
  returnTo,
  idleHours,
  maxHours,
  syncMinutes,
}: ConnectKeyBlockProps) {
  return (
    <section className="block" aria-labelledby="connect-title">
      <BlockBar
        index="01"
        title="Connect"
        meta="Linear API key · memory only"
      />
      <div className={styles.panel}>
        <h1 id="connect-title" className={styles.title}>
          Your week, from Linear.
        </h1>
        <p className={styles.lead}>
          Paste a personal API key from Linear (Settings → Security &amp; access
          → Personal API keys). The planner asks Linear whose key it is and
          keeps it only in this server&apos;s memory. It uses the key for what
          you do here and, for workspace members, to refresh its copy of Linear
          every {syncMinutes} minutes while you are connected. It is never
          saved, logged or sent back to your browser. It is forgotten when you
          sign out, after {idleHours} hours idle, after {maxHours} hours, or
          when the server restarts.
        </p>
        <p className={styles.trust}>
          Whoever runs this server could still capture a key, so connect only to
          a planner you trust.
        </p>
        <form
          className={styles.form}
          method="post"
          action="/api/auth/key"
          autoComplete="off"
        >
          <label htmlFor="linear-api-key" className={styles.label}>
            Linear API key
          </label>
          <input
            id="linear-api-key"
            name="apiKey"
            type="password"
            className={['input', styles.input].filter(Boolean).join(' ')}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            data-1p-ignore=""
            data-lpignore="true"
            data-bwignore=""
            data-form-type="other"
            required
            maxLength={256}
            aria-describedby="linear-api-key-hint"
          />
          <p id="linear-api-key-hint" className={styles.hint}>
            Starts with lin_api_. Create one just for this, named
            &ldquo;Milestone Planner&rdquo;, with Read and Write on all teams,
            never Admin. A Read-only key makes the planner read-only for you.
            Revoke it in Linear when you stop using the planner. If your browser
            offers to save it, choose Never.
          </p>
          {returnTo !== null ? (
            <input type="hidden" name="returnTo" value={returnTo} />
          ) : null}
          <div className={styles.actions}>
            <Button type="submit" variant="primary">
              Connect
            </Button>
          </div>
        </form>
      </div>
    </section>
  );
}

/* The notices above the connect block: why the last connect failed, that
   sign-out forgot the key everywhere (`signedOut` 'everywhere'), that a
   sign-out could not tell whose key it was because this browser's
   connection had already ended ('ended': other browsers may still be
   connected, so it never claims otherwise), or that a session ended on
   its own (idle, time limit, restart) because the browser still sent a
   cookie the planner no longer knows. */
export function ConnectNotices({
  errorMessage,
  signedOut,
  connectionEnded,
  idleHours,
  maxHours,
}: {
  errorMessage: string | null;
  signedOut: 'everywhere' | 'ended' | null;
  connectionEnded: boolean;
  idleHours: number;
  maxHours: number;
}) {
  return (
    <>
      {errorMessage !== null ? (
        <div className="block">
          <Notice label="COULD NOT CONNECT" tone="danger" role="alert">
            {errorMessage}
          </Notice>
        </div>
      ) : null}
      {signedOut === 'everywhere' ? (
        <div className="block">
          <Notice label="SIGNED OUT" tone="muted" role="status">
            The planner forgot your key, in every browser you connected it from.
            It still works in Linear until you revoke it there (Settings →
            Security &amp; access).
          </Notice>
        </div>
      ) : signedOut === 'ended' ? (
        <div className="block">
          <Notice label="ALREADY DISCONNECTED" tone="warning" role="status">
            This browser&apos;s connection had already ended, so the planner
            could not tell whose key to forget. If you also connected your key
            in another browser, it may still be connected there. To forget it
            everywhere, paste it here again, then sign out. It still works in
            Linear until you revoke it there (Settings → Security &amp; access).
          </Notice>
        </div>
      ) : connectionEnded ? (
        <div className="block">
          <Notice label="CONNECTION ENDED" tone="muted" role="status">
            The planner forgot your key: you were idle for {idleHours} hours,
            connected {maxHours} hours ago, connected it in too many browsers at
            once, or the planner restarted. Paste it again to carry on.
          </Notice>
        </div>
      ) : null}
    </>
  );
}
