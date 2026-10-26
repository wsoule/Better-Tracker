# Deploying Milestone Planner

This guide sets up a production deployment: a Linear OAuth application, a Slack
app for the digests, and one Railway project with Postgres plus two services
built from this repo (the web app and the cron worker). It follows the build
spec (`docs/architecture.md`, cited as "arch §n") and the verified external
facts in `docs/research.md` (cited as "research: <section>").

The research could not load linear.app, slack.com or railway.com directly. Some
facts come from search excerpts of the official pages, cross-checked against
each vendor's SDK source. Where the research marks a fact UNVERIFIABLE or only
inferred, this guide says **verify this in your workspace**. Section 6 lists the
open questions that need a live test. Section 7 runs the planner against real
Linear **without an OAuth app**: each person pastes their own personal API key,
which the planner keeps only in memory (`LINEAR_AUTH=api_key`).

What you need:

- A Linear **workspace admin**. Installing the app with `actor=app` is
  workspace-scoped and needs an admin (research: Linear OAuth 2.0, Q3).
- A Slack admin, or a member who is allowed to install apps.
- A Railway account and access to this GitHub repository.
- The public URL the app will live at, called `APP_URL` below (for example
  `https://planner.example.com`, no trailing slash). Linear needs it for the
  callback and webhook URLs. If you do not have a domain yet, do the first part
  of step 3 (create the project and the `web` service, then generate a Railway
  domain), then come back to step 1.

## 1. Linear OAuth application

One OAuth application does three things. It signs people in (`actor=user`). It
is installed once into the workspace (`actor=app`), and it then makes the
allocation writes as its own app user. It also delivers webhooks for every
workspace that installs it (arch §4.1).

1. In Linear, open **Settings → Administration → API** and create a new OAuth
   application (research: Linear webhooks, 5a). Creating or managing OAuth apps
   needs admin permissions in that workspace (research: Linear OAuth 2.0, Q3).
   Exactly which roles may create one on non-Enterprise plans is an open
   question: **verify this in your workspace**.
2. Name it after `APP_NAME` (default `Milestone Planner`). Allocation comments
   and assignments show up in Linear as coming from this app user.
3. **Callback URL**: `<APP_URL>/api/auth/linear/callback`, exactly. The
   `redirect_uri` must match a registered URL character for character (research:
   Linear OAuth 2.0, Q1). Sign-in, the write grant and the install all use this
   one callback (arch §7.1). To also run the app locally against real Linear,
   add `http://localhost:3000/api/auth/linear/callback` if the form accepts more
   than one URL.
4. **Webhooks**: enable them and set
   - URL: `<APP_URL>/api/webhooks/linear`
   - Resource types: **Issue, Project, Initiative, User**, plus
     **OAuthAuthorization** if the form offers it (arch §4.1). There is no
     ProjectMilestone and no IssueRelation webhook type (research: Linear
     webhooks, "Is there a ProjectMilestone webhook?" and "Are IssueRelation …
     changes delivered by webhook?"). The worker's 15-minute resync picks those
     changes up instead.

   Set up webhooks **before** anyone installs the app. A changelog note says
   existing installs must re-authorize before deliveries start when webhooks are
   enabled later. The research rates that only partially supported: **verify
   this in your workspace**. If deliveries never arrive, reinstall (step 4).

5. Copy three values into the Railway variables (step 3):
   - Client ID → `LINEAR_CLIENT_ID`
   - Client secret → `LINEAR_CLIENT_SECRET`
   - Webhook signing secret → `LINEAR_WEBHOOK_SECRET`. The web app checks the
     `Linear-Signature` header (HMAC-SHA256 of the raw body) against it and
     rejects any delivery whose `webhookTimestamp` is more than 60 s old (arch
     §4.1).
6. **Distribution** can stay **private** (the default) for one workspace.
   "Private applications are only installable by the owning workspace", so
   create the app in the workspace you will install it into. Public distribution
   is only needed for other workspaces (research: Linear OAuth 2.0, "OAuth app
   distribution"). To let other people's workspaces install it, make it public:
   open **Settings → Administration → API**, open the app and switch it to
   **Public**. Linear then asks for a developer URL: use `<APP_URL>/contact`,
   the planner's contact page (who runs it, from `OPERATOR_NAME`,
   `OPERATOR_EMAIL` and `OPERATOR_URL`; section 5 "Opening the planner to other
   workspaces"). Making it public does not let anyone in by itself: the planner
   only admits the workspaces `LINEAR_WORKSPACES` names (closed to new ones
   while it is unset). It is not listed in Linear's Integration Directory; that
   is a separate submission this guide does not cover.

Nothing else needs configuring on the Linear side. The app requests its scopes
when it sends people to Linear (arch §7 auth):

- Sign-in uses `read`.
- Anyone who edits issues, milestone dates or project leads grants `read,write`
  once, so Linear credits those edits to that person. There is no PM role:
  everyone signed in can edit everything (design §12, 2026-10-22).
- The install uses `read,write,initiative:read` with `actor=app`. An `actor=app`
  app user sees the workspace's initiatives only through `initiative:read`
  (Linear changelog 2025-08-14; research: Linear OAuth 2.0 scopes), and every
  sync reads them to group the timeline by initiative. An `actor=app` install
  cannot request `admin`. An installation made before this scope was added must
  be installed again from `/setup` so its grant carries it.

What the planner relies on (arch §4.1, research: Linear OAuth 2.0, Q3–Q4):

- **Access tokens last 24 hours** (`expires_in` ≈ 86399) and **refresh tokens
  rotate**. Each refresh returns a new access token and a new refresh token, and
  the old refresh token stops working. (Whether the old access token also stops
  at once is not documented; see section 6.) The planner refreshes 5 minutes
  early, under a database row lock, so only one process ever refreshes a given
  token. One consequence: a database restored from a backup holds refresh tokens
  that are already dead (see step 5).
- **The install needs a workspace admin**, and the app sees **only the teams the
  admin picks during the install**. Issues in other teams, including private
  teams outside that grant, are invisible to the planner. An admin can change
  team access later in Linear. The next full sync then adds or drops those
  teams' data.
- **Granted private teams stay private.** The planner reads team visibility and
  membership and shows a private team's projects, milestones, issues, relations
  and log entries only to its members; a Linear **guest** sees only the teams
  they belong to, and no initiatives (arch §2.13). Membership changes show after
  the next full sync (Linear sends no webhook for them). Digests follow the same
  rule: a lead or watcher is never told about a project they cannot see, and a
  digest names only issues its recipient can see. Since 2026-10-22 guests are
  also **read-only** (design §12, "guests are read-only"): they can look but not
  change anything here (no edits, settings, runs, resync, digest preview or
  write grant). A person Linear turns from guest to member (or back) gets the
  change on their next page after the mirror learns it (a User webhook, or the
  next full sync).
- If the workspace has **Third-Party App Approvals** turned on (paid plans), a
  member's first sign-in may become an approval request for an admin or owner
  (research: Linear OAuth 2.0, Q3). **Verify this in your workspace** before
  rolling out to the team.
- Linear retries a failed webhook delivery after 1 minute, 1 hour and 6 hours,
  then may disable the webhook. If it does, re-enable the webhook in the app's
  settings (research: Linear webhooks, 6a). The resync covers anything that was
  missed.

## 2. Slack app (digests)

The worker sends each person at most one digest per day, as a direct message
from the app. The message lands in the app's **App Home → Messages** tab and is
posted with `chat.postMessage` with `channel=<user id>` (arch §6, research:
Slack DM digests). People are matched by email: their Linear email is looked up
with `users.lookupByEmail`, so it must match their Slack email.

1. Create a Slack app for your workspace at <https://api.slack.com/apps> ("From
   scratch").
2. **OAuth & Permissions → Bot Token Scopes**: add exactly
   - `chat:write` (send the DMs)
   - `users:read` and `users:read.email` (find people by email; Slack requires
     `users:read.email` to be requested together with `users:read`)

   No `im:write` is needed: posting to a user ID needs only `chat:write`
   (research: Slack DM digests, "Can chat.postMessage be called with
   channel=<user ID>…").

3. **App Home**: turn on the **Messages Tab**. Slack's method reference lists
   `messages_tab_disabled` as the error for sends while it is off, and the
   planner then marks the person undeliverable. Whether Slack still raises that
   error today was not confirmed on the live page, so turn the tab on either
   way. Read-only is fine, because the planner never reads replies. The research
   found the polarity of the "read-only" manifest flag ambiguous: **verify in
   the App Home page** that the setting does what you expect.
4. Leave token rotation off. The planner uses one long-lived bot token and has
   no Slack token-refresh logic.
5. **Install to Workspace**, then copy the **Bot User OAuth Token** (`xoxb-…`)
   into `SLACK_BOT_TOKEN` (step 3).

If you prefer an app manifest, the App Home keys below are verified (research:
Slack DM digests, "Does the App Home Messages tab need to be enabled?"). The
other keys are standard manifest keys that the research did not re-check, so
compare the result with the dashboard after creating the app:

```yaml
display_information:
  name: Milestone Planner
features:
  bot_user:
    display_name: Milestone Planner
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: true
oauth_config:
  scopes:
    bot:
      - chat:write
      - users:read
      - users:read.email
```

Without `SLACK_BOT_TOKEN`, digests are only recorded in the outbox. They show in
Settings, and nothing is sent. With warnings set to live and no token, every
digest is recorded as undeliverable, so the gap is visible (arch §7.1).

**One Slack bot serves one workspace.** While the planner may serve more than
one Linear workspace (`LINEAR_WORKSPACES=*`, a list of more than one, or, while
it is unset, more than one installed workspace), it never uses
`SLACK_BOT_TOKEN`: every workspace's digests stay in its outbox, recorded as
undeliverable while warnings are live, and boot and each live warning run log a
warning naming why (arch §7 "Fail-safes"). One bot cannot DM people in a
stranger's Slack. The planner's pages then promise no Slack DM either: Settings
and the landing page say digests are kept in the planner. The check is made
every time, so when a second workspace uninstalls, Slack DMs and the pages that
mention them come back without a redeploy.

## 3. Railway

### Why the dashboard and not a config file

Railway's Config as Code (`railway.json` / `railway.toml`) is **deprecated**.
New services cannot opt into it, and existing files stop being read at the
**2026-12-01** hard cutoff (research: Railway deployment, "CRITICAL: Is Config
as Code … still usable"). A committed `railway.json` would therefore be ignored,
so these steps use the dashboard. The newer option is Infrastructure as Code
(`.railway/railway.ts`, applied with the Railway CLI). It is not included
because whether Railway honors the Dockerfile path, watch patterns and cron
fields applied through it could not be verified from this environment (research:
Railway deployment, "IaC caveats").

### Project layout

One Railway project with three services:

| service    | what                  | from                                    |
| ---------- | --------------------- | --------------------------------------- |
| `Postgres` | Railway's PostgreSQL  | Railway's database service              |
| `web`      | the Next.js app       | this repo, `deploy/Dockerfile`          |
| `worker`   | the cron job (`tick`) | this repo, the same `deploy/Dockerfile` |

1. Create the project and add a **PostgreSQL** database. Keep the service name
   `Postgres`: the reference `${{Postgres.DATABASE_URL}}` uses the service name
   exactly as Railway shows it (research: Railway deployment, "Variable
   reference syntax"). If you rename it, change the references to match.
2. Add a service from this GitHub repository and name it `web`. Add a second
   service from the same repository and name it `worker`.
3. On **both** services:
   - **Root Directory**: `/`. This is a shared pnpm workspace. Each service
     needs the whole repo, not one subfolder (research: Railway deployment,
     "Root directory vs shared (pnpm workspace) monorepos").
   - Variable **`RAILWAY_DOCKERFILE_PATH=deploy/Dockerfile`**. The Dockerfile is
     kept out of the repo root on purpose: Railway always builds with a
     Dockerfile when it finds one there (research: Railway deployment, "Can a
     cron service share the Dockerfile…"). The research saw this variable both
     as `Dockerfile` (the default) and as `/build/Dockerfile`. **Verify in the
     first build log** that Railway used `deploy/Dockerfile`. If it did not, use
     `/deploy/Dockerfile`.

The image downloads the locked dependencies with `pnpm fetch` (a layer that
changes only with `pnpm-lock.yaml` and `pnpm-workspace.yaml`), installs them
offline with `pnpm install --frozen-lockfile`, and runs `scripts/build-all.sh`,
which builds every package, the worker and the web app. The image then ships
only production dependencies (a fresh `pnpm install --prod`, no Next build
cache). The web app starts from `apps/planner`; the worker's start command runs
from the image's `/app`. **The build never touches the database.** Private
networking exists only at runtime, not during the build (research: Railway
deployment, "Private networking hostnames and protocol"). The Dockerfile
declares no build arguments, so no variable or secret is baked into the image.
Each service builds its own image from the same Dockerfile.

### `web` service

- **Start command**: leave it empty. The image's default command runs
  `next start` on `0.0.0.0:$PORT`.
- Variable **`PORT=3000`**. Railway does not document the default value it
  injects, so set it explicitly (research: Railway deployment, "Web service:
  PORT injection and host binding").
- **Healthcheck path**: `/api/health`, which returns `{ ok, db }` (arch §8.1).
  Railway polls it only while a deploy goes live, never afterwards, from the
  host `healthcheck.railway.app`. The default timeout is 300 s (research:
  Railway deployment, "Healthchecks").
- **Networking → Public Networking**: generate a domain, or add your custom
  domain, targeting **port 3000**. A custom domain needs both the CNAME and the
  TXT record Railway shows. Without the TXT record it answers 404 (research:
  Railway deployment, "Custom domains and subdomains"). `APP_URL` is this domain
  with `https://`.

### `worker` service

- **Custom start command**: `node apps/worker/dist/index.js tick`. For image
  builds, Railway runs the start command in exec form, without a shell. That is
  fine here because the command expands no variables.
- **Cron schedule**: `*/15 * * * *`. Facts about Railway cron (research: Railway
  deployment, "Cron: how cronSchedule works…"):
  - Times are UTC.
  - Runs must be at least 5 minutes apart, and start times can drift by a few
    minutes.
  - Railway runs the start command on each tick and expects the process to exit.
  - Railway never stops a running job. While the previous tick is still running,
    the next tick is **skipped**.

  The worker's hard timeout covers that last point. `TICK_TIMEOUT_MINUTES`
  (default 10) is counted from the moment the process starts, boot included: a
  run that is still going then logs an error and exits 1, before the next slot,
  so one stuck run cannot block the runs after it. The worker refuses values
  above 14, which also keeps it below 15: the daily job's claim may be taken
  over after 45 minutes, which must only happen to a tick that is dead and whose
  allocation run no longer blocks new ones (a run counts as crashed 30 minutes
  after it started). Commands run by hand get the same limit (see "Running jobs
  by hand").

- **Restart policy**: **Never**. The default is On Failure with up to 10
  restarts. Railway does not document how restarts interact with cron runs; its
  cron run statuses include `RESTARTING`, which hints that they can apply. The
  research recommends Never so that a failed run stays failed and the next
  scheduled tick retries, but that is an inference (research: Railway
  deployment, "Restart policy defaults" and open questions): **verify this in
  your workspace** by watching `railway cron list` after a failed run.
- No public domain, no healthcheck and no `PORT` are needed.

Each tick does the following (arch §9):

- First, housekeeping (arch §9 "Cleanup"), before any workspace: expired
  sessions are deleted and their Linear grants revoked; the sessions of a
  workspace that was uninstalled in Linear or removed are ended (their grants
  revoked), except sessions started after the revoke (an admin signing in to
  reinstall); such a workspace's data is purged 30 days after the revoke unless
  it was installed again (a few per tick; a workspace whose grant Linear refused
  is never purged on its own); webhook delivery records older than 30 days,
  digests older than 90 days and daily job records older than 30 days are
  pruned. The audit log and the run log are kept for as long as the workspace
  stays installed. A blocked workspace that is still installed is removed. An
  installed workspace `LINEAR_WORKSPACES` leaves out is **not** removed: it is
  only not served (a soft gate; a warning per tick names it and the fix, section
  5), and when one of the list's URL keys is not tied to a workspace yet, the
  tick first reads that workspace's current URL key from Linear once (a rename
  no sync has seen) and serves it again if the list names it. Housekeeping gets
  at most 2 minutes, and at most half of `TICK_TIMEOUT_MINUTES`, for work that
  calls Linear: it starts a batch of revocations or a purge only when it can
  finish it in time even if Linear answers each revocation only at its 15-second
  timeout, and leaves the rest for the next tick (the summary line says
  `left for the next tick: …`). A purge whose workspace still has more sessions
  than one tick can revoke (about 24) ends them over a few ticks, then purges;
  the log names `purge --workspace <id> --yes` to do it at once.
- Then, for every installed workspace it admits, least recently attempted first:
  when the local time in that workspace's timezone (Settings) has reached
  `DAILY_RUN_AT` (default `08:00`), the tick runs **the daily job**: sync,
  allocation in the workspace's mode, then warnings. A claim makes it run once
  per local day, so the job runs on the first tick at or after 08:00 local.
- Otherwise the tick runs a plain **full resync**. That resync is what picks up
  milestone and relation changes, which have no webhooks. Every sync records
  when it started, so a workspace whose sync is cut off by the deadline goes
  after the others next tick instead of first again.

Two details about the daily time:

- On daylight-saving days the job is due from the first moment the clock shows
  `DAILY_RUN_AT` or later. A time that the clock skips is due from the change
  itself.
- Keep `DAILY_RUN_AT` at 23:45 or earlier. A later time may never get a tick
  before midnight, and the worker logs a warning when it is set that late.

### Variables

Railway variables can be set per service, or once as **shared variables** and
referenced from each service with `${{shared.NAME}}`. Mark secrets as
**sealed**: sealed values are never shown in the UI or API and are not copied to
PR environments (research: Railway deployment, "Variable reference syntax").
`.env.example` describes every variable.

| variable                  | web | worker | value                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | :-: | :----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`            |  ✓  |   ✓    | `${{Postgres.DATABASE_URL}}`, the private-network URL (`postgres.railway.internal`). The traffic is already WireGuard-encrypted, so **no SSL settings are needed**. Do not use `DATABASE_PUBLIC_URL`: its egress is billed and its certificate is self-signed (research: "Is SSL needed for Postgres…").                                                                                                                                                            |
| `APP_URL`                 |  ✓  |   ✓    | `https://<your domain>`, no trailing slash. The worker uses it for digest links.                                                                                                                                                                                                                                                                                                                                                                                    |
| `TOKEN_ENCRYPTION_KEY`    |  ✓  |   ✓    | sealed. `openssl rand -base64 32`. Must be **the same on both services**: the worker decrypts the tokens the web app stored.                                                                                                                                                                                                                                                                                                                                        |
| `SESSION_SECRET`          |  ✓  |        | sealed. `openssl rand -base64 48` (at least 32 characters). Signs the short-lived OAuth cookie and the sign-out notice.                                                                                                                                                                                                                                                                                                                                             |
| `LINEAR_CLIENT_ID`        |  ✓  |   ✓    | from step 1. The worker needs it to refresh and revoke tokens.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `LINEAR_CLIENT_SECRET`    |  ✓  |   ✓    | sealed, from step 1                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `LINEAR_WEBHOOK_SECRET`   |  ✓  |        | sealed, from step 1                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `SLACK_BOT_TOKEN`         |  ✓  |   ✓    | sealed. `xoxb-…` from step 2. Not used while the planner may serve more than one workspace (step 2, "One Slack bot serves one workspace").                                                                                                                                                                                                                                                                                                                          |
| `DEFAULT_TIMEZONE`        |  ✓  |   ✓    | IANA zone for new workspaces, e.g. `America/Chicago` (default `UTC`). Anyone can change it later in Settings.                                                                                                                                                                                                                                                                                                                                                       |
| `WATCHER_EMAILS`          |  ✓  |   ✓    | comma-separated. The first watchers, saved on the first full sync after the install; if none match, the installer is the first watcher. Watchers get every warning (design §5: the project owner plus the configured watchers).                                                                                                                                                                                                                                     |
| `DAILY_RUN_AT`            |     |   ✓    | `HH:MM` in each workspace's timezone (default `08:00`)                                                                                                                                                                                                                                                                                                                                                                                                              |
| `WORKER_CONCURRENCY`      |     |   ✓    | optional: how many workspaces one tick works on at once (default `3`, `1` to `8`). Each workspace in flight uses at most one of the worker's 10 Postgres connections at a time, so the cap leaves room for the rest of the tick (arch §9 "Scaling").                                                                                                                                                                                                                |
| `MIRROR_CACHE_WORKSPACES` |  ✓  |        | optional: how many workspaces' mirrors the web service keeps in memory, least recently read dropped first (default `16`, `1` to `64`). Raise it when more workspaces are in use at the same time; lower it when memory is tight. The worker exits after each tick, so it does not need it.                                                                                                                                                                          |
| `LINEAR_WORKSPACES`       |  ✓  |   ✓    | which workspaces may use the planner: org ids (recommended) or URL keys, comma-separated, or `*` for everyone. Unset: only workspaces already installed, so **a new deployment must set it** to its first workspace (section 4 "First run"), and a list must name every installed workspace that should stay served (section 5 "Add another workspace"). **The same value on both services**, best as a shared variable (section 5 "Operating several workspaces"). |
| `OPERATOR_NAME`           |  ✓  |        | optional: who runs this planner, on `/contact`, the landing page, privacy and terms                                                                                                                                                                                                                                                                                                                                                                                 |
| `OPERATOR_EMAIL`          |  ✓  |        | optional: the address `/contact` offers for questions and deletion requests. A deployed planner without it logs one info line at boot.                                                                                                                                                                                                                                                                                                                              |
| `OPERATOR_URL`            |  ✓  |        | optional: a website `/contact` links to (http or https)                                                                                                                                                                                                                                                                                                                                                                                                             |
| `DEMO_URL`                |  ✓  |        | optional: a public demo deployment, linked from the landing page as "Try the demo first"                                                                                                                                                                                                                                                                                                                                                                            |
| `PORT`                    |  ✓  |        | `3000`                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `RAILWAY_DOCKERFILE_PATH` |  ✓  |   ✓    | `deploy/Dockerfile` (a Railway build setting, not read by the app)                                                                                                                                                                                                                                                                                                                                                                                                  |

Optional: `APP_NAME`, `LOG_LEVEL` (`debug` / `info` / `warn` / `error`),
`SESSION_DAYS` (default 30) and `TICK_TIMEOUT_MINUTES` (default 10, at most 14).
`PM_EMAILS` is no longer used (there is no PM role, design §12): remove it. A
service that still has it boots normally and logs one warning saying so. **Never
set `LINEAR_FIXTURE` in production**: either value (`1`, or `showcase` for the
large showcase workspace) switches to a fictional demo workspace. `PGLITE_DIR`
is not used when `DATABASE_URL` is set.

A public demo deployment is the one exception: it sets `LINEAR_FIXTURE` on both
services (planner and worker; each builds its own in-memory copy), `1` for the
small scenario workspace or `showcase` for the large one. The graph draws every
issue, and the showcase's whole-workspace issue level (406 boxes, 247 arrows) is
well inside the 700-box and 1,000-arrow draw limits, so visitors' edits do not
tip it into "Too many to draw" (`docs/architecture.md` §4 "Showcase demo
workspace").

**Migrations run on boot.** Each service applies pending migrations when it
starts, and every worker run applies them too. A Postgres advisory lock
serializes them, so the web app and the worker can start at the same time
safely. There is no build-time or pre-deploy migration step.

### Order

1. Postgres, then `web` with its domain. The first deploy fails until the
   variables are set, which is expected.
2. The Linear app (step 1) and the Slack app (step 2).
3. All variables on both services, then redeploy both. On a new deployment this
   includes `LINEAR_WORKSPACES` naming your first workspace (section 4, step 1).
4. The `worker` cron schedule.

## 4. First run

1. **Name your workspace first.** A new deployment admits no workspace while
   `LINEAR_WORKSPACES` is unset (unset admits only workspaces already installed,
   and there are none yet), so the first sign-in would be refused with "This
   planner is not open to … yet", and boot logs
   `no workspace can sign in until LINEAR_WORKSPACES names one`. Set
   `LINEAR_WORKSPACES` on both services (one shared variable) to your
   workspace's URL key, the `<key>` in `linear.app/<key>` (it is pinned to that
   workspace's id at the first sign-in; the id itself is shown on `/setup` and
   Settings → Status afterwards), then redeploy. Then open `APP_URL` and **Sign
   in with Linear**. Use a Linear workspace admin for this first sign-in,
   because the next step needs one.
2. **Install**: the app sends a signed-in user to `/setup` while the workspace
   has no installation. Start the install there. Linear asks the admin which
   **teams** the app may access. Pick every team whose projects the planner
   should manage, because it sees nothing else. There is no PM step: everyone
   signed in can edit everything (design §12, 2026-10-22), except **Linear
   guests, who are read-only** (design §12, "guests are read-only"): a guest may
   sign in and see the teams Linear shows them, but cannot install the app,
   allow edits, change settings, start runs, resync or preview digests, and is
   never asked for write access. Install with a full workspace member (an
   admin); a guest who tries is sent back with "The planner is read-only for
   you…". If `WATCHER_EMAILS` matches nobody, the installer becomes the first
   watcher.
3. **Confirm the first sync**. The install triggers a full sync, and Settings →
   Status shows when the last full sync ran and whether it worked. Until that
   first sync lands the planner cannot tell members from guests: the first page
   after the install waits for it, and if it fails the planner stays read-only
   for everyone until a sync works (each page view and the worker's next tick
   retry it). Pages then say "The first sync from Linear has not landed yet"
   with a way to Setup, the web service's logs say why
   (`the first sync failed; everyone is read-only until it lands`), and Setup
   still offers **Reinstall**, which is the fix when the cause is the app's
   grant (for example the `initiative:read` scope missing). Within 15 minutes
   the worker's first tick logs a line such as
   `tick ok — <workspace id>: synced (mirror v3, 412 issues, 2310 ms), …`. To
   run it right away, trigger the cron job off-schedule with `railway cron run`
   (add `--yes` outside a terminal) (research: Railway deployment, "Cron: how
   cronSchedule works…").
4. **Settings → Watchers and Schedule** (Watchers was called People):
   - Set the watchers: the people warned about every at-risk milestone, besides
     the project lead (design §5). `WATCHER_EMAILS` (else the installer) filled
     the list at the first sync; it may be emptied, and then only leads are
     warned.
   - Set the workspace **timezone**. It decides "today", the days left and when
     the daily job is due.
5. **Runs → Preview (dry run)**: review what allocation would assign, skip and
   block. Fix the blockers in Linear: projects with no lead, and next milestones
   that fail the rubric (no date, no "done means…", no issues).
6. **Settings → digest preview**: check what each person would receive. People
   whose Slack email differs from their Linear email are reported as
   undeliverable once warnings are live.
7. **Go live.** Anyone signed in switches **allocation** and **warnings** to
   live in Settings → Modes (Settings → Audit records who switched it).
   Allocation stays a dry run until someone switches it (design §7.4). The
   scheduled daily job runs once per local day, so if today's already ran (as a
   dry run), the first scheduled live allocation is tomorrow's; anyone can start
   one now with **Runs → Run now**. When warnings go live, the warning memory
   resets, so the first live run announces everything that is notable at that
   moment. A preview digest already recorded today still counts as today's
   digest, so that first live announcement goes out the next day (arch §7.1).

## 5. Operations

**Logs.** Every component writes one JSON object per line to stdout or stderr,
with `time`, `level`, `logger` (`engine`, `worker`, …), `msg` and fields. Values
under credential-like keys are redacted. The worker also prints one plain
summary line per command. Railway's cron history and logs show it:

```
tick ok — org-1: daily ran for 2026-10-21, allocation live succeeded: 4 assigned, 0 failed, 1 blocked project, warnings live: 3 notices, 3 digests, 3 delivered; cleanup: 0 expired sessions, 2 old webhook delivery records
tick FAILED (1 of 2 workspaces) — org-1: synced (…), daily due at 08:00 America/Chicago; org-2: FAILED (…)
```

**Exit codes** (arch §9): `0` ok. `1` means one of these happened:

- a workspace failed, unless the failure is chronic (a tick's workspace with no
  successful sync for 24 hours is logged at warn and does not fail the tick); a
  workspace whose app grant Linear refused fails every run until an admin
  reinstalls ("Operating several workspaces" below has the details);
- housekeeping failed;
- the worker could not start (bad configuration, database unreachable);
- the run hit its `TICK_TIMEOUT_MINUTES` limit (any command except `migrate`).

Workspaces uninstalled in Linear, removed or blocked by you, or not admitted by
`LINEAR_WORKSPACES` are skipped and never fail a run; a workspace a tick had no
time left for is deferred to the next one, which is not a failure either.

`2` is a usage error. One workspace failing never stops the others. A workspace
counts as failed when its job throws, or when an allocation run ends `failed` or
`partial`, meaning some Linear writes failed and the run log says which. Digests
that could not be delivered do **not** fail the run, because the count includes
people who simply have no Slack account. They are listed in Settings →
Notifications, and a Slack configuration error (bad token, missing scope) is
logged at `error`. Railway's cron history marks failed runs. Which status a
non-zero exit shows (for example `CRASHED`) is not documented: **verify this in
your workspace**.

**Health.** `GET /api/health` returns `{ ok, db }`: 200 when the database
answers a ping, 503 when it does not or the planner cannot start. Railway checks
it only while a deploy goes live. For continuous monitoring, point an external
uptime check at it.

**Rate limits** (arch §8.1 "Rate limits"). The web service limits, per client
IP, OAuth sign-in starts (120 per 10 minutes), workspace switches (60 per 10
minutes) and refused webhook deliveries (100 a minute; a delivery Linear signed
is never limited), and, per session, allocation runs (6 per 10 minutes), digest
previews (20 per 10 minutes) and every other change (300 a minute). Sign-in
callbacks, sign-outs and the demo sign-in are never limited. One address is
often a whole office, campus or mobile carrier behind NAT: the start limit is
set for a team signing in together (everyone does once after this release
renames the cookies, and connecting a workspace or allowing edits counts as a
start), so a lockout there means a script, not a busy morning. The counts live
in the web process's memory: each replica counts on its own and a redeploy
forgets them. The client IP is Railway's `X-Real-IP` header and nothing else; a
request without one is not limited by IP.

**Check once that `X-Real-IP` cannot be spoofed.** The limits rely on Railway's
edge setting `X-Real-IP` to the real client address, replacing whatever a client
sent. From one machine, send 121 sign-in starts, each claiming another address:

```bash
for i in $(seq 1 121); do
  curl -s -o /dev/null -w '%{redirect_url}\n' \
    -H "X-Real-IP: 198.51.100.$i" "$APP_URL/api/auth/linear?intent=signin"
done | tail -1
```

The last line must end in `/?auth_error=auth_rate_limited`: the 121st start was
counted against your real address, so the forged header was ignored. If it is
Linear's authorize URL instead, the header reached the planner as sent and the
IP limits can be bypassed; do not open the planner to strangers until that is
fixed. (The check spends your own address's starts: signing in from that machine
waits up to 10 minutes. With more than one web replica, the starts may spread
over replicas; run it with one.)

**Running jobs by hand.** The worker's commands are
`node apps/worker/dist/index.js <command>`. Run `--help` for the full list (the
operator commands are in "Operating several workspaces" below):

- `migrate`
- `sync`
- `daily [--force]`
- `allocate --dry-run`, or `allocate --live --workspace <id> [--override-mode]`
- `warn`
- `tick`
- `serve`

All of them take `[--workspace <id>]`, except `migrate`. `allocate --live`
requires it: a live run writes to Linear (assignments, state moves, comments) as
the app, so it runs in the one workspace you name, never in every workspace at
once (some may have left allocation on dry run in Settings). It also refuses a
workspace whose saved allocation mode (Settings) is still dry run (exit 1,
nothing written), since `/terms` tells people allocation writes only once
someone switched it to live; add `--override-mode` only when you mean to write
to Linear there anyway (the terms say you can). They need the production
variables and the private network. `sync`, `daily`, `allocate` and `warn` stop
with exit 1 after `TICK_TIMEOUT_MINUTES`, like `tick`, naming the stage they
were stuck in, so a manual run never overlaps a tick that takes over the daily
job. `migrate` has no time limit: if a migration takes longer than one run's
budget (every command applies pending migrations when it starts), apply it with
`migrate`. `railway cron run` runs the worker's configured `tick`. For anything
else, run the command in the `web` service with `railway ssh`, as "Running them
on Railway" below shows (the web image contains the worker):
`railway ssh --service web -- node /app/apps/worker/dist/index.js sync --workspace <org id>`.
If that session does not see the service's variables (the check is in that
section), temporarily change the worker's start command and use
`railway cron run`.

**The daily job did not run.**

- `daily already ran for <day>` in the summary means today's claim is taken.
- `daily due at <time> <zone>` means it is not that time yet in the workspace's
  timezone.
- If the job fails with an error, its claim is released and the next tick (15
  minutes later) runs it again.
- If a tick (or a `daily` run by hand) is killed or hits its timeout **in the
  middle of** the daily job, its claim stays taken for a 45-minute lease, so the
  next two or three ticks report `daily already ran`. After that the next tick
  takes the day over and runs the whole job again (logged as
  `took over a stale job claim`), normally 45 to 60 minutes after the killed run
  started. If the dead run was killed during its allocation run, that run is
  more than 30 minutes old by then, so the takeover closes it as crashed (logged
  as `marked stale allocation run as failed`) instead of being blocked by it.
- A takeover happens only while the job is still due, before local midnight. If
  the killed job started after about 23:00 in the workspace's timezone, the
  ticks after midnight are due for the next day, so the killed day's job is not
  repeated; the next day's job runs as usual. A `daily` or `warn` run by hand
  after midnight counts for the new day, so run `allocate` by hand if the
  assignments cannot wait.
- If another allocation run is in progress when the daily job starts, the job
  fails with `An allocation run is already in progress` (exit 1), gives the day
  back, and a later tick runs it. That run can be an `allocate` run by hand (or
  someone's run from the web app) that is still going, or one that was killed or
  timed out: a run counts as in progress until 30 minutes after it started.
- What the re-run does: issues the dead tick already assigned are skipped as
  already assigned (never assigned or commented twice; a comment it had not
  posted yet stays missing). Nobody gets a second digest that day, not even
  someone whose digest was being sent when the tick died (it may have reached
  Slack). What the dead tick's delivered digests said counts as said; the
  notices in the digest that was being sent come back the next day.

`daily --force` is safe to repeat. Allocation never reassigns an assigned issue,
and nobody gets a second digest on the same day.

**Rotating secrets.**

- `SESSION_SECRET` signs only the 10-minute OAuth cookie (and the five-minute
  "Signed out of <workspace>" notice value), so you can rotate it at any time.
  Sign-ins in progress at that moment have to start over.
- `LINEAR_WEBHOOK_SECRET`: rotate the webhook signing secret in the Linear app,
  then update `web`. Deliveries fail verification until both match. Linear
  retries them, and the 15-minute resync heals anything missed.
- `LINEAR_CLIENT_SECRET`: rotate it in the Linear app, then update both services
  promptly. Token refreshes need the new secret, and the research says rotating
  does not revoke existing tokens (research: Linear OAuth 2.0, "Revoke URL and
  its params"). **Verify this in your workspace.**
- `SLACK_BOT_TOKEN`: regenerate or reinstall the Slack app, then update both
  services.
- `TOKEN_ENCRYPTION_KEY`: rotate only if it leaked. There is no key ring, so a
  new key makes every stored Linear token unreadable. Set the new key on both
  services and redeploy. Everyone signs in again, and an admin reinstalls from
  `/setup`.

**Session cookies after the several-workspaces release** (owner decision
2026-10-25). On an https `APP_URL` the planner's OAuth and demo cookies are now
`__Host-mp_session`, `__Host-mp_sessions` (the other workspaces this browser
holds) and `__Host-mp_oauth`, which a sibling subdomain cannot set. The plain
`mp_session` and `mp_oauth` used before are no longer read, and every auth
response expires them. So once, after this release, everyone signed in under the
old names lands on the sign-in page and signs in again; nothing else is lost.
API-key mode keeps its cookies as they were.

**A revoked install.** The installation is marked revoked, its stored app token
wiped, for one of three reasons (arch §7 "Revoking"):

- **uninstalled**: an admin removed the app in Linear, which sends an `OAuthApp`
  revoked webhook. The worker skips the workspace (info, not a failure), the
  next housekeeping ends the sessions started before the uninstall, and its data
  is purged 30 days later unless an admin installs the app again first;
- **removed**: you ran `remove` or `block` (or a block you made matched an
  installed workspace later). Handled like an uninstall. Taking a workspace out
  of `LINEAR_WORKSPACES` does **not** remove it: it is only no longer served
  (section 5 "Operating several workspaces");
- **grant_dead**: Linear rejected the app's token refresh (`invalid_grant`).
  Members keep their sessions, the workspace is never purged on its own, and
  every worker run reports it as a failed workspace (exit 1, an error log naming
  the reinstall), so the cron job turns red instead of quietly doing nothing
  while allocation and warnings have stopped (arch §7.1, §9). An uninstall also
  ends up here when Linear's `OAuthApp` revoked webhook never arrived (the
  webhook was disabled, or `LINEAR_WEBHOOK_SECRET` did not match). `/privacy`
  says such a workspace's data is kept until you remove it (its 30 days count
  from Linear's uninstall notice), so act on it. When the workspace's admin
  confirms they uninstalled the app (or nobody will reinstall), run
  `remove --workspace <id>`, which starts the 30-day purge, or `remove` and, 15
  minutes later, `purge --workspace <id> --yes` to delete it now. **After
  upgrading to this release**, every installation that was already revoked shows
  as `revoked:grant_dead` (the cause was not recorded before): run `workspaces`
  once and remove or purge those the same way.

Settings and `/setup` then show that a reinstall is needed, why, and (for the
first two) when the data is deleted. A Linear admin reinstalls from `/setup` and
picks the teams again. A person whose own grant died simply signs in again.

**Backups.** Back up the Railway Postgres database with whatever your Railway
plan provides, or with `pg_dump` over a temporary public TCP proxy. With libpq,
`sslmode=require` works against its self-signed certificate. The database holds
what Linear does not: settings (watchers included), weights, "done means…" text,
the allocation run log, warning memory and the audit log. The Linear mirror
rebuilds itself on the next sync. A restored backup holds refresh tokens that
have since rotated and died. After a restore, expect an admin to reinstall and
everyone to sign in again.

**PGlite** (the embedded database used when `DATABASE_URL` is unset) is for
local development only. Two processes must never share one PGlite directory, so
production always uses `DATABASE_URL`.

### Operating several workspaces

One OAuth deployment can serve several Linear workspaces (design §12,
2026-10-25). Personal API keys (section 7) and demo mode stay one workspace.

**Set `LINEAR_WORKSPACES` on both services.** The web service decides which
workspaces may sign in and install. The worker decides which ones it syncs. Give
both the same value, most simply as one Railway shared variable referenced from
each service as `${{shared.LINEAR_WORKSPACES}}`. Otherwise the worker keeps
syncing a workspace the web refuses.

**A workspace the value leaves out is not served, but nothing is deleted.** Its
people are signed out at once and cannot sign back in, the worker skips it and
its webhooks are ignored. Its installation, app token, sessions and data stay as
they were, so putting it back on the list restores it (its people are signed in
again). Boot logs a warning for every installed workspace a list leaves out
(`<id> is installed but not in LINEAR_WORKSPACES: it is not served; add it back or run 'remove'`),
and every tick's housekeeping repeats it
(`cleanup: … 1 installed workspace not served (LINEAR_WORKSPACES leaves it out)`).
Only `remove`, `block` and `purge` (below) uninstall a workspace, sign its
people out for good or delete its data. A workspace listed by a URL key it got
from a rename the planner has not seen yet (no sync runs for a workspace that is
not served) is not stuck: while that URL-key entry is not tied to a workspace,
each tick's housekeeping, after its other work, reads the current URL key of up
to 5 such workspaces from Linear with the app's token (those read longest ago
first, each read given 10 seconds at most) and serves one again in the same tick
when the entry matches
(`1 installed workspace admitted again (its URL key read from Linear)`); its
people who signed in under the new key stay signed in meanwhile. A read that
keeps failing is logged at `warn` once, then at `info`.

The value (arch §7 "Admission"):

- **unset or empty**: closed to new workspaces. Only workspaces that already
  have an installation (active, or revoked but not purged yet, so an admin can
  reinstall) may sign in, so an existing deployment keeps working. **A new
  deployment admits nobody**: name its first workspace before the first sign-in
  (section 4 "First run"; boot warns "no workspace can sign in until
  LINEAR_WORKSPACES names one"). To add a workspace later, switch to a list that
  names every installed workspace plus the new one ("Add another workspace"
  below).
- **a list**: comma-separated, at most 100 entries, case-insensitive, each a
  Linear organization id or a URL key. **Use ids**: an admin can rename a URL
  key in Linear. (A URL-key entry is pinned to the workspace it first admits:
  after a rename, and even after that workspace's data is purged, it still
  admits only that workspace, never another one that takes the old key.) The id
  is shown on Settings → Status and `/setup` ("Workspace id") and by the
  `workspaces` command; a person whose workspace is refused sees "This planner
  is not open to that Linear workspace yet" and a link to `/contact`, so they
  can ask you.
- **`*`**: every Linear workspace may sign in and install. Boot logs a warning.
  Use `block` to keep one out.

**Add another workspace** (for example your work workspace next to the one
already installed):

1. Run `workspaces` (below) and note the organization id of every installed
   workspace: each `active` one, and any `revoked:…` one an admin may still
   reinstall.
2. Set `LINEAR_WORKSPACES` to those ids plus the new workspace, comma-separated
   (`<id 1>,<id 2>,<new id or URL key>`), as the one shared variable both
   services use, and redeploy the web service. The new workspace's id is shown
   nowhere until it is admitted, so its URL key (`linear.app/<key>`) is fine: it
   is pinned to that workspace on its first sign-in. Check the web's boot log:
   there must be no `is installed but not in LINEAR_WORKSPACES` warning.
3. An admin of the new workspace opens it at linear.app first, then signs in
   (or, already signed in to another workspace, chooses **Connect another
   workspace** in the workspace menu) and installs the app from `/setup`.
4. Run `workspaces` again: every workspace you listed shows `active`.

**A list that leaves out an installed workspace signs its people out at once.**
Nothing is deleted, and adding it back restores it, but until then nobody in it
can use the planner.

**How a tick handles many workspaces** (arch §9 "Scaling"):

- It works on `WORKER_CONCURRENCY` workspaces at once (default 3), least
  recently attempted first (a sync counts from when it started, so one that the
  time limit cut off goes after the others), so the workspaces a tick could not
  reach run first on the next one.
- It starts a workspace only with at least 3 minutes, or twice that workspace's
  last full sync time, left before `TICK_TIMEOUT_MINUTES`, and a daily job only
  with at least 5 minutes left. Anything it cannot start is logged as
  `deferred to the next tick` at info and runs first on the next tick. This is
  not a failure.
- It skips the plain resync of a workspace whose last successful full sync
  finished less than 10 minutes ago. The daily job always syncs.
- Workspaces uninstalled in Linear, removed or blocked by you, or not admitted
  by `LINEAR_WORKSPACES` are skipped (info), never failures.

```
tick ok — org-1: synced (mirror v9, 412 issues, 2310 ms), daily due at 08:00 UTC; org-2: sync skipped (the last full sync finished 4 min ago), daily due at 08:00 UTC; org-3: skipped (removed by the operator); org-4: workspace deferred to the next tick (2 min left, needs 3 min); cleanup: 0 expired sessions, 0 old webhook delivery records
tick ok (1 chronic) — …; org-5: chronic failure (…)
```

Which outcomes turn the cron red (exit 1):

- a workspace whose job failed, unless the failure is **chronic**: in a tick, a
  workspace with no successful full sync for 24 hours (or none since it was
  installed more than 24 hours ago) is logged at warn and shown as
  `chronic failure`, and the tick still exits 0. The cron turns red when a
  workspace starts failing, not every 15 minutes after that; `workspaces` shows
  `chronic` until it recovers;
- a workspace whose app grant Linear refused (`revoked:grant_dead`), on every
  tick, until an admin reinstalls or you remove or purge it;
- housekeeping, the database, the configuration or the time limit, as before.
  When the time limit fires, the error line names the workspaces still running
  (`stuck while running tick (workspaces still running: <id>)`). One named on
  every tick has a sync that never fits: raise `TICK_TIMEOUT_MINUTES` (at
  most 14) or `remove` it. Housekeeping runs first in every tick, so purges and
  session revocations go on meanwhile, and the stuck workspace goes after the
  others on the next tick, so they keep syncing too (each of its ticks still
  ends in exit 1 until you act).

**Operator commands.** These list and manage the workspaces this deployment
holds. They run from the worker's command line only; nothing in the planner
offers them. Their output holds no Linear tokens and no email addresses.
`<name>` is a workspace's organization id or its URL key (ids are safer: an
admin can rename a URL key). They are refused with personal API keys.

| command                                      | what it does                                                                                                                                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspaces [--json]`                        | every workspace: id, URL key, name, status (`active`, `revoked:<reason>`, `blocked`, `not admitted`, `not installed`), install date, purge date, last sync, issues, sessions; then the blocks |
| `remove --workspace <name>`                  | revokes the app's Linear token, marks the install removed and ends its sessions now. Its data is deleted 30 days later unless an admin installs the app again, which stays allowed            |
| `purge --workspace <name> --yes`             | deletes everything the planner keeps for a revoked workspace now (mirror, settings, run log, audit log). Run `remove` first and wait 15 minutes. Without `--yes` it does nothing              |
| `block --workspace <name> [--reason <text>]` | refuses the workspace from now on (sign-in, install, webhooks, the worker); removes it when installed and ends its sessions                                                                   |
| `unblock --workspace <name>`                 | lifts a block, also one made under a URL key nothing here knows any more (a purged workspace, or one refused at sign-in). The workspace stays removed until an admin installs the app again   |
| `unpin --entry <url key>`                    | frees a `LINEAR_WORKSPACES` URL-key entry from the workspace it was first matched to, so the workspace that holds that URL key now can be admitted by it. Nothing else changes                |

Typical uses:

- **Someone asks for their workspace's data to be deleted now**: `remove`, then
  15 minutes later `purge --workspace <id> --yes`. After an uninstall in Linear
  the purge happens by itself 30 days later.
- **Stop serving a workspace**: take it out of `LINEAR_WORKSPACES` on both
  services. It is no longer served, but nothing is deleted (boot and every tick
  warn about it). To also uninstall it and start the 30-day purge, run `remove`;
  to keep it out for good, also while `LINEAR_WORKSPACES` is `*`, `block` it
  (which removes it and ends its sessions).
- **A URL-key entry admits the wrong workspace now**: the list names `acme`,
  which was tied to the workspace that first signed in under it; that workspace
  renamed its URL key and another one took `acme`, but the entry still admits
  only the first. Run `unpin --entry acme`: the next workspace that signs in or
  installs under `acme` is tied to it. Better, replace the entry with the
  organization id you mean.

**Running them on Railway.** The worker service is a cron job: its container
runs only while a tick does, so there is normally nothing to connect to. Run the
commands in the `web` service instead: its image is the same Dockerfile, so it
contains the worker (`apps/worker/dist`), and it has the variables the commands
need (`DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`, `LINEAR_CLIENT_ID`,
`LINEAR_CLIENT_SECRET`, `LINEAR_WORKSPACES`). With the Railway CLI linked to the
project (`railway link`):

```bash
railway ssh --service web -- node /app/apps/worker/dist/index.js workspaces
railway ssh --service web -- node /app/apps/worker/dist/index.js workspaces --json > workspaces.json
railway ssh --service web -- node /app/apps/worker/dist/index.js remove --workspace <org id>
railway ssh --service web -- node /app/apps/worker/dist/index.js purge --workspace <org id> --yes
railway ssh --service web -- node /app/apps/worker/dist/index.js block --workspace <org id or URL key> --reason "<why>"
railway ssh --service web -- node /app/apps/worker/dist/index.js unblock --workspace <org id or URL key>
railway ssh --service web -- node /app/apps/worker/dist/index.js unpin --entry <URL key>
```

From Railway's documentation of `railway ssh`: it runs one command in the
service's container when one follows `--` (`railway ssh -- ls -la`), or opens a
shell without one; `--service` picks the service and `--environment` the
environment (both default to the linked ones); output that is piped runs without
a terminal, so `--json` stays clean; and it needs an SSH key registered with
Railway, which the CLI offers to register the first time. The image's working
directory is `/app` (`deploy/Dockerfile`); the absolute path does not depend on
where the shell starts. The commands write their JSON logs to stderr, so stdout
holds only the table or the JSON.

**Verify this in your workspace** once: that the session sees the service's
variables. Check one that is not a secret,
`railway ssh --service web -- printenv APP_URL`, which must print your
`APP_URL`. If it prints nothing, run the command the documented way instead:
temporarily set the worker's start command to it (for example
`node apps/worker/dist/index.js workspaces`), run `railway cron run`, read the
output in the worker's logs, and set the start command back to
`node apps/worker/dist/index.js tick`.

### Opening the planner to other workspaces

Before strangers use the planner (design §12, 2026-10-25), in this order:

1. Make the Linear app **public** and set its developer URL to
   `<APP_URL>/contact` (step 1, item 6).
2. Set **`OPERATOR_NAME`**, **`OPERATOR_EMAIL`** and, if you have one,
   **`OPERATOR_URL`** on the web service. `/contact` shows them, the landing
   page says "Run by <name>.", and the privacy and terms pages name you where
   they say who to ask. Without them the pages stay neutral ("the person who
   runs this planner") and `/contact` says no contact details are published.
3. Optionally set **`DEMO_URL`** to a public demo deployment (one with
   `LINEAR_FIXTURE=showcase`): the landing page links to it.
4. Decide **`LINEAR_WORKSPACES`** (above) and set it on both services. A list
   must name every installed workspace that should stay served ("Add another
   workspace").
5. Leave `SLACK_BOT_TOKEN` as it is: with more than one possible workspace the
   planner stops using it by itself (step 2).
6. Run the **`X-Real-IP` check** (section 5 "Rate limits").
7. Read `/privacy` and `/terms` on the deployment and have the wording reviewed
   for your situation: they describe what this code stores and does (with every
   retention period taken from the code and `SESSION_DAYS`), in plain words, and
   they are not legal advice. The privacy page says the planner runs on Railway;
   if you host it elsewhere, change that line in
   `apps/planner/lib/adapters/public-pages.ts`.

The landing page says what the planner stores (linking to `/privacy`), that
Linear signs a person in to the workspace they have open at linear.app, and
"Admins: sign in, then install it for your workspace."; every signed-out page
ends with privacy · terms · contact links.

## 6. Open questions that need a live test

Collected from `docs/research.md`. None of these blocks a deployment. Each one
says what the planner does in the meantime.

- **Does editing a milestone fire a Project webhook?** Creating, editing or
  deleting a project milestone may or may not send a `Project` `update`
  (research: Linear webhooks, open questions). Until that is confirmed, a
  milestone change made in Linear (a new date, a rename) shows up on the next
  15-minute resync, or sooner when an issue in that milestone changes.
- **Relation changes have no webhook.** Adding or removing "blocks / blocked by"
  sends nothing the planner subscribes to, so the dependency graph catches up on
  the next 15-minute resync.
- **Can one OAuth app be used with `actor=app` and `actor=user` together?** It
  is very likely but not documented. To test: install as an admin, then sign in
  as a non-admin member, and as a member who grants write. Confirm all three
  work, and that allocation still runs as the app afterwards.
- **Is `webhookTimestamp` regenerated on retries?** If Linear re-sent the
  original timestamp, every retry would be rejected as stale by the 60-second
  check. To test: make one delivery fail (a non-200 answer), then log the
  retry's `webhookTimestamp` and `Linear-Delivery` header. The resync heals any
  lost change either way.

More items from the research to confirm along the way:

- Does a subscription to OAuthAuthorization deliver the payload type `OAuthApp`
  or `OAuthAuthorization`?
- Does the `Linear-Delivery` id stay the same across retries? The planner
  dedupes on it.
- Is archiving delivered as `remove` or as an `update`?
- Railway's default injected `PORT` (set it explicitly), and the cron status a
  non-zero exit shows.
- The polarity of Slack's read-only Messages-tab flag.
- Which Slack error codes come back for deactivated, guest or Slack Connect
  recipients.
- Whether Linear refresh tokens have an absolute or inactivity lifetime.
- Whether an old access token stops working immediately after a refresh.

## 7. Real Linear with personal API keys (no OAuth app)

`LINEAR_AUTH=api_key` (owner request 2026-10-23, design §12; arch §7.4) needs no
Linear OAuth app, no `TOKEN_ENCRYPTION_KEY`, no webhook and no Slack app. Each
person pastes a personal Linear API key on the planner's home page. The key is
held **only in the web service's memory**: never in the database, on disk, in
logs or in the browser. It is forgotten on sign-out (every device at once; a
browser whose own connection had already ended says so instead of claiming it),
after 2 hours idle, 12 hours after connecting, and on every restart or deploy.
Edits, comments and live allocation runs go out with the acting person's own
key. Nothing runs on a schedule: no daily allocation, no digests, no webhooks.
The planner refreshes its copy of Linear when someone connects, on Resync, and
every `SYNC_INTERVAL_MINUTES` (default 15) while a workspace member is
connected, reading with a member's key.

1. **Variables.** Set `LINEAR_AUTH=api_key` as **one shared variable** and
   reference it from both the `web` and `worker` services
   (`${{shared.LINEAR_AUTH}}`), so they can never disagree. On `web` set an
   https `APP_URL`, `LINEAR_WORKSPACE=<urlKey>` (your workspace's URL key, as in
   `linear.app/<urlKey>`; **required** on a deployed planner, so nobody can bind
   it to another workspace) and **`DATABASE_URL=${{Postgres.DATABASE_URL}}`**
   (required: the project's Postgres service keeps the planner's own data, the
   settings, weights, "done means…" and the audit log, across deploys; the keys
   are never in it). Without `DATABASE_URL` the planner falls back to PGlite on
   the container's disk, which Railway replaces on every deploy, and logs a
   warning at boot saying so. The planner refuses to boot when deployed without
   https or without the pin. `PORT` and `RAILWAY_DOCKERFILE_PATH` stay as in
   section 3. The worker needs only `LINEAR_AUTH` and `DATABASE_URL` for its
   `migrate`; it does not need the pin.
2. **Unset `LINEAR_FIXTURE`** (the planner refuses both together). Rows a demo
   wrote to the same database stay but are ignored; a fresh database is cleaner.
3. **One replica, App Sleeping off** on `web`. The keys live in that one
   process; a second replica would know none of them, and a sleeping service
   forgets them all.
4. **The worker:** remove its cron schedule, or let it run: `tick` and `serve`
   print "api-key mode: no scheduled sync, allocation or digests" and exit 0
   without opening the database. `sync`, `daily`, `allocate` and `warn` exit 1
   with the reason; `migrate` still works (it skips the deployed-only key
   checks, since it never handles a key). If the worker runs `serve` as an
   always-on service (restart policy Always or On Failure with retries), delete
   that service or set its restart policy to **Never**: `serve` now exits at
   once, and a supervisor would restart it over and over.
5. **Every deploy forgets every key.** With auto-deploy on push, everyone pastes
   their key again after each merge. The page says why ("Connection ended").
6. **Switching from OAuth:** nothing is purged. The planner ignores the stored
   OAuth grants and sessions in this mode and adopts the workspace's existing
   row (settings, weights and audit stay). Revoke the OAuth app in Linear
   (Settings → Administration → API → your app), which makes every stored grant
   worthless, then delete `TOKEN_ENCRYPTION_KEY`, `LINEAR_CLIENT_*`,
   `LINEAR_WEBHOOK_SECRET` and `SESSION_SECRET` (each still set logs one "X is
   unused when LINEAR_AUTH=api_key" warning) and the Linear webhook.
7. **Switching back to OAuth:** set `LINEAR_AUTH=oauth` (or remove it), restore
   the OAuth variables and **reinstall** from Setup (section 4): the row this
   mode used has no token.
8. **Each person's key.** In Linear: Settings → Security & access → Personal API
   keys → New key. Make one just for this, named "Milestone Planner", with
   **Read and Write on all teams, never Admin**. A Read-only key works but makes
   the planner read-only for that person; a team-limited key sees less. Revoke
   it in Linear when you stop using the planner (signing out of the planner does
   not revoke it; Linear has no API for that). Workspace admins may have to
   allow member API keys (Settings → Administration → API). The first person to
   connect should be a workspace **member** (not a guest): a member's key reads
   Linear for the planner's shared copy, and with only guests connected the
   planner shows its last copy.
9. **Trust.** Anyone who can deploy this project, change its variables or
   `railway ssh` into the `web` container could capture keys, so give those
   rights only to people you would trust with everyone's Linear access.
   `deploy/Dockerfile` sets `NODE_OPTIONS=--disable-sigusr1` (no inspector on a
   signal; the planner refuses to boot deployed without it) and disables core
   dumps (`ulimit -c 0`). That closes the quiet paths, not every path. Railway's
   HTTP logs show who connected, when and from where (`POST /api/auth/key`, the
   client IP), but never the key: they hold no bodies. Do not add a tracing or
   logging integration that records request bodies or headers.
10. **A workspace bound wrongly** (only possible with the pin unset, so local
    runs only): stop the planner and delete that `installations` row (the one
    with an empty `app_user_id`), then connect again.

The connect form only posts over HTTPS from the planner's own page, and failed
tries are limited per client address (Railway's `X-Real-IP`) and overall, each
try counted as it starts; the overall limit only refuses addresses that failed
themselves, so one address's failures never lock everyone else out after a
deploy (arch §8.1 "API-key mode").

## Appendix: running locally against real Linear

Demo mode needs nothing (`LINEAR_FIXTURE=1`, or `LINEAR_FIXTURE=showcase` for
the large showcase workspace, see `README.md`). To try the real integration
locally:

1. Register `http://localhost:3000/api/auth/linear/callback` on the Linear app.
2. Copy `.env.example` to `apps/planner/.env.local` and fill it in, including
   `LINEAR_WORKSPACES` set to your workspace's URL key or org id: a fresh
   database has no installed workspace, so with it unset nobody can sign in
   (section 4, step 1). `*.local` files are gitignored, and Next.js reads env
   files from the app's directory. Set `DATABASE_URL` to a local Postgres.
   Without it each process uses PGlite at a path relative to its own working
   directory: the web app runs in `apps/planner` and the worker in the repo
   root, so they would open two different databases and the worker would report
   `no installed workspaces`. Two processes must never share one PGlite
   directory anyway.
3. Build the packages and the worker (`scripts/build-all.sh --skip-planner`),
   then run the worker from the repo root with the same file:
   `node --env-file=apps/planner/.env.local apps/worker/dist/index.js tick`.

Linear cannot deliver webhooks to `localhost`, so locally the worker's resync is
the only way changes arrive.

With personal API keys (section 7) there is nothing to register: set
`LINEAR_AUTH=api_key` and `APP_URL=http://localhost:3000` in
`apps/planner/.env.local` (no pin is needed locally; the first member to connect
binds the workspace), start the planner, and paste your key on the home page.
The planner syncs by itself while you are connected; the worker is not needed.
`LINEAR_API_URL` is for tests only (a local fake Linear on `127.0.0.1`, in
api_key and OAuth mode); never set it outside them.
