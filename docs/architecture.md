# Milestone Planner — architecture

This is the build spec for the tool described in
`docs/design/2026-10-21-milestone-planner-design.md` (the "design doc"; section
numbers like §6.5 refer to it). Linear stays the source of truth. This tool does
the **allocation** and the **noticing**, and gives two audiences a screen each:
_My week_ for everyone, the _timeline_ for PMs.

Working product name: **Milestone Planner** (configurable via `APP_NAME`; the
repo and package scope are `better-tracker`).

## 1. Layout

```
apps/
  planner/   Next.js 16 app: pages, route handlers (OAuth, webhooks, PM edits)
  worker/    CLI for scheduled jobs (daily run, periodic resync, migrations)
packages/
  core/      pure domain logic + shared types (no I/O, no dependencies)
  linear/    Linear GraphQL gateway, OAuth, webhook verification, fixture workspace
  store/     Postgres persistence (pg in production, PGlite locally/tests)
  notify/    digest delivery: Slack DMs, outbox
  engine/    orchestration: sync, allocation, warnings, PM edits, read models
  logger/    structured JSON logger
docs/
  architecture.md   this file
  design/           the design doc
  deploy.md         Railway + Linear app + Slack app setup
```

Dependency direction: `core` ← `linear`, `store`, `notify` ← `engine` ←
`planner`, `worker`. `logger` is used by `engine`, `planner`, `worker`. Nothing
imports `planner` or `worker`. No package may import from a sibling it does not
list in `package.json`.

### Conventions (binding for every package)

- Files are **kebab-case** (`next-milestone.ts`, `timeline-bar.tsx`).
- **No `any`.** Use `unknown` + narrowing. Library packages compile with
  `isolatedDeclarations`, so every exported function, const and class member
  needs an explicit type annotation.
- Dependencies come from the `catalog` in `pnpm-workspace.yaml`
  (`"x": "catalog:"`), internal ones as `workspace:*`. Do not add dependencies
  without the catalog.
- Log through `@better-tracker/logger`, never `console.*` outside tests and the
  worker's human-readable CLI output.
- Tests use `bun:test` in each package's `test/` folder. Pure logic gets
  table-style unit tests; I/O packages get integration tests against PGlite and
  fake `fetch`.
- Comments follow AGENTS.md "Code Readability": a short comment above
  non-trivial helpers explaining what and why.
- Times: instants are ISO strings in UTC. Calendar logic ("today", "days left")
  happens in the workspace timezone through `core/dates.ts` only.

### Running checks without moon

moon cannot download its toolchain plugins in some sandboxes. The direct
equivalents (from the repo root, `export PATH="$PWD/node_modules/.bin:$PATH"`):

```bash
oxfmt .                                                  # root:format
oxlint --type-aware --tsconfig tsconfig.oxlint.json .    # root:lint
stylelint "**/*.css" --allow-empty-input                 # root:lint-css
(cd packages/<p> && ./node_modules/.bin/tsdown --clean && tsc --noEmit --pretty && bun test)
(cd apps/planner && tsc --noEmit --pretty && next build)
```

Build order (dependencies first): `logger`, `core` → `linear`, `store`, `notify`
→ `engine` → `worker`, `planner`.

## 2. Domain rules (packages/core)

All rules are pure functions of `(Snapshot, EvalContext, …)`. `today` is the
workspace-local calendar date; `daysLeft(d) = d - today` in whole calendar days.

### 2.1 Issue states

- open = state type in `triage | backlog | unstarted | started`
- closed = `completed | canceled`

### 2.2 Progress (per milestone)

`total` = all issues in the milestone; `completed`, `canceled`;
`scope = total - canceled`; `open`; `openUnassigned` (open and no assignee,
triage included); `openTriage`. Shown as `completed/scope`.

### 2.3 "Done means…" (rubric item b)

`resolveDoneMeans(milestone, meta)`:

1. `meta.doneMeans` (trimmed, non-empty) → source `planner`.
2. Otherwise the first line of `milestone.description` matching
   `/^\s*done means\b[\s:—–-]*(.+)$/i` → source `linear_description`, text is
   the capture group (lets teams author it in Linear).
3. Otherwise `{ text: null, source: null }`.

### 2.4 Rubric (§6.7)

A milestone is valid iff it has (a) a target date, (b) "done means…", (c) its
project has a lead, (d) at least one issue (`total > 0`). Gaps are reported in
that order: `no_target_date`, `no_done_means`, `no_project_lead`, `no_issues`.

### 2.5 Status

In this precedence:

1. `total === 0` → `empty`
2. `open === 0` → `complete` (all done/canceled)
3. no target date → `unscheduled`
4. `daysLeft < 0` → `overdue`
5. `daysLeft <= warnLeadDays` and at least one risk reason → `at_risk`
6. otherwise `on_track`

Risk reasons (§6.5), evaluated for milestones with open issues and a date (for
overdue ones too, so warnings can say why):

- `unassigned_open`: `openUnassigned > 0`.
- `stalled`: `now - lastStateChangeAt(milestone) > stallDays` where the
  milestone's `lastStateChangeAt` is the max of its issues' `lastStateChangeAt`
  (closed issues count: finishing something is movement).
- `behind_pace`:
  `open / scope > clamp(daysLeft, 0, paceWindowDays) / paceWindowDays`. Example
  from the doc: 3/7 done with 2 days left → 4/7 = 0.57 remaining > 2/7 = 0.29
  elapsed-window remaining → behind. `scope === 0` never reaches this (status
  would be complete).

### 2.6 Next milestone (§6.2, §6.11)

Per project: the first milestone in `milestonesByProject` order (target date
ascending, undated last, then `sortOrder`) whose status is not `complete`.
`empty` milestones are not complete, so an empty milestone blocks its project
(loud, per §6.11). An overdue milestone stays next. The weight override never
affects this.

### 2.7 Display ordering and weight (§6.6, §6.13)

Milestones: (1) overdue before everything else; (2) within each group, higher
`weight` first (null = 0); (3) target date ascending (undated last); (4) project
priority (urgent 1, high 2, medium 3, low 4, none 0 last); (5) milestone
`sortOrder`; (6) id. Issues inside a milestone: priority (same rank), then
`createdAt` ascending (age), then identifier.

### 2.8 Allocation plan (§6.1–6.4, §7.4)

For each project, in timeline order:

1. Status not in `tuning.activeProjectStatuses` → `inactive` (not loud).
2. No next milestone → `no_open_milestone`.
3. No lead → `blocked/no_lead`; lead deactivated → `blocked/lead_inactive`.
4. Next milestone fails the rubric → `blocked/next_milestone_invalid` with gaps.
   Never skips ahead to a later milestone.
5. Otherwise, for each open issue in the next milestone (issue display order):
   assigned → skip `already_assigned`; triage → skip `triage`; else action:
   assign to lead, and if the state type is `backlog`, move to the team's Todo
   state (`resolveTodoState`: the team's `unstarted` state named "Todo"
   case-insensitively, else its lowest-`position` `unstarted` state, else no
   move). Issues already in unstarted/started keep their state.
6. Outcome `allocate` if any actions, else `nothing_to_do`.

Issues with no milestone are never allocated; they appear in the timeline's
per-project "unplanned" bucket.

### 2.9 Warnings (§6.5, §7.5, §6.11)

Evaluated daily for milestones in active projects:

| condition                                          | kind               | key                                        |
| -------------------------------------------------- | ------------------ | ------------------------------------------ |
| status overdue                                     | `overdue`          | `overdue:<targetDate>`                     |
| rubric invalid and `0 <= daysLeft <= warnLeadDays` | `invalid_due_soon` | `invalid:<targetDate>:<gaps>`              |
| status at_risk                                     | `at_risk`          | `at_risk:<targetDate>`                     |
| anything else                                      | —                  | `ok:<status>` (remembered, never notified) |

Overdue wins over invalid, invalid over at_risk (an invalid milestone due soon
is reported as invalid with its risk reasons attached).

Per project: allocation `blocked` → kind `allocation_blocked`, key
`blocked:<reason>:<nextMilestoneId>:<gaps>`; otherwise key `ok`.

Send rule: a subject produces a notice when its key differs from the remembered
`lastKey` (status changed, or re-dated since the date is in the key), **or** it
is `overdue` and `day - lastNotifiedOn >= overdueRepeatDays` ("keeps
escalating", §6.11). `occurrence` counts consecutive sends for the same key.
Memory is written for every evaluated subject, so a milestone that recovers and
later slips again is re-announced.

Recipients: milestone notices → project lead (if active) + watchers;
`allocation_blocked` → watchers + lead (if any). Deduplicated, inactive users
dropped.

Digests (§6.8): one per recipient per day, items sorted overdue → at_risk →
invalid_due_soon → allocation_blocked, then by milestone display order. Each
item carries the project, milestone, due date, days left, open count, unassigned
count, plain lines ("3 open issues unassigned", "no state change in 9 days",
"2/7 done with 2 days left", "missing: done means…"), and a deep link
`<appUrl>/timeline?milestone=<id>` (or `?project=<id>`).

### 2.10 Dependency graph (§7.3)

- Issue level, scope = a milestone's or project's issues; plus the direct
  blockers and blocked issues outside the scope as `external` nodes (that is
  where cross-project blockers show up). Edge = `blocks` relation where the
  blocked issue is in scope or the blocker is in scope; `resolved` when the
  blocker is closed.
- Milestone level: node per milestone in an active project with open issues or
  with edges; edge B → A when an **open** issue in A is blocked by an **open**
  issue in B (A ≠ B), `weight` = number of such relations.
- Flags: `unassigned`, `overdue` (issue's milestone overdue / milestone
  overdue), `inCycle` (Tarjan SCC size > 1 or self-loop), `waitsOnUnassigned` /
  `waitsOnOverdue` (transitively over open blockers), `crossProject` /
  `crossOwner` on edges (owner = assignee for issues, project lead for
  milestones), `onRiskChain` when the edge's blocker is unassigned/overdue or
  itself waits on one.
- `toMermaid(graph)` emits `flowchart LR` with stable sanitized ids (`n0`, `n1`,
  …), quoted labels, `-->` for open edges, `-.->` for resolved, and `classDef`s
  for risk/cycle/external.

### 2.11 Views

- `buildWeekView` (§7.1): sections = milestones containing the user's open
  issues, in display order; rows in issue order; then a "No milestone" section.
  `thisWeek` = overdue or `daysLeft <= 6`. A row is `newBecauseLeadOf` when a
  live allocation assigned it to this user within `newBadgeDays` and it is still
  assigned to them.
- `buildTimelineView` (§7.2): window `today - timelineDaysBack` →
  `today + timelineDaysAhead`. Groups per initiative (initiative priority rank,
  then `sortOrder`; projects in several initiatives appear under the first),
  then "No initiative". Lanes = projects not completed/canceled, ordered by
  project priority rank then `sortOrder`. Bars per dated milestone: `start` =
  previous dated milestone's date (same project), else project `startDate`, else
  window start, never after `end`. Banners: projects without lead (active only),
  milestones without date, open issues without milestone (per project), blocked
  projects.

## 3. Core API (packages/core/src/index.ts)

```ts
// config.ts
export const DEFAULT_TUNING: Tuning;
export function defaultSettings(
  workspaceId: string,
  timezone: string
): WorkspaceSettings;
// dates.ts
export function todayIn(timeZone: string, now: Date): IsoDate;
export function addDays(date: IsoDate, days: number): IsoDate;
export function diffDays(later: IsoDate, earlier: IsoDate): number;
export function isValidIsoDate(value: string): boolean;
export function isValidTimeZone(value: string): boolean;
// snapshot.ts
export function indexWorkspace(data: WorkspaceData): Snapshot;
export function isOpenState(type: WorkflowStateType): boolean;
export function priorityRank(p: Priority): number; // 1..4, none = 5
// rubric.ts / progress.ts / assess.ts
export function resolveDoneMeans(
  m: Milestone,
  meta: MilestoneMeta | undefined
): DoneMeans;
export function milestoneProgress(
  snapshot: Snapshot,
  milestoneId: string
): Progress;
export function evaluateRubric(
  snapshot: Snapshot,
  milestoneId: string,
  meta: MilestoneMeta | undefined
): RubricResult;
export function assessWorkspace(
  snapshot: Snapshot,
  ctx: EvalContext
): Map<string, MilestoneAssessment>;
export function nextMilestoneId(
  snapshot: Snapshot,
  projectId: string,
  assessments: ReadonlyMap<string, MilestoneAssessment>
): string | null;
// ordering.ts
export function compareMilestones(
  snapshot: Snapshot,
  ctx: EvalContext,
  assessments: ReadonlyMap<string, MilestoneAssessment>
): (a: Milestone, b: Milestone) => number;
export function compareIssues(a: Issue, b: Issue): number;
export function orderProjects(snapshot: Snapshot): Project[];
// allocation.ts
export function resolveTodoState(
  snapshot: Snapshot,
  teamId: string
): WorkflowState | null;
export function planAllocation(
  snapshot: Snapshot,
  ctx: EvalContext,
  assessments: ReadonlyMap<string, MilestoneAssessment>
): AllocationPlan;
export function allocationComment(input: {
  appName: string;
  projectName: string;
  milestoneName: string;
  targetDate: IsoDate;
}): string;
// warnings.ts
export function planWarnings(input: {
  snapshot: Snapshot;
  ctx: EvalContext;
  assessments: ReadonlyMap<string, MilestoneAssessment>;
  allocationPlan: AllocationPlan;
  memory: readonly WarningMemory[];
  watcherUserIds: readonly string[];
}): WarningPlan;
export function buildDigests(input: {
  snapshot: Snapshot;
  ctx: EvalContext;
  assessments: ReadonlyMap<string, MilestoneAssessment>;
  notices: readonly Notice[];
  appUrl: string;
}): Digest[];
// graph.ts / mermaid.ts
export function buildDependencyGraph(
  snapshot: Snapshot,
  ctx: EvalContext,
  assessments: ReadonlyMap<string, MilestoneAssessment>,
  scope: GraphScope
): DependencyGraph;
export function toMermaid(graph: DependencyGraph): string;
// views.ts
export function buildWeekView(input: {
  snapshot: Snapshot;
  ctx: EvalContext;
  assessments: ReadonlyMap<string, MilestoneAssessment>;
  userId: string;
  recentAllocations: readonly RecentAllocation[];
}): WeekView;
export function buildTimelineView(input: {
  snapshot: Snapshot;
  ctx: EvalContext;
  assessments: ReadonlyMap<string, MilestoneAssessment>;
  allocationPlan: AllocationPlan;
}): TimelineView;
export function buildMilestoneDetail(input: {
  snapshot: Snapshot;
  ctx: EvalContext;
  assessments: ReadonlyMap<string, MilestoneAssessment>;
  milestoneId: string;
}): MilestoneDetail | null;
// labels.ts — shared human copy for UI and digests
export const RUBRIC_GAP_LABEL: Record<RubricGap, string>;
export const RISK_REASON_LABEL: Record<RiskReason, string>;
export const STATUS_LABEL: Record<MilestoneStatus, string>;
export const BLOCK_REASON_LABEL: Record<AllocationBlockReason, string>;
export const PRIORITY_LABEL: Record<Priority, string>;
```

The allocation comment (§7.4) is exactly:
`Assigned by <appName>: you lead <project> and this is in its next milestone <milestone>, due <Mon D, YYYY>.`

## 4. Linear integration (packages/linear)

- `createLinearGateway({ accessToken, fetch?, logger?, endpoint? })` — real API
  over `fetch` (no SDK at runtime). Bearer token. Retries 429/5xx with bounded
  backoff honoring reset headers; maps failures to `LinearApiError`.
- Queries live in `queries.ts` as plain strings and are validated against
  Linear's published schema in tests (`test/schema.test.ts` using `graphql`'s
  `buildSchema` + `validate`). See §4.1 for the schema source.
- `fetchWorkspace` pages every connection (page size within Linear's limit),
  keeps nested connections shallow (ids only) to stay under complexity limits,
  and maps nodes with `map.ts` into core types. `lastStateChangeAt`
  approximation = latest of createdAt/startedAt/completedAt/canceledAt.
- `fetchLastStateChanges(ids)` batches issue `history` lookups with aliases and
  returns the newest entry whose `toStateId` is set.
- `oauth.ts`: `buildAuthorizeUrl`, `exchangeCode`, `refreshTokens`,
  `revokeToken`, PKCE helpers (`createPkcePair`). Details in §4.2.
- `webhooks.ts`: `verifyWebhookSignature(rawBody, header, secret)` (constant
  time) and `parseWebhookEvent(json, nowMs)` → normalized
  `{ workspaceId, type, action, entityId, webhookTimestamp }` or a typed
  rejection (bad JSON, stale timestamp, unsupported type).
- `fixture.ts`: `createFixtureWorkspace(today: IsoDate): WorkspaceData` — a
  deterministic fictional workspace (generic names, nothing from the real team)
  dated relative to `today`, exercising every state: overdue, at risk for each
  reason, on track, complete, empty, undated, invalid (missing done-means / no
  lead), triage issues, unplanned issues, blocks chains across projects, a
  cycle, a project with an inactive lead, a paused project.
  `createFixtureGateway(state, actorUserId | 'app')` mutates that in-memory
  workspace so demo drags and allocation runs "write back".

### 4.1 Linear facts this design relies on

Verified against Linear's SDL (vendored at `packages/linear/schema/`, SDK
98.0.0) and Linear's SDK source; sources in `docs/research.md`.

**GraphQL** (`https://api.linear.app/graphql`, `Authorization: Bearer <token>`)

- Root connections used by `fetchWorkspace`: `users(includeDisabled: true)`
  (deactivated leads must stay visible), `teams`, `workflowStates`,
  `initiatives`, `projects` (filter out completed/canceled via `status.type`),
  `projectMilestones`, `issues`, `issueRelations` (no filter arg; keep
  `type == "blocks"`). Page with `first: 100` +
  `pageInfo { hasNextPage endCursor }`; a page over Linear's max is rejected
  loudly, so keep the constant in one place. Single queries are capped at 10,000
  complexity points (connections multiply children by `first`), so nested
  connections only select ids with a small explicit `first`.
- Issues fetched: `issues(filter: { project: { null: false } })` (open and
  closed, for progress) plus open issues without a project
  (`filter: { project: { null: true }, state: { type: { nin: ["completed", "canceled", "duplicate"] } } }`)
  for My week's "No milestone" section. Archived issues are excluded by default
  (`includeArchived: false`).
- `Issue.priority` is a **Float** (0–4); round and clamp. `Project.priority` and
  `Initiative.priority` are Int. `WorkflowState.type` is a String that can be
  `"duplicate"` → map to `canceled`; unknown types → `backlog` + warn log.
- `IssueRelation { type: String, issue, relatedIssue }`: for `"blocks"`, `issue`
  blocks `relatedIssue`. An issue's blockers are its `inverseRelations` of type
  `blocks`.
- `Project.status { type }` (ProjectStatusType), not the deprecated `state`.
- `ProjectMilestone { id name description targetDate sortOrder project { id } }`;
  `targetDate` is a `TimelessDate` (`YYYY-MM-DD`).
- Last state change:
  `Issue.stateHistory(first: 50) { nodes { startedAt endedAt } pageInfo { … } }`
  — the span with `endedAt == null` started when the issue entered its current
  state (order is undocumented: search, don't index). Fallback: max `createdAt`
  of `history` entries with `toStateId`.
- Mutations: `issueUpdate(id, input: { assigneeId, stateId })` →
  `IssuePayload { success issue }`; `commentCreate(input: { issueId, body })` →
  `CommentPayload { success comment { id } }`;
  `projectMilestoneUpdate(id, input: { targetDate })`;
  `projectUpdate(id, input: { leadId })`.
- Identity:
  `{ viewer { id name displayName email active avatarUrl app } organization { id name urlKey } }`.
  With an actor=app token, `viewer` is the app user (`app: true`), never the
  installing human.
- Rate limits (OAuth apps, per user/app user): 5,000 requests/h and 2,000,000
  complexity points/h. Rate limiting arrives as HTTP 400 **or** 429 with
  `errors[].extensions.code == "RATELIMITED"` (the SDK also checks
  `extensions.type == "ratelimited"`); reset headers
  `x-ratelimit-requests-reset` / `x-ratelimit-complexity-reset` are epoch ms.

**OAuth 2.0** (one Linear OAuth app, two actor modes)

- Authorize:
  `GET https://linear.app/oauth/authorize?client_id&redirect_uri &response_type=code&scope=<comma-separated>&state&code_challenge &code_challenge_method=S256[&actor=app][&prompt=consent]`.
- Token: `POST https://api.linear.app/oauth/token`,
  `application/x-www-form-urlencoded`:
  `grant_type=authorization_code, code, redirect_uri, client_id, client_secret, code_verifier`.
  Response:
  `access_token, token_type, expires_in (~86399 s), scope, refresh_token`.
- Access tokens last **24 h**; refresh with
  `grant_type=refresh_token, refresh_token, client_id, client_secret`. Refresh
  tokens **rotate** (the old pair dies), so refreshes are single-flight under a
  row lock (`withInstallationLock` / `withSessionLock`), refreshed 5 minutes
  early. On `invalid_grant` the session must sign in again; the installation
  must be reinstalled (shown loudly in Settings and logs).
- Revoke: `POST https://api.linear.app/oauth/revoke` with `token` and
  `token_type_hint`.
- `actor=app` (admin-only install, workspace-scoped): writes are attributed to
  the app user, which is what allocation comments should say. Scopes
  `read,write` (actor=app cannot request `admin`). The app only sees the teams
  the admin picks at install — document this in setup.
- Per-user sign-in uses the default actor (user) with `read`; PMs upgrade to
  `read,write` so their date/lead edits are attributed to them in Linear. Scopes
  are sent comma-separated.

**Webhooks** (configured on the OAuth app: URL + resource types; delivered for
every workspace that installs it, routed by `organizationId`)

- Header `Linear-Signature` = lowercase hex HMAC-SHA256 of the **raw** body with
  the app's webhook signing secret; compare in constant time; verify before
  parsing JSON.
- Freshness: body field `webhookTimestamp` (ms) must be within 60 s of now,
  either direction (the `Linear-Timestamp` header is legacy; ignore it).
- `Linear-Delivery` header (UUID) identifies a delivery → dedupe on it
  (`webhookId` is the same for every delivery and must not be used).
- Payload:
  `{ action, type, data, url, updatedFrom, createdAt, organizationId, webhookId, webhookTimestamp, actor }`;
  actions `create`, `update`, `remove` (`remove` also means archived);
  `OAuthApp` + `revoked` when an installation is revoked.
- Resource types to subscribe: **Issue, Project, Initiative, User,
  OAuthAuthorization**. There is **no ProjectMilestone and no IssueRelation
  webhook**: milestone and relation changes are picked up by refetching on
  Issue/Project events and by the periodic full resync (default every 15 minutes
  from the worker).
- Respond 200 within 5 s (Linear retries 1 min, 1 h, 6 h, then may disable the
  webhook), so the route only verifies and acks; processing runs in Next's
  `after()`.

## 5. Persistence (packages/store)

`openStore({ databaseUrl?, pgliteDir?, encryptionKey, logger })`: `databaseUrl`
→ `pg.Pool`; otherwise PGlite (`pgliteDir` or in-memory). One SQL dialect
(Postgres) for both. Migrations are an ordered array of SQL strings applied in a
transaction and recorded in `schema_migrations`; `migrate()` takes
`pg_advisory_lock` so two processes never race.

Tables (all keyed by `workspace_id`):

- `installations` — app actor tokens (encrypted), app user id, installer.
- `sessions` — `token_hash` (SHA-256 of the cookie token), user, the user's
  Linear tokens (encrypted), expiry.
- `settings` — `data jsonb` (WorkspaceSettings).
- `milestone_meta` — weight, done_means, updated_by/at.
- `mirror_entities` — `(workspace_id, kind, id) pk, data jsonb, synced_at`.
- `sync_state` — `version bigint` (bumped on every mirror write), last full sync
  time/status/error, last webhook time.
- `allocation_runs` — mode, trigger, status, summary jsonb; a partial unique
  index on `(workspace_id) where status = 'running'` makes concurrent runs
  impossible.
- `allocation_entries` — per-issue/per-project log (§6.12 "logged").
- `warning_memory` — `(workspace_id, subject_kind, subject_id) pk`.
- `notifications` — unique `(workspace_id, day, recipient_id)`.
- `job_claims` — unique `(workspace_id, job, day)`.
- `audit_log` — PM edits with before/after.

Token encryption: AES-256-GCM, key = 32 bytes from `TOKEN_ENCRYPTION_KEY`
(base64), random 12-byte IV per value, stored as `v1:<iv>:<tag>:<ciphertext>`
(base64url). Session cookie tokens are 32 random bytes (base64url); only their
SHA-256 hash is stored.

## 6. Notifications (packages/notify)

- `createSlackChannel({ botToken, fetch?, logger?, sleep? })` (raw `fetch`, no
  SDK). Bot scopes: `chat:write`, `users:read`, `users:read.email` (no
  `im:write`: `chat.postMessage` with `channel=<user id>` posts to the app's DM
  / App Home Messages tab, which must be enabled in the Slack app).
  - Lookup: `GET https://slack.com/api/users.lookupByEmail?email=…` with
    `Authorization: Bearer xoxb-…` (form/query method, not JSON). Cache email →
    user id per process.
  - Send: `POST https://slack.com/api/chat.postMessage`,
    `Content-Type: application/json; charset=utf-8`, body
    `{ channel: <U…>, text, blocks, unfurl_links: false, unfurl_media: false }`.
  - Always check `body.ok` (errors come back as HTTP 200). On HTTP 429 or
    `ratelimited` / `rate_limited`, wait `Retry-After` seconds (cap the wait)
    and retry once. Send digests sequentially (≈1/s).
  - Error classes: config (`invalid_auth`, `not_authed`, `account_inactive`,
    `token_revoked`, `token_expired`, `missing_scope`) → `failed` and log at
    error; per-person (`users_not_found`, `user_not_found`, `user_disabled`,
    `channel_not_found`, `messages_tab_disabled`, no email) → `undeliverable`;
    transient (`service_unavailable`, `fatal_error`, `request_timeout`, network)
    → `failed`.
  - Limits: ≤ 50 blocks, header ≤ 150 chars (plain_text), section text ≤ 3000
    chars, top-level `text` ≤ 4000 chars. Over the limit → truncate and add a
    final "…and N more — open the timeline" context block (never drop items
    silently). mrkdwn-escape `&`, `<`, `>` in titles; links are `<url|label>`
    with `|` and `>` stripped from labels.
- `createOutboxChannel()`: `delivers = false`; the engine records digests with
  status `preview`.
- `renderDigest(digest, ctx) → { text, blocks }` is exported and unit-tested.

## 7. Engine (packages/engine)

`createEngine(deps: EngineDeps): Engine` (contract in `src/types.ts`).

- **load(workspaceId)**: reads `sync_state.version`; if it equals the cached
  version, reuses the indexed snapshot; otherwise loads the mirror and
  re-indexes. Settings + milestone meta are read every call (small). Computes
  `today` (workspace tz), assessments, allocation plan. No mirror yet → runs
  `fullSync` first (if installed).
- **fullSync**: app gateway `fetchWorkspace()` → refine `lastStateChangeAt` via
  `fetchLastStateChanges` for open issues in milestones whose target date is
  within `warnLeadDays + stallDays` ahead or already past → bootstrap PMs and
  watchers from `bootstrap*Emails` + installer if settings are empty →
  `replaceMirror`.
- **handleWebhook**: `recordWebhookDelivery` (duplicate → `'duplicate'`), then
  by `type`: `Issue` → `fetchIssue` + `fetchIssueRelations` (replace every
  relation touching that issue) and, when the issue's milestone is not mirrored
  yet, `fetchProject` for its project; `Project` → `fetchProject` (upsert
  project + all its milestones, delete mirrored milestones of that project that
  are gone); `Initiative` → `fetchInitiative`; `User` → `fetchUser`; `OAuthApp`
  with action `revoked` → `markInstallationRevoked`. Fetch returning null or
  action `remove` → delete from the mirror (a removed project also drops its
  milestones). Anything else → `'ignored'`. Errors are recorded on the delivery
  and logged; the periodic resync heals drift.
- **runAllocation** (§7.4, §6.3, §6.12, §9 safety):
  1. `store.startRun` (null → `EngineInputError('conflict')`).
  2. `fullSync` so the plan uses fresh data.
  3. `planAllocation`; record `block` entries for blocked projects and `skip`
     entries for skips.
  4. Dry run: record each action as `assign/planned`.
  5. Live: for each action, `fetchIssue` live and re-check (still open, not
     triage, still unassigned, still in that milestone) → else `stale`. Then
     `updateIssue({ assigneeId, stateId? })` **first**, then `createComment`
     (assign-then-comment: a rerun never double-comments, because the issue is
     no longer unassigned). Record `applied` with the comment id, or `failed`
     with the error. Continue past failures. Patch the mirror with the returned
     issue.
  6. `finishRun` with status `succeeded` / `partial` (some failed) / `failed`
     (threw). Idempotent by construction: assigned issues are never reassigned.
- **runWarnings**: `planWarnings` with stored memory → `buildDigests` → for each
  digest `insertNotification` (false → `alreadySent`, nothing sent) → if
  `warningsMode === 'live'` deliver via the channel, else status `preview`. Save
  memory only after notifications are recorded. `previewOnly` builds digests
  without writing anything (Settings preview).
- **runDaily**: `claimJob(daily, today)` unless `force` → fullSync →
  runAllocation(settings.allocationMode, schedule) → runWarnings. If the run
  throws before finishing, `releaseJob` so a retry can run.
- **PM edits**: require `actor.isPm` (else `not_pm`). Linear writes
  (`setMilestoneTargetDate`, `setProjectLead`) also require
  `actor.canWriteLinear` (else `needs_write_scope`) and go through
  `linear.forSession(actor.session)` so Linear attributes them to the human.
  Each edit patches the mirror and appends an audit entry. Weight and done-means
  are tool-owned writes.
- **auth**: `startOAuth(intent)` creates state + PKCE pair. Scopes: `signin` →
  `read`; `grant_write` → `read,write`; `install` → `read,write` with
  `actor=app`. `finishSignIn` exchanges the code, asks `whoAmI`, creates a
  session (`sessionDays`). `finishInstall` exchanges with the app actor, checks
  the workspace matches the actor's, saves the installation, makes the installer
  a PM, and triggers `fullSync`. `authenticate` refreshes the session's Linear
  token when needed (under `withSessionLock`) and computes `isPm` from settings.

### 7.1 Engine exports and boot

`src/index.ts` exports: `createEngine`,
`createEngineFromEnv(env): Promise<Engine>`,
`loadEngineConfigFromEnv(env): EngineConfig` (throws one error listing every
missing/invalid variable), `EngineAuthError`, `EngineInputError`,
`LinearApiError` (re-exported) and `isLinearApiError(e)` (instanceof, with a
`name === 'LinearApiError'` fallback across bundle copies), and every type in
`src/types.ts`.

`createEngineFromEnv`:

- `LINEAR_FIXTURE=1` (demo mode): in-memory PGlite unless `PGLITE_DIR` is set;
  ephemeral random `TOKEN_ENCRYPTION_KEY` if unset; `APP_URL` defaults to
  `http://localhost:3000`; `oauth: null`. Seeds the fixture workspace
  (`createFixtureStore(today)`), a fake installation, settings (PMs and watchers
  = the fixture PMs, `dry_run`, `preview`), milestone meta from
  `FIXTURE_MILESTONE_META`, then `fullSync`. `devSignIn` creates sessions with
  scopes `read,write`. Webhooks are ignored. The `LinearProvider` serves
  `createFixtureGateway` (app actor or the session's user).
- Otherwise: requires `APP_URL`, `TOKEN_ENCRYPTION_KEY`, `LINEAR_CLIENT_ID`,
  `LINEAR_CLIENT_SECRET`; `DATABASE_URL` or PGlite at `PGLITE_DIR` (default
  `.data/pglite`); redirect URI `${APP_URL}/api/auth/linear/callback`; Slack
  channel when `SLACK_BOT_TOKEN` is set, else the outbox. Runs `store.migrate()`
  before returning.
- Real `LinearProvider`: loads the installation/session tokens, refreshes when
  `expiresAt` is within 5 minutes (under the row lock, re-reading inside the
  lock so only one process refreshes), and returns
  `createLinearGateway({ accessToken })`. A revoked installation or an
  `invalid_grant` refresh → `EngineAuthError('not_installed')` (workspace) or
  `EngineAuthError('not_signed_in')` (session), logged at error.

Validation done by the engine (never trust the client): dates via
`isValidIsoDate`; lead must be an active, non-app mirrored user or null; weight
an integer in [-1000, 1000] or null; done-means trimmed, single line, ≤ 280
chars, empty → null; settings: at least one PM (no lockout), valid IANA
timezone, tuning integers within sane ranges (1–90 days), known modes; user ids
must exist in the mirror.

## 8. Web app (apps/planner)

### 8.1 Routes

| route                           | who                        | what                                                                                                               |
| ------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `/`                             | all                        | signed out: "Sign in with Linear" (fixture mode: demo user picker); signed in → `/week`                            |
| `/week`                         | signed in                  | My week; PMs may pass `?user=<id>`                                                                                 |
| `/timeline`                     | signed in                  | PM timeline; `?milestone=<id>` opens the drawer, `?project=<id>` focuses a lane; edit controls only for PMs        |
| `/graph`                        | signed in                  | dependency graph; default milestone level; `?milestone=<id>` or `?project=<id>` for issue level                    |
| `/runs`, `/runs/[id]`           | signed in                  | allocation run log; PMs get "Preview (dry run)" and "Run now"                                                      |
| `/settings`                     | PMs (read-only for others) | modes, PMs, watchers, timezone, tuning, sync/webhook/Slack status, digest preview, notification history, audit log |
| `/setup`                        | signed in                  | install the app into the workspace (admin)                                                                         |
| `GET /api/auth/linear?intent=`  | —                          | starts OAuth (sets `mp_oauth` cookie)                                                                              |
| `GET /api/auth/linear/callback` | —                          | finishes OAuth                                                                                                     |
| `POST /api/auth/logout`         | —                          | ends session                                                                                                       |
| `POST /api/auth/demo`           | fixture mode only          | demo sign-in                                                                                                       |
| `POST /api/webhooks/linear`     | Linear                     | verify, ack 200, process in `after()`                                                                              |
| `PATCH /api/milestones/[id]`    | PM                         | `{ targetDate?, weight?, doneMeans? }`                                                                             |
| `PATCH /api/projects/[id]`      | PM                         | `{ leadId }`                                                                                                       |
| `POST /api/runs`                | PM                         | `{ mode: 'dry_run' \| 'live' }`                                                                                    |
| `POST /api/sync`                | PM                         | full resync                                                                                                        |
| `POST /api/warnings/preview`    | PM                         | digests without sending                                                                                            |
| `PATCH /api/settings`           | PM                         | settings patch                                                                                                     |
| `GET /api/health`               | —                          | `{ ok, db }` for Railway healthchecks                                                                              |

Security: session cookie `mp_session` (httpOnly, `SameSite=Lax`, `Secure` when
`APP_URL` is https, `Path=/`); OAuth cookie `mp_oauth` carries
`{state, codeVerifier, intent, returnTo}` signed with HMAC-SHA256
(`SESSION_SECRET`), 10-minute expiry, compared in constant time. Mutating routes
require same-origin `Origin` (or `Sec-Fetch-Site: same-origin`) and JSON bodies
validated with zod. `returnTo` must be a relative path. Every page/route
resolves the actor server-side; the UI never decides permissions.

### 8.2 Design system (from wsoule/Analytics `competitors-site` + `DESIGN.md`)

The UI reuses that site's system verbatim: tokens (`--paper`, `--ink`,
`--background`, `--foreground`, `--border`, `--muted`, `--accent #ee5a24`,
`--accent-hover`, `--on-accent`, `--ink-soft`, `--grey-2..4`,
`--hairline-faint`, `--hatch`, `--tint`, the `*-inverse` set), light + dark via
`html[data-theme]` with the pre-paint theme script, Geist + JetBrains Mono via
`next/font/google`, body weight 300, zero radius, no shadows, 1px hairlines
collapsed with `-1px` margins, 2px only for emphasis, the hatched chrome
titlebar (`.block` / `.blockBar` / `.blockKey` / `.blockTitle` / `.blockMeta`),
the sticky nav dock with orange registration marks that floods orange on hover,
the grid tab strip (selected = ink fill, hover = orange flood), roster-style
register rows whose hover swaps paper and ink tokens locally, the `Mark` square
idiom, the 2px-accent explain drawer, mono uppercase micro-labels with positive
tracking, `:focus-visible` orange outline, hover effects gated behind
`@media (hover: hover) and (min-width: 901px)`, and a designed
`prefers-reduced-motion` state.

Status uses only the system's own marks (no new hues — DESIGN.md §3):

| status                               | mark                         |
| ------------------------------------ | ---------------------------- |
| complete                             | filled ink square            |
| on_track                             | hollow ink square            |
| at_risk                              | hollow accent square (2px)   |
| overdue                              | filled accent square         |
| unscheduled / empty / rubric-invalid | hatched square, muted border |

The same states drive timeline bars (overdue = accent fill; at risk = 2px accent
border; on track = ink border on paper; complete = ink fill; invalid = hatch +
muted label listing what is missing).

### 8.3 Pages

- **My week**: hatched titlebar `01 · MY WEEK · <name> · <today>`; a stats strip
  (open / this week / overdue / new); a legend row; sections as register blocks:
  header `PROJECT › MILESTONE`, due date + days left, `completed/scope` with a
  1px progress rule, status mark; rows: identifier (mono), title (sans),
  priority label, state, "NEW — GIVEN TO YOU BECAUSE YOU LEAD <PROJECT>" chip in
  accent; each row links to Linear. A divider separates "This week" from
  "Later". Empty state is honest copy.
- **Timeline**: banners first (no lead / no date / unplanned / blocked, each a
  count that expands to a list). Then a drawing like the competitors Matrix:
  sticky left column of lanes grouped by initiative, a date axis with week ticks
  (mono 9.5px), today as a 1px accent vertical rule, bars positioned by date.
  PMs drag a bar's right edge to change its date (snaps to days, shows the date
  while dragging, PATCH on drop, optimistic with rollback + error notice), and
  get controls in the drawer for weight, lead (select of active users), "done
  means…". Clicking a bar opens the 2px-accent drawer: rubric checklist,
  progress, risk reasons, issues table, "What does this wait on?" →
  `/graph?milestone=<id>`. Below 900px the drawing becomes per-project cards
  (like the Matrix cards fallback).
- **Graph**: milestone/issue level tabs; SVG laid out with `@dagrejs/dagre`
  (rankdir LR) on the server, rendered as hairline boxes with mono labels; risk
  chains in accent, cycles dashed accent, cross-project edges dashed ink,
  resolved edges faint; legend; click a node → side panel with links; "Copy
  Mermaid" copies `toMermaid` output.
- **Runs**: register of runs (mode chip DRY RUN / LIVE, trigger, counts); detail
  lists assigned / would assign / failed / stale / skipped / blocked grouped by
  project with reasons.
- **Settings**: register rows per setting; mode switches use the Matrix switch
  idiom (13px square glyph that fills accent).

Fixture mode shows a permanent accent-bordered "DEMO DATA — NOT CONNECTED TO
LINEAR" strip under the nav.

## 9. Worker (apps/worker)

`node apps/worker/dist/index.js <command>`:

- `migrate`
- `sync [--workspace <id>]` — full resync of one/all installed workspaces
- `daily [--workspace <id>] [--force]` — the scheduled job
- `allocate --dry-run|--live [--workspace <id>]`
- `warn [--workspace <id>]`
- `tick` — **what the Railway cron runs every 15 minutes** (`*/15 * * * *`,
  UTC): for each installed workspace, if the local time in its timezone is at or
  past `DAILY_RUN_AT` (default `08:00`) and today's daily job is unclaimed,
  `runDaily` (which syncs first); otherwise a plain `fullSync` (the periodic
  resync that heals milestone/relation drift, since Linear has no webhooks for
  those). Then `cleanup`. Closes the store and exits. A hard timeout
  (`TICK_TIMEOUT_MINUTES`, default 10) exits non-zero so a hung run never blocks
  later ones (Railway skips a cron tick while the previous one runs).
- `serve` — long-running alternative to cron for other hosts: runs `tick` every
  `SYNC_INTERVAL_MINUTES` (default 15) until SIGTERM.

Exit code is non-zero when any workspace failed, so cron failures are loud.
Every command runs migrations first (advisory-locked, idempotent).

## 10. Configuration

| env                                         | used by         | meaning                                                           |
| ------------------------------------------- | --------------- | ----------------------------------------------------------------- |
| `APP_URL`                                   | planner, worker | public base URL                                                   |
| `APP_NAME`                                  | all             | display name (default `Milestone Planner`)                        |
| `DATABASE_URL`                              | all             | Postgres; unset → PGlite at `PGLITE_DIR` (default `.data/pglite`) |
| `TOKEN_ENCRYPTION_KEY`                      | all             | 32 random bytes, base64                                           |
| `SESSION_SECRET`                            | planner         | ≥ 32 chars, signs the OAuth cookie                                |
| `LINEAR_CLIENT_ID` / `LINEAR_CLIENT_SECRET` | planner, worker | OAuth app                                                         |
| `LINEAR_WEBHOOK_SECRET`                     | planner         | webhook signing secret                                            |
| `SLACK_BOT_TOKEN`                           | worker, planner | optional; without it digests stay in the outbox                   |
| `DEFAULT_TIMEZONE`                          | all             | IANA zone for new workspaces (default `UTC`)                      |
| `PM_EMAILS`, `WATCHER_EMAILS`               | engine          | comma-separated bootstrap lists                                   |
| `LINEAR_FIXTURE`                            | planner, worker | `1` = demo mode, no Linear needed                                 |
| `SYNC_INTERVAL_MINUTES`, `DAILY_RUN_AT`     | worker serve    | scheduler                                                         |
| `LOG_LEVEL`                                 | all             | debug/info/warn/error                                             |

`packages/engine` exports `loadEngineConfigFromEnv(env)` and
`createEngineFromEnv(env)` so the planner and worker build identical engines.

## 11. Testing

- core: unit tests per rule above, including the doc's own examples (3/7 done
  with 2 days left; invalid next milestone blocks and never skips ahead; overdue
  stays next; weight changes display order only).
- linear: schema validation of every query/mutation; mapping fixtures;
  pagination with a fake fetch; OAuth URL/exchange/refresh with a fake fetch;
  webhook signature + timestamp tests with known vectors.
- store: every method against in-memory PGlite; concurrency guards (second
  `startRun` returns null; duplicate notification returns false; job claims).
- notify: rendering limits and Slack error mapping with a fake fetch.
- engine: end-to-end with the fixture gateway + PGlite + a recording channel:
  dry vs live allocation, idempotent rerun, stale re-check, warning dedupe
  across days, overdue repeat, PM permission errors.
- planner: unit tests for cookie signing/origin checks; Playwright smoke in
  fixture mode (screens render, drag updates a date).

## 12. Verified external facts

See `docs/research.md` (generated from the research pass with sources).
