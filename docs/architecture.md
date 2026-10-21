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
2. Otherwise the first line of `milestone.description` that, after dropping a
   leading markdown list/blockquote/heading marker, matches
   `/^[\s*_]*done means\b[\s:—–*_-]*([^\s:—–*_-].*)$/i` → source
   `linear_description`, text is the capture group with trailing emphasis
   removed (lets teams author it in Linear, including `**Done means:** …`). A
   bare "Done means:" with nothing after it does not count.
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

"Not loud" for an inactive project means: the engine's `TimelineLane.active` is
false, and nothing derives it again. Its lane, register row and the person's
issues in it stay listed, drawn in greys, but it is in no warning, banner
(§2.11), due-this-week, overdue or at-risk count, "at risk / overdue" filter,
deadline or "needs attention" list (its dates are not deadlines while it is
inactive; core's week view never marks its milestones `thisWeek`, §2.11); where
a count could seem to contradict a grey overdue bar, the page says how many were
left out (§8.4).

### 2.9 Warnings (§6.5, §7.5, §6.11)

Evaluated daily for milestones in active projects:

| condition                                                         | kind               | key                                        |
| ----------------------------------------------------------------- | ------------------ | ------------------------------------------ |
| status overdue                                                    | `overdue`          | `overdue:<targetDate>`                     |
| rubric invalid, not complete, and `0 <= daysLeft <= warnLeadDays` | `invalid_due_soon` | `invalid:<targetDate>:<gaps>`              |
| status at_risk                                                    | `at_risk`          | `at_risk:<targetDate>`                     |
| anything else                                                     | —                  | `ok:<status>` (remembered, never notified) |

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
  `thisWeek` = the project is active (§2.8) and the milestone is overdue or
  `daysLeft <= 6`; `totals.thisWeek` counts issues in those sections and
  `totals.overdue` the overdue milestones of active projects (an inactive
  project's section keeps its real status and sorts as usual, under "Later" on
  the page). A row is `newBecauseLeadOf` when a live allocation assigned it to
  this user within `newBadgeDays` and it is still assigned to them.
- `buildTimelineView` (§7.2): window `today - timelineDaysBack` →
  `today + timelineDaysAhead`. Groups per initiative (initiative priority rank,
  then `sortOrder`; projects in several initiatives appear under the first),
  then "No initiative". Lanes = projects not completed/canceled, ordered by
  project priority rank then `sortOrder`. Bars per dated milestone: `start` =
  previous dated milestone's date (same project), else project `startDate`, else
  window start, never after `end`. Banners, active projects only (an inactive
  project keeps its undated milestones and `unplannedIssueIds` on its lane):
  projects without lead, milestones without date, open issues without milestone
  (per project), blocked projects.

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
  `exchangeCode` and `refreshTokens` take an optional last argument
  `{ now?: () => number }` (epoch ms, default `Date.now`) that `expires_in` is
  counted from; the engine passes its own clock.
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
  `type == "blocks"`). Page with `first: 50` (Linear's documented default; its
  maximum is not documented anywhere we could verify) +
  `pageInfo { hasNextPage endCursor }`; keep the constant in one place. Single
  queries are capped at 10,000 complexity points (connections multiply children
  by `first`), so nested connections only select ids with a small explicit
  `first`.
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
  actions `create`, `update`, `remove` (how archiving is delivered is not
  documented; treat `remove` and an update with `archivedAt` set the same way:
  refetch, which returns null for archived entities). Two non-entity payloads
  exist in the schema: `OAuthAppWebhookPayload` (type `OAuthApp`,
  `oauthClientId`, no `data`) — the app was revoked for the workspace → mark the
  installation revoked; and `OAuthAuthorizationWebhookPayload` (type
  `OAuthAuthorization`, `userId`, `activeTokensForUser`) — a user's
  authorization changed → log only (a dead user token surfaces as a failed
  refresh and the person signs in again).
- Resource types to subscribe: **Issue, Project, Initiative, User** (plus
  OAuthAuthorization if offered). Webhooks configured on the OAuth app cover the
  teams the app was granted at install; private-team data outside that grant is
  invisible to the app by design. There is **no ProjectMilestone and no
  IssueRelation webhook**: milestone and relation changes are picked up by
  refetching on Issue/Project events and by the periodic full resync (default
  every 15 minutes from the worker).
- Respond 200 within 5 s (Linear retries 1 min, 1 h, 6 h, then may disable the
  webhook), so the route only verifies and acks; processing runs in Next's
  `after()`.

## 5. Persistence (packages/store)

`openStore({ databaseUrl?, pgliteDir?, encryptionKey, logger })`: `databaseUrl`
→ `pg.Pool`; otherwise PGlite (`pgliteDir` or in-memory). One SQL dialect
(Postgres) for both. Migrations are an ordered array of SQL strings applied in a
transaction and recorded in `schema_migrations`; `migrate()` takes
`pg_advisory_lock` so two processes never race.

Isolation: everything runs at READ COMMITTED (the lock-then-read patterns and
the `ON CONFLICT` claims depend on seeing the latest commits; under a stricter
server default such as `default_transaction_isolation = 'repeatable read'` they
fail with serialization errors). The pg pool sends
`-c default_transaction_isolation=read\ committed` as a startup option, appended
to the `options` of `DATABASE_URL` (or `PGOPTIONS`), so no query has to run
before a connection's first one. Every transaction also pins the level in
`BEGIN`, and every write runs in a transaction of its own, so a transaction-mode
pooler that drops startup options is still safe; statements outside a
transaction are single-statement reads. A pooler that refuses the option instead
(PgBouncer in its default configuration closes the connection with 08P01
"unsupported startup parameter") makes the handle switch, once and logged at
info, to connections opened with `DATABASE_URL` exactly as given, and retry the
call there (only opening a connection fails that way). A refusal of the URL's
own `options` still fails.

Tables (all keyed by `workspace_id`):

- `installations` — app actor tokens (encrypted), app user id, installer,
  `revoked_at` (set when the app has no working grant any more: Linear sent the
  `OAuthApp` revoked webhook, or the engine's refresh was rejected; a reinstall
  clears it).
- `sessions` — `token_hash` (SHA-256 of the cookie token), user, the user's
  Linear tokens (encrypted), expiry.
- `settings` — `data jsonb` (WorkspaceSettings).
- `milestone_meta` — weight, done_means, updated_by/at. PM edits go through
  `updateMilestoneMetaField(workspaceId, milestoneId, 'weight' | 'doneMeans', value, updatedBy, at)`,
  which inserts the row or updates **only that column** plus
  `updated_by`/`updated_at` (`INSERT … ON CONFLICT DO UPDATE SET <column>, …`)
  and returns the row, so two processes editing the two fields never overwrite
  each other. `upsertMilestoneMeta` (whole row) is for seeding.
- `mirror_entities` — `(workspace_id, kind, id) pk, data jsonb, synced_at`.
- `sync_state` — `version bigint` (bumped on every mirror write), last full sync
  time/status/error, last webhook time.
- `allocation_runs` — mode, trigger, status, summary jsonb; a partial unique
  index on `(workspace_id) where status = 'running'` makes concurrent runs
  impossible. `startRun(…, staleAfterMinutes)` first closes runs still `running`
  that started longer ago than that as `failed`/`stale run` (a crashed process);
  the engine passes `ALLOCATION_RUN_STALE_MINUTES` (30).
- `allocation_entries` — per-issue/per-project log (§6.12 "logged").
- `warning_memory` — `(workspace_id, subject_kind, subject_id) pk`.
- `notifications` — unique `(workspace_id, day, recipient_id)`.
- `job_claims` — unique `(workspace_id, job, day)`, `claimed_at`, `finished_at`
  (migration 3; claims made before it count as finished). A claim is a lease:
  `claimJob(…, now, { leaseMinutes })` inserts the claim, or takes over an
  existing one only while it is unfinished and `claimed_at` is older than the
  lease (one `INSERT … ON CONFLICT DO UPDATE … WHERE` upsert, so of several
  concurrent takeovers exactly one wins; logged at warn). The claim time is the
  claim's identity: `finishJob(…, { claimedAt, at })` sets `finished_at` and
  `releaseJob(…, claimedAt)` deletes the claim only while it is still that
  unfinished claim, so a holder that was taken over never touches the new
  holder's. A finished claim is never taken over. The engine's daily lease is 45
  minutes (§7).
- `audit_log` — PM edits with before/after.

Token encryption: AES-256-GCM, key = 32 bytes from `TOKEN_ENCRYPTION_KEY`
(base64), random 12-byte IV per value, stored as `v1:<iv>:<tag>:<ciphertext>`
(base64url). Session cookie tokens are 32 random bytes (base64url); only their
SHA-256 hash is stored.

Session cleanup: `deleteExpiredSessions(now)` deletes and counts;
`takeExpiredSessions(now, limit)` deletes up to `limit` expired sessions (oldest
expiry first, `FOR UPDATE SKIP LOCKED` so a session mid-refresh is left for the
next call) and returns them with their decrypted tokens, so the caller can
revoke them. A row whose tokens no longer decrypt is deleted, logged and left
out of the result.

Errors: `withSessionLock` / `withInstallationLock` reject with the exported
`StoreNotFoundError` (`kind: 'session' | 'installation'`, `id`) when the row
does not exist, before calling fn. `isStoreNotFoundError(error, kind?)` checks
`instanceof` and falls back to `name === 'StoreNotFoundError'` plus a string
`kind` (another bundled copy of the store).

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
- **getSettings(workspaceId)** (additive): the saved settings over the defaults,
  exactly as `load` reports them, with no sync, no mirror read and no
  installation check (the timezone as saved, even if invalid). The worker reads
  each workspace's timezone with it on every tick.
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
  1. `store.startRun` (null → `EngineInputError('conflict')`); a run still
     `running` `ALLOCATION_RUN_STALE_MINUTES` (30) after it started counts as
     crashed and is closed as `stale run` first.
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
- **runDaily**: `claimJob(daily, day, { leaseMinutes })` unless `force` →
  fullSync → runAllocation(settings.allocationMode, schedule) → runWarnings →
  `finishJob`. If the run throws, `releaseJob` so the next tick can retry. If
  the process dies instead (killed, hard timeout), the claim stays unfinished
  and, once older than `config.dailyLeaseMinutes` (default 45,
  `DEFAULT_DAILY_LEASE_MINUTES`), the next due tick takes the day over and runs
  the whole job again (see "A daily takeover" below). Ticks run a day only until
  its local midnight, so a claim still within its lease at the day's last tick
  is never taken over by the schedule, and that day's job is not repeated. `day`
  is the optional `input.day` (the day the scheduler decided is due), else today
  in the workspace timezone; a given day must be today or yesterday there
  (`EngineInputError('invalid')` otherwise), so a decision made just before
  local midnight claims and warns for that day instead of claiming the next one
  hours early. Warnings run for that day.
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
`name === 'LinearApiError'` fallback across bundle copies), the timing constants
`DEFAULT_DAILY_LEASE_MINUTES` (45) and `ALLOCATION_RUN_STALE_MINUTES` (30) the
worker derives its timeout cap from, and every type in `src/types.ts`.

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
  lock so only one process refreshes; the new expiry is counted on the
  provider's `now` clock), and returns `createLinearGateway({ accessToken })`. A
  revoked installation or an `invalid_grant` refresh →
  `EngineAuthError('not_installed')` (workspace) or
  `EngineAuthError('not_signed_in')` (session), logged at error. Every
  `not_installed` the engine raises, from the provider (sync, webhooks) or from
  its own installation check (allocation, PM edits, settings), uses one of two
  messages naming `APP_NAME` (`NOT_INSTALLED_MESSAGE` in `runtime.ts`; boot
  passes `appName` to the provider): "… is not installed in this Linear
  workspace yet." (no row) and "… lost its access to this Linear workspace …; an
  admin must install it again." (revoked, or a grant Linear rejects). A dead
  installation grant (`invalid_grant`, or an expired token without a refresh
  token) is also recorded with `markInstallationRevoked(workspaceId, now)` once
  the row lock is released, after re-reading the row: a reinstall saved in
  between (different tokens) is left alone. From then on Settings and `/setup`
  see `revokedAt`, `listWorkspaceIds` skips the workspace (the worker stops
  retrying it every tick) and `forApp` fails fast without calling Linear. A
  session or installation row missing at lock time (`StoreNotFoundError`) maps
  to `not_signed_in` / `not_installed`.

Validation done by the engine (never trust the client): dates via
`isValidIsoDate`; lead must be an active, non-app mirrored user or null; weight
an integer in [-1000, 1000] or null; done-means trimmed, single line, ≤ 280
chars, empty → null; settings: at least one PM (no lockout), valid IANA
timezone, tuning integers within sane ranges (1–90 days), known modes; user ids
must exist in the mirror.

Engine decisions made while building it (binding for callers):

- **No credentials leave the engine.** `Actor.session`, `SignInResult.session`,
  `getInstallation()` and `finishInstall()` carry tokens with `accessToken: ''`
  and `refreshToken: null` (expiry and scopes kept), so a page can never
  serialize a Linear token. The real provider's `forSession` therefore reads the
  session's tokens from its row under `withSessionLock`.
- **Digests are claim-first**: in live mode with a delivering channel each
  digest is inserted as `pending`, sent, then `updateNotificationStatus` records
  the outcome (at most one digest per person per day, even across a crash). A
  notice that one of its recipients did not get today keeps its old warning
  memory, so it is announced the next day instead of being lost: the person
  already had a digest today that did not carry it, the send `failed` (Slack
  down, bad token), warnings are live with no channel configured, or the notice
  had no recipient at all (no active lead, no watchers). A per-person
  `undeliverable` (no Slack account) does not hold the notice, or everyone else
  would get it again every day. When a recipient already has today's row (a
  second run the same day, such as a daily takeover), the notices its stored
  digest carried with the same key count as told if it went out (`sent`, or
  `preview` while warnings are in preview); a `pending` row (the send's outcome
  is unknown, so it is never repeated), a `failed` one, or a preview row after
  going live told nothing.
- **Going live forgets the warning memory**: `updateSettings` switching
  `warningsMode` from `preview` to `live` resets every memory row to "never
  told", so the first live run announces whatever is notable now (preview runs
  remembered notices nobody received). Today's preview rows still count as
  today's digest, so that announcement goes out the next day.
- People the mirror shows as deactivated in Linear (or app users) are signed out
  by `authenticate` (session deleted), as sign-in refuses them too.
- PM edits and `updateSettings` require an active installation (`not_installed`
  otherwise). Weight and "done means…" edits write only their own column
  (`updateMilestoneMetaField`), so edits of the two fields of one milestone from
  different web instances both stick. They still run one at a time per milestone
  within a process, so each audit entry's `before` is the value the previous
  edit left (across instances `before` is best effort).
- **A dead installation grant is recorded as `revokedAt`**, not as a separate
  auth-error field: every consumer already reads `revokedAt` as "reinstall
  needed" (`listWorkspaceIds`, `requireInstallation`, sign-in's `needsInstall`,
  `finishInstall`'s lockout rule) and a reinstall clears it, so no migration or
  second flag is needed. `revokedAt` therefore means "the app has no working
  Linear grant", whether Linear revoked it or a refresh was rejected; the
  rejection is in the error logs.
- `handleWebhook` treats a blank `deliveryId` as none (no dedupe), and the
  public `runAllocation` always syncs first (only `runDaily` reuses its sync).
- `runDaily` syncs once: its allocation run reuses that sync.
- **A daily takeover re-runs the whole job**, which is safe wherever the dead
  run stopped. Killed mid-sync: nothing was written. Killed during a live
  allocation: the takeover's fresh sync shows the issues the dead run assigned
  as assigned, so they are skipped `already_assigned` (never re-assigned or
  re-commented); a comment the dead run had not posted yet stays missing, and an
  assignment it made just before dying is logged only as that skip. The dead run
  stays `running` until `startRun` closes it as `stale run`
  (`ALLOCATION_RUN_STALE_MINUTES`, 30 minutes after it started), and the lease
  is sized so a takeover never finds it in the way: the worker caps
  `TICK_TIMEOUT_MINUTES` at lease − stale − 1 = 14, so a dead tick started its
  allocation run at most 14 minutes after its claim, and that run is stale by
  claim + 44, before the claim can be taken over (claim + 45). A daily run that
  does find an allocation run in progress (a manual `allocate` or a PM's run
  from the web app, still going or killed, that started less than
  `ALLOCATION_RUN_STALE_MINUTES` ago) fails with `conflict`, gives the day back,
  and a later tick runs the job. Killed during warnings: memory was not saved
  yet, so every notice is planned again; nobody is sent a second digest that day
  (a recipient with a row today counts as `alreadySent`, including a `pending`
  row, whose send may have reached Slack). What the dead run's delivered digests
  carried counts as told; the notices of the recipient whose send was in flight
  keep their old memory and are offered again the next day. A run that outlives
  its lease and completes anyway finds its claim gone: `finishJob` returns false
  and it logs a warning. The lease must be longer than any daily run can live
  plus `ALLOCATION_RUN_STALE_MINUTES`; hence the worker's cap above, which
  applies to the manual `daily`, `allocate`, `warn` and `sync` commands too
  (§9), so a manual run is never taken over while it is still working either.
- A live run in which every assignment failed is `failed`; a comment that fails
  after a successful assignment leaves the entry `applied` with an error and the
  run `partial`. Stale reasons: `not_found`, `closed`, `now_assigned`,
  `moved_milestone`, `now_triage`.
- `finishInstall` saves only the installer as PM; the first full sync (mirror
  version 0) merges `PM_EMAILS`/`WATCHER_EMAILS` in. Reinstalling over an active
  installation needs a PM, unless no configured PM is still an active person in
  the mirror (lockout recovery: only a Linear admin can grant `actor=app`, and
  the reinstaller becomes a PM).
- `authenticate` drops a session whose refresh hits `invalid_grant`; a transient
  refresh failure keeps the person signed in.
- Webhook processing errors resolve as `'processed'` with the error recorded on
  the delivery. Removals of entities the mirror never had write nothing.
- Additive API: `EngineDeps.fetch` (OAuth calls), `Engine.close()`,
  `createEngineFromEnv(env, { logger, now, fetch, channel })`. Demo mode never
  uses `DATABASE_URL` or Slack.
- `cleanup()` resolves with `CleanupResult`
  `{ expiredSessions, revokedTokens, revokeFailures, oldDeliveries }` (also
  logged as `cleanup finished`). Real mode takes expired sessions with
  `takeExpiredSessions` in batches of 50 (at most 500 per run; the rest wait for
  the next tick) and revokes each one's Linear grant (refresh token, else access
  token), because Linear may auto-revoke a user's oldest tokens past about 10
  per app. Revocation is best effort: a failure is logged at warn and counted,
  never fails cleanup. Demo mode only deletes (`deleteExpiredSessions`). Webhook
  delivery records older than 30 days (`WEBHOOK_RETENTION_DAYS`) are pruned:
  dedupe needs only Linear's ~6 h retry window, the rest keeps each delivery's
  processing error around to investigate.

## 8. Web app (apps/planner)

Two references, one rule: **layout and interaction from Gr8r Studio
(github.com/gr8rstudio/gr8r-studio), visual language from the Analytics
`competitors-site` (wsoule/Analytics).** Gr8r decides where things go and how
they behave (sidebar shell, topbar, command palette, grouped task lists, Gantt
timeline, slide-over drawer, projects register, phone tab bar). Analytics
decides how everything looks (paper/ink/one purple accent, hairlines, mono
labels, hatched chrome, zero radius, no shadows). Gr8r's rounded cards, shadows,
indigo accent and semantic hues are **not** used. Gr8r is a reference only;
nothing is imported from it.

### 8.1 Routes

| route                           | who                        | what                                                                                                           |
| ------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `/`                             | all                        | signed out: "Sign in with Linear" (fixture mode: demo user picker); signed in → `/week`                        |
| `/week`                         | signed in                  | My week (the landing screen); PMs may pass `?user=<id>`                                                        |
| `/timeline`                     | signed in                  | Gantt timeline; `?milestone=<id>` opens the drawer, `?project=<id>` focuses a lane; edit controls only for PMs |
| `/projects`                     | signed in                  | projects register: next milestone, status, progress, lead, allocation state                                    |
| `/graph`                        | signed in                  | dependency graph; default milestone level; `?milestone=<id>` or `?project=<id>` for issue level                |
| `/runs`, `/runs/[id]`           | signed in                  | allocation run log; PMs get "Preview (dry run)" and "Run now"                                                  |
| `/settings`                     | PMs (read-only for others) | modes, people, schedule, status, digest preview, notifications, audit                                          |
| `/setup`                        | signed in                  | install the app into the workspace (admin)                                                                     |
| `GET /api/palette`              | signed in                  | command-palette index (pages, projects, milestones, the user's open issues), fetched when the palette opens    |
| `GET /api/auth/linear?intent=`  | —                          | starts OAuth (sets `mp_oauth` cookie)                                                                          |
| `GET /api/auth/linear/callback` | —                          | finishes OAuth                                                                                                 |
| `POST /api/auth/logout`         | —                          | ends session                                                                                                   |
| `POST /api/auth/demo`           | fixture mode only          | demo sign-in                                                                                                   |
| `POST /api/webhooks/linear`     | Linear                     | verify, ack 200, process in `after()`                                                                          |
| `PATCH /api/milestones/[id]`    | PM                         | `{ targetDate?, weight?, doneMeans? }`                                                                         |
| `PATCH /api/projects/[id]`      | PM                         | `{ leadId }`                                                                                                   |
| `POST /api/runs`                | PM                         | `{ mode: 'dry_run' \| 'live' }`                                                                                |
| `POST /api/sync`                | PM                         | full resync                                                                                                    |
| `POST /api/warnings/preview`    | PM                         | digests without sending                                                                                        |
| `PATCH /api/settings`           | PM                         | settings patch                                                                                                 |
| `GET /api/health`               | —                          | `{ ok, db }` for Railway healthchecks                                                                          |

Security: session cookie `mp_session` (httpOnly, `SameSite=Lax`, `Secure` when
`APP_URL` is https, `Path=/`); OAuth cookie `mp_oauth` carries
`{state, codeVerifier, intent, returnTo}` signed with HMAC-SHA256
(`SESSION_SECRET`), 10-minute expiry, compared in constant time. Mutating routes
require same-origin `Origin` (or `Sec-Fetch-Site: same-origin`) and JSON bodies
validated with zod. `returnTo` must be a relative path. Every page/route
resolves the actor server-side; the UI never decides permissions.

Auth and frame details (decided while building `apps/planner`; binding):

- `mp_oauth` is scoped to `Path=/api/auth`. `returnTo` must start with exactly
  one `/` (never `//` or `/\`), contain no control characters or spaces
  (browsers strip them, turning `/\t/x` into `//x`) and resolve to the same
  origin; anything else becomes `/week`. Non-ASCII characters are
  percent-encoded (UTF-8), because the callback's `Location` header must be a
  byte string. It is checked when signing the cookie and again after verifying
  it.
- Every callback outcome clears `mp_oauth`. Failures land on
  `/?auth_error=<code>`: the engine's `EngineAuthError`/`EngineInputError`
  codes, `linear_<kind>`, `oauth_expired` (missing, tampered or expired cookie),
  `oauth_state`, `oauth_code`, `access_denied`, `sign_in_first`
  (install/grant_write without a session), `session_secret`, `invalid_request`
  or `internal` (logged). The demo sign-in reports the engine's `invalid` (a
  deactivated person or the app user) as `demo_inactive`. A signed-in visitor
  sees the error on `/` instead of being sent to `/week`. A sign-in that
  replaces a session ends the old one in `after()`.
- `SESSION_SECRET` (≥ 32 chars) is required in real mode; without it the OAuth
  routes log the misconfiguration and redirect with `session_secret`. Demo mode
  uses a per-process random secret.
- `POST /api/webhooks/linear` reads at most 5 MiB of raw body (413), answers a
  bare 400 for a bad signature, a stale timestamp or a malformed payload, 503
  while `LINEAR_WEBHOOK_SECRET` is unset, and 200 (dropped) for verified event
  types the engine does not use, so Linear never disables the webhook over them.
- `GET /api/health` has no engine ping to call: it boots the engine (store
  opened and migrated) and reads `listWorkspaceIds()`; failure is 503
  `{ ok: false, db: 'error' }`.
- `GET /api/palette` returns `{ projects, milestones, issues }`, each entry
  `{ id, label, hint, href, external, status?, statusLabel?, muted? }`; issues
  are the person's open My week issues and open in Linear in a new tab. An
  inactive project's entries (§2.8) are `muted` (grey mark, label ending "·
  inactive project"); a complete milestone's hint reads "complete · Oct 1", not
  "due Oct 1".
- Unmatched page URLs render `(app)/not-found.tsx` inside the frame (a
  `[...missing]` catch-all, since the two root layouts leave Next without a
  single root 404); like every `(app)` page it streams under
  `(app)/loading.tsx`, so `redirect()`/`notFound()` there are client-side (meta
  refresh / `noindex`, status 200). Unmatched `/api/*` paths answer a JSON 404.
- `app/global-error.tsx` is the styled last resort when a root layout throws
  (the engine cannot start or read the session: database unreachable,
  configuration incomplete), which `(app)/error.tsx` does not wrap: the
  signed-out bar, the error digest and a retry. `/setup` offers no reinstall in
  demo mode (there is no OAuth there).
- Engine errors are recognised by `name` + `code` as well as by class
  (`lib/engine-errors.ts`): the process-wide engine cached on `globalThis` may
  come from another route bundle's copy of the package, where `instanceof`
  fails.

Run log, sync and settings routes (decided while building `apps/planner`;
binding):

- `POST /api/runs`, `POST /api/sync`, `POST /api/warnings/preview` and
  `PATCH /api/settings` share one order (`lib/pm-routes.ts`): CSRF guard and
  session (`requireApiActor`) → strict zod body (unknown keys, a bad `mode`, a
  tuning value outside 1–90 or not whole, an empty patch or an empty `tuning`
  object: 400 before the engine, so a no-op never writes an audit entry; sync
  and preview take `{}`) → `actor.isPm` (else 403 `not_pm`; the engine's
  `fullSync` and `runWarnings` have no actor, so this check is the only one for
  those two) → the engine, errors mapped by `errorResponse`.
- **A live run is gated by the saved mode**: `POST /api/runs { mode: 'live' }`
  answers 409 `live_runs_off` while `settings.allocationMode` is `dry_run`
  (§7.4: dry run until a PM switches it live in Settings → Modes). Only the web
  route is gated; the worker's `allocate --live` is an operator command.
  Answers: `/api/runs` 201 `{ run }` (the finished run; the run takes as long as
  its sync), `/api/sync` 200 `{ sync }` (a `SyncResult`, `ok: false` carries the
  error), `/api/warnings/preview` 200 `{ preview }` (the digests mapped for
  display with app-relative `/timeline?…` links; nothing recorded or sent),
  `/api/settings` 200 `{ settings }`. A partial `tuning` is passed through; the
  engine merges it over the saved tuning.
- `/settings?section=modes|people|schedule|status|notifications|audit` (default
  Modes) shows one section beside the sub-nav; each section's form PATCHes only
  its own fields. People lists active non-app people plus deactivated people
  still on a list; the last active PM's box is locked on. Slack status is not
  shown: the engine exposes no "Slack configured" flag.
- A settings save moves keyboard focus to the form's status line (a
  `tabIndex=-1` live region beside Save and Reset) before Save and the fields
  disable, and the line then says "Saved" or "Not saved: <why>"; Reset focuses
  it too and it says "Changes discarded" (never a previous save's "Saved"), so
  focus never falls to `<body>`. The engine's timezone refusal (code `invalid`,
  "timezone must be…") is shown capitalised under the timezone field
  (`aria-invalid`, `aria-describedby`) with focus moved there, not toasted;
  other refusals stay toasts. A submit stopped by the form's own checks focuses
  the first field marked. Status's Resync and Preview do the same with their own
  status line, and a finished preview focuses its heading (it is not a live
  region, which would read every digest aloud).
- The digest preview's "Allocation stopped" rows name the project (the subject)
  and, under Due, the next milestone's date with "Next milestone: <name>";
  "Whole project" only when there is no next milestone.
- `/graph` with no edges in scope shows the empty state rather than a field of
  unconnected boxes. Otherwise only nodes on at least one edge are drawn (and
  any id the adapter is asked to keep); the rest are listed under the canvas as
  "N milestones (issues) have no blocking relations", a small register (mark,
  name, project or assignee, due) collapsed behind "Show N" when longer than six
  (again at each scope: moving between levels does not carry it open). Milestone
  rows open `/timeline?milestone=<id>`, issue rows the issue in Linear (a
  scope's issues would all open the same drawer). The receipts and the block
  meta count drawn vs listed ("4 of 14 milestones"), and Copy Mermaid copies the
  drawn graph. Milestone nodes take the accent only when at risk or overdue (a
  later milestone's unassigned issues are normal; they keep the `UNASSIGNED`
  chip); issue nodes when open and unassigned or overdue.
- `/runs/[id]` answers the not-found page for an unknown id; already-assigned
  skips are collapsed into one count per project.
- The run and settings registers stack into cards by their own width
  (`stackWithin`), not the viewport's: inside the 252px sidebar a 1024px window
  leaves the settings content about 440px wide (700px at 1280). Run cards flow
  their eight cells into as many ~120px columns as fit (two rows at 1024 and
  1280, three on a phone). The Notifications register leads with the recipient
  (channel under the name) in five columns, so it stays a table at 700px; the
  Audit "When" column is fixed at 152px so the time fits one line.

### 8.2 Visual language (Analytics `competitors-site` + `DESIGN.md`)

The one deliberate departure from Analytics is the accent: purple `#9747ff`
(pressed `#7f36f0`) instead of its orange, at the owner's request. Like the
orange it is one value in both themes: 4.51:1 against white paper and for white
text on a purple fill, 4.25:1 against the dark paper.

Tokens (`--paper`, `--ink`, `--background`, `--foreground`, `--border`,
`--muted`, `--accent #9747ff`, `--accent-hover #7f36f0`, `--on-accent`,
`--ink-soft`, `--grey-2..4`, `--hairline-faint`, `--hatch`, `--tint`, the
`*-inverse` set), light + dark via `html[data-theme]` with the pre-paint theme
script, Geist + JetBrains Mono via `next/font/google`, body weight 300, zero
radius, no shadows (overlays separate with a 1px ink border and a scrim derived
from `--ink`, never blur), 1px hairlines collapsed with `-1px` margins, 2px only
for emphasis, the hatched chrome titlebar (`.block` / `.blockBar` …), accent
registration marks on the chrome, the grid tab strip (selected = ink fill, hover
= accent flood), register rows whose hover swaps paper and ink tokens locally,
the `Mark` square idiom, the 2px-accent explain panel, mono uppercase
micro-labels with positive tracking, `:focus-visible` accent outline, hover
floods gated behind `@media (hover: hover) and (min-width: 901px)`, and a
designed `prefers-reduced-motion` state. Motion uses the Analytics curves
(`--ease-out-quint` for drawers, `--ease-out-expo` for growth).

Status uses only the system's own marks (no new hues — DESIGN.md §3):

| status                               | mark                         |
| ------------------------------------ | ---------------------------- |
| complete                             | filled ink square            |
| on_track                             | hollow ink square            |
| at_risk                              | hollow accent square (2px)   |
| overdue                              | filled accent square         |
| unscheduled / empty / rubric-invalid | hatched square, muted border |

Where Gr8r uses a coloured status dot, priority bars, or a red/green number, the
planner uses these marks, mono labels, and the accent only for "needs action"
(overdue, unassigned, blocked, missing input).

### 8.3 Layout and interaction (from Gr8r Studio)

- **Shell** (`app/components/shell/*`): a fixed left **sidebar** (252px) that is
  the chrome zone — hatched background, 1px right hairline, accent registration
  marks at its outer corners — containing: brand row (`MILESTONE PLANNER` mono +
  workspace name + collapse button), primary nav (My week with a count of
  this-week issues, Timeline, Projects, Graph, Runs), a `PROJECTS` section
  listing active projects with the status mark of each project's next milestone
  (click → `/timeline?project=<id>`), and a footer with Settings, the signed-in
  user (PM chip), theme toggle and sign out. Active nav item = ink fill; hover =
  accent flood. A 46px **topbar** (paper, bottom hairline): mono breadcrumb on
  the left (`TIMELINE › ATLAS MIGRATION`), and on the right the "Search or jump
  to… CTRL K" palette trigger. `[` collapses the sidebar to an icon rail (choice
  remembered in localStorage).
- **Phone (≤ 900px)**: sidebar becomes an off-canvas drawer opened from a topbar
  menu button; a fixed bottom **tab bar** (My week / Timeline / Projects / Graph
  / More) like Gr8r's phone layout; pages become single column.
- **Command palette** (Ctrl/⌘ K, or the topbar trigger): centered 640px panel,
  1px ink border, 2px accent top rule, scrim from `--ink`; sections
  _Suggestions_ (PM: "Preview allocation (dry run)", "Resync from Linear";
  everyone: "Switch theme"), _Jump to_ (projects, milestones, the user's open
  issues by identifier — fetched from `/api/palette` on first open), and
  _Navigation_ with two-key shortcuts (G W My week, G T Timeline, G P Projects,
  G G Graph, G R Runs, G S Settings). ↑/↓ move, ↵ selects, Tab cycles sections,
  Esc closes; fuzzy match on label + identifier. `?` opens a shortcuts sheet.
- **Toasts**: bottom-right stack, 1px ink border (2px accent for errors), mono
  label + one sentence, auto-dismiss after 4 s, `aria-live="polite"`; used after
  saves, runs and copies.
- **Loading**: `loading.tsx` per route renders hatched skeleton rows in the
  page's real layout (Gr8r skeletons), not spinners.
- **Slide-over drawer** (milestone details): opens from the right over the
  content (no scrim on desktop, scrim on phone), 2px accent left rule, header
  with `PROJECT / MILESTONE` breadcrumb and actions (open in Linear, copy link,
  close), an alert strip when overdue ("Overdue by 3 days. Reschedule" focusing
  the date field), then a Gr8r-style property list (label column + value
  column): Status, Due date, Lead, Progress, Weight, Next milestone, Done
  means…; then the rubric checklist, risk reasons, issues, and "Waits on".
  Linkable via `?milestone=<id>`; Esc closes; focus is trapped while open and
  returned on close.

### 8.4 Pages

- **My week** (Gr8r Home + My Tasks, one screen as §2 Goal 1 asks): header "Good
  morning, Pat" (sans 26px/700) + a receipts line ("Wednesday, October 21 · 4
  issues due this week · 1 milestone overdue"); a four-cell stats strip (Open
  issues · this week, Overdue milestones, New to you, At risk in your projects)
  in the stat-card idiom; then two columns. Main column: the list in Gr8r's
  grouped-table form — column headers (Issue / State / Priority / Due; no
  Project column, because every group heading names the project and beside the
  deadlines panel a fifth column left titles unreadably narrow), collapsible
  group rows per milestone (`PROJECT › MILESTONE`, due + days left,
  `completed/scope` with a 1px progress rule, status mark), "THIS WEEK" (always
  shown once anything is open) and "LATER" dividers, rows with identifier
  (mono), title, state, priority label, and the accent chip "NEW — GIVEN TO YOU
  BECAUSE YOU LEAD <PROJECT>" (an empty THIS WEEK says "Nothing of yours is due
  this week."); a final "No milestone" divider with one group per project
  (`PROJECT › Issues without a milestone`, linking to `/timeline?project=`; a
  completed or canceled project has no lane, so its group is not a link), then
  "Issues without a project or milestone". "At risk in your projects" counts the
  milestones of active projects the person leads whose status is at risk or
  overdue (§2.5) — a blocked project whose next milestone is on track is not at
  risk; it appears under "Needs attention" with its reason. Inactive projects
  (§2.8) are never loud here: the person's issues in them stay in the list,
  under "LATER", their group drawn quietly (grey mark named "<status> · inactive
  project", "Inactive project" for the days left, no accent), but THIS WEEK, the
  this-week counts (receipts, the Open issues note, the sidebar's My week
  count), "Overdue milestones", "At risk in your projects", the deadlines and
  "Needs attention" leave them out; the two stats add "+1 in an inactive
  project" and the empty "Needs attention" names the inactive project it left
  out. The two columns sit side by side only while the content area (not the
  viewport) is at least 1040px wide; below that the deadlines and attention
  panels stack under the list. Right column (Gr8r "Upcoming deadlines"):
  milestones the user leads or has issues in, grouped Overdue / Today / Tomorrow
  / This week (up to 6 days out); and "Needs attention" for projects the user
  leads that are blocked (reason) or have unassigned next-milestone issues. PMs
  get a person picker (`?user=<id>`, honoured on the server for PMs only and
  only for people in the mirror).
- **Timeline** (Gr8r Timeline in the Matrix drawing style): banners first (no
  lead / no date / unplanned / blocked, each a count that expands to a list), as
  one compact block: a 1px hairline frame with a single 2px accent rule on its
  left, one ~40px row per banner on 1px rules (mono key and count, one sentence,
  a quiet Show / Hide), banners at zero left out. A toolbar: project search,
  zoom **Weeks / Months** (segmented tab strip), **Today** (scrolls to today),
  filters (initiative; **Show All / Active / At risk** as one segmented control,
  since at risk only ever keeps active lanes), **Dependencies** toggle. It is
  one row from a 1366px window with the sidebar open (the search gives up width,
  220 → 100px, before anything wraps, and the initiative select is capped at
  200px with an ellipsis so a long initiative name cannot push it over the zoom
  control); narrower, the Show control wraps under it. The receipts line counts
  overdue and at-risk milestones in active projects only and says how many
  projects are inactive ("9 projects (1 inactive) · …"). The chart: a sticky
  left column of lanes grouped by initiative (lane = project name, lead or
  `NO LEAD` in accent), a two-row sticky header (month names; day/week ticks in
  mono 9.5px; weekends shaded with `--tint`), today as a 1px accent vertical
  rule, a "Milestones" summary row with a diamond (45°-rotated square mark) at
  each due date like Gr8r, bars per milestone (start → due date) with a diamond
  at the end, styled by status (overdue accent fill; at risk 2px accent border;
  on track ink border; complete ink fill; rubric-invalid hatched with "MISSING:
  …"), a `NEXT` tag on each lane's next milestone, `↑2` for a weight override.
  With Dependencies on, milestone-level edges are drawn as 1px curved connectors
  between bars (accent when on a risk chain), like Gr8r's dependency arrows. PMs
  drag a bar's right edge to re-date (snaps to days, date tooltip, Esc cancels,
  PATCH on drop, optimistic with rollback + toast); keyboard: focus the handle,
  ←/→ ±1 day, ↵ commit. Clicking a bar opens the slide-over drawer. Below 900px:
  per-project cards. Built while wiring it (binding):
  - The toolbar state is mirrored to the URL in place (`?q=`, `?initiative=`,
    `?active=1`, `?risk=1`, `?zoom=months`, `?deps=1`; Dependencies start off,
    Weeks is the default zoom), and every link the page builds (lane names,
    banner rows, "waits on") keeps it. Show: Active is `?active=1`, At risk is
    `?risk=1` (both set reads as At risk); At risk keeps active projects with an
    at-risk or overdue dated milestone. The toolbar follows the address bar when
    it changes under it (back/forward, the sidebar's plain `/timeline` or a
    project link while filtered), as the projects register does: it reads
    `useSearchParams`, skips the query strings it wrote itself, and keeps a
    half-typed search when a URL means the state already shown.
  - Re-dating and the lead are Linear writes: handles and those drawer fields
    only for PMs with Linear write access (a read-only PM sees a one-line notice
    linking `/api/auth/linear?intent=grant_write&returnTo=/timeline`). Weight
    and "done means…" need only `isPm`. Complete milestones have no drag handle.
    Every open milestone failing the rubric carries its "Missing: …" line,
    overdue and at-risk ones included (their marks stay).
  - The drawer opens on click with a skeleton and fills when the server answers
    `?milestone=`; an id the mirror lacks closes it and shows a "Not found"
    notice. A lane focused by `?project=` is scrolled into the page too (chart
    and phone card).
  - The drawer's "Next milestone" cell says what that means for allocation: on
    the project's next milestone, "Allocation stopped · <reason>" in the accent
    when the project is blocked (or a quiet "Inactive project" note); on any
    other milestone, which one is next. A deactivated lead is loud in the Lead
    cell and named as deactivated in the met "Project lead" check.
  - An inactive (muted) lane is never loud anywhere: its bars, its phone card
    rows (grey hollow marks) and the "Milestones" summary diamonds (a day with
    only inactive milestones is drawn in greys; a shared day takes the active
    lanes' status); it is in no banner, receipt count or At risk filter. Its
    milestones' drawer is quiet too: no overdue strip, a grey status mark named
    "<status> · inactive project", and no accent on the risk lines, due date,
    progress or the issues' "Unassigned" / "Blocked by".
  - A complete milestone is never overdue: wherever its date is printed with a
    countdown (`dueLabel` in `lib/format.ts`: the drawer, the register, the
    graph's details and rows) it reads "Oct 1 · complete", never "Oct 1 · 20
    days overdue".
  - A phone card row whose mark is hatched (missing input) and that carries its
    "Missing: …" line leaves the status label out of its receipts, so an empty
    milestone reads "0/0 · Missing: issues", not "No issues yet · 0/0 · Missing:
    issues".
  - `PATCH /api/milestones/[id]` needs at least one of `targetDate`
    (`YYYY-MM-DD` or null), `weight` (integer or null), `doneMeans` (string or
    null), no other keys; it applies the date first, then weight, then "done
    means…", stopping at the first engine error. Malformed bodies are 400s
    before the engine is called.
- **Projects** (Gr8r Projects page, register form): one row per non-completed
  project grouped by initiative: name + initiative, Linear status (mono chip),
  next milestone (name, due, status mark), next-milestone progress bar
  (`completed/scope`), lead or `NO LEAD`, allocation state chip (`ALLOCATING n`
  / `BLOCKED` filled accent with the reason as a mono line under it, worded as
  on the timeline's Blocked banner and My week's "Needs attention": "Project has
  no lead", "Next milestone is missing: done means…" / `NOTHING TO DO` /
  `NO OPEN MILESTONE` / `INACTIVE`), links to its timeline lane (the row), graph
  and Linear. An inactive project's next milestone is drawn in greys (grey mark,
  muted date, ink progress). Search + status filter (All / Blocked / At risk =
  an active project's next milestone at risk or overdue / Inactive) in a
  toolbar, mirrored to `?q=` and `?filter=` so a filtered register can be
  linked; the register also follows the URL when it changes under it
  (back/forward, a link to `/projects` while filtered).
- **Graph**: level tabs (Milestones / Issues in <scope>); SVG laid out with
  `@dagrejs/dagre` (rankdir LR) on the server, hairline boxes with mono labels;
  risk chains in accent, cycles dashed accent, cross-project edges dashed ink,
  resolved edges faint; legend; hover/focus highlights the upstream chain; click
  a node → slide-over details; "Copy Mermaid" copies `toMermaid` output. Nodes
  with no blocking relation are listed under the canvas, not drawn (§8.1).
- **Runs**: register of runs (mode chip DRY RUN / LIVE, trigger, counts); detail
  lists assigned / would assign / failed / stale / skipped / blocked grouped by
  project with reasons.
- **Settings** (Gr8r settings layout): a left sub-nav of sections (Modes,
  People, Schedule, Status, Notifications, Audit) beside the section content;
  rows per setting; mode switches use the Matrix switch idiom (13px square glyph
  that fills accent).

Fixture mode shows a permanent accent-bordered "DEMO DATA — NOT CONNECTED TO
LINEAR" strip at the top of the content column.

## 9. Worker (apps/worker)

`node apps/worker/dist/index.js <command>`:

- `migrate`
- `sync [--workspace <id>]` — full resync of one/all installed workspaces
- `daily [--workspace <id>] [--force]` — the scheduled job
- `allocate --dry-run|--live [--workspace <id>]`
- `warn [--workspace <id>]`
- `tick` — **what the Railway cron runs every 15 minutes** (`*/15 * * * *`,
  UTC): for each installed workspace, if the local time in its timezone is at or
  past `DAILY_RUN_AT` (default `08:00`) and today's daily job is unclaimed (or
  its claim was abandoned by a run that died, past the engine's lease),
  `runDaily` (which syncs first); otherwise a plain `fullSync` (the periodic
  resync that heals milestone/relation drift, since Linear has no webhooks for
  those). Then `cleanup`. Closes the store and exits. A hard timeout
  (`TICK_TIMEOUT_MINUTES`, default 10) exits non-zero so a hung run never blocks
  later ones (Railway skips a cron tick while the previous one runs).
- `serve` — long-running alternative to cron for other hosts: runs `tick` every
  `SYNC_INTERVAL_MINUTES` (default 15) until SIGTERM.

Exit code is non-zero when any workspace failed, so cron failures are loud.
Every command runs migrations first (advisory-locked, idempotent).

Worker decisions made while building it (binding):

- **Due rule** (`decideDailyRun(now, timezone, dailyAt)` in
  `apps/worker/src/schedule.ts`, pure): the daily run for local date D is due
  from the first instant of D at which the wall clock shows `DAILY_RUN_AT` or
  later, until local midnight. On a fall-back day a repeated time counts from
  its first occurrence and stays due through the repeated hour; a time inside a
  spring-forward gap is due from the transition. The timezone is the saved
  setting (read with `getSettings`, which never syncs), or `DEFAULT_TIMEZONE`
  when that is invalid (as the engine does). The tick passes the local date it
  decided on as `runDaily`'s `day`, so a run that starts after local midnight
  still runs the day that was due. "Unclaimed" is decided by `runDaily`'s own
  claim: a due tick whose `runDaily` returns `ran: false` falls back to
  `fullSync`.
- `DAILY_RUN_AT` is strict `HH:MM` (00:00–23:59); invalid worker variables exit
  1 before boot. A time later than one tick interval before midnight is logged
  as a warning (no tick may land before midnight).
- **Exit codes**: `0` ok (including "no installed workspaces"); `1` when a
  workspace failed (its job threw, or an allocation run ended `failed` or
  `partial`), a workspace-independent step failed (listing workspaces,
  `cleanup`), boot failed, or the hard timeout fired; `2` usage error (unknown
  command/option, missing `--dry-run|--live`, an option that does not apply).
  Undelivered digests do not fail a run (they include people with no Slack
  account); they are counted in the summary.
- `tick`'s hard timeout is **one** budget counted from the start: boot, the tick
  and closing the store together, so the process always ends within
  `TICK_TIMEOUT_MINUTES`. The manual one-shot commands (`sync`, `daily`,
  `allocate`, `warn`) get the same budget; on expiry each logs and prints the
  stage it was stuck in (`booting`, `running <command>`, `closing the store`)
  and exits 1. `TICK_TIMEOUT_MINUTES` is at most 14 (`MAX_TICK_TIMEOUT_MINUTES`,
  derived from the engine's constants: the 45-minute daily lease minus the
  30-minute stale-run threshold, minus a minute), so a run always ends, and its
  allocation run is stale, before a tick may take its daily claim over; that
  also keeps a tick below the 15-minute cron interval. `migrate` has no timeout:
  it claims no daily job and starts no allocation run, and it is how an operator
  applies a migration too long for one budget (every other command applies
  pending migrations inside its own). `serve` gives its boot, each tick and its
  shutdown one budget each; SIGTERM/SIGINT let the current tick finish, then the
  store is closed and `serve` exits 0; a second signal, including one during
  that close, exits 1 at once.
- The CLI runs only when its module is the process's main script, resolved the
  way node resolves it (`node apps/worker tick` and `node apps/worker/dist tick`
  work too), so it can never load and silently do nothing.
- Manual `allocate` runs use trigger `manual` and no actor. Each command prints
  one human summary line on stdout besides the JSON logs.
- Demo mode logs a warning that `DATABASE_URL` is ignored and, without
  `PGLITE_DIR`, that nothing (the daily claim included) survives the process.

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
| `DAILY_RUN_AT`                              | worker          | `HH:MM` in each workspace's timezone (default `08:00`)            |
| `TICK_TIMEOUT_MINUTES`                      | worker          | hard limit per run (not `migrate`), minutes (default 10, ≤ 14)    |
| `SYNC_INTERVAL_MINUTES`                     | worker serve    | minutes between ticks (default 15)                                |
| `PGLITE_DIR`                                | all             | PGlite directory when `DATABASE_URL` is unset (local dev only)    |
| `SESSION_DAYS`                              | engine          | session lifetime in days (default 30)                             |
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
  With `TEST_DATABASE_URL` the same suite also runs on real Postgres, including
  sessions forced to REPEATABLE READ (as behind a pooler that dropped the
  startup option), writes racing an uncommitted writer, and a subprocess that
  must print no `DeprecationWarning`. `TEST_PGBOUNCER_URL` (a transaction-mode
  PgBouncer with its default configuration) runs the store behind a pooler that
  refuses the startup option.
- notify: rendering limits and Slack error mapping with a fake fetch.
- engine: end-to-end with the fixture gateway + PGlite + a recording channel:
  dry vs live allocation, idempotent rerun, stale re-check, warning dedupe
  across days, overdue repeat, PM permission errors.
- planner: unit tests for cookie signing/origin checks; Playwright smoke in
  fixture mode (screens render, drag updates a date).

## 12. Verified external facts

See `docs/research.md` (generated from the research pass with sources).
