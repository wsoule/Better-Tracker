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
open questions that need a live test.

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
   Linear OAuth 2.0, Q1). Sign-in, the PM write grant and the install all use
   this one callback (arch §7.1). To also run the app locally against real
   Linear, add `http://localhost:3000/api/auth/linear/callback` if the form
   accepts more than one URL.
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
   distribution").

Nothing else needs configuring on the Linear side. The app requests its scopes
when it sends people to Linear (arch §7 auth):

- Sign-in uses `read`.
- A PM who edits dates or leads grants `read,write` once, so Linear credits
  those edits to that person.
- The install uses `read,write` with `actor=app`. An `actor=app` install cannot
  request `admin`.

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

The image installs dependencies with `pnpm install --frozen-lockfile` and runs
`scripts/build-all.sh`, which builds every package, the worker and the web app.
**The build never touches the database.** Private networking exists only at
runtime, not during the build (research: Railway deployment, "Private networking
hostnames and protocol"). The Dockerfile declares no build arguments, so no
variable or secret is baked into the image. Each service builds its own image
from the same Dockerfile.

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

Each tick does the following for every installed workspace (arch §9):

- When the local time in that workspace's timezone (Settings) has reached
  `DAILY_RUN_AT` (default `08:00`), the tick runs **the daily job**: sync,
  allocation in the workspace's mode, then warnings. A claim makes it run once
  per local day, so the job runs on the first tick at or after 08:00 local.
- Otherwise the tick runs a plain **full resync**. That resync is what picks up
  milestone and relation changes, which have no webhooks.
- Afterwards it runs housekeeping: expired sessions are deleted and their Linear
  grants revoked, and webhook delivery records older than 30 days are pruned.

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

| variable                  | web | worker | value                                                                                                                                                                                                                                                                                                    |
| ------------------------- | :-: | :----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`            |  ✓  |   ✓    | `${{Postgres.DATABASE_URL}}`, the private-network URL (`postgres.railway.internal`). The traffic is already WireGuard-encrypted, so **no SSL settings are needed**. Do not use `DATABASE_PUBLIC_URL`: its egress is billed and its certificate is self-signed (research: "Is SSL needed for Postgres…"). |
| `APP_URL`                 |  ✓  |   ✓    | `https://<your domain>`, no trailing slash. The worker uses it for digest links.                                                                                                                                                                                                                         |
| `TOKEN_ENCRYPTION_KEY`    |  ✓  |   ✓    | sealed. `openssl rand -base64 32`. Must be **the same on both services**: the worker decrypts the tokens the web app stored.                                                                                                                                                                             |
| `SESSION_SECRET`          |  ✓  |        | sealed. `openssl rand -base64 48` (at least 32 characters). Signs the short-lived OAuth cookie.                                                                                                                                                                                                          |
| `LINEAR_CLIENT_ID`        |  ✓  |   ✓    | from step 1. The worker needs it to refresh and revoke tokens.                                                                                                                                                                                                                                           |
| `LINEAR_CLIENT_SECRET`    |  ✓  |   ✓    | sealed, from step 1                                                                                                                                                                                                                                                                                      |
| `LINEAR_WEBHOOK_SECRET`   |  ✓  |        | sealed, from step 1                                                                                                                                                                                                                                                                                      |
| `SLACK_BOT_TOKEN`         |  ✓  |   ✓    | sealed. `xoxb-…` from step 2.                                                                                                                                                                                                                                                                            |
| `DEFAULT_TIMEZONE`        |  ✓  |   ✓    | IANA zone for new workspaces, e.g. `America/Chicago` (default `UTC`). PMs can change it later in Settings.                                                                                                                                                                                               |
| `PM_EMAILS`               |  ✓  |   ✓    | comma-separated. Merged into Settings on the first full sync after the install.                                                                                                                                                                                                                          |
| `WATCHER_EMAILS`          |  ✓  |   ✓    | comma-separated. Watchers get every warning (design §5: the project owner plus the configured watchers).                                                                                                                                                                                                 |
| `DAILY_RUN_AT`            |     |   ✓    | `HH:MM` in each workspace's timezone (default `08:00`)                                                                                                                                                                                                                                                   |
| `PORT`                    |  ✓  |        | `3000`                                                                                                                                                                                                                                                                                                   |
| `RAILWAY_DOCKERFILE_PATH` |  ✓  |   ✓    | `deploy/Dockerfile` (a Railway build setting, not read by the app)                                                                                                                                                                                                                                       |

Optional: `APP_NAME`, `LOG_LEVEL` (`debug` / `info` / `warn` / `error`),
`SESSION_DAYS` (default 30) and `TICK_TIMEOUT_MINUTES` (default 10, at most 14).
**Never set `LINEAR_FIXTURE` in production**: it switches to the fictional demo
workspace. `PGLITE_DIR` is not used when `DATABASE_URL` is set.

**Migrations run on boot.** Each service applies pending migrations when it
starts, and every worker run applies them too. A Postgres advisory lock
serializes them, so the web app and the worker can start at the same time
safely. There is no build-time or pre-deploy migration step.

### Order

1. Postgres, then `web` with its domain. The first deploy fails until the
   variables are set, which is expected.
2. The Linear app (step 1) and the Slack app (step 2).
3. All variables on both services, then redeploy both.
4. The `worker` cron schedule.

## 4. First run

1. Open `APP_URL` and **Sign in with Linear**. Use a Linear workspace admin for
   this first sign-in, because the next step needs one.
2. **Install**: the app sends a signed-in user to `/setup` while the workspace
   has no installation. Start the install there. Linear asks the admin which
   **teams** the app may access. Pick every team whose projects the planner
   should manage, because it sees nothing else. The installer becomes the first
   PM.
3. **Confirm the first sync**. The install triggers a full sync, and Settings →
   Status shows when the last full sync ran and whether it worked. Within 15
   minutes the worker's first tick logs a line such as
   `tick ok — <workspace id>: synced (mirror v3, 412 issues, 2310 ms), …`. To
   run it right away, trigger the cron job off-schedule with `railway cron run`
   (add `--yes` outside a terminal) (research: Railway deployment, "Cron: how
   cronSchedule works…").
4. **Settings → People and Schedule**:
   - Check the PMs (`PM_EMAILS` was merged in at the first sync, and at least
     one PM is required).
   - Set the watchers: the people warned about every at-risk milestone, besides
     the project lead (design §5).
   - Set the workspace **timezone**. It decides "today", the days left and when
     the daily job is due.
5. **Runs → Preview (dry run)**: review what allocation would assign, skip and
   block. Fix the blockers in Linear: projects with no lead, and next milestones
   that fail the rubric (no date, no "done means…", no issues).
6. **Settings → digest preview**: check what each person would receive. People
   whose Slack email differs from their Linear email are reported as
   undeliverable once warnings are live.
7. **Go live.** A PM switches **allocation** and **warnings** to live in
   Settings. Allocation stays a dry run until a PM switches it (design §7.4).
   The scheduled daily job runs once per local day, so if today's already ran
   (as a dry run), the first scheduled live allocation is tomorrow's; a PM can
   start one now with **Runs → Run now**. When warnings go live, the warning
   memory resets, so the first live run announces everything that is notable at
   that moment. A preview digest already recorded today still counts as today's
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

- a workspace failed;
- housekeeping failed;
- the worker could not start (bad configuration, database unreachable);
- the run hit its `TICK_TIMEOUT_MINUTES` limit (any command except `migrate`).

`2` is a usage error. One workspace failing never stops the others. A workspace
counts as failed when its job throws, or when an allocation run ends `failed` or
`partial`, meaning some Linear writes failed and the run log says which. Digests
that could not be delivered do **not** fail the run, because the count includes
people who simply have no Slack account. They are listed in Settings →
Notifications, and a Slack configuration error (bad token, missing scope) is
logged at `error`. Railway's cron history marks failed runs. Which status a
non-zero exit shows (for example `CRASHED`) is not documented: **verify this in
your workspace**.

**Health.** `GET /api/health` returns `{ ok, db }`. Railway checks it only while
a deploy goes live. For continuous monitoring, point an external uptime check at
it.

**Running jobs by hand.** The worker's commands are
`node apps/worker/dist/index.js <command>`. Run `--help` for the full list:

- `migrate`
- `sync`
- `daily [--force]`
- `allocate --dry-run|--live`
- `warn`
- `tick`
- `serve`

All of them take `[--workspace <id>]`, except `migrate`. They need the
production variables and the private network. `sync`, `daily`, `allocate` and
`warn` stop with exit 1 after `TICK_TIMEOUT_MINUTES`, like `tick`, naming the
stage they were stuck in, so a manual run never overlaps a tick that takes over
the daily job. `migrate` has no time limit: if a migration takes longer than one
run's budget (every command applies pending migrations when it starts), apply it
with `migrate`. The verified way to run one is `railway cron run`, which runs
the worker's configured `tick`. For anything else, temporarily change the
worker's start command, or use a shell inside the service if your Railway plan
offers one: **verify this in your workspace**.

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
  a PM's run from the web app) that is still going, or one that was killed or
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

- `SESSION_SECRET` signs only the 10-minute OAuth cookie, so you can rotate it
  at any time. Sign-ins in progress at that moment have to start over.
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

**A revoked install.** The installation is marked revoked when:

- an admin removes the app in Linear, which sends an `OAuthApp` revoked webhook;
  or
- a token refresh is rejected (`invalid_grant`).

Settings and `/setup` then show that a reinstall is needed. The worker stops
syncing that workspace, and the error logs say why (arch §7.1). A Linear admin
reinstalls from `/setup` and picks the teams again. A person whose own grant
died simply signs in again.

**Backups.** Back up the Railway Postgres database with whatever your Railway
plan provides, or with `pg_dump` over a temporary public TCP proxy. With libpq,
`sslmode=require` works against its self-signed certificate. The database holds
what Linear does not: settings, PMs and watchers, weights, "done means…" text,
the allocation run log, warning memory and the audit log. The Linear mirror
rebuilds itself on the next sync. A restored backup holds refresh tokens that
have since rotated and died. After a restore, expect an admin to reinstall and
everyone to sign in again.

**PGlite** (the embedded database used when `DATABASE_URL` is unset) is for
local development only. Two processes must never share one PGlite directory, so
production always uses `DATABASE_URL`.

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
  as a non-admin member and as a PM who grants write. Confirm all three work,
  and that allocation still runs as the app afterwards.
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

## Appendix: running locally against real Linear

Demo mode needs nothing (`LINEAR_FIXTURE=1`, see `README.md`). To try the real
integration locally:

1. Register `http://localhost:3000/api/auth/linear/callback` on the Linear app.
2. Copy `.env.example` to `apps/planner/.env.local` and fill it in. `*.local`
   files are gitignored, and Next.js reads env files from the app's directory.
   Set `DATABASE_URL` to a local Postgres. Without it each process uses PGlite
   at a path relative to its own working directory: the web app runs in
   `apps/planner` and the worker in the repo root, so they would open two
   different databases and the worker would report `no installed workspaces`.
   Two processes must never share one PGlite directory anyway.
3. Build the packages and the worker (`scripts/build-all.sh --skip-planner`),
   then run the worker from the repo root with the same file:
   `node --env-file=apps/planner/.env.local apps/worker/dist/index.js tick`.

Linear cannot deliver webhooks to `localhost`, so locally the worker's resync is
the only way changes arrive.
