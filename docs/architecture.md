# Milestone Planner — architecture

This is the build spec for the tool described in
`docs/design/2026-10-21-milestone-planner-design.md` (the "design doc"; section
numbers like §6.5 refer to it). Linear stays the source of truth. This tool does
the **allocation** and the **noticing**, and gives every signed-in person two
screens: _My week_ and the editable _timeline_.

Working product name: **Milestone Planner** (configurable via `APP_NAME`; the
repo and package scope are `better-tracker`).

**Owner decision 2026-10-21** (design doc §12): every signed-in person can edit
an issue from the planner (title, description, state, assignee, priority,
labels, estimate, due date, project, milestone, blocking relations) and read and
add comments, always with their own Linear token. The only automatic write stays
allocation. The contracts are in §2.12, §3, §4, §5, §7.2 and §8.5 (the issue
page and slide-over as built).

**Owner decision 2026-10-22** (design doc §12): there is no PM role. Every
signed-in person can do everything a PM could: change a milestone's target date,
a project's lead, a milestone's weight and "done means…", every workspace
setting (modes, people, schedule, tuning), start a dry run or (while allocation
is live) a live run, resync, preview digests, and view anyone's My week. What
stays: **watchers** (`settings.watcherUserIds`, bootstrapped from
`WATCHER_EMAILS`, else the installer; the list may be empty); edits written to
Linear (milestone date, project lead, issue edits) still need the person's own
write grant (`actor.canWriteLinear`), planner-only edits need only a session;
the **audit log** records who changed what; allocation stays the only automatic
write and stays in dry run until someone switches it live in Settings → Modes
(audited). `WorkspaceSettings.pmUserIds`, `Actor.isPm`, `PM_EMAILS` and the
`not_pm` error code are gone; old stored settings are read without the PM list
(§5) and a deploy that still sets `PM_EMAILS` logs one warning at boot (§7.1).
The contracts are in §2.9, §5, §7, §7.1, §8 and §10.

**Owner decision 2026-10-22, "Guests limited to read only"** (design doc §12): a
Linear guest may sign in and see what Linear lets them see (§2.13, unchanged),
but changes nothing through the planner: no issue edits, comments or relations,
no milestone date, lead, weight or "done means…", no settings, no runs, no
resync, no digest preview and no write grant. It is the only permission
distinction in the app, and it comes from Linear's guest flag, not a planner
role. `Actor.readOnly` carries it; one engine guard, `requireWritable`
(`EngineAuthError('read_only')`, 403), is called first by every mutating engine
method and by the routes of the actor-less jobs (resync, preview); the pages
offer a guest no controls and one quiet notice. The contracts are in §2.13, §7,
§7.1, §7.2, §8.1, §8.3, §8.4 and §8.5.

**Owner request 2026-10-22, "every issue in one list"** (the owner's words:
"Need good and intuitive ways to see all tasks then filter by projects and
initiatives and milestones and order by weight based on those and easily group
things and move them to milestones and stuff."): one list of every issue the
person can see, filtered by initiative, project, milestone, assignee, team,
status, priority, text and three quick filters, ordered by the weight rule or by
a field, grouped by milestone, project, initiative, assignee, status or priority
(optionally inside initiative or project sections), and issues moved to a
milestone (with its project), a project, a person, a status or a priority, one
at a time or up to 100 at once. A move is an issue edit of the 2026-10-21
decision (project, milestone, assignee, status, priority), made with the
person's own token, refused for a guest (`requireWritable`) and audited per
issue, so there is no new kind of Linear write. The mirror gains each issue's
due date. The contracts are in §2.7, §2.13, §2.14, §3, §4, §4.1, §5, §7 and
§7.3.

## 1. Layout

```
apps/
  planner/   Next.js 16 app: pages, route handlers (OAuth, webhooks, edits)
  worker/    CLI for scheduled jobs (daily run, periodic resync, migrations)
packages/
  core/      pure domain logic + shared types (no I/O, no dependencies)
  linear/    Linear GraphQL gateway, OAuth, webhook verification, fixture workspace
  store/     Postgres persistence (pg in production, PGlite locally/tests)
  notify/    digest delivery: Slack DMs, outbox
  engine/    orchestration: sync, allocation, warnings, edits, read models
  logger/    structured JSON logger
  ui/        portable React task UI (TS source, CSS modules; see its README)
docs/
  architecture.md   this file
  design/           the design doc
  deploy.md         Railway + Linear app + Slack app setup
```

Dependency direction: `core` ← `linear`, `store`, `notify` ← `engine` ←
`planner`, `worker`. `logger` is used by `engine`, `planner`, `worker`. Nothing
imports `planner` or `worker`. No package may import from a sibling it does not
list in `package.json`. `ui` imports no workspace package, no `next/*` and no
`process.env`: it is also meant for the Dispatch desktop app (Vite + Tauri), so
its props are plain data, links go through the host's `UiLinkProvider`, and its
global sheet can be confined to `[data-bt-ui]` wrappers (`data-bt-ui-scoped` on
`<html>`, `packages/ui/README.md`). Another repository installs it from the
tarball `pnpm pack` makes in `packages/ui` (exact dependency versions, `src/`
only); its noop moon `build` task links it into the planner's `^:build`, so a ui
change re-runs the planner's build, typecheck, tests and e2e in CI.

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
→ `engine` → `worker`, `planner`. `scripts/build-all.sh` (the Docker build)
derives it from the `package.json` workspace dependencies
(`pnpm --recursive exec`, topological) and builds every project with a
`tsdown.config.ts`, then the planner.

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

The issue list's weight order (§2.14) builds on this without changing
`compareMilestones` (My week, the graph, digests and allocation keep it as it
is). Issues fall in tiers, so paused work never outranks live work and the
unplanned work of live projects comes before it (builder's calls, flagged in the
design doc): **A** in a mirrored milestone of an active project (§2.8); **B** in
an active project with no mirrored milestone; **C** no mirrored project; **D**
in a milestone of an inactive project; **E** an inactive project with no
milestone. Inside A and D, milestones that are not complete come before complete
ones, then `compareMilestones` (one global sort per build, partitioned stably);
inside B and E, projects in `orderProjects` order (first initiative, then
project priority, `sortOrder`, id). Inside a milestone, or a project's "No
milestone", open issues come before closed ones, then `compareIssues`. The
weight stays display only: `nextMilestoneId` and `planAllocation` never read the
tiers or the weight (a core test changes a weight and compares the plans).

### 2.8 Allocation plan (§6.1–6.4, §7.4)

For each project, in timeline order:

1. Status not in `tuning.activeProjectStatuses` → `inactive` (not loud).
2. No lead → `blocked/no_lead`; lead deactivated → `blocked/lead_inactive`. This
   comes before the next milestone, so an active project without a working lead
   is blocked (and reaches the digest as `allocation_blocked`, §2.9) even when
   it has no open milestone (`nextMilestoneId` null): design §6.1 flags a
   project with no lead everywhere.
3. No next milestone → `no_open_milestone`.
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
dropped, and so is anyone who may not see the project (§2.13). Watchers are
`settings.watcherUserIds`, the only people the settings name (owner decision
2026-10-22: there is no PM list); it may be empty, and then only leads are told.

Digests (§6.8): one per recipient per day, items sorted overdue → at_risk →
invalid_due_soon → allocation_blocked, then by milestone display order. Each
item carries the project, milestone, due date, days left, open count, unassigned
count, the open issues themselves (`openIssues`: id, identifier, title, whether
unassigned, and `<appUrl>/issues/<identifier>`, in display order, so the message
names what's open and what's unassigned, design §7.5), plain lines ("3 open
issues unassigned", "no state change in 9 days", "2/7 done with 2 days left",
"missing: done means…"), and a deep link `<appUrl>/timeline?milestone=<id>` (or
`?project=<id>`). `openIssues` is optional in the type only because digests
stored before it existed lack it.

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

### 2.12 Issue page (owner decision 2026-10-21)

`buildIssueDetail({ snapshot, ctx, assessments, issueId })` → `IssueDetail`
(null for an issue the mirror does not hold), from the mirror only:

- the issue, its state (`id`, `name`, `type`; no colour), team, assignee and
  project lead as `{ id, name, active }`, priority, project (`active` = status
  in `tuning.activeProjectStatuses`, §2.8) and milestone (target date, days
  left, status, reasons, `isNext`, rubric gaps, progress).
- `blockedBy` / `blocks`: one row per blocker/blocked pair with the Linear
  relation id (what `removeRelation` takes), the other issue's identifier,
  title, state, assignee, project and milestone names, `external` (the other
  issue has no project, or its project is inactive or not mirrored) and
  `resolved` (the relation's blocker is closed, as on graph edges). Rows whose
  other issue is open come first, then issue order (§2.7). Relations whose other
  end is not mirrored are only counted (`hiddenRelations`).
- timing: created / updated / started / completed / canceled,
  `lastStateChangeAt`, `daysInState` (whole days, floor, never negative) and
  `stalled` (open and more than `stallDays × 24 h` in its state, like §2.5).
- `why`: `unassignedInNextMilestone` (open, unassigned, not triage, in its
  active project's next milestone: allocation hands it to the lead unless the
  project is blocked); `blocksAtRiskMilestones` (overdue / at-risk milestones of
  active projects holding an open issue this open issue blocks, milestone
  order); `waitsOnUnassigned` / `waitsOnOverdue` (transitively over open
  blockers, exactly as the graph computes them, so project status is not
  considered); `onRiskChain` (it waits on one of those, or is itself unassigned
  or overdue and blocks an open issue).
- `options` (`buildIssueEditOptions(snapshot, ctx, teamId)`): the team's
  workflow states by type group (triage, backlog, unstarted, started, completed,
  canceled), then `position` (Linear orders positions only within a type group);
  assignable people (active, not app users) by name; projects with their
  milestones (§2.6 order), active projects first in timeline order, each with
  `includesTeam`.

Limits shared with the UI: `ISSUE_TITLE_MAX_LENGTH` 255 characters,
`ISSUE_DESCRIPTION_MAX_LENGTH` 100,000 UTF-16 code units, `COMMENT_MAX_LENGTH`
10,000 characters. Estimates follow Linear's documented scales
(linear.app/docs/estimates): exponential 1 2 4 8 16 (+32 64 extended), Fibonacci
1 2 3 5 8 (+13 21), linear 1 2 3 4 5 (+6 7), T-shirt XS S M L XL (+XXL XXXL),
stored as the Fibonacci numbers they translate to; `allowZero` adds 0; `notUsed`
allows only "no estimate". `estimateOptions(scale)`,
`isAllowedEstimate(scale, value)`, `estimateLabel(scale, value)`.

### 2.13 Per-viewer visibility (`visibility.ts`)

The mirror is read with the app's token, which sees every team the admin granted
at install, private ones included. A person is shown only what Linear would show
them (orchestrated decision 2026-10-22, from the review findings on guests and
private teams):

- `viewerScope(snapshot, userId)` → `{ userId, guest, teamIds, everything }`. A
  member of a team (`Team.memberIds`) always sees it. Otherwise a guest
  (`User.guest`, or a person the mirror does not know) sees nothing, and a
  workspace member sees `public` teams and `restricted` ones (non-private teams
  inside a private team's boundary) when they belong to the team or an ancestor
  up to the nearest `private` one. A team whose visibility the mirror does not
  know (written before it was read) is shown to its members only, so an old
  mirror fails closed.
- `visibleSnapshot(snapshot, scope)`: the mirror re-indexed without the hidden
  teams and their workflow states, the projects none of whose teams is visible
  (with their milestones), the issues whose team is hidden (or whose mirrored
  project is), and every relation with a hidden end; a guest also gets no
  initiatives (Linear's guests cannot see them) and projects without
  `initiativeIds`. Users stay. When the viewer sees everything it returns the
  snapshot itself. Views built on it are computed from what the viewer sees
  (progress, status and the allocation plan of a project shared with a hidden
  team count only its visible issues).
- `scopeSeesProject`, `scopeSeesIssue`.
- Read-only people (owner decision 2026-10-22, "Guests limited to read only"):
  the same `guest` test — a Linear guest, or a person the mirror does not know —
  also makes a person read-only in the planner (the engine's `Actor.readOnly`,
  §7): they see what this section allows and change nothing.
- Warnings (§2.9): a lead or watcher who cannot see a notice's project is not
  among its recipients, and each digest names only the open issues its recipient
  can see (`visibleDigest`, also used for the Settings preview with the
  previewing person's scope; counts and plain lines name nothing and stay).
- The issue list and its picker options (§2.14) are built from the viewer's
  snapshot only, so a hidden team's issues, projects, milestones and relations
  reach no row, count, flag, ref or option. A filter value the viewer's snapshot
  lacks matches nothing and is reported in `unknownIds`, unknown and hidden
  alike, and never becomes a header or a drop target. `buildIssueListOptions`
  narrows each project's `teamIds` to the viewer's teams: `visibleSnapshot`
  keeps a shared project's full team list, and the options go to the browser.

### 2.14 Issue list (`issue-list.ts`, owner request 2026-10-22)

`buildIssueList({ snapshot, ctx, assessments, allocationPlan, query, viewerId })`
→ `IssueListView`, over the viewer's snapshot (§2.13). One pass per step, never
per comparison. At 50,000 issues one build took 70–200 ms on a busy 4-core
sandbox, and the default view (500 rows, 200 headers and their refs) is about
390 KB of JSON; the core scale test asserts under 600 KB and the shared 4 s
bound.

- **Query** (`IssueListQuery`): `filters`, `group`
  (`milestone | project | initiative | assignee | state | priority | none`),
  `sections` (`none | initiative | project`), `sort`
  (`weight | priority | due | updated | created | title`), `dir` and `limit`.
  `normalizeIssueListQuery(raw)` never throws: unknown enum values, blank
  values, values over 200 characters, repeats and values past 50 per field are
  dropped (values keep their order); `q` is trimmed to 200 characters; an empty
  status list means the open types; `limit` is rounded up to a multiple of 500
  in [500, 2000]; an invalid pair resets `sections` to `none` (initiative
  sections with every group but `initiative`; project sections with `milestone`,
  `assignee`, `state`, `priority`, `none`; `issueListSectionsAllowed`); the
  weight sort has no direction (`asc`), the others default to
  `ISSUE_LIST_DEFAULT_DIR` (`updated` and `created` newest first).
  `buildIssueList` normalizes again and returns the query as applied.
- **Filters**: values within a field are OR'd, fields and quick filters AND'd,
  an empty field adds no condition. `LIST_NONE` (`'none'`, equal to
  `NO_INITIATIVE_ID`) means no project / milestone / assignee / initiative;
  `LIST_ME` (`'me'`) is `viewerId` (none: matches nothing). Status by type
  across teams, open by default. Initiative: the issue's mirrored project's
  first initiative (`homeInitiativeIds`, the timeline's rule), `none` for a
  project in no mirrored initiative; an issue without a project matches no
  initiative value. Project and milestone count only what the snapshot mirrors
  (a milestone of another project than the issue's reads as none). Quick:
  `blocked` (open with an open blocker), `at_risk` (open, its milestone overdue
  or at risk in an active project), `next` (open, in its active project's next
  milestone). Text: `issueSearchScore` (`issue-search.ts`, shared with the
  relation picker's search) with every query word in the accent-folded title,
  and the identifier only when the query holds a digit ("24" finds ENG-24; "eng"
  does not match every ENG issue).
- **Fallback**: a snapshot without initiatives (a guest's, or a workspace with
  none) facing a query that names initiatives, groups or divides by them drops
  the initiative values, groups by project instead and divides by nothing, with
  `fallback: { reason: 'no_initiatives' }`; every initiative id gets the same
  answer. A query that names no initiative (the default view) needs no fallback,
  so a guest's plain `/issues` has no such notice: nothing on it speaks of
  initiatives (the Group menu's initiative choices say "No initiatives to
  show").
- **Order**: the weight order of §2.7, or a field first (priority with none
  last, the issue's own `dueDate` with undated last, `updatedAt`, `createdAt`,
  folded title then identifier; nulls last in both directions), ties broken by
  the weight key. Field sorts order rows inside groups; groups keep their own
  order.
- **Groups** (key `<sectionKey>/<valueKey>`): milestone (`m:<id>`; a project's
  `nm:<projectId>`; `np`), by tier, then the milestone or project rank; project
  (`p:<id>`): active projects in `orderProjects` order, then `np`, then inactive
  ones; initiative (`i:<id|none>`): `compareInitiatives`, "No initiative", then
  `np`; assignee (`a:<id|none>`): the viewer, active people by folded name,
  deactivated (and app or unknown) people, then unassigned; state
  (`s:<type>:<stateNameKey>`): one group per type and name across teams
  (`stateNameKey` trims and lower-cases, so ENG's and OPS's "In Review" are
  one), by type, then the lowest position, then name; priority (`pr:<0-4>`): all
  five even when empty when there are no sections, Urgent to No priority; none
  (`all`). A group's `count` counts every match, shown or not. Each group
  carries its drop `patch` (`IssueBulkPatch`, §7.3): a milestone moves there
  with its project, a project's "No milestone" and a project group move into the
  project with no milestone, "No project" clears the project, an assignee group
  assigns (null for a deactivated person, an app or an unknown person: the bulk
  edit would refuse them), a state group sets that status by name, a priority
  group that priority; initiative groups and `all` take no drop. Groups of an
  inactive project are `muted`.
- **Sections**: with `sections: none` and grouped by milestone, the tiers as
  dividers: `t:overdue` (tier A, milestone overdue), `t:upcoming` (the rest of
  A, complete milestones last), `t:unplanned` (B, then C) and `t:inactive` (D,
  E), empty ones left out; any other grouping is one unlabelled section `all`.
  `sections: initiative`: one per first initiative (`i:<id>`), then `i:none`,
  then `p:none`; `sections: project`: active projects (`p:<id>`), `p:none`,
  inactive ones. Inside a section, groups keep their global order; a section's
  `count` counts its matches.
- **Empty milestones as drop targets** (grouped by milestone only): with 1 to 5
  real project ids in the project filter, every milestone of those projects that
  is not complete is listed even without matches, as is every milestone the
  milestone filter names that the viewer's snapshot holds (complete or not);
  such a group has `count: 0`, no rows and `emptyTarget: true`. Its header's ref
  carries the milestone's whole progress, so the planner can tell "no open
  issues here yet" from "none of its open issues match".
- **Budgets**: sections, then groups, in order: the first 200 groups
  (`ISSUE_LIST_MAX_GROUPS`) are kept and the rest only counted in `moreGroups`
  (their issues still count in `total`); each kept group takes rows from the row
  budget (`limit`) until it runs out, so later groups may have none.
- **Rows** (`IssueListRow`): the issue's fields with its mirrored project and
  milestone (null when not mirrored), its state's name and type, `dueDate`
  (`Issue.dueDate`, none when absent or malformed), `blockedBy` (open blockers),
  `holdsUpMilestoneId` (open and blocking an open issue of an overdue or at-risk
  milestone of an active project: the first such milestone in weight order),
  `unassignedInNext` (§2.12's `unassignedInNextMilestone`) and `projectActive`
  (true without a project).
- **Counts and presets**: one pass also counts the preset tabs over open issues,
  whatever the current filters: `all`, `mine` (assigned to the viewer),
  `unplanned` (no mirrored milestone), `unassigned`, `blocked`, `at_risk`; each
  equals the `total` of its own filters in `ISSUE_LIST_PRESETS`.
  `sameIssueListFilters` compares filters field by field as sets.
- **Refs**: names and facts only for what kept rows, groups, sections and filter
  values reference, closed over milestones' projects and projects' first
  initiatives, leads and next milestones (people, teams, initiatives, projects
  with lead, next milestone and allocation outcome, milestones with date, days
  left, status, rubric, `isNext`, weight and progress).
- **Also**: `unknownIds` (filter values the snapshot lacks, per facet; `me` and
  `none` never), `alsoIn` (with an initiative filter: projects in a chosen
  initiative whose first initiative is another, so their issues are not listed),
  `includesClosed` (the status filter names a closed type), `projectCount`
  (mirrored projects that are not completed or canceled) and `today`.
- `buildIssueListOptions(snapshot, ctx, assessments)` → `IssueListOptions`, the
  pickers' data: initiatives (`compareInitiatives`), projects active first then
  the rest (timeline order) with their milestones in §2.6 order (date, days
  left, status, `isNext`, weight), non-app people active first by folded name,
  and teams by name with their states (type group, then position).

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
export const NO_INITIATIVE_ID = 'none'; // the "No initiative" id
export function homeInitiativeIds(
  snapshot: Snapshot
): ReadonlyMap<string, string | null>; // each project's first initiative
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
// issue-detail.ts / estimates.ts — the issue page (§2.12)
export function buildIssueDetail(input: {
  snapshot: Snapshot;
  ctx: EvalContext;
  assessments: ReadonlyMap<string, MilestoneAssessment>;
  issueId: string;
}): IssueDetail | null;
export function buildIssueEditOptions(
  snapshot: Snapshot,
  ctx: EvalContext,
  teamId: string
): IssueEditOptions;
export const ISSUE_TITLE_MAX_LENGTH = 255;
export const ISSUE_DESCRIPTION_MAX_LENGTH = 100_000;
export const COMMENT_MAX_LENGTH = 10_000;
export function estimateOptions(scale: EstimateScale): EstimateOption[];
export function isAllowedEstimate(scale: EstimateScale, value: number): boolean;
export function estimateLabel(scale: EstimateScale, value: number): string;
export function isEstimateScaleType(value: string): value is EstimateScaleType;
// issue-search.ts — the issue text matcher (§2.14), shared with the planner's
// relation search
export function foldText(text: string): string; // "Résumé" → "resume"
export function issueSearchTerms(text: string): IssueSearchTerms;
export function foldedTitles(snapshot: Snapshot): ReadonlyMap<string, string>; // once per snapshot
export function issueSearchScore(
  issue: Issue,
  terms: IssueSearchTerms,
  foldedTitle: string,
  options?: { identifier?: boolean } // false: titles only
): 0 | 1 | 2 | 3 | null; // identifier exact, prefix, contains; every title word
// issue-list.ts — the issue list (§2.14)
export const OPEN_STATE_TYPES: readonly WorkflowStateType[];
export const ALL_STATE_TYPES: readonly WorkflowStateType[];
export const ISSUE_LIST_DEFAULT_LIMIT = 500; // also _LIMIT_STEP 500, _MAX_LIMIT 2000
export const ISSUE_LIST_MAX_GROUPS = 200; // also _MAX_VALUES 50, _QUERY_MAX 200,
// _VALUE_MAX_LENGTH 200, _EMPTY_TARGET_PROJECTS 5
export const ISSUE_LIST_DEFAULT_DIR: Readonly<
  Record<IssueListSort, 'asc' | 'desc'>
>;
export const DEFAULT_ISSUE_LIST_QUERY: IssueListQuery; // frozen
export const ISSUE_LIST_PRESETS: Readonly<
  Record<IssueListPresetId, IssueListFilters>
>;
export function normalizeIssueListQuery(raw: unknown): IssueListQuery; // never throws
export function sameIssueListFilters(
  a: IssueListFilters,
  b: IssueListFilters
): boolean;
export function issueListSectionsAllowed(
  group: IssueListGroupBy,
  sections: IssueListSectionBy
): boolean;
export function stateNameKey(name: string): string; // trimmed, lower case
export function buildIssueList(input: {
  snapshot: Snapshot;
  ctx: EvalContext;
  assessments: ReadonlyMap<string, MilestoneAssessment>;
  allocationPlan: AllocationPlan;
  query: IssueListQuery;
  viewerId: string | null; // resolves LIST_ME
}): IssueListView;
export function buildIssueListOptions(
  snapshot: Snapshot,
  ctx: EvalContext,
  assessments: ReadonlyMap<string, MilestoneAssessment>
): IssueListOptions;
// visibility.ts — per-viewer visibility (§2.13)
export function viewerScope(snapshot: Snapshot, userId: string): ViewerScope;
export function visibleSnapshot(
  snapshot: Snapshot,
  scope: ViewerScope
): Snapshot;
export function scopeSeesProject(scope: ViewerScope, project: Project): boolean;
export function scopeSeesIssue(
  snapshot: Snapshot,
  scope: ViewerScope,
  issue: Issue
): boolean;
export function visibleDigest(
  snapshot: Snapshot,
  scope: ViewerScope,
  digest: Digest
): Digest;
// labels.ts — shared human copy for UI and digests
export const RUBRIC_GAP_LABEL: Record<RubricGap, string>;
export const RISK_REASON_LABEL: Record<RiskReason, string>;
export const STATUS_LABEL: Record<MilestoneStatus, string>;
export const BLOCK_REASON_LABEL: Record<AllocationBlockReason, string>;
export const PRIORITY_LABEL: Record<Priority, string>;
export const ISSUE_FIELD_LABEL: Record<IssuePatchField, string>; // "Status", "Due date", …
// the issue list's copy: STATE_TYPE_LABEL (Triage, Backlog, Todo, In progress,
// Done, Canceled), ISSUE_LIST_GROUP_LABEL, ISSUE_LIST_SECTION_LABEL,
// ISSUE_LIST_SORT_LABEL, ISSUE_LIST_SORT_HINT, ISSUE_LIST_QUICK_LABEL (Blocked,
// At risk, In next milestones), ISSUE_LIST_TIER_LABEL (Overdue, Upcoming, No
// milestone, Inactive projects), ISSUE_LIST_PRESET_LABEL
```

`Issue.dueDate?: IsoDate | null` (since 2026-10-22, §4): the issue's own Linear
due date; absent on mirrors written before it, read as none.

Issue list types (`types.ts`, §2.14): `LIST_NONE`, `LIST_ME`,
`IssueListGroupBy`, `IssueListSectionBy`, `IssueListSort`, `IssueListQuick`,
`IssueListIdFacet`, `IssueListPresetId`, `IssueListFilters`, `IssueListQuery`,
`IssueListRow`, `IssueListGroupValue`, `IssueListGroup`,
`IssueListSectionValue`, `IssueListSection`, `IssueListRefs`, `IssueListView`,
`IssueListOptions`, and the bulk edit's `IssueBulkPatch`
(`move: { projectId, milestoneId }`, `assigneeId`, `priority`,
`state: { type, name }`, §7.3).

Issue page types (`types.ts`): `IssueDetail`, `IssueRelationRow`,
`IssueDetailProject`, `IssueDetailMilestone`, `IssueDetailTiming`,
`IssueWhyItMatters`, `IssueEditOptions`, `IssueProjectOption`, `IssuePersonRef`;
the live part `IssueExtras` (`issueId`, `description`, `labels`, `estimate`,
`dueDate`, `comments` oldest first, `commentsTruncated`, `estimateScale`),
`IssueLabel` (`id`, `name`, `color` — drawn only as the label picker's small
swatch, §8.5 —, `teamId` or null for workspace labels, `group` with
`singleSelect`), `IssueComment` (`id`, `body` markdown, `createdAt`, `url`,
`parentId`, `author` `{ id, name }` or null, `externalAuthor` for bots and
integrations), `EstimateScale` (`type`, `allowZero`, `extended`),
`EstimateOption`; and the edit `IssuePatch` (any of `title`, `description` (null
clears), `stateId`, `assigneeId` (null unassigns), `priority` 0–4, `projectId`
(null), `projectMilestoneId` (null), `dueDate` (null), `estimate` (null),
`labelIds` (the full new set)) with `IssuePatchField = keyof IssuePatch`.

The allocation comment (§7.4) is exactly:
`Assigned by <appName>: you lead <project> and this is in its next milestone <milestone>, due <Mon D, YYYY>.`

## 4. Linear integration (packages/linear)

- `createLinearGateway({ accessToken, fetch?, logger?, endpoint? })` — real API
  over `fetch` (no SDK at runtime). Bearer token. Retries 429/5xx with bounded
  backoff honoring reset headers; maps failures to `LinearApiError`. A response
  whose `errors` is not empty fails even when it also carries `data` (Linear
  nulls a field that failed, and a null assignee or project would read as
  "none"); aliased batches set the failed aliases aside by the errors' paths and
  retry the rest.
- Queries live in `queries.ts` as plain strings and are validated against
  Linear's published schema in tests (`test/schema.test.ts` using `graphql`'s
  `buildSchema` + `validate`). See §4.1 for the schema source.
- `fetchWorkspace` pages every connection (page size within Linear's limit),
  keeps nested connections shallow (ids only) to stay under complexity limits,
  and maps nodes with `map.ts` into core types. `lastStateChangeAt`
  approximation = latest of createdAt/startedAt/completedAt/canceledAt.
- `fetchLastStateChanges(ids)` batches issue `history` lookups with aliases and
  returns the newest entry whose `toStateId` is set.
- `IssueFields`, the fragment of every issue the mirror reads (the sync, a
  webhook's refetch, `updateIssue`, `updateIssueFields`), selects `dueDate`
  (since 2026-10-22, for the issue list's due-date sort and column); `mapIssue`
  maps it with the milestone date helper (a malformed or absent one reads as
  null). It is a scalar on the issue, so it costs no connection and needs no
  migration (issues are stored as jsonb).
- For per-viewer visibility (§2.13) `fetchWorkspace` also reads `User.guest`,
  `Team.visibility` (`public | private | restricted`; the deprecated
  `Team.private` is not used, an unknown value reads as `private`, logged) and
  `Team.parent { id }`, and pages the root `teamMemberships` connection
  (`{ team { id } user { id } }`, archived memberships left out) into
  `Team.memberIds`. Linear sends no webhook for team memberships or teams, so a
  membership change shows after the next full sync (every 15 minutes).
- `oauth.ts`: `buildAuthorizeUrl`, `exchangeCode`, `refreshTokens`,
  `revokeToken`, PKCE helpers (`createPkcePair`). Details in §4.2.
  `exchangeCode` and `refreshTokens` take an optional last argument
  `{ now?: () => number }` (epoch ms, default `Date.now`) that `expires_in` is
  counted from; the engine passes its own clock. Every token-endpoint call
  (exchange, refresh, revoke) is aborted after `OAUTH_TIMEOUT_MS` (15 s,
  `timeoutMs` overrides) as `OAuthError('network_error')`: refreshes run inside
  the store's row lock, which must not be held for undici's 300 s default.
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
- **Issue page** (owner decision 2026-10-21; additive `LinearGateway` methods,
  real and fixture):
  - `fetchIssueDetail(issueId) → IssueExtras | null` — one `IssueDetail` query
    (description, estimate, due date, the team's estimate settings with its
    ancestors up to `TEAM_ANCESTOR_LEVELS` (4: Linear nests teams five levels
    deep, changelog 2026-04-09), the first 50 labels and comments), then every
    further label page (an edit sends the full set back, so the set must be
    complete: `labels(…, includeArchived: true)`, since Linear keeps an archived
    label on the issues that carry it and the connection leaves archived ones
    out by default) and up to 3 more comment pages: at most `ISSUE_COMMENTS_MAX`
    (200) comments, sorted oldest first by `createdAt` (Linear does not document
    the default direction of `orderBy: createdAt`, so which 200 an issue with
    more keeps is not guaranteed), `commentsTruncated` when more remain. Null
    when the issue is gone, archived or trashed. A blank description reads as
    null.
  - `listIssueLabels(teamId) → IssueLabel[]` — root `issueLabels` filtered to
    the team's labels and workspace labels
    (`or: [{ team: { id: { eq } } }, { team: { null: true } }]`), every page;
    label groups (`isGroup`) and archived labels dropped; by name.
  - `updateIssueFields(issueId, patch: IssuePatch) → Issue` — `issueUpdate` with
    exactly the patch's keys (`issueUpdateInput` shape-checks them and refuses
    an empty patch before any request; `estimate` must be an Int, `dueDate`
    `YYYY-MM-DD`), mapped like the sync mirrors it; `lastStateChangeAt` moves to
    `updatedAt` when `stateId` was sent.
  - `createBlockingRelation(blocker, blocked) → BlockingRelation` —
    `issueRelationCreate(input: { issueId: blocker, relatedIssueId: blocked, type: blocks })`,
    not retried after a server/network failure (it could run twice).
    `deleteRelation(relationId)` — `issueRelationDelete(id)`, checks `success`.
  - `createComment(issueId, body)` already fits a person's comment (markdown
    body; the token decides the author) and is unchanged.
  - A refusal of these writes is rewritten by
    `readableWriteError(error, action)` into one sentence ("Linear refused to
    update the issue: Estimate 4 is not valid for this team."; "Linear does not
    let this account update the issue."), keeping `kind`, `retryAt` and the
    original as `cause`.
  - The fixture keeps the extra fields in the same store (`fixture-details.ts`:
    descriptions on most demo issues, workspace and team labels with a
    single-select "Area" group and an archived label, Fibonacci estimates on
    Engineering and extended T-shirt sizes with zero on Operations, some due
    dates, a seeded discussion), and refuses what Linear would: a state of
    another team, an unknown user, project or label, a milestone of another
    project, an estimate off the team's scale, a group label, an archived or
    other-team label the issue does not already carry (one it carries may stay),
    two labels of a single-select group, a self or duplicate relation. A project
    change without a milestone drops the old project's milestone. Seeded
    comments live in `seededComments`; `comments` stays the list of comments
    written through the gateway.
  - The due date lives only in that fields store, its one source: every issue
    the fixture gateway returns (`fetchWorkspace`, `fetchIssue`, `updateIssue`,
    `updateIssueFields`) is a copy carrying it (`withFields`), so a due-date
    edit shows on the next read of the issue and of the workspace; a read never
    creates a fields entry, and the store's own issues never hold the field.

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
- Issue page (owner decision 2026-10-21): `IssueUpdateInput` also takes `title`,
  `description` (markdown), `priority: Int`, `projectId`, `projectMilestoneId`,
  `dueDate: TimelessDate`, `estimate: Int` and `labelIds: [String!]` (the full
  set; `addedLabelIds`/`removedLabelIds` exist but are not used), each nullable
  where the field can be empty. `Issue.labels` leaves archived labels out unless
  `includeArchived: true`, and Linear keeps an archived label on the issues that
  carry it while refusing new uses (linear.app/docs/labels), so the issue page
  reads the set with archived labels and an edit may keep them. Sub-teams may
  also use their parent team's labels (same page); the planner offers only the
  team's own and workspace labels (an inherited label an issue carries stays
  editable as a carried label).
  `issueRelationCreate(input: { issueId, relatedIssueId, type: blocks })` →
  `IssueRelationPayload { success issueRelation }`;
  `issueRelationDelete(id) → DeletePayload { success entityId }`.
  `Issue.description: String`, `Issue.estimate: Float`,
  `Issue.dueDate: TimelessDate`, `Issue.labels` and `Issue.comments` are
  connections (`comments(orderBy: createdAt)`; the direction is undocumented).
  `IssueLabel { id name color isGroup team parent { groupType } }`: a group
  cannot be applied; `groupType` is `singleSelect` / `multiSelect`, and a group
  without one is single-select.
  `Comment { body createdAt url parent user botActor externalUser }` (`user` is
  null for bots and integrations). Team estimates: `Team.issueEstimationType` is
  a String, one of `notUsed`, `exponential`, `fibonacci`, `linear`, `tShirt`
  (unknown → treated as `notUsed`, logged); `issueEstimationAllowZero`,
  `issueEstimationExtended`; a sub-team with `inheritIssueEstimation` uses its
  parent's settings, and every level may inherit (the chain is followed to the
  first team that does not; one inheriting past the levels read is logged).
  Scale values: linear.app/docs/estimates (§2.12).
- Issue list (owner request 2026-10-22): `Issue.dueDate: TimelessDate`,
  `Issue.estimate: Float` and `Issue.labelIds: [String!]!` are scalars; the
  mirror reads `dueDate` only (estimates would need each team's scale to be
  shown honestly, labels a mirrored label catalog). `IssueUpdateInput` also has
  `addedLabelIds`, `removedLabelIds`, `teamId` and `sortOrder`, which the
  planner never sends (no team changes, no manual order). Linear has a batch
  mutation,
  `issueBatchUpdate(ids: [UUID!]!, input: IssueUpdateInput!): IssueBatchPayload!`
  (`{ issues, lastSyncId, success }`); its `ids` are documented "Can't be more
  than 50 at a time", one input is shared by every id, and it is documented only
  as "Updates multiple issues at once": no atomicity and no per-issue errors
  (`issueBatchCreate` is the one documented "atomically"). The bulk edits (§7.3)
  therefore write per issue with `updateIssueFields`; the batch may go behind
  the same contract after one check against a real workspace, recorded in
  `docs/research.md`.
- Identity:
  `{ viewer { id name displayName email active avatarUrl app guest } organization { id name urlKey } }`.
  With an actor=app token, `viewer` is the app user (`app: true`), never the
  installing human.
- Rate limits (OAuth apps, per user/app user): 5,000 requests/h and 2,000,000
  complexity points/h. Rate limiting arrives as HTTP 400 **or** 429 with
  `errors[].extensions.code == "RATELIMITED"` (the SDK also checks
  `extensions.type == "ratelimited"`); reset headers
  `x-ratelimit-requests-reset` / `x-ratelimit-complexity-reset` are epoch ms.
  The wait (`rateLimitResetMs`) comes from `Retry-After` (seconds or a date,
  which the SDK reads) first, then the endpoint window
  (`x-ratelimit-endpoint-requests-remaining` 0 → its `-reset`, research.md Q7),
  then the latest reset among the global windows that are used up; a window with
  requests left never decides it, and with none of these the client backs off
  (500 ms, doubling). A wait beyond 60 s fails at once with `rate_limited` and
  `retryAt`.

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
  `read,write,initiative:read` (actor=app cannot request `admin`;
  `initiative:read` is how an app user gets the workspace's initiatives,
  changelog 2025-08-14, research.md "Linear OAuth 2.0" scopes, and the sync
  reads them). The app only sees the teams the admin picks at install — document
  this in setup.
- Per-user sign-in uses the default actor (user) with `read`; anyone signed in
  may upgrade to `read,write` (`grant_write`) so their edits are attributed to
  them in Linear: milestone dates and project leads (anyone's since the owner
  decision of 2026-10-22; a PM's before) and, since the owner decision of
  2026-10-21, issue edits and comments. Scopes are sent comma-separated.

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
- `settings` — `data jsonb` (WorkspaceSettings). The PM list is retired (owner
  decision 2026-10-22): rows saved earlier still carry `pmUserIds`, which
  `getSettings` drops when reading and `saveSettings` never writes
  (`RETIRED_SETTINGS_KEYS` in `store.ts`), so no migration is needed.
- `milestone_meta` — weight, done_means, updated_by/at. Edits (anyone signed in)
  go through
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
- `audit_log` — who changed what, kept for good: milestone and project edits
  (`milestone.target_date`, `milestone.weight`, `milestone.done_means`,
  `project.lead`) and `settings.update` (open to everyone since the owner
  decision of 2026-10-22, so this is how everyone sees who switched a mode or
  changed the watchers; entries written before it may carry `pmUserIds` and
  still read), and (owner decision 2026-10-21) a person's issue edits with
  before/after: one entry per changed field, actions `issue.title`,
  `issue.description`, `issue.state`, `issue.assignee`, `issue.priority`,
  `issue.project`, `issue.milestone`, `issue.due_date`, `issue.estimate`,
  `issue.labels`, `issue.comment`, `issue.blocker_added`,
  `issue.relation_removed`; `subjectId` is the issue (the blocked issue for
  relations). Descriptions and comments are logged as `{ length }` only (a
  comment also with its `commentId`), never any of their words: Settings → Audit
  is open to every signed-in person, while those texts are read with each
  person's own token (§7.2); labels as `[{ id, name }]`; state, assignee,
  project and milestone as ids. `appendAuditEntries(entries)` (additive) appends
  many entries in one statement,
  `INSERT … SELECT … FROM jsonb_array_elements($1) WITH ORDINALITY … ORDER BY`
  the ordinality, so the identity ids follow the given order (an
  `INSERT … SELECT` without `ORDER BY` promises none, and `listAudit` sorts
  `occurred_at DESC, id DESC`); an empty list writes nothing, and strings are
  cleaned as `write()` cleans them. A bulk issue edit (§7.3) writes through it
  exactly the entries the single edits would, all sharing one `at`, in field
  order then request order. No migration.
- `listRunEntriesForIssue(workspaceId, issueId, limit)` (additive, issue page) →
  `IssueRunEntry[]`: the run entries about one issue, dry runs included, newest
  first (`created_at`, then run start, run id, seq), each with its run's
  `runMode` and `runTrigger`. Migration 4 adds
  `allocation_entries_issue_idx (workspace_id, issue_id, created_at DESC)`.

Bounded waits: every pg pool connection is opened, or a free one waited for,
within `PG_CONNECT_TIMEOUT_MS` (10 s, `connectionTimeoutMillis`), so an
unreachable database fails calls (and `/api/health` answers 503) instead of
hanging until TCP gives up; there is no statement timeout (migrations and
advisory locks may wait). `withInstallationLock` / `withSessionLock` run
`SET LOCAL lock_timeout = '30s'` before `SELECT … FOR UPDATE`: the holder's
token refresh is bounded at 15 s (`OAUTH_TIMEOUT_MS`, §4), so a waiter past 30 s
fails with 55P03 instead of piling up on pool connections. `write()` (every
single-statement write) drops U+0000 from string parameters like `jsonParam`
does, since Postgres refuses it in text as in jsonb; the engine refuses control
characters in what people type (§7.1), this is the backstop.

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
  Each item's section is the linked title, the kind line, the plain lines as
  bullets, "Due <date> · N open · M unassigned", then the open issues as
  `• <issue url|KEY> Title` bullets (" — unassigned" on those with no assignee),
  unassigned first, at most 10, the rest counted as "• …and N more open issues
  (M unassigned)". Room for that last bullet is kept while the lines are placed,
  so the issues are never dropped silently. The top-level `text` lists items
  only, not issues.

## 7. Engine (packages/engine)

`createEngine(deps: EngineDeps): Engine` (contract in `src/types.ts`).

- **load(workspaceId)**: reads `sync_state.version`; if it equals the cached
  version, reuses the indexed snapshot; otherwise loads the mirror and
  re-indexes. Settings + milestone meta are read every call (small). Computes
  `today` (workspace tz), assessments, allocation plan. No mirror yet → runs
  `fullSync` first (if installed).
- **Per-viewer visibility** (§2.13; `visibility.ts`, the one place views apply
  it): `load`, `getWeekView`, `getTimelineView`, `getGraph`,
  `getMilestoneDetail`, `getIssueList`, `getIssueListOptions`, `getRun`,
  `listAudit` and `runWarnings({ previewOnly })` take an additive optional
  `viewer: Actor`; with it the mirror is narrowed (`visibleSnapshot`, cached per
  mirror snapshot and set of visible teams) before anything is built, so the
  assessments and the allocation plan are computed over what that person sees.
  Every read the web app makes for a person passes it (§8.1); only the worker's
  jobs (sync, allocation, the warnings sent to leads and watchers) and tests
  read the whole mirror. A viewer of another workspace is `wrong_workspace`. The
  issue page and every edit (`getIssueDetail`, `updateIssue`, `addComment`,
  `addBlocker`, `removeRelation`, milestone and project edits) look entities up
  in the viewer's narrowed mirror, so an issue of a team they cannot see is
  `not_found` like an unknown one, while what a write changes in the mirror is
  decided on the whole mirror. `getRun` and `listAudit` leave out entries about
  a project, milestone or issue the viewer cannot see; an entry about one the
  mirror no longer holds (a closed project, a deleted issue) cannot be placed in
  a team, so members see it and guests do not. The digest preview narrows each
  recipient's digest to what the previewing person sees. A mirror written before
  team visibility was mirrored is synced by `load` first (if that sync fails it
  is read as it is, which shows people nothing). Since the owner decision of
  2026-10-22 ("Guests limited to read only") a guest is also read-only: see
  "Read-only people" below.
- **Read-only people** (owner decision 2026-10-22, "Guests limited to read
  only"; `permissions.ts`, `engine.ts`): `authenticate` sets `Actor.readOnly`
  from the mirror on every request (`readOnlyReasonFor`: core's
  `viewerScope(...).guest`, so a Linear guest or a person the mirror does not
  know), and `Actor.readOnlyReason` says which (`guest`, `unknown`, or
  `not_synced` for the no-mirror case below; absent when not read-only) so the
  planner never calls someone a guest who is not one. Without a mirror nobody is
  known. With no active installation (never installed, or uninstalled) nobody is
  read-only, so someone can install or reinstall (Linear lets only an admin
  approve that), and every other change needs an active installation anyway. An
  installed workspace without a mirror (its first sync has not landed) gets that
  sync in `authenticate` first, joined with the one the install started
  (`fullSync` is single-flight), so people are placed before anything is
  decided; if it fails, everyone is read-only (`not_synced`) until a sync lands
  (a run would otherwise sync first and then act for a person the planner never
  placed). Install and reinstall stay open in that state (`requireCanInstall`,
  the one guard `finishInstall` uses, and the `GET /api/auth/linear` start of an
  install): a reinstall is how an admin fixes a grant that makes the first sync
  fail, and Linear lets only a workspace admin approve an `actor=app` install. A
  read-only person's `canWriteLinear` is always false. `requireWritable(actor)`
  throws
  `EngineAuthError('read_only', 'Guests in Linear can look but not change anything here.')`
  (`READ_ONLY_MESSAGE`; an `unknown` or `not_synced` person is told that the
  planner has not seen their account yet, or that the first sync has not
  landed); `engine.ts` calls it first, before any module runs, in
  `runAllocation` (a person's run; the worker's `actor: null` is not guarded),
  `runWarnings` with a `viewer` (the digest preview), `setMilestoneTargetDate`,
  `setProjectLead`, `setMilestoneWeight`, `setMilestoneDoneMeans`,
  `updateSettings`, `updateIssue`, `addComment`, `addBlocker`, `removeRelation`
  and `updateIssues` (§7.3). `fullSync` takes no actor: the web's resync route
  calls the same guard first (§8.1). `finishSignIn` with `grant_write`, or any
  sign-in whose token came back with `write` scope (an edited authorize URL),
  refuses a guest (Linear's identity says `guest`, or the mirror does) with
  `read_only`, revoking the grant Linear just issued and creating no session.
  `getIssueDetail` reports `readOnly` and
  `canEdit: canWriteLinear && !readOnly`. Nothing a refused call touches is
  written: not Linear, the mirror, settings, the run log or the audit log.
- **getSettings(workspaceId)** (additive): the saved settings over the defaults,
  exactly as `load` reports them, with no sync, no mirror read and no
  installation check (the timezone as saved, even if invalid). The worker reads
  each workspace's timezone with it on every tick.
- **fullSync**: app gateway `fetchWorkspace()` → refine `lastStateChangeAt` via
  `fetchLastStateChanges` for open issues in milestones whose target date is
  within `warnLeadDays + stallDays` ahead or already past → bootstrap the
  watchers when the workspace has no settings yet (or, on its first sync, saved
  settings with no watchers): `WATCHER_EMAILS` matches, else the installer
  (`bootstrapWatchers`; app users never, unmatched emails logged at warn) →
  `replaceMirror`. Later syncs never touch saved settings, so an emptied watcher
  list stays empty. Single-flight per workspace within a process: a caller that
  finds a sync running for its workspace (the web resync, the worker, `load`'s
  first sync, a webhook's) shares its result or its error instead of paging
  Linear again with the app's token, whose hourly quota allocation and webhooks
  share. The wait is bounded: past `SYNC_JOIN_WAIT_MS` (2 minutes) from the
  running sync's start on the engine clock, a caller runs its own (logged at
  warn), which later callers then join, so a hung sync never holds the daily job
  or a takeover. The web route adds a per-workspace cooldown (§8.1).
- **handleWebhook**: `recordWebhookDelivery` (duplicate → `'duplicate'`), then
  by `type`: `Issue` → `fetchIssue` + `fetchIssueRelations` (replace every
  relation touching that issue) and, when the issue's milestone is not mirrored
  yet, `fetchProject` for its project; `Project` → `fetchProject` (upsert
  project + all its milestones, delete mirrored milestones of that project that
  are gone); `Initiative` → `fetchInitiative`; `User` → `fetchUser`; `OAuthApp`
  with action `revoked` → `markInstallationRevoked`. Fetch returning null or
  action `remove` → delete from the mirror (a removed project also drops its
  milestones). Anything else → `'ignored'`. A refetched issue keeps the mirror's
  `lastStateChangeAt` when that is later (`withMirroredStateTime`: `fetchIssue`
  knows only the timestamp approximation, the sync's value may be
  history-refined), unless its state moved (`updatedFrom.stateId`, or a state
  other than the mirror's): then the issue's `updatedAt`. When an Issue or
  Project event brings a project the mirror did not have (reopened, or newly
  visible), its milestones come with it but its issues cannot (there is no
  per-project issue read), so a `fullSync` follows at once (its failure is
  logged; the webhook's own change stays applied). Errors are recorded on the
  delivery and logged; the periodic resync heals drift. An Issue refetch equal
  to what the mirror holds writes nothing (since 2026-10-22, for the issue
  list's moves): when no project refresh was needed, the mirror has the issue,
  `sameIssue(mirrored, refetched)` holds (every `Issue` key compared with `===`,
  an absent `dueDate` read as null, after the `lastStateChangeAt` rule above)
  and Linear's relations of the issue are exactly the mirrored ones touching it
  (same ids, same ends), the webhook answers "changed nothing" and the mirror
  version, and every cached snapshot, stays as it was. So the echo of the
  planner's own write (a person's edit, a bulk edit once it patched the mirror)
  re-indexes nothing; an echo that lands while a bulk edit is still writing
  still applies once. The refetch itself (2 app requests per issue) is still
  made: skipping it would need proof that relation-only changes move
  `Issue.updatedAt`.
- **Issue list reads** (owner request 2026-10-22; `issue-list.ts`):
  `getIssueList(workspaceId, query, viewer?)` → `IssueListResult`
  `{ view, mirrorVersion }` and `getIssueListOptions(workspaceId, viewer?)` →
  `IssueListOptionsResult` `{ options, mirrorVersion }`: thin wrappers like
  `getTimelineView` that run core's `buildIssueList` / `buildIssueListOptions`
  (§2.14) over `load` with the viewer, `viewerId` = the viewer's user id (so
  `me` is whoever reads; without a viewer it matches nothing). They are reads:
  no `requireWritable`, so a guest gets both (with the no-initiatives fallback);
  a viewer of another workspace is `wrong_workspace`. The mirror version lets
  the planner refetch the options only when the mirror moved.
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
     issue; when no state was sent it keeps the mirror's later (possibly
     history-refined) `lastStateChangeAt`, as people's edits do (§7.2), since
     `runDaily`'s warnings read that mirror next.
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
- **Milestone, project and settings edits** (`milestone-edits.ts`,
  `settings.ts`): open to every signed-in person of the workspace (owner
  decision 2026-10-22: there is no PM role and no `not_pm` code) but a read-only
  one, who is refused first with `read_only`. Linear writes
  (`setMilestoneTargetDate`, `setProjectLead`) require `actor.canWriteLinear`
  (else `needs_write_scope`) and go through `linear.forSession(actor.session)`
  so Linear attributes them to the human; Linear's refusals of them map through
  `engineErrorFromLinear` like issue edits' (§7.2: forbidden → 403
  `linear_forbidden`, a rejected token → 401 `not_signed_in`, rate limit → 429).
  Weight, done-means and `updateSettings` are tool-owned writes and need only
  the session. Each edit patches the mirror (or settings) and appends an audit
  entry under the person's id.
- **runAllocation** from a person (`trigger: 'manual'`): anyone signed in to
  that workspace (else `wrong_workspace`) but a read-only person (`read_only`),
  either mode; the live writes go out as the app, so no write grant is needed.
  The web route keeps live runs off until someone switches allocation live
  (§8.1).
- **auth**: `startOAuth(intent)` creates state + PKCE pair. Scopes: `signin` →
  `read`; `grant_write` → `read,write` (for anyone signed in but a guest: owner
  decisions 2026-10-21 and 2026-10-22); `install` → `read,write,initiative:read`
  with `actor=app` (§4.1). `finishSignIn` exchanges the code, asks `whoAmI`,
  creates a session (`sessionDays`). `finishInstall` exchanges with the app
  actor, checks the workspace matches the actor's and saves the installation
  (anyone signed in may install or reinstall: only a Linear admin can grant
  `actor=app`); it writes no settings, and the web route then schedules the
  first `fullSync`, which bootstraps the watchers. `authenticate` refreshes the
  session's Linear token when needed (under `withSessionLock`) and returns
  `Actor { session, canWriteLinear, readOnly }` (no role; `readOnly` is Linear's
  guest flag, above).

### 7.1 Engine exports and boot

`src/index.ts` exports: `createEngine`,
`createEngineFromEnv(env): Promise<Engine>`,
`loadEngineConfigFromEnv(env): EngineConfig` (throws one error listing every
missing/invalid variable), `EngineAuthError`, `EngineInputError`,
`LinearApiError` (re-exported) and `isLinearApiError(e)` (instanceof, with a
`name === 'LinearApiError'` fallback across bundle copies), the timing constants
`DEFAULT_DAILY_LEASE_MINUTES` (45) and `ALLOCATION_RUN_STALE_MINUTES` (30) the
worker derives its timeout cap from, and every type in `src/types.ts` (including
`IssueDetailResult` and `IssueUpdateResult`, §7.2). Issue page helpers
(additive): `ISSUE_HISTORY_LIMIT` (20), `normalizeIssuePatch`,
`normalizeCommentBody`, `textSummary` (a text's `{ length }` for the audit log)
and `engineErrorFromLinear`. The read-only guard (additive): `requireWritable`
and `READ_ONLY_MESSAGE`, which the web's resync and preview routes call. The
issue list (additive, §7.3): `ISSUE_BULK_MAX` (100), `ISSUE_BULK_CONCURRENCY`
(4) and `normalizeIssueBulkPatch`, with the types `IssueListResult`,
`IssueListOptionsResult`, `IssueBulkResult`, `IssueBulkOutcome` and
`IssueBulkBefore`. `DONE_MEANS_MAX_LENGTH`, `WEIGHT_MIN` and `WEIGHT_MAX` come
from `milestone-edits.ts` (was `pm-edits.ts`).

`createEngineFromEnv`:

- Retired variables (`RETIRED_ENV_VARIABLES` in `config.ts`): `PM_EMAILS` seeded
  the PM list, which the owner decision of 2026-10-22 retired. It is neither
  read nor validated (a malformed old value never blocks a boot); when a deploy
  still sets it, boot logs exactly one warning saying it is unused and to set
  `WATCHER_EMAILS` instead.

- `LINEAR_FIXTURE=1` (demo mode): in-memory PGlite unless `PGLITE_DIR` is set;
  ephemeral random `TOKEN_ENCRYPTION_KEY` if unset; `APP_URL` defaults to
  `http://localhost:3000`; `oauth: null`. Seeds the fixture workspace
  (`createFixtureStore(today)`), a fake installation (installed by
  `FIXTURE_INSTALLER_USER_ID`, Ana), settings (watchers =
  `FIXTURE_WATCHER_USER_IDS`, Ana and Ben; `dry_run`, `preview`; no PM flags:
  every demo person may edit everything, except the one Linear guest, Gus Hart
  (`FIXTURE_GUEST_USER_ID`, a member of Operations only), who is read-only),
  milestone meta from `FIXTURE_MILESTONE_META`, then `fullSync`. `devSignIn`
  creates sessions with scopes `read,write`. Webhooks are ignored. The
  `LinearProvider` serves `createFixtureGateway` (app actor or the session's
  user).
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
  its own installation check (allocation, edits, settings), uses one of two
  messages naming `APP_NAME` (`NOT_INSTALLED_MESSAGE` in `runtime.ts`; boot
  passes `appName` to the provider): "… is not installed in this Linear
  workspace yet." (no row) and "… lost its access to this Linear workspace …; an
  admin must install it again." (revoked, or a grant Linear rejects). A dead
  installation grant (`invalid_grant`, or an expired token without a refresh
  token) is also recorded with `markInstallationRevoked(workspaceId, now)` once
  the row lock is released, after re-reading the row: a reinstall saved in
  between (different tokens) is left alone. From then on Settings and `/setup`
  see `revokedAt`, `listWorkspaceIds` skips the workspace (the worker stops
  retrying it every tick) and `forApp` fails fast without calling Linear.
  `listRevokedWorkspaceIds()` (additive) lists those workspaces, and the worker
  reports each as a failed workspace on every run (§9), so allocation and
  warnings never stop silently. A session or installation row missing at lock
  time (`StoreNotFoundError`) maps to `not_signed_in` / `not_installed`.

Validation done by the engine (never trust the client): dates via
`isValidIsoDate`; lead must be an active, non-app mirrored user or null; weight
an integer in [-1000, 1000] or null; done-means trimmed, single line, no control
characters other than tab (C0, DEL), ≤ 280 chars, empty → null; settings: no
`pmUserIds` key (refused with "pmUserIds is no longer a setting…"), watchers may
be an empty list, valid IANA timezone, tuning integers within sane ranges (1–90
days), known modes; user ids must exist in the mirror; issue edits as listed in
§7.2.

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
- Milestone/project edits and `updateSettings` require an active installation
  (`not_installed` otherwise). Weight and "done means…" edits write only their
  own column (`updateMilestoneMetaField`), so edits of the two fields of one
  milestone from different web instances both stick. They still run one at a
  time per milestone within a process, so each audit entry's `before` is the
  value the previous edit left (across instances `before` is best effort).
  `updateSettings` likewise runs one save at a time per workspace within a
  process: the settings are one stored document, so without the queue two people
  saving different Settings sections at once would each write back what they
  read and one change would be lost (its audit entry reading as a revert).
- **A dead installation grant is recorded as `revokedAt`**, not as a separate
  auth-error field: every consumer already reads `revokedAt` as "reinstall
  needed" (`listWorkspaceIds`, `requireInstallation`, sign-in's `needsInstall`)
  and a reinstall clears it, so no migration or second flag is needed.
  `revokedAt` therefore means "the app has no working Linear grant", whether
  Linear revoked it or a refresh was rejected; the rejection is in the error
  logs.
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
  does find an allocation run in progress (a manual `allocate` or someone's run
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
- `finishInstall` saves no settings; the first full sync (mirror version 0)
  bootstraps the watchers from `WATCHER_EMAILS`, else the installer. Anyone
  signed in may reinstall over an active installation (there is no PM to
  require, and only a Linear admin can grant `actor=app`); a reinstall keeps the
  saved settings. There is no lockout to recover from: nobody needs a role to
  change settings, and settings can no longer name the people who may.
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

### 7.2 Issue page (owner decision 2026-10-21)

Additive `Engine` methods. Reads need only a session; writes refuse a read-only
person (a Linear guest) first with `EngineAuthError('read_only')` (owner
decision 2026-10-22, "Guests limited to read only"), then need
`actor.canWriteLinear` (else `EngineAuthError('needs_write_scope')`) and nothing
else (there is no role to check since the owner decision of 2026-10-22).

- **getIssueDetail(actor, issueId) → IssueDetailResult**
  `{ detail, extra, extraError, extraSource, labels, estimateScale, estimateOptions, allocationHistory, canEdit, readOnly }`:
  `detail` = core's `buildIssueDetail` over `load()` (unknown id →
  `EngineInputError('not_found')`); `extra` (`fetchIssueDetail`) and `labels`
  (`listIssueLabels(team)`) are read live in parallel with the **actor's own
  token** (`linear.forSession`); when that gateway cannot be had because its
  refresh failed for a transient reason the app's reads instead
  (`extraSource: 'app'`, logged at warn). Transient means the token endpoint was
  unreachable or timed out (`OAuthError` `network_error`) or answered 5xx or 429
  (or a Linear transport/server failure). A grant Linear rejected for good
  (`EngineAuthError('not_signed_in')`: revoked, lost access) is never bridged
  with the app's token: `extra` null, `extraSource` null, "Linear no longer
  accepts your sign-in; …". Neither is any other failure (another OAuth `error`
  code such as `invalid_client` after a secret rotation, a store error): `extra`
  null, `extraSource` null, "The planner could not read Linear as you right now
  …", logged at error. A live failure never throws: `extra` null, `labels` [],
  `estimateScale` null and `extraError` a sentence ("Linear did not answer; …").
  An issue the person's token does not get back reads "Linear does not show this
  issue to your account: it is in a team you cannot see, or it was deleted or
  archived." (Linear answers not found for both). `allocationHistory` =
  `listRunEntriesForIssue(…, ISSUE_HISTORY_LIMIT)` (20). `canEdit` =
  `actor.canWriteLinear && !actor.readOnly`; `readOnly` (additive) =
  `actor.readOnly`, so a client offers a guest no controls and no grant.
- **updateIssue(actor, issueId, patch) → IssueUpdateResult**
  `{ issue, changed }`. Validated before Linear is called
  (`normalizeIssuePatch`, then the mirror): only `IssuePatch` keys and at least
  one value; title trimmed, one line, no control characters other than tab (C0,
  DEL: a NUL used to reach Postgres as a 500), 1–255 characters; description ≤
  100,000 (blank → null); state of the issue's team; assignee an active non-app
  mirrored user or null; priority an integer 0–4; project mirrored or null;
  milestone of the target project (an issue without a project has none), and a
  project change without a milestone also sends `projectMilestoneId: null` (the
  old project's milestone is cleared); due date a calendar date or null;
  estimate a non-negative integer allowed by the team's live scale (`notUsed`
  refuses any) or null; labels the team's live usable labels or ones the issue
  carries now (an archived or inherited label may stay, never be added anew), at
  most one per single-select group, duplicates dropped. The current values of
  description, due date, estimate and labels are read live (actor's token) only
  when the patch touches them. Values equal to the current ones are dropped;
  when nothing is left nothing is written (`changed: []`). Then
  `updateIssueFields` with the actor's token, the mirror is patched at once
  (`applyMirrorChanges`, which bumps the mirror version so the next render shows
  it; a write that did not move the state keeps the mirror's later — possibly
  history-refined — `lastStateChangeAt`; an issue that leaves every mirrored
  project while closed, or moves to an unmirrored project, is removed with its
  relations, as a full sync would), and one audit entry per changed field. Edits
  of one issue are serialized per process.
- **addComment(actor, issueId, body) → IssueComment**: body trimmed, 1–10,000
  characters; `createComment` with the actor's token; audited as
  `{ commentId, length }` (never the text). The mirror holds no comments (the
  page reads them live).
- **addBlocker(actor, issueId, blockerIssueId) → BlockingRelation**: creates
  "blocker blocks issue" (for "this issue blocks X" call it with X as
  `issueId`); both issues mirrored (else `not_found`), not the same issue
  (`invalid`), not an existing pair (`conflict`). **removeRelation(actor,
  relationId)**: a mirrored blocks relation (else `not_found`); a relation
  Linear no longer has counts as removed. After either, the relations of both
  issues are re-read through the app (the mirror's own view) and replace every
  mirrored relation touching them, as an Issue webhook would; if that read fails
  the direct change is applied (logged). Audited as `issue.blocker_added` /
  `issue.relation_removed`.
- **Linear errors** of these writes (`engineErrorFromLinear`): `forbidden` →
  `EngineAuthError('linear_forbidden')` (403; Linear's own permissions said no),
  `unauthorized` → `EngineAuthError('not_signed_in')`, `not_found` →
  `EngineInputError('not_found')`, `invalid_input` →
  `EngineInputError('invalid')` with Linear's sentence, `rate_limited` →
  `EngineInputError('rate_limited')` (additive code, 429; `retryAt` set when
  Linear sent a reset); network/server/graphql failures stay `LinearApiError`
  (502). Nothing is written to the mirror or the audit log on a failure.
- The planner's only automatic write is still allocation (§7 runAllocation).

### 7.3 Bulk issue edits (owner request 2026-10-22, `bulk-issue-edits.ts`)

**updateIssues(actor, issueIds, patch: IssueBulkPatch) → IssueBulkResult** is
the issue list's bulk change, drop and Undo. It sends nothing new to Linear:
each issue gets the single edit's write (`updateIssueFields`, §7.2) of the
fields a move may set (project and milestone, assignee, status, priority), with
the person's own token (`linear.forSession`), so Linear's permissions apply and
its history credits the person. Nothing creates, deletes or archives issues or
changes their team. Steps:

1. `engine.ts` wraps it in `writable`: `requireWritable` first (a guest is
   refused `read_only` before anything runs), then `requireWriteScope`
   (`needs_write_scope`).
2. Whole-request checks before anything is read: 1–100 (`ISSUE_BULK_MAX`)
   non-empty ids (repeats once, first place kept); `normalizeIssueBulkPatch`: a
   plain object with only `move`, `assigneeId`, `priority` and `state`, at least
   one; `move` exactly `{ projectId, milestoneId }`, each an id or null, a
   milestone only with a project; `priority` an integer 0–4; `state` exactly
   `{ type, name }`, one of the six types and a name of 1–100 characters
   (trimmed, no control characters). Else `EngineInputError('invalid')`.
3. Every issue is locked like a single edit locks it: `serializeAll` takes the
   `issue\0<workspace>\0<id>` keys of `rt.serialize` one after another in sorted
   order, so a single edit never interleaves with a bulk edit of the same issue
   and two overlapping bulk edits cannot wait on each other in a cycle.
4. `load` with the person as viewer gives the visible snapshot (every lookup),
   the whole mirror and the allocation plan before. The targets must be in the
   visible snapshot: the move's project and milestone (`not_found` for an
   unknown or hidden one alike; a milestone of another project is `invalid`,
   "{Milestone} is not a milestone of {Project}."), and an assignee who is an
   active person (an app or a deactivated person is `invalid` with the single
   edit's words). Nothing is written when one fails.
5. Per issue, in request order: missing from the snapshot → `failed` /
   `not_found` ("{id} is not in the planner any more."); a status resolves to
   the issue's team's state of that type whose name matches (`stateNameKey`:
   trimmed, case-insensitive; the lowest position if several), and a team
   without one skips the issue (`skipped` / `state_not_in_team`, "{Team} has no
   {name} status; {KEY} was left as it was."; never guessed by type); only the
   fields that differ from the mirror are sent (`projectMilestoneId` compared
   with the issue's milestone), and an issue left with nothing to send is
   `unchanged`; then `checkAgainstMirror` (the single edit's check, which also
   clears the old project's milestone) → its `invalid` makes the issue `failed`.
6. Writes, at most `ISSUE_BULK_CONCURRENCY` (4) in flight, each error through
   `engineErrorFromLinear`: forbidden → `failed` / `linear_forbidden` with
   Linear's sentence, Linear's not found or invalid input → `failed` with that
   code, network, server or GraphQL failures (already retried) → `failed` /
   `linear_error` with Linear's words, as the single edit's 502 says them; any
   other error (a bug, a token that would not decrypt) is logged and answered
   with a fixed "Linear could not update {KEY}. It was logged.", since an
   outcome goes to the browser and an internal error's text can name internals;
   a rate limit or a rejected sign-in stops new writes (in-flight ones finish),
   and the issue it hit and every one not started are `skipped` /
   `not_attempted`, with
   `stopped: { code: 'rate_limited' | 'not_signed_in', retryAt }`. When the run
   stopped before anything changed it throws like a single edit:
   `EngineAuthError('not_signed_in')` (401) or
   `EngineInputError('rate_limited', …, { retryAt })` (429).
7. The mirror is patched once for the call (one version bump of its own),
   against the mirror as it is after the last write (webhooks take no issue lock
   and may have applied a newer copy meanwhile): an issue whose mirrored copy is
   newer (`updatedAt` later) or already `sameIssue` with the write's answer (its
   echo) is left alone, and so is one the mirror no longer holds (every issue
   written was in the mirror loaded in step 4, so a webhook found it deleted,
   archived or moved out of the kept projects meanwhile, or the call's own echo
   removed it; writing the older answer would bring it back until the next full
   sync); the rest merge `issueMirrorChanges`, and a write that did not move the
   state keeps the later `lastStateChangeAt`. A failure to read or patch the
   mirror is logged, not thrown (`patchMirror`): Linear already has the change,
   the audit and the result still follow, and webhooks or the next sync bring
   the mirror up to date.
8. The audit gets the single edit's entries (`issue.project`, `issue.milestone`,
   `issue.assignee`, `issue.state`, `issue.priority`; before and after as ids or
   numbers), all with one `at` (`rt.nowIso()` once per call, also `result.at`),
   in field order then request order, through one `appendAuditEntries` (§5); a
   failure is logged at error and the result is still returned.
9. `allocation`, from the viewer's plan before and a fresh `load` after:
   `handedOver` lists, per project, the changed issues the next run gives to the
   lead that the earlier plan did not (with `live` from
   `settings.allocationMode`); `stopped` the old and new projects of changed
   issues that are blocked now and were not before, with the reason and rubric
   gaps (emptying a next milestone, for example, makes the next one next).
10. One log line, `issues edited in bulk`, with the counts and the stop code.

`IssueBulkResult` is `{ at, outcomes, counts, stopped, allocation }`; `outcomes`
are in request order, each `changed` (with the fields sent and the issue's
`before`: project, milestone, assignee, priority, status type and name, which
Undo sends back), `unchanged`, `skipped` or `failed` (with a code and a
sentence). Linear's `issueBatchUpdate` is not used (§4.1). The web route is
`PATCH /api/issues` (§8.1), and the Issues page (§8.4) is its only caller: the
bulk bar, a drop, a row menu's or key's pick, and Undo (one request per group of
issues that go back to the same place).

## 8. Web app (apps/planner)

One reference: **layout, interaction and look from Gr8r Studio
(github.com/gr8rstudio/gr8r-studio)**, with one exception, the accent, which is
our purple `#9747ff` (an earlier owner decision) in the role Gr8r gives its
indigo. Gr8r decides where things go and how they behave (sidebar shell, topbar,
command palette, grouped task lists, Gantt timeline, slide-over drawer, projects
register, phone tab bar) and, since the owner decision of 2026-10-22 ("the
current one is too stark", design doc §12), how everything looks: warm neutral
surfaces, soft low-contrast borders, 4–12px radius, soft shadows only on things
that float, tinted semantic status colours, sentence-case Geist at Gr8r's scale
and weights, Geist Mono only for identifiers and keys (§8.2). The earlier visual
language from the Analytics `competitors-site` (paper/ink, black hairlines, mono
uppercase labels, hatched chrome, numbered blocks, zero radius, no shadows, the
accent as the only status colour) is retired. Every screen has moved off it but
the dependency graph (`/graph`, `packages/ui/src/graph/*`), whose restyle waits
for the graph work on another branch: until then it keeps its older drawing on
the new tokens (the §8.4 Graph bullet and the graph notes in §8.1 describe it as
it is), and new work there follows §8.2. Gr8r is a reference only; nothing is
imported from it.

### 8.1 Routes

| route                            | who               | what                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                              | all               | signed out: "Sign in with Linear" (fixture mode: demo user picker); signed in → `/week`                                                                                                                                                                                                                                                                                                                                                               |
| `/week`                          | signed in         | My week (the landing screen); anyone may pass `?user=<id>` to see a person's week; `?issue=<key>` opens the issue slide-over (§8.5)                                                                                                                                                                                                                                                                                                                   |
| `/timeline`                      | signed in         | Gantt timeline; `?milestone=<id>` opens the drawer (with `&issue=<key>`, one of its issues in its place, §8.5), `?project=<id>` focuses a lane; edit controls for everyone but a guest (date and lead need Linear write access)                                                                                                                                                                                                                       |
| `/projects`                      | signed in         | projects register: next milestone, status, progress, lead, allocation state                                                                                                                                                                                                                                                                                                                                                                           |
| `/graph`                         | signed in         | dependency graph; default milestone level; `?milestone=<id>` or `?project=<id>` for issue level; `?issue=<key>` opens an issue node's slide-over (§8.5)                                                                                                                                                                                                                                                                                               |
| `/runs`, `/runs/[id]`            | signed in         | allocation run log; everyone but a guest gets "Preview (dry run)" and, while allocation is live, "Run now"                                                                                                                                                                                                                                                                                                                                            |
| `/settings`                      | signed in         | modes, watchers, schedule, status, digest preview, notifications, audit; editable by everyone but a guest (read-only for them)                                                                                                                                                                                                                                                                                                                        |
| `/setup`                         | signed in         | install the app into the workspace (admin; nothing to start for a guest)                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /api/palette`               | signed in         | command-palette index (pages, projects, milestones, the user's open issues → `/issues/<key>`), fetched when the palette opens                                                                                                                                                                                                                                                                                                                         |
| `GET /api/auth/linear?intent=`   | —                 | starts OAuth (sets `mp_oauth` cookie); `install` and `grant_write` need a session and are refused for a read-only person (`/?auth_error=read_only`), except `install` while the first sync has not landed (`not_synced`); `grant_write` is offered to everyone else                                                                                                                                                                                   |
| `GET /api/auth/linear/callback`  | —                 | finishes OAuth                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `POST /api/auth/logout`          | —                 | ends session                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `POST /api/auth/demo`            | fixture mode only | demo sign-in                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `POST /api/webhooks/linear`      | Linear            | verify, ack 200, process in `after()`                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `PATCH /api/milestones/[id]`     | not a guest       | `{ targetDate?, weight?, doneMeans? }`; `targetDate` needs Linear write access                                                                                                                                                                                                                                                                                                                                                                        |
| `PATCH /api/projects/[id]`       | write access      | `{ leadId }`                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `/issues`                        | signed in         | the Issues page: every issue the person can see; the URL is the whole view (`?q=&initiative=&project=&milestone=&assignee=&team=&state=&priority=&quick=&group=&sections=&sort=&dir=&limit=`); `?issue=<key>` opens the slide-over (§8.5); read-only for a guest                                                                                                                                                                                      |
| `/tasks`                         | all               | a 307 to `/issues` (a `next.config.ts` redirect, query kept), never a page                                                                                                                                                                                                                                                                                                                                                                            |
| `/issues/[id]`                   | signed in         | the issue page (§8.5), by identifier (`/issues/ENG-24`) or id; edit controls for anyone with Linear write access (never a guest)                                                                                                                                                                                                                                                                                                                      |
| `GET /api/issues/[id]`           | signed in         | `{ result: IssueDetailResult }` by id or identifier, private, never cached (the pages render the issue on the server)                                                                                                                                                                                                                                                                                                                                 |
| `GET /api/issues/options`        | signed in         | `{ options: IssueListOptions, mirrorVersion }`: the Issues page's picker data (initiatives, projects with their milestones, people, teams with their states) as the person may see it, fetched on the first popover open; private, never cached                                                                                                                                                                                                       |
| `GET /api/issues/search?q=`      | signed in         | the relation picker's mirror search (`&near=<issue id>` ranks that issue's milestone and project first) → `{ results }`, at most 20, private                                                                                                                                                                                                                                                                                                          |
| `PATCH /api/issues/[id]`         | write access      | `[id]` is the issue id (not the identifier, unlike the GET); an `IssuePatch` (§3) → `{ result: IssueUpdateResult }`                                                                                                                                                                                                                                                                                                                                   |
| `PATCH /api/issues`              | write access      | the Issues page's bulk change, drop and Undo (§7.3): `{ issueIds (1–100, distinct), patch: IssueBulkPatch, returnTo? }`, strict → `{ result: IssueBulkResult }` (partial results included), private; a guest 403 `read_only` before the body; no grant 403 `needs_write_scope` with the link back to the sanitized `/issues…` `returnTo` (else `/issues`); a stop with nothing changed 401 or 429 with `Retry-After`; an unknown or hidden target 404 |
| `POST /api/issues/[id]/comments` | write access      | `{ body }` → 201 `{ comment }`                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `POST /api/issues/[id]/blockers` | write access      | `{ blockerIssueId }` (it blocks `[id]`) → 201 `{ relation }`                                                                                                                                                                                                                                                                                                                                                                                          |
| `DELETE /api/relations/[id]`     | write access      | removes a blocks relation (no body) → 204                                                                                                                                                                                                                                                                                                                                                                                                             |
| `POST /api/runs`                 | not a guest       | `{ mode: 'dry_run' \| 'live' }`                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `POST /api/sync`                 | not a guest       | full resync; 429 `resync_cooldown` with `Retry-After` within 60 s of the workspace's last web resync                                                                                                                                                                                                                                                                                                                                                  |
| `POST /api/warnings/preview`     | not a guest       | digests without sending                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `PATCH /api/settings`            | not a guest       | settings patch (audited)                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /api/health`                | —                 | `{ ok, db }` for Railway healthchecks                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `/ui-gallery/*`                  | demo mode only    | the `@better-tracker/ui` component gallery with fixture props (no engine); 404 unless `LINEAR_FIXTURE=1` or `next dev`, checked per request                                                                                                                                                                                                                                                                                                           |

Security: session cookie `mp_session` (httpOnly, `SameSite=Lax`, `Secure` when
`APP_URL` is https, `Path=/`); OAuth cookie `mp_oauth` carries
`{state, codeVerifier, intent, returnTo}` signed with HMAC-SHA256
(`SESSION_SECRET`), 10-minute expiry, compared in constant time. Mutating routes
require same-origin `Origin` (or `Sec-Fetch-Site: same-origin`) and JSON bodies
validated with zod, read through one limited reader (`readJson`: at most 1 MiB,
else 413 `too_large` before anything is parsed; the webhook's limit is 5 MiB).
`returnTo` must be a relative path. Every page/route resolves the actor
server-side; the UI never decides permissions. Every mutating route above
(PATCH, POST and DELETE, but the auth routes and the webhook) answers a Linear
guest 403 `read_only` (owner decision 2026-10-22, "Guests limited to read only")
right after the CSRF guard and the session, before its body is read:
`refuseReadOnly` in `lib/http.ts` runs the engine's own `requireWritable`, so
the routes and the engine refuse with the same code and sentence, and
`errorResponse` maps an engine `read_only` to 403 as well. A "write access" row
above is therefore never a guest; the pages and GET routes stay open to one.
Every engine read made for a person passes that actor as the `viewer` (§7,
§2.13: pages, the palette, the issue read and search, the run detail, the audit
and the digest preview; `lib/load.ts`'s cached view loaders take it from the
request), so a private team's data reaches only its members and a guest sees
only their teams. Every response carries `lib/security-headers.ts`: a
Content-Security-Policy (`default-src 'self'`, `object-src 'none'`,
`base-uri 'none'`, `frame-ancestors 'none'`, `connect-src 'self'`,
`form-action 'self' https://linear.app`; `script-src` and `style-src` keep
`'unsafe-inline'`, because Next streams the server-component payload as inline
scripts, the layouts inline the pre-paint theme and sidebar scripts and React
positions with style attributes; a nonce would need a proxy and dynamic
rendering of every page; development adds `'unsafe-eval'`),
`Strict-Transport-Security: max-age=31536000; includeSubDomains` (ignored by
browsers over plain HTTP), `X-Frame-Options: DENY`, `nosniff`, a strict-origin
referrer policy and a Permissions-Policy.

Auth and frame details (decided while building `apps/planner`; binding):

- A signed-out visit to a page (a digest's `/timeline?milestone=<id>` link
  opened on a phone, say) redirects to `/?returnTo=<the page's path and query>`;
  the landing page passes it on to "Sign in with Linear"
  (`/api/auth/linear?intent=signin&returnTo=…`) and to the demo picker's form
  (`POST /api/auth/demo` takes an optional `returnTo` field), so signing in
  lands there, not on My week. A signed-in visitor of `/?returnTo=…` goes
  straight there. The same `sanitizeReturnTo` rules apply at every hop.
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
  (install/grant_write without a session), `read_only` (install/grant_write
  started by a Linear guest, or the engine refusing a guest's write grant at the
  callback: "You are a guest in Linear, so the planner is read-only for you…"),
  `session_secret`, `invalid_request` or `internal` (logged). The demo sign-in
  reports the engine's `invalid` (a deactivated person or the app user) as
  `demo_inactive`. A signed-in visitor sees the error on `/` instead of being
  sent to `/week`. A sign-in that replaces a session ends the old one in
  `after()`.
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
  are the person's open My week issues and open the planner's issue page
  (`/issues/<key>`, where Linear is one click away). An inactive project's
  entries (§2.8) are `muted` (grey mark, label ending "· inactive project"); a
  complete milestone's hint reads "complete · Oct 1", not "due Oct 1".
- Unmatched page URLs render `(app)/not-found.tsx` inside the frame (a
  `[...missing]` catch-all, since the two root layouts leave Next without a
  single root 404); like every `(app)` page it streams under
  `(app)/loading.tsx`, so `redirect()`/`notFound()` there are client-side (meta
  refresh / `noindex`, status 200). Unmatched `/api/*` paths answer a JSON 404.
- `/tasks` → `/issues` is a `next.config.ts` `redirects()` entry
  (`permanent: false`, a real 307 that keeps the query), because a page-level
  `redirect()` under `(app)` would stream under `loading.tsx` as a client-side
  refresh with status 200 (above). The Issues page lives in the
  `app/(app)/issues/(list)/` route group, beside `issues/[id]/`, so its
  `loading.tsx` never wraps the issue page (Next's `loading.js` wraps every page
  below its folder).
- `app/global-error.tsx` is the styled last resort when a root layout throws
  (the engine cannot start or read the session: database unreachable,
  configuration incomplete), which `(app)/error.tsx` does not wrap: the
  signed-out bar and Gr8r's full-page state (`MessageBlock`: a 22px icon, red
  for a failure and amber while the first sync is pending; a short label; a 19px
  headline; the copy; the error digest as a mono "Error reference" line; a
  retry), with no code keys; `(app)/not-found.tsx` and `(app)/error.tsx` use the
  same state. `/setup` offers no reinstall in demo mode (there is no OAuth
  there) and none to a Linear guest (the read-only notice instead of the install
  or reinstall button); elsewhere anyone signed in may start a reinstall
  (Linear's consent screen is what limits it to admins), and its install steps
  say the installer becomes the first watcher unless the deployment's
  `WATCHER_EMAILS` names someone.
- The fixture-mode picker on `/` is Gr8r's sign-in card: the demo people by name
  as full-width secondary buttons (round initials, name, email, a chevron; the
  accessible name reads "Sign in as <name> …"), with no role column or ordering
  by role, and a footnote saying that everyone can make every edit, except the
  guest. The demo's one Linear guest, Gus Hart (Operations only), carries a
  `Guest` chip and the note "Guest in Linear · sees one team, read only" in
  place of the email (`DemoUserRow.label`; Linear's guest flag, not a role).
  Below the card, what the planner does is a grid of six option cards with
  icons. Real mode's "Sign in with Linear" is the card's one large full-width
  primary `Button` (`size="lg"`, `block`). A sign-in error is a red alert at the
  top of the card; a signed-in person who hits one gets it as a full-page state.
  `?auth_error=not_pm` is no longer a known code (it reads as an unfinished
  sign-in).
- Engine errors are recognised by `name` + `code` as well as by class
  (`lib/engine-errors.ts`): the process-wide engine cached on `globalThis` may
  come from another route bundle's copy of the package, where `instanceof`
  fails.

Run log, sync and settings routes (decided while building `apps/planner`;
binding):

- `POST /api/runs`, `POST /api/sync`, `POST /api/warnings/preview` and
  `PATCH /api/settings` share one order (`lib/workspace-routes.ts`, renamed from
  `pm-routes.ts`): CSRF guard and session (`requireApiActor`) → the read-only
  check (`refuseReadOnly`: 403 `read_only` for a Linear guest, before the body
  is read; `fullSync` and the preview take no actor in the engine, so this is
  what keeps a guest from them) → strict zod body (unknown keys, a bad `mode`, a
  tuning value outside 1–90 or not whole, an empty patch or an empty `tuning`
  object: 400 before the engine, so a no-op never writes an audit entry; sync
  and preview take `{}`; `pmUserIds` is an unknown key) → the engine, errors
  mapped by `errorResponse`. There is no role check: any signed-in person of the
  workspace but a guest may call all four (owner decisions 2026-10-22), and
  nobody is ever answered `not_pm`.
- **Resync is one per workspace per minute from the web**: `POST /api/sync`
  answers 429 `resync_cooldown` with `Retry-After` (seconds) when the same
  workspace's last web resync was accepted less than 60 s ago (per process, like
  the engine; a signed-out, cross-origin, read-only (guest) or invalid request
  does not start the clock, a sync that fails does). A full sync pages every
  Linear connection with the app's token, whose hourly quota allocation, webhook
  refetches and the worker's sync share; the engine also joins concurrent syncs
  of a workspace into one (§7). Settings → Status says "Not synced: …" for it.
- **A live run is gated by the saved mode**: `POST /api/runs { mode: 'live' }`
  answers 409 `live_runs_off` while `settings.allocationMode` is `dry_run`
  (§7.4: dry run until someone switches it live in Settings → Modes, which
  anyone signed in may do; the switch is a `settings.update` audit entry). Only
  the web route is gated; the worker's `allocate --live` is an operator command.
  Answers: `/api/runs` 201 `{ run }` (the finished run; the run takes as long as
  its sync), `/api/sync` 200 `{ sync }` (a `SyncResult`, `ok: false` carries the
  error), `/api/warnings/preview` 200 `{ preview }` (the digests mapped for
  display with app-relative `/timeline?…` links; nothing recorded or sent),
  `/api/settings` 200 `{ settings }`. A partial `tuning` is passed through; the
  engine merges it over the saved tuning.
- `/settings?section=modes|watchers|schedule|status|notifications|audit`
  (default Modes; the old `?section=people` opens Watchers) shows one section
  beside the sub-nav; each section's form PATCHes only its own fields. Every
  section is editable by everyone signed in but a Linear guest; there is no PM
  copy, and the chip beside each section's title says what the section does
  ("Audited" for Modes, Watchers and Schedule) rather than who may use it. A
  guest (owner decision 2026-10-22, "Guests limited to read only") gets the
  read-only mode: every section shows its values as plain text
  (`ReadOnlySettings` / `ReadOnlyWatchers` in `settings/read-only-sections.tsx`,
  rows from `modesReadOnlyRows` and `scheduleReadOnlyRows`) with no switch, box,
  input, Save or Reset, Status has no Resync or Preview, the title's chip reads
  "Read only", and one read-only notice sits under the section's sentence in
  Modes, Watchers, Schedule and Status. Watchers (the section that was People)
  lists active non-app people plus deactivated people still watching, with one
  Watcher box each (no PM column, no locked box: the watcher list may be
  emptied, and then only leads are warned; the hint and the save toast say so).
  The Audit section reads entries saved before 2026-10-22 as they were saved: a
  change to the retired PM list reads "PM list (retired): … → …", and the save
  that dropped the field is not reported as a change. Slack status is not shown:
  the engine exposes no "Slack configured" flag.
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
  rows open `/timeline?milestone=<id>`, issue rows the issue's slide-over on the
  graph (`?issue=<key>`, §8.5; they opened Linear before the owner decision of
  2026-10-21). The receipts and the block meta count drawn vs listed ("4 of 14
  milestones"), and Copy Mermaid copies the drawn graph. In the graph's older
  drawing (not restyled yet, §8 intro) milestone nodes take the accent only when
  at risk or overdue (a later milestone's unassigned issues are normal; they
  keep the `UNASSIGNED` chip), and issue nodes when open and unassigned or
  overdue; its restyle moves these to the §8.2 status tones.
- `/runs/[id]` answers the not-found page for an unknown id; already-assigned
  skips are collapsed into one count per project.
- The run and settings registers stack into cards by their own width
  (`stackWithin`), not the viewport's: beside the 252px sidebar and the 220px
  settings nav, a 1024px window leaves the Notifications and Audit registers
  about 470px wide (730px at 1280). Run cards flow their eight cells into as
  many ~120px columns as fit (two rows at 1024 and 1280, three on a phone). The
  Notifications register leads with the recipient (channel under the name) in
  five columns, so it stays a table at 700px; the Audit "When" column is fixed
  at 152px so the time fits one line.

### 8.2 Visual language (Gr8r Studio, purple accent)

The tokens live in `packages/ui/src/styles/tokens.css` (light block, then two
identical dark blocks: `html[data-theme='dark']`/wrapper, and
`data-theme="system"` under `prefers-color-scheme: dark`); the reset, block
chrome and shared classes in `tokens.css` and `primitives.css`, all scoped as
the ui README describes. Gr8r's values are copied, not approximated; the only
changes are the purple accent, a darker text step for the semantic hues in light
(below) and the planner's own extra tokens (`--accent-ink*`, `--on-danger`,
`--st-triage`, `--st-canceled`, `--shadow-raised`, `--shadow-drawer`, the
`-line` tints, `--r-chip`, `--r-xl`, the `--fw-*`, `--lh*` and `--ls-*` steps).

- **Surfaces**, back to front: `--bg` (page behind everything; signed-out
  pages), `--bg-side` (sidebar), `--surface` (main column, panels, cards,
  drawer, menus), `--surface-2` (hover fill), `--surface-3` (pressed / on,
  tracks), `--sunken` (recessed wells: group rows, weekends, footers),
  `--overlay` (scrim). Light
  `#fbfaf8 / #f4f3f0 / #ffffff / #f6f5f2 / #eeede9 / #f7f6f3`; dark (a warm
  charcoal, redefined, not inverted)
  `#1a1a19 / #151514 / #1d1d1c / #252524 / #2d2d2b / #181817`.
- **Lines**, by weight: `--divider` (row separators inside a container) <
  `--border` (container edges, section rules, toolbars, column headers) <
  `--border-strong` (inputs, secondary buttons, checkboxes, hover outlines).
  Light `#f0eeea / #e9e7e2 / #dad7d0`. No `#000` line anywhere; no `-1px` margin
  collapses.
- **Text**: `--text` (`#1d1c1a`, never `#000`), `--text-2` (secondary, idle nav,
  ghost buttons), `--text-3` (meta, counts, placeholders, column headers),
  `--text-4` (idle icons and glyphs only, never words), `--text-inv` (on an
  inverted fill: toast, tooltip).
- **Accent** `#9747ff` in both themes, with `--on-accent` white (4.51:1). Its
  roles, as Gr8r's: the primary button, focus rings, selection (`--accent-soft`
  row fill, checked checkbox / switch), progress fills, the today marker, unread
  / new dots and counts, query highlights, accent links. It never means a
  status. Tints derive by `color-mix`: `--accent-soft` 10%, `--accent-line` 38%,
  `--accent-hover` / `--accent-active` (88% / 78% toward warm black). Purple
  **text** is `--accent-ink`, which reads at least 4.5:1 on every surface and on
  `--accent-soft`: `#7c33ea` in light (5.97:1 on white, 4.64:1 on the soft tint
  over the sidebar), `#b385ff` in dark (6.20:1 on `#1d1d1c`, 4.80:1 on the soft
  tint over `--surface-2`); hovered `--accent-ink-hover` `#6b28d0` / `#c4a0ff`.
- **Semantic hues** carry status and risk: `--red` (danger), `--amber`
  (warning), `--green` (success), `--blue` (info), each with `-soft` (10–12%)
  and `-line` (38%) tints. Light uses Gr8r's hues one step darker so they stay
  text-safe on every surface and on their own tint (`#b03b2f`, `#88590d`,
  `#247149`, `#2f63ae`; Gr8r's `#3570c4` blue is only 4.33:1 on its tint); dark
  uses Gr8r's pastels (`#e57d70`, `#d8a443`, `#5cba86`, `#72a5ea`). `--violet`,
  `--teal`, `--rose`, `--orange`, `--gray` are for dots, swatches and avatar
  tints only (a project chip's dot, a person's avatar), never a status.
  `--on-danger` is the text on a `--red` fill.
- **Workflow-state hues** for `StateGlyph`: `--st-triage` (orange),
  `--st-backlog`, `--st-todo` (greys), `--st-progress` (amber), `--st-review`
  (violet), `--st-done` (green), `--st-canceled` (faint grey). Glyph colours,
  not text colours.
- **Tones in code**: `UiTone = 'default' | 'muted' | 'accent' | SemanticTone`
  and `SemanticTone = 'danger' | 'warning' | 'success' | 'info'`
  (`packages/ui/src/types.ts`); `ChipTone` adds `'inverse'` for old callers.
  Components render the tone as `data-tone`, and `primitives.css` gives every
  `[data-tone]` element `--tone` (fills, dots, icons), `--tone-ink` (text,
  4.5:1), `--tone-soft` and `--tone-line`, so a component colours itself from
  them without one rule per value.
- **Elevation** only for things that float or can be picked up: popovers, menus,
  pickers, modals, the command palette and toasts `--shadow-pop`; the drawer
  `--shadow-drawer` plus a 1px `--border` left edge (`--border-strong` in dark,
  where the drawer and the page share one surface); dragged bars
  `--shadow-drag`; card-like rows that can be picked up `--shadow-card`;
  secondary buttons `--shadow-sm`; the raised white pill of a selected segment
  or the active sidebar / settings nav item `--shadow-raised`. Panels, rows,
  banners, chips and inputs have none. Shadows are warm (`rgba(28, 25, 20, …)`)
  in light; dark keeps only rings and deep drops.
- **Radius**: `--r-xs` 4px (checkbox, kbd, focus ring, tiny icon buttons),
  `--r-chip` 5px (chips, badges, segmented options, tooltips), `--r-sm` 6px
  (buttons, inputs, nav and menu items, timeline bars, the segmented track),
  `--r` 8px (notices, alerts, toasts, cards), `--r-lg` 10px (panels, boxed
  lists, popovers, empty states), `--r-xl` 12px (modals, command palette, full
  drawer), 50% (avatars, status marks, dots).
- **Panels vs flat**: a list, table or chart inside a scrolling page sits in a
  panel (`--surface`, 1px `--border`, `--r-lg`, no shadow), with rows split by
  `--divider` that never touch the panel edge; a four-number strip is one such
  panel split into cells by `--border` rules. Recessed areas use `--sunken`, not
  boxes.
- **Type**: Geist (`--font-sans`) for every word, 400 body at `--fs` 13.5px and
  `--lh` 1.45 with `ss01` + `cv11`; weights 450 (`--fw-soft`: nav items, dense
  titles), 500 (buttons, labels, meta, active nav), 600 (headings, group
  headers, stat values); never 300 or 700. Scale: `--fs-2xs` 11 (counts,
  eyebrows), `--fs-xs` 12 (meta, chips, column headers), `--fs-sm` 12.5
  (buttons, group headers, secondary), `--fs` 13.5 (body, rows, inputs),
  `--fs-md` 14.5 (section titles), `--fs-xl` 19 (drawer / issue title),
  `--fs-2xl` 23 (page title, `--ls-title`). Everything is sentence case. The one
  uppercase voice is the `.eyebrow` (11px, 600, `0.06em`, `--text-3`) for
  sidebar, menu, palette and day section headers. **Geist Mono** (`--font-mono`,
  via `next/font` `--font-geist-mono`) is only for issue keys, `kbd`, code and
  error codes (`.mono`: 0.92em, `-0.01em`); dates, counts and numbers are Geist
  with tabular figures (`.num`).
- **Controls**: `Button` primary (purple fill), secondary (white, strong border,
  `--shadow-sm`), quiet (ghost: fill on hover), danger (red fill, for a
  destructive or irreversible write), 30px (sm 26px; lg 36px for a card's one
  call to action; `block` stretches it across), pressed `scale(0.97)`; fields
  30px, `--border-strong`, `--r-sm`, focus = accent border + 3px `--accent-soft`
  halo; checkbox 15px rounded, accent when checked; switch a 30×18 track with a
  sliding knob (`aria-label` / `aria-labelledby` name it by its row when the
  visible word is shared, "Allocation live"); segmented control a `--surface-3`
  track with a raised white thumb; tabs a `--border` bar with a 2px `--text`
  underline (not the accent); icon buttons 26px ghosts, `--text-2`, hovering to
  `--surface-2` (`--surface-3` on the grey sidebar and the signed-out page).
  Focus elsewhere is a 2px accent outline, offset 1px.
- **People**: round initials avatars (22px in the sidebar, 20px in pickers, 26px
  beside comments, in the watcher list and the sign-in card), 600 initials at
  0.4× the size inside a 1.5px `--surface` ring; neutral `--surface-3` in the
  shell and lists, a 17% tint of a decorative hue picked from the name in the
  task view; nobody (unassigned) is a dashed empty circle. Never square.
- **Chips and notices**: a `Chip` is Gr8r's badge (20px, `--r-chip`, 12px 500):
  neutral by default, the tone's ink on its soft tint for a status or a call to
  action, or with `dot` a neutral bordered pill with a 6px dot in the tone's hue
  for a lifecycle status (a Linear project status, a run's mode). A `Notice` /
  alert is a `--r` box: neutral (`default`, `muted`) bordered, any other tone
  filled with its soft tint, the lead-in in the tone's ink and the copy in
  `--text`. Empty states are a soft `--r-lg` box with an optional title
  (`--fs-md` 600 over the `--fs-sm` `--text-2` sentence); one that reports a
  missing input gets a dashed edge (`.hatched`).
- **No texture, no numbers**: hatching is retired (`--hatch` is `transparent`);
  "missing" is drawn as a dashed `--border-strong` outline. `BlockBar` /
  `.blockBar` is a section heading row (14.5px semibold, quiet meta on the
  right), with no box and no section number (`index` is ignored).
- **Kept from before**: hover styles only behind
  `@media (hover: hover) and (width >= 901px)`; a designed
  `prefers-reduced-motion` state (transitions off, no scale or lift); form
  fields 16px on phones and touch screens (`width <= 640px` or
  `pointer: coarse`) so iOS Safari does not zoom; the scoped-stylesheet mode (ui
  README). Motion uses Gr8r's `--ease`, `--spring`, `--ease-drawer` and `--dur`
  140ms. A timeline bar's sticky label is capped to the part of the bar still
  visible beside the lane column (the bar's end less the chart's scroll offset),
  so the receipts drop out and the name stays readable rather than sliding under
  it.
- **Old token names** stay as aliases only for the graph's older drawing (the
  one screen still on them, see the §8 intro) and go when it moves; new code
  does not use them: `--paper`, `--background` → `--surface`; `--ink`,
  `--foreground`, `--ink-soft` → `--text`; `--muted` → `--text-2`;
  `--grey-2-ink` → `--text-3`; `--grey-2` → `--text-4`; `--grey-3` →
  `--border-strong`; `--grey-4` → `--surface-3`; `--hairline-faint` →
  `--divider`; `--tint` → `--surface-2`. `--accent-ink-inverse`,
  `--muted-inverse`, `--ink-soft-inverse` and `--hairline-inverse` exist only
  for the graph's ink hover flood (a flood must still swap them,
  `test/styles-contrast.test.ts`), and `--ease-out-quint` / `--ease-out-expo`
  are unused. `test/styles-contrast.test.ts` checks every text token at 4.5:1 on
  every surface and on its own tint, in both themes.

**Status colours.** One mapping for every screen; the label always travels with
the colour (text, `aria-label` or a tooltip), and a shape differs too wherever a
mark is drawn. Gr8r's own usage decides the hue: red for overdue dates, urgent
priority, at-risk projects and errors; amber for warnings, pending ("Invited"),
on hold and due within a day; green for done, success and good deltas; blue for
in-progress projects; grey for planning / inactive; the accent only for
selection, progress and unread.

| what                                   | value                                                                                                        | tone                                         | drawn as                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| milestone status (`StatusMark`)        | complete                                                                                                     | success                                      | green disc with a tick                                                                                                                     |
|                                        | on track                                                                                                     | success                                      | green ring                                                                                                                                 |
|                                        | at risk                                                                                                      | warning                                      | amber ring, right half filled                                                                                                              |
|                                        | overdue                                                                                                      | danger                                       | red disc                                                                                                                                   |
|                                        | unscheduled, empty, on track but rubric-invalid (`missing`)                                                  | muted                                        | dashed grey ring; the missing input is named in warning text                                                                               |
|                                        | any status of an inactive project (`muted`)                                                                  | muted                                        | faint grey ring; no tone anywhere in that row                                                                                              |
| timeline bar                           | as the milestone status                                                                                      | same                                         | the hue at 16% fill, 45% outline; done at 60% opacity                                                                                      |
| rubric item (`Checklist`)              | met / missing (no date, no "done means…", no lead, no issues)                                                | success / warning                            | green tick / amber, the word "Missing"                                                                                                     |
| risk reason                            | unassigned open issues, stalled, behind pace                                                                 | warning                                      | amber text or tinted chip                                                                                                                  |
| warning kind                           | overdue / at risk, invalid due soon, allocation blocked                                                      | danger / warning                             |                                                                                                                                            |
| allocation (projects register)         | allocating N                                                                                                 | info                                         | tinted chip                                                                                                                                |
|                                        | nothing to do                                                                                                | default                                      | neutral chip                                                                                                                               |
|                                        | blocked (no lead, lead inactive, next milestone invalid)                                                     | warning                                      | tinted chip; the reason line under it in `--text-2`                                                                                        |
|                                        | no open milestone, inactive, not evaluated                                                                   | muted                                        | quiet chip                                                                                                                                 |
| timeline banner                        | no lead, no date, blocked / unplanned                                                                        | warning / info                               | tinted callout                                                                                                                             |
| issue alert                            | overdue / blocked, holds up, stalled, unassigned                                                             | danger / warning                             | tinted alert                                                                                                                               |
| issue state (`StateGlyph`)             | triage, backlog, todo, in progress, done, canceled                                                           | `--st-*`                                     | orange dashed ring, grey dashed ring, grey ring, amber half ring, green disc + tick, faint ring + slash; the state name stays neutral text |
| priority (`PriorityGlyph`)             | urgent                                                                                                       | danger                                       | red rounded square with "!"; the label stays neutral                                                                                       |
|                                        | high, medium, low / none                                                                                     | none                                         | `--text-2` bars over `--border-strong` ghosts / three dashes                                                                               |
| due date                               | overdue / due today or tomorrow / later / an undated milestone (a missing input) / an issue with no due date | danger / warning / default / warning / muted | text colour; an issue's missing date is a muted "—"                                                                                        |
| progress (`ProgressRule`)              | overdue / behind pace / complete / inactive / otherwise                                                      | danger / warning / success / muted / default | fill; default is the accent                                                                                                                |
| run status                             | running / succeeded / partly failed / failed                                                                 | info / success / warning / danger            | tinted chip                                                                                                                                |
| allocation mode                        | dry run / live                                                                                               | muted / info                                 | `dot` pill                                                                                                                                 |
| run issue outcome                      | would assign / assigned / failed / not written, skipped                                                      | default / success / danger / muted           | chip                                                                                                                                       |
| Linear project status                  | backlog, planned / started / paused / completed / canceled                                                   | muted / info / warning / success / muted     | `dot` pill                                                                                                                                 |
| settings status                        | working, installed / not installed, never synced / revoked, sync failed / no webhook yet, demo               | success / warning / danger / muted           | value text                                                                                                                                 |
| My week numbers                        | overdue milestones / at risk / new to you / open issues                                                      | danger / warning / accent / default          | the value                                                                                                                                  |
| "New — given to you because…"          |                                                                                                              | accent                                       | tinted chip (unread)                                                                                                                       |
| errors (`Notice role="alert"`, toasts) |                                                                                                              | danger                                       | tinted notice; toast icon `--red`                                                                                                          |
| demo-data and read-only notices        |                                                                                                              | default                                      | neutral bordered notice                                                                                                                    |

### 8.3 Layout and interaction (from Gr8r Studio)

- **Shell** (`AppShell` and the rest of `packages/ui/src/shell/*`, wired up by
  the planner's `app/(app)/components/planner-shell.tsx`), Gr8r's two-tone
  frame: a fixed left **sidebar** (252px, `--bg-side`, 1px `--border` right
  edge, no texture) containing: a brand row in Gr8r's workspace-switcher form (a
  22px dark tile with the product's initials, "Milestone Planner" at `--fs` 600
  over the workspace name in `--text-3`, the collapse icon button), primary nav
  (My week with a count of this-week issues, Issues, Timeline, Projects, Graph,
  Runs: 30px rows at `--fs` / 450 in `--text-2` with 16px Lucide icons in
  `--text-4`, hover `--surface-3`; the current item a raised white pill,
  `--surface` + `--shadow-raised` at 500, in dark a `--surface-3` fill), a
  `Projects` section (uppercase eyebrow header with an "All" link) listing
  active projects with the status mark of each project's next milestone (click →
  `/timeline?project=<id>`), and a footer with Settings, the signed-in user (a
  22px round initials avatar; no role chip: there are no roles since the owner
  decision of 2026-10-22; a Linear guest's line carries a `Guest` badge,
  `GUEST_BADGE`, and someone read-only for another reason a `Read only` badge,
  `userBadge` from `ShellFrame.readOnly` and `readOnlyReason`), theme toggle and
  sign out as ghost icon buttons. The shell also provides `readOnlyReason` to
  every read-only notice and to the (app) error page, which says "The first sync
  from Linear has not landed yet." with Try again and Open Setup while it is
  `not_synced` (every mirror-backed page fails then). A nav count is a quiet
  `--fs-2xs` `--text-3` number; a `countTone` makes it a Gr8r badge (accent: a
  solid accent pill for new / unread; a status tone: its tinted pill). A 46px
  white **topbar** (`--border` bottom): a sentence-case breadcrumb on the left
  (`Timeline / Atlas migration`: `--fs-sm` `--text-2`, the current crumb
  `--text` 500, "/" in `--text-4`), and on the right the recessed "Search or
  jump to… Ctrl K" palette trigger (26px, `--sunken`, `--border`, `--r-sm`, key
  caps; at 1100px and below just its icon). `[` collapses the sidebar to a 52px
  icon rail (choice remembered in localStorage) with inverted tooltips.
- **Phone (≤ 900px)**: the sidebar becomes a 280px off-canvas drawer
  (`--shadow-pop`, over the `--overlay` scrim) opened from a topbar menu button;
  a fixed white bottom **tab bar** (`--border` top; 19px icons over 11px labels,
  `--text-3` idle, `--text` current: My week / Issues / Timeline / Projects /
  More, Graph and Runs living in More's drawer since the Issues page took
  Graph's place, owner request 2026-10-22) like Gr8r's phone layout; at ≤ 640px
  the topbar is 50px and shows only the current crumb; pages become single
  column.
- **Command palette** (Ctrl/⌘ K, or the topbar trigger): a centered 640px white
  card (`--r-xl`, `--shadow-pop`) over the `--overlay` scrim (no blur; dark mode
  darkens the page rather than veiling it); a 50px input row, uppercase eyebrow
  section headers, 38px rows with a `--surface-2` active highlight, query
  matches in `--accent-ink` 600, a `--sunken` footer of key hints; sections
  _Suggestions_ (`PALETTE_SUGGESTIONS` in `lib/adapters/shell.ts`, the same for
  everyone, hinted by what they do, never by a role: "Preview allocation (dry
  run)", "Resync from Linear", "Switch theme"; a Linear guest gets only "Switch
  theme", `paletteSuggestions(readOnly)`), _Jump to_ (projects, milestones, the
  user's open issues by identifier — fetched from `/api/palette` on first open),
  and _Navigation_ with two-key shortcuts (G W My week, G I Issues, G T
  Timeline, G P Projects, G G Graph, G R Runs, G S Settings; a nav target's
  optional `hint` is its item's hint, so "tasks" finds Issues, hinted "All
  tasks"). ↑/↓ move, ↵ selects, Tab cycles sections, Esc closes; fuzzy match on
  label + identifier (a hint matches only as a substring or a run of word
  starts, "eng24" → `ENG-24`, so a project's "Project · <lead>" hint never pulls
  it in by scattered letters). On a phone the hint ellipsizes before the label.
  `?` opens a shortcuts sheet. The palette API's `isSequencePending()` is true
  between a sequence's first key and its second (1.2 s); a page's own single-key
  commands (the issue list's `m`, `a`, `s`, `p` on a focused row) yield while it
  is true, so G S and G P still navigate with a row focused.
- **Acting on lists** (`packages/ui`, for the Issues page; Gr8r's list view):
  `TaskGroupTable` takes optional `selection` (a checkbox per row, tri-state
  group and column-header boxes, shift-click ranges, `x`, Shift+↑/↓, ⌘/Ctrl+A;
  selected rows `--accent-soft`, the checkbox carrying the state, never
  `aria-selected` on the list items), `drag` (HTML5, from an 18px grip shown on
  row hover under `(hover: hover) and (pointer: fine)` only; a selected row
  carries the selection; a target group gets a 6% accent wash and an inset
  `--accent-line`, a refused one the not-allowed cursor and its reason in the
  header; no reordering inside a group), and slots (`renderCell` for cell
  pickers with `appearance="cell"`, `rowActions`, `groupActions`,
  `onRowContextMenu`). Without them it renders My week exactly as before.
  `ViewToolbar` (Gr8r's `.toolbar`: 26px search, Filter / Sort / Group, end
  actions, a 2px accent progress rule while busy), `FilterChips` (`.chipsbar`:
  accent-tinted chips joined by "and", amber for a value the planner cannot
  find, Clear all) and `BulkBar` (`.bulkbar`: the inverted `--text` toolbar at
  the bottom centre, a polite count, an inline confirm strip, busy and limit
  notes, Esc clears) complete it; menus are `PickerPopover` with
  `searchable={false}`. Details in `packages/ui/README.md`.
- **Toasts**: a bottom-right stack (full width above the tab bar on phones) of
  Gr8r's inverted cards (`--text` fill, `--text-inv` ink, `--r`,
  `--shadow-pop`): a 15px icon (an error's is red), the semibold lead-in word
  and one sentence, an optional action, auto-dismiss after 4 s (a thin countdown
  line, paused on hover or focus), `aria-live="polite"` (errors assertive); used
  after saves, runs and copies.
- **Loading**: `loading.tsx` per route renders Gr8r's shimmer skeletons
  (5px-radius bars shimmering from `--surface-3` to `--surface-2`, round marks,
  40px rows split by `--divider`) in the page's real layout, not spinners;
  reduced motion holds them still.
- **Alerts and key caps**: `AlertStrip` is Gr8r's alert tinted by `tone`
  (data-tone, default `warning`): the tone's soft fill, no border, `--r`, the
  lead-in word and the follow-up in the tone's text colour, the sentence in
  `--text`; `default` / `muted` are a bordered neutral box. `Kbd` is Gr8r's
  keycap: Geist Mono 11px in an 18px `--surface` cap, `--r-xs`, 1px `--border`
  with a 1.5px bottom edge, `--text-2`, printed in the key's case.
- **Signed out**: `SignedOutFrame` is Gr8r's auth frame: the `--bg` page with a
  plain top row (the brand tile and product name, an optional neutral badge such
  as "Demo", the theme toggle), no box, rule or texture.
- **Slide-over drawer** (milestone details): opens from the right over the
  content (no scrim on desktop; on a phone full width over the `--overlay`
  scrim), white with `--shadow-drawer` and a 1px left edge (`--border`;
  `--border-strong` in dark), easing in from 48px, 560px wide; a 46px header bar
  with the `Project / Milestone` breadcrumb (`--fs-sm` `--text-2`) and ghost
  actions (open in Linear, copy link, close); the title (`--fs-xl` 600) scrolls
  with the body; an alert strip when overdue (`AlertStrip tone="danger"`:
  "Overdue by 3 days. Reschedule" focusing the date field), then Gr8r's property
  list (`PropertyList`, `.kv`: a 112px column of `--text-2` labels with
  `--text-4` icons, 30px rows, no rules; each label sits on its value's first
  text baseline, so it stays level with a field's text or the first line of a
  tall value rather than its middle): Status, Due date, Lead, Progress, Weight,
  Next milestone, Done means…; then the rubric checklist, risk reasons, issues,
  and "Waits on". Linkable via `?milestone=<id>`; Esc closes; focus is trapped
  while open and returned on close. Esc in the Weight or "Done means…" field
  while it holds unsaved text puts the saved value back instead (the drawer
  stays); the next Esc closes. When the panel swaps its content in place
  (milestone → one of its issues, a relation row → another issue, "‹ Back to
  <milestone>", a "Waits on" row), SlideOver's `contentKey` changes: the body
  scrolls to the top and focus that was in the panel, or fell to `<body>`
  because the focused row unmounted, moves to the panel, so the new title is
  announced and Tab starts at the header; focus on a page row that swapped it
  stays there.

### 8.4 Pages

- **My week** (Gr8r Home + My Tasks, one screen as §2 Goal 1 asks): header "Good
  morning, Pat" (page title, §8.2) + a receipts line ("Wednesday, October 21 · 4
  issues due this week · 1 milestone overdue") with the "Showing" person picker
  on the right; a four-cell stats strip (Open issues · this week, Overdue
  milestones, New to you, At risk in your projects) as Gr8r's stat strip: one
  `--r-lg` panel split by soft rules, each number in its status colour (overdue
  danger, at risk warning, new to you the accent, open issues neutral; a zero is
  never coloured); then two columns. Main column: the list in Gr8r's
  grouped-list form, as one panel — column headers (Issue / State / Priority /
  Due; no Project column, because every group heading names the project and
  beside the deadlines panel a fifth column left titles unreadably narrow),
  "This week" (always shown once anything is open) and "Later" section bands on
  `--sunken`, collapsible group rows per milestone in Gr8r's group-header form
  (chevron, status mark, `Project / Milestone`, issue count, then due + days
  left in the due-date colour and `completed/scope` with a 4px progress bar: the
  accent fill, danger when overdue, warning when behind pace), flat rows split
  by `--divider` with the identifier (Geist Mono), title (opens the issue
  slide-over, `?issue=<key>`, §8.5; a separate ↗ icon beside it opens the issue
  in Linear; the open row takes the accent tint), state and priority glyphs in
  their colours beside neutral labels, the due date (danger overdue, warning due
  today or tomorrow), and the accent chip "New — given to you because you lead
  <Project>" (an empty This week says "Nothing of yours is due this week."); a
  final "No milestone" band with one group per project
  (`Project / Issues without a milestone`, linking to `/timeline?project=`; a
  completed or canceled project has no lane, so its group is not a link), then
  "Issues without a project or milestone". "At risk in your projects" counts the
  milestones of active projects the person leads whose status is at risk or
  overdue (§2.5) — a blocked project whose next milestone is on track is not at
  risk; it appears under "Needs attention" with its reason. Inactive projects
  (§2.8) are never loud here: the person's issues in them stay in the list,
  under "Later", their group drawn quietly (grey mark named "<status> · inactive
  project", "Inactive project" for the days left, a grey date and progress
  fill), but This week, the this-week counts (receipts, the Open issues note,
  the sidebar's My week count), "Overdue milestones", "At risk in your
  projects", the deadlines and "Needs attention" leave them out; the two stats
  add "+1 in an inactive project" and the empty "Needs attention" names the
  inactive project it left out. The two columns sit side by side only while the
  content area (not the viewport) is at least 1040px wide; below that the
  deadlines and attention panels stack under the list. The grouped list stacks
  its rows (key and title, then state · priority · due) by its own width, under
  720px (a container query, not the viewport's 900px: beside the deadlines a
  901–1100px window leaves the table 550–750px); a group heading keeps the mark,
  `Project /`, milestone and count on one line (the project ellipsizes first,
  the milestone wraps in place), and a row's ↗ stays on its title's last line.
  Right column, each under its section title in a `--r-lg` panel (Gr8r "Upcoming
  deadlines"): milestones the user leads or has issues in, grouped Overdue /
  Today / Tomorrow / This week (up to 6 days out; a group that holds something
  colours its label and dates: Overdue danger, Today and Tomorrow warning); and
  "Needs attention" for projects the user leads that are blocked (the reason
  under the name, a warning "Blocked" chip) or have unassigned next-milestone
  issues (a warning "N unassigned" chip). Everyone gets a person picker
  (`?user=<id>`, honoured on the server for anyone signed in, only for people in
  the mirror). Beside it, one quiet link to the Issues page: "All my issues"
  (`/issues?assignee=me`) on your own week, "All of <first name>'s issues"
  (`/issues?assignee=<id>`) on someone else's (`WeekPageModel.allIssuesHref` and
  `allIssuesLabel`); it lists the same open issues in the weight order, without
  the This week / Later split and with inactive projects last.
- **Issues** (Gr8r's Tasks page; owner request 2026-10-22, "every issue in one
  list"; `app/(app)/issues/(list)/`, `lib/adapters/issue-list.ts`): every issue
  the person can see, filtered, weight-ordered and grouped on the server by
  core's `buildIssueList` (§2.14, over the viewer's snapshot, §2.13), the client
  island only following the URL. Issues move from it one at a time, in bulk or
  by dragging (see Moving below; §7.3 has the engine).
  - **URL** (the whole view; `parseIssueListParams`, `issueListHref`):
    `q, initiative, project, milestone, assignee, team, state, priority, quick, group, sections, sort, dir, limit, issue`
    in that order, values comma-separated (`none` = no project / milestone /
    initiative / assignee, `me` = whoever opens the link; priorities as
    `urgent,high,medium,low,none`; `state=all` for every status, none for the
    four open types), defaults left out (`group=milestone`, `sections=none`,
    `sort=weight`, the sort's own `dir`, `limit=500`). Lenient: unknown
    parameters and values are dropped by core's `normalizeIssueListQuery` (50
    values per field, 200 characters per value and for `q`, `limit` stepped by
    500 to 2,000, a sections level that cannot divide the grouping dropped); a
    non-canonical URL is rewritten in place (`history.replaceState`, no
    refetch). Every discrete change (a value, a tab, the grouping, the sort,
    Clear all, "Only this …") is a `router.push` in a transition; the search
    applies 250 ms after typing stops, its first change pushed and the rest
    replaced (one history entry per search, so Back leaves it); Show more
    replaces. While the server answers, the old list stays at 60% opacity with
    `aria-busy` and the toolbar's 2px accent progress rule. The island follows
    the address bar (Back, Forward, a tab or sidebar link), skipping the URLs it
    wrote and keeping a half-typed search while the URL still means the view
    shown. Changing a filter starts the row budget over; removing a project from
    the project filter drops that project's milestones from the milestone filter
    (`withFilterValues`).
  - **Header**: "Issues", "Every issue across {n} projects.", and quiet
    receipts: "{all} open issues · {unplanned} without a milestone · {blocked}
    blocked · {at risk} at risk" with the default filters, else "{total} match
    these filters · {all} open in all", plus " · showing {shown}" when the row
    budget cut the list. Under it the preset tabs (`NavTabs`, scrolling sideways
    on a phone): All · Mine · Unplanned · Unassigned · Blocked · At risk, each
    with its own preset's count (`IssueListView.counts`, so the count is what
    the tab then shows), each keeping the grouping, sections and sort, current
    only when the filters are exactly its preset's. A plain click on a tab goes
    through the island like any other view change (`NavTabItem.onFollow`): the
    tab, chips and busy list follow at once; its href still opens a new tab.
  - **Notices** under the tabs, quiet `Notice tone="default"` lines in this
    order: the read-only notice (a guest); "Linear read only · Allow edits in
    Linear to change issues here." with the grant link back to the view (no
    write grant, not a guest); the no-initiatives fallback worded by why (a
    guest: "Linear shows guests no initiatives, so this list covers every
    project you can see."; someone the mirror does not know yet; a workspace
    without initiatives: "… so the list is grouped by project."); a filter
    naming something the planner lacks ("… closed, deleted, or in a team you
    cannot see …"); each project of a chosen initiative that counts under
    another first initiative; closed issues' coverage with a closed status; more
    than 200 groups.
  - **Toolbar** (`ViewToolbar`): "Search issues" (`/` focuses it), **Filter**
    (`f` opens it; an accent badge counts the set fields, the default status not
    counted), **Sort: Weight**, **Group: Milestone** ("· by initiative" with
    sections; on a phone the "Sort:" / "Group:" words drop), and at the right
    **Open as graph** (the narrowest single milestone, else project, filtered;
    `none` is not a container; otherwise `/graph`; this branch's graph has no
    initiative level yet) and **Copy link** (the address bar's URL; "Link
    copied."). Every menu is a `PickerPopover` with `searchable={false}`: Filter
    lists the fields (Initiative only for a viewer with initiatives, Team only
    with two or more teams) and the quick filters (Blocked, At risk, In next
    milestones; hinted "On" while set); Sort and Group are one multi-select list
    with one choice per part, each chosen one marked with the trailing accent
    tick (`marks="tick"`), not checkbox squares (sort and direction; grouping
    and sections, a section level that cannot divide the grouping disabled with
    "Already grouped by …"; for a viewer without initiatives the initiative
    choices are disabled, and the island applies core's fallback to the URL's
    view too, `withoutInitiatives`, so a guest's `?group=initiative` reads
    "Group: Project", as the list is grouped). A "?" sheet group "Issues" lists
    `/`, F and G I while the page is mounted. The search's first change pushes
    one history entry and later changes replace it only once that entry is in
    the address bar (a replace sent while the push is pending would cancel it,
    and Back would skip the unfiltered list).
  - **Chips** (`FilterChips`): one per set field in URL order, "{Field} is
    {values}" ("3 projects" from three values on; "Not found", amber, for an id
    the planner lacks), then one per quick filter ("Issue is blocked"), joined
    by "and"; the default status reads "Status is open" and removing it means
    every status (`state=all`), which then reads "Status is any" (counted in the
    badge; its × goes back to open issues), so closed issues never come in
    without a chip saying so. Choosing a field in the Filter menu adds a pending
    "{Field} is …" chip with its picker open (it goes away if closed with
    nothing chosen); clicking a chip reopens its multi-select picker, which
    stays open while values toggle, each toggle applied at once. The pickers
    that list workspace data fetch `GET /api/issues/options` on first open
    (`use-issue-list-options.ts`, refetched when the page renders a newer mirror
    version; a failure offers Retry) and are filtered by the page, at most 200
    options then a disabled "Keep typing to narrow N more": initiatives then "No
    initiative"; projects as Active projects, Other projects, then "No project";
    milestones by project in timeline order (only the filtered projects' when a
    project filter is set), each with its status mark and date, then "No
    milestone"; people as "Me (name)", "Unassigned", active people, deactivated
    ones hinted; teams; the six status types; the five priorities. "+ Filter"
    opens the same menu; Clear all restores the default filters, keeps the
    layout and is disabled when there is nothing to clear.
  - **List**: one `TaskGroupTable` panel (column header sticky under the topbar,
    collapsed groups remembered per viewer and grouping under
    `milestone-planner:issues:collapsed:<group>`, complete milestones and groups
    whose rows the budget left out folded by default; the header paints above
    every in-row control while rows scroll under it). Columns Milestone (the
    milestone's name, then " · {project}" muted and cut first, the project left
    out when project groups or sections already name it; the full "Project ›
    Milestone" as its tooltip; or a muted "No milestone") · Assignee · Status ·
    Priority · Due, minus the one the grouping names. When the list is too
    narrow for them beside a readable title (`dropColumns`: 260px of title at
    1160, 1000 and 860px of list width), Due goes first, then Priority, Status
    and Assignee; the Milestone column never does; below 720px the cards show
    them all. Grouped by milestone without sections, the tiers divide it:
    Overdue / Upcoming / No milestone / Inactive projects. Milestone groups
    carry the status mark, the project eyebrow, the milestone (linking to its
    timeline drawer), "Next" and "↑2" tags, the count of every match, the due
    date and countdown, the whole milestone's progress and an amber "Missing: …"
    line when it fails the rubric; a project's "No milestone" and "No project"
    groups; project groups (the next milestone's mark or "No open milestone",
    the first initiative as eyebrow, "Lead: <name>", an amber "No lead" or
    "Allocation stopped: <why>" line on an active project); initiative groups
    ("{n} projects"); people ("<name> (you)" first, "· deactivated", Unassigned
    last, avatar marks); statuses by name across teams; all five priorities;
    "All issues". Rows: the mono key, the title (opens the slide-over, §8.5; the
    ↗ opens Linear), a warning "Blocked" chip (open blockers) and "Holds up
    <milestone>" chip, the assignee ("Unassigned" amber when it is in its active
    project's next milestone), the state and priority glyphs, and the issue's
    own due date (danger overdue, warning today or tomorrow); a closed issue is
    struck through, and an inactive project's rows carry no tone at all. A group
    showing fewer rows than it holds ends with "Showing 12 of 212" (or "212
    issues not shown") · **Show more** (+500 rows, up to 2,000, then "Narrow the
    filter to see the rest.") · **Only this milestone** (project, person,
    priority, "Only In progress issues", …: that group's own filter in place of
    the field's value). With one to five projects in the project filter (grouped
    by milestone) their open milestones are listed even when empty: "No open
    issues here yet." when the milestone has none, else "None of its 3 open
    issues match these filters. · Only this milestone". Nothing matching at all:
    "No open issues match these filters." (or "No issues …" with an explicit
    status) and Clear filters.
  - **Phone** (≤ 768px 16px gutters): the header and tabs as above, the toolbar
    in two rows (search, then the controls scrolling sideways), rows as cards by
    the list's own width (as My week), the slide-over full screen. A touch
    screen or a phone (`(pointer: coarse), (width <= 640px)`) has no checkboxes
    until the toolbar's **Select** button turns selection mode on ("Done" turns
    it off and clears the selection); a tap on a card then selects it instead of
    opening it. Both are decided in CSS (`hideOnTouch`, and the Select button
    rendered always and shown by the same query), so the server's markup and the
    hydrated page agree and no checkbox flashes on load. The bulk bar sits above
    the tab bar with Move to milestone, Assignee and **More** (statuses and
    priorities in one grouped list), its labels hidden at 390px; the list keeps
    72px of room under its last row while anything is selected. Pickers open as
    bottom sheets; there is no drag.
  - **Moving** (`issues-screen.tsx`, `issue-row-actions.tsx`,
    `use-issue-moves.ts`; pure parts in `lib/adapters/issue-moves.ts`). Who:
    `canMove` (a Linear write grant and not a guest) brings the checkboxes,
    grips, cell pickers, the row menu's edits and the bulk bar; without the
    grant the edits are listed disabled ("Needs Linear write access") beside the
    notice; a guest gets the read-only row items only. The milestone weight is
    the planner's own, so its menu is there for everyone but a guest. The page
    model carries what moves compare against: each shown row's facts
    (`rowFacts`: team, project, milestone, assignee, priority, state, whether it
    blocks or waits on anything), each group's drop target (`targets`: core's
    drop patch, its words, and why it takes nothing), the milestone groups'
    weights (`milestoneMenus`) and the referenced projects' names.
    - **Cells**: Milestone (the move picker), Assignee (active people, "You"),
      Status (the row's own team's statuses) and Priority are `PickerPopover`s
      with `appearance="cell"`, each saving one issue through
      `PATCH /api/issues/[id]` (`engine.updateIssue`, the one single-edit path):
      the new value shows "Saving", then stays (the list refreshes) or rolls
      back with "Not saved · …" and the not-saved toast ("Allow edits" on
      `needs_write_scope`). The milestone cell's choices map to the single
      edit's patch (`movePatch`: a milestone brings its project; "No milestone"
      under a project keeps the project; "No project" clears both). A row whose
      change is in flight shows plain values.
    - **Row "…" menu** (also right-click on a desktop row, which opens it, and
      the stage it turns into, at the pointer; and the row keys): Open ↵; Move
      to milestone… M, Assign to… A, Status… S, Priority… P (headed "{n}
      selected issues" when the row is in a selection of several, which they
      then act on); Blocking chain (when the issue blocks or waits on something:
      its milestone's, else its project's issue-level graph, as this branch's
      graph has no single-issue level); Open issue page; Open in Linear ↗; Copy
      link. Choosing an edit turns the same "…" button's popover into that
      field's picker (search focused); closing it leaves focus on the button. M,
      A, S and P on a focused row open those pickers directly for the selection
      when the row is in it, else for the row, and yield while a G chord is
      pending (`isSequencePending`).
    - **The move picker** (the cell, the menu, M, the bulk bar): one group per
      project, the moving issues' own projects first, then other active projects
      in timeline order, then inactive ones ("{name} · inactive"); each lists
      its milestones (status mark; "Oct 28 · next · ↑2"; complete ones last,
      "complete"; "not ENG's" when the project does not include the issues'
      team), then "No milestone"; it ends with "Other" › "No project". Filtered
      by the page, at most 200 options with "Keep typing to narrow N more".
      Options come from `GET /api/issues/options`, fetched on first open.
    - **Selection** (`TaskGroupTable`'s `selection`): click, shift-click ranges
      across groups, group and header tri-state boxes, `x`, Shift+↑/↓, ⌘/Ctrl+A;
      the set is the island's and is cut to the shown rows on every render (rows
      that leave the view drop out; the rest stay selected for a quick re-move).
      Esc clears it (after any open popover and the slide-over) and puts focus
      back on the last focused row.
    - **Bulk bar** (`BulkBar`, while anything is selected): "{n} selected",
      **Move to milestone**, **Assignee** ("Unassign", you, active people),
      **Status** (the selected issues' teams' statuses joined by type and name,
      so "In Review" of ENG and OPS is one choice; "not in {Team}" when a team
      lacks it, whose issues are then left as they are), **Priority**, ✕. More
      than 100 selected disables them: "At most 100 at a time ({n} selected)." A
      change of 20 or more issues (`BULK_CONFIRM_AT`), or a drag that changes
      any issue's project, asks first in the bar: "Move 24 issues to Garnet
      mobile app › Push notifications? 3 of them move from Atlas billing
      migration to Garnet mobile app. 1 is in Operations, which Garnet mobile
      app does not include. This changes them in Linear, as you." [Move 24
      issues] [Cancel] ("Set {n} issues to {value}? …" for the other fields);
      while sending it reads "Moving 24 issues…". While the bar is up the toasts
      stack above it (the bar publishes its height as `--bulk-bar-h`), so the
      Undo toast never covers its actions or ✕, on a phone too.
    - **Drag** (`TaskGroupTable`'s `drag`, desktop fine pointers only): the grip
      drags the row, or the selection when the row is in it. A group takes the
      drop when its patch would change at least one dragged issue; a project
      group (grouped by project) takes only the issues from other projects, so a
      row released on its own project keeps its milestone. A group that takes
      nothing says why while dragged over: "Initiatives come from the project.
      Drop on a project or a milestone.", "Already there.", "Order inside a
      group comes from the weight. Change the milestone's weight instead." (one
      row on its own milestone), "{name} is deactivated in Linear.", "At most
      100 issues at a time.". There is no reordering inside a group.
    - **In flight** (one `PATCH /api/issues` per pick or drop): the rows show
      the new value at once, dimmed with "Moving to Push notifications…" (or
      "Saving…"), and stay where they are; unchanged, skipped and failed rows
      are back at once, the failed and skipped ones noted "Not moved · {reason}"
      (amber) until the selection changes or the next change; changed rows wait
      for the refresh started after the answer, which places them.
    - **Toasts** (`bulkResultToast`, one action each): "Moved 2 issues to Garnet
      mobile app › Push notifications." ("Moved ENG-12 to …"; "Assigned …",
      "Unassigned …", "Set … to In Review.", "Set … to High priority.") with
      **Undo** for 8 s, plus " 1 already had that."; "Nothing to change: the 3
      issues already had that."; "Partly saved · Changed 2 of 3 issues. 1 not
      changed: {reason}" with **Select them**; Linear's rate limit ("… Try the
      rest after 3:05 PM.") or a rejected sign-in, with Select them; then the
      allocation sentences from the plans before and after ("2 of them are
      unassigned in Garnet mobile app's next milestone: the next allocation run
      gives them to Ben Carter." / "… a live allocation run would give them to …
      (allocation is in dry run)." / "Allocation is stopped for Garnet mobile
      app: …") and " 2 no longer match these filters." (judged on the fields the
      change sets).
    - **Undo** (`undoRequests`): the changed issues grouped by their values
      before, of every field the change set (so a two-field change goes back by
      the pair), one `PATCH /api/issues` per group, one after another; an
      ordinary audited edit. "Undone · 2 issues are back where they were.", or
      "Undid 1 of 2: ENG-12 left the planner; undo it in Linear." for an issue
      the change took out of the mirror (never retried).
    - **Weight** (a milestone group's "…" menu): Raise weight, Lower weight
      (each hinted "Becomes 3" / "Becomes −1", the weight it leaves, within
      ±1000), Clear weight when set, the line "Weight changes only the order on
      screen, never which milestone is next." (a disabled row, wrapped), and
      Open milestone (the timeline drawer's exact field). Each saves through
      `PATCH /api/milestones/[id] { weight }` (audited `milestone.weight`),
      toasts "Dual-write has weight 2 now." / "… has no weight now.", refreshes
      the list (the group moves) and puts focus back on the group's toggle.
    - **Keys** (the "?" sheet's Issues group adds them for a person who can
      move): X, Shift+↑↓, ⌘A (Ctrl A off Apple platforms, as the palette's own
      row reads), M, A, S, P, Esc.
- **Timeline** (Gr8r Studio's timeline): banners first (no lead / no date /
  unplanned / blocked, each a count that expands to a list) as Gr8r's tinted
  callouts stacked 6px apart: one `--r` box per banner in its tone's soft fill
  (warning for no lead, no date and blocked, info for unplanned:
  `TimelineBanner.tone`, rendered as `data-tone` beside `data-banner-id`), an
  icon in the hue, the lead-in ("No lead") in the tone's ink, one sentence with
  the count, and a quiet Show / Hide that opens the list on a surface inset;
  banners at zero left out. A flat toolbar: project search (26px, magnifier),
  initiative select, zoom **Weeks / Months** (segmented control), **Today**
  (quiet button, scrolls to today), **Dependencies** switch, **Show All / Active
  / At risk** (one segmented control, since at risk only ever keeps active
  lanes). It is one row from a 1366px window with the sidebar open (the search
  gives up width, 220 → 100px, before anything wraps, and the initiative select
  is capped at 200px with an ellipsis so a long initiative name cannot push it
  over the zoom control); narrower, the Show control wraps under it. Under it a
  legend line: the five status marks with sentence-case labels and the due-date
  diamond. The receipts line counts overdue and at-risk milestones in active
  projects only and says how many projects are inactive ("9 projects (1
  inactive) · …"). The chart is one `--r-lg` panel: a sticky left column of
  lanes grouped by initiative (sunken initiative rows, name semibold and count;
  lane = project name, the lead under it in `--text-3`, "No lead" or a
  deactivated lead in the warning tone), a two-row sticky header (month names
  12px semibold; day numbers 11px tabular, weekend cells sunken; today's number
  in an accent chip, or with week columns a "Today" chip in the month row),
  sunken weekends and `--divider` week rules behind the rows, today as a 2px
  accent line at 0.7 under the header, a "Milestones" summary row (on the plain
  surface, as Gr8r's) with Gr8r's diamond (12px, 2px radius, turned 45°) in the
  most urgent status hue at each due date, and bars per milestone (start → due
  date, 24px, `--r-sm`) filled with the status hue at 16% over the surface and
  outlined at 45% (overdue red, at risk amber, on track and complete green,
  complete at 60% opacity, an inactive project grey; rubric-invalid = a dashed
  `--border-strong` outline on the surface with its "Missing: …" line in amber),
  a 10px diamond in the hue at the due date, and small neutral pills: "Next" on
  each lane's next milestone, "↑2" for a weight override. With Dependencies on,
  milestone-level edges are Gr8r's 1.3px curved connectors in `--text-3` (amber
  on a risk chain, dashed for a scheduling conflict, `--text` for the open
  milestone's). Anyone with Linear write access drags a bar's right edge to
  re-date (an accent grip shows on the due-date diamond on hover or focus; the
  dragged bar lifts with `--shadow-drag`; snaps to days, an inverted date
  tooltip, Esc cancels, PATCH on drop, optimistic with rollback + toast);
  keyboard: focus the handle, ←/→ ±1 day, ↵ commit. Clicking a bar opens the
  slide-over drawer (the open bar takes the accent selection ring). Below 900px:
  per-project cards (Gr8r's phone list: bordered `--r-lg` cards under initiative
  headings; status mark, name, receipts with the status word in its tone and the
  missing input in amber, the date red when overdue). Built while wiring it
  (binding):
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
    for everyone with Linear write access (anyone without it sees a one-line
    "Linear read only" notice above the chart with "Allow edits in Linear",
    linking `/api/auth/linear?intent=grant_write&returnTo=%2Ftimeline`, and the
    drawer's note under its properties links the same upgrade back to that
    milestone). Weight and "done means…" are editable by everyone signed in
    (owner decision 2026-10-22: no PM role); the timeline's permissions are only
    `{ canWriteLinear, readOnly }`, and the drawer model carries
    `canEditLinear`, that `grantWriteHref` and `readOnly`, never a role or a
    "can edit meta" flag. A Linear guest (`readOnly`, owner decision 2026-10-22,
    "Guests limited to read only") gets no drag handles, no edit fields (weight
    and "done means…" are plain text too, a missing "done means…" pointing at
    the Linear description only), no Reschedule action and no grant link: one
    quiet notice above the chart and one where the drawer's edit note would be,
    "You are a guest in Linear, so this view is read-only." (`READ_ONLY_NOTICE`
    in `lib/read-only.ts`, `components/read-only-notice.tsx`; someone read-only
    for another reason reads `readOnlyNotice(reason)` instead, from the reason
    the shell provides once to every notice, and their user line says "Read
    only", not "Guest"). Complete milestones have no drag handle. Every open
    milestone failing the rubric carries its "Missing: …" line, overdue and
    at-risk ones included (their marks stay).
  - Links into the Issues page (owner request 2026-10-22): the milestone
    drawer's "Open as list" under its issues
    (`/issues?milestone=<id>&state=all`, since the drawer lists closed issues
    too), and "Plan in Issues" on each project row of the Unplanned banner
    (`/issues?project=<id>&milestone=none`: its unplanned issues beside its open
    milestones, listed as targets).
  - The drawer opens on click with a skeleton and fills when the server answers
    `?milestone=`; an id the mirror lacks closes it and shows a "Not found"
    notice. A lane focused by `?project=` is scrolled into the page too (chart
    and phone card).
  - The drawer's "Next milestone" cell says what that means for allocation: on
    the project's next milestone, "Allocation stopped · <reason>" in the warning
    tone when the project is blocked (or a quiet "Inactive project" note); on
    any other milestone, which one is next. A deactivated lead is loud in the
    Lead cell and named as deactivated in the met "Project lead" check.
  - An inactive (muted) lane is never loud anywhere: its bars, its phone card
    rows (grey hollow marks) and the "Milestones" summary diamonds (a day with
    only inactive milestones is drawn in greys; a shared day takes the active
    lanes' status); it is in no banner, receipt count or At risk filter. Its
    milestones' drawer is quiet too: no overdue strip, a grey status mark named
    "<status> · inactive project", and no status tone on the risk lines, due
    date or the issues' "Unassigned" / "Blocked by" (its progress is muted).
  - The drawer's colours follow §8.2: the overdue alert is danger; the risk
    reasons and missing input under the status, "No lead", a deactivated lead,
    "Allocation stopped" and an open issue's "Unassigned" / "Blocked by" are
    warning; the due date is danger when overdue and warning when it is missing
    or due today or tomorrow; progress is danger overdue, warning behind pace,
    success complete, muted in an inactive project. The rubric checklist is a
    `--r-lg` panel (met = green tick and "Met", missing = dashed amber ring and
    an amber "Missing" chip); issues and "Waits on" are `--r-lg` panels with
    `--divider` rows.
  - A complete milestone is never overdue: wherever its date is printed with a
    countdown (`dueLabel` in `lib/format.ts`: the drawer, the register, the
    graph's details and rows) it reads "Oct 1 · complete", never "Oct 1 · 20
    days overdue".
  - A phone card row whose mark is dashed (missing input) and that carries its
    "Missing: …" line leaves the status label out of its receipts, so an empty
    milestone reads "0/0 · Missing: issues", not "No issues yet · 0/0 · Missing:
    issues".
  - `PATCH /api/milestones/[id]` needs at least one of `targetDate`
    (`YYYY-MM-DD` or null), `weight` (integer or null), `doneMeans` (string or
    null), no other keys; it applies the date first, then weight, then "done
    means…", stopping at the first engine error. Malformed bodies are 400s
    before the engine is called. Neither PATCH route checks a role; the engine
    asks for Linear write scope for the date and the lead only, and its
    `needs_write_scope` answer carries a grant link back to
    `/timeline?milestone=<id>` (or `?project=<id>` for the lead), which the
    drawer's and the drag's "Not saved" toast offers as "Allow edits"
    (`notSavedToast` in `lib/api-client.ts`).
- **Projects** (Gr8r Projects page, table form): one `--r-lg` panel per
  initiative under its section title, one row per non-completed project: name +
  initiative, Linear status as a dot pill (backlog / planned / canceled grey,
  started blue, paused amber, completed green), next milestone (name, status
  mark, due line in the due-date colour: danger overdue, warning due today or
  tomorrow or undated), next-milestone progress bar (`completed/scope`; danger
  overdue, warning behind pace), lead or "No lead" in warning text, allocation
  chip ("Allocating n" info / "Blocked" warning with the reason in secondary
  text under it, worded as on the timeline's Blocked banner and My week's "Needs
  attention": "Project has no lead", "Next milestone is missing: done means…" /
  "Nothing to do" neutral / "No open milestone" and "Inactive" quiet), links to
  its timeline lane (the row), graph, issues (`/issues?project=<id>`) and Linear
  (quiet buttons). An inactive project's row carries no status colour: grey
  mark, muted date, grey progress, its name in secondary text. Search (with its
  icon) + status filter (All / Blocked / At risk = an active project's next
  milestone at risk or overdue / Inactive) in a flat toolbar, mirrored to `?q=`
  and `?filter=` so a filtered register can be linked; the register also follows
  the URL when it changes under it (back/forward, a link to `/projects` while
  filtered).
- **Graph** (not restyled yet, see the §8 intro: this is its older drawing,
  shown on the new tokens and atoms): level tabs (Milestones / Issues in
  <scope>); SVG laid out with `@dagrejs/dagre` (rankdir LR) on the server,
  hairline boxes with mono labels; risk chains in accent, cycles dashed accent,
  cross-project edges dashed ink, resolved edges faint; legend; hover/focus
  highlights the upstream chain; click a node → slide-over details; "Copy
  Mermaid" copies `toMermaid` output. A milestone's details link "Issues of this
  milestone" (its issue level), "Open as list" (`/issues?milestone=<id>`) and
  "Open on the timeline". Nodes with no blocking relation are listed under the
  canvas, not drawn (§8.1). Its restyle follows the timeline: nodes `--r-sm`
  with tinted status fills like the bars, tags as sentence-case `Chip`s in their
  §8.2 tones, a legend like the timeline's.
- **Runs**: a register panel of runs (mode as a `dot` pill: Dry run grey, Live
  blue; status as a tinted chip: Running blue, Succeeded green, Partly failed
  amber, Failed red; trigger; counts, Failed red and Blocked amber above zero);
  detail: a page head with the mode and status chips, the stats strip (Assigned
  green, Failed red, Blocked amber), the run's properties in a panel, then per
  project a heading row over an amber "Blocked" callout with its gaps, a
  register of assigned / would assign / failed / stale / skipped issues (outcome
  chips: would assign neutral, assigned green, failed red, not written and
  skipped grey; a Linear error in red) and one quiet line for already-assigned
  skips. Everyone signed in gets "Preview (dry run)" above the log and, while
  allocation is live, "Run now" behind a second click; in dry run the note says
  anyone can switch allocation live in Settings → Modes and that the switch is
  audited. There is no list of who may run; a Linear guest gets the read-only
  notice instead of the buttons (owner decision 2026-10-22). An issue's activity
  names a hand-started run "Manual run".
- **Settings** (Gr8r settings layout): a 220px sub-nav column (`NavTabs`
  vertical under a "Settings" eyebrow, the current section a raised pill) with a
  `--border` rule beside the section; at 900px and below it becomes a wrapping
  strip above it. The section's name is the page h1 (19px semibold) with a
  neutral chip (Audited, Newest 50, or Read only for a guest) and a one-line
  lead; then Gr8r setting rows (`.srow`: the setting's name 13.5px medium over
  one 12px `--text-3` help line, its control or value on the right, `--divider`
  rules; on a phone the control drops under the text), grouped under small
  headings with a `--border` rule (Schedule: Time, Risk and warnings, My week
  and the timeline, Projects). Modes are two switches, each named by its row for
  assistive tech ("Allocation live", "Warnings live"; turning one live shows an
  amber note on what the save starts); Watchers is Gr8r's member list (round
  initials, name, email, a Watcher box); Status lists the installation and sync
  as rows whose value takes the "settings status" colour of §8.2, then Resync,
  Preview today's digests and the inline preview (one register per recipient;
  kinds as tinted chips, Overdue red, the rest amber); Notifications (Sent
  green, Sending blue, Preview grey, Failed and Undeliverable red) and Audit are
  registers in a wider column. Each form ends in Save, Reset and a status line
  (red when a field or the last save failed); a refused field gets a red border
  and a soft red halo beside its error line.

Fixture mode shows a permanent neutral notice (`Notice tone="default"`, lead-in
"Demo data": "Not connected to Linear. …") at the top of the content column.

### 8.5 Issue page and slide-over (owner decision 2026-10-21)

- **Where.** `/issues/[id]` takes an identifier in any case or an id; the
  planner's own links use the identifier (`/issues/ENG-24`). It is the task
  view's page layout (`TaskDetail`, properties in a right rail when the view is
  at least 760px wide) with Linear ↗ and Copy link in its header; the topbar
  reads "Issues / ENG-24" ("Issues" links to the Issues page, §8.4; it was an
  unlinked root before that page existed), and an issue the mirror lacks is the
  app's 404. The **slide-over** is `?issue=<identifier or id>` on `/week`,
  `/issues`, `/timeline` and `/graph`, rendered on the server from the search
  params like the milestone drawer (`lib/issue-load.ts`, one `getIssueDetail`
  per render); a click opens it at once with a skeleton until the server
  answers, and closing it removes the parameter (scroll kept). Its header
  carries Linear ↗, copy link and open-as-page (icons); an unknown key reads
  "Issue not found" in the panel. It opens from My week's and the Issues page's
  row titles (the row's separate ↗ icon still opens Linear; on `/issues` the URL
  keeps the whole view beside `?issue=`; the open row keeps its selected fill,
  the accent tint), from the milestone drawer's issue list (the issue replaces
  the milestone in the same panel, crumb `‹ <Milestone> / <KEY>`, the "‹
  <Milestone>" a pill, goes back to it; ✕ and Esc close both), from the graph's
  issue nodes and its "no blocking relations" issue rows (same panel as the node
  details; the node stays selected on the canvas), and from the relation rows
  inside it (a plain click swaps the issue in place, a modified click opens its
  page). The command palette's issues open the page.
- **Data.** `engine.getIssueDetail(actor, id)` never fails for Linear being
  unreachable: with `extra` null the page shows the mirror's facts and
  `extraError` where the description and comments would be, and the live fields
  (labels, estimate, due date, description) read "Unavailable" and are not
  editable, since an edit needs their current value. `GET /api/issues/[id]`
  serves the same result to other clients; the pages do not use it.
- **Model** (`lib/adapters/issue.ts`, pure and unit-tested):
  `buildIssueTaskModel` maps the result to crumbs (project →
  `/timeline?project=`, milestone → `/timeline?milestone=`), status, alert
  strips, read-only facts, description, comments, relations, activity and the
  edit options. Alerts, each a callout tinted by its tone (§8.2): **Overdue**
  (its milestone; danger), **Blocked** (the open blockers, with a Graph link),
  **Holds up** (at-risk or overdue milestones waiting on it), **Stalled** (with
  the milestone's countdown) and **Unassigned** (in the next milestone: who the
  next live run gives it to, or why allocation is stopped — no lead, a
  deactivated lead, the milestone failing the rubric) (warning;
  `TaskDetailAlert.tone`). Closed issues and issues of inactive projects (§2.8)
  get none, and an inactive project's issue is quiet throughout (grey milestone
  mark named "<status> · inactive project", no tone on the assignee, due date or
  time in state). An unassigned open issue reads "Unassigned" in amber beside a
  dashed empty avatar; a due date is red when overdue and amber due today or
  tomorrow; time in state is amber when stalled; a missing or deactivated lead
  is amber. Activity marks are coloured by outcome: assigned green, the comment
  failed amber, failed red, dry runs, skips and lifecycle muted. Facts: assignee
  ("(you)" for the viewer; "Given by the planner on Oct 14: they lead
  <project>." after a live allocation; deactivated people noted), priority,
  labels, estimate ("3 points", or the T-shirt size), due date with its
  countdown, project with its lead, milestone with its status line ("At risk ·
  due Oct 23, in 2 days · 3 of 7 done · next milestone"), time in state (whole
  days; under a day reads "Since today" or "Since yesterday" by the workspace
  calendar). The description is printed as plain text with its line breaks; it
  is markdown source and is never parsed into HTML. Comments are oldest first, a
  bot's or integration's muted, with "First 200 · more in Linear" when Linear
  holds more. Activity lists the allocation run entries about the issue
  (identical repeats, such as the same dry-run plan every day, folded into the
  newest with "Seen in N runs") and the created / started / completed / canceled
  / moved-to-state instants, newest first.
- **Who.** Every signed-in person sees it (a Linear guest only the issues of
  their teams, §2.13). With `canEdit` the values are the `@better-tracker/ui`
  edit controls: `InlineTextField` (title, in the heading), `StatePicker`
  (status line), `AssigneePicker`, `PriorityPicker`, `LabelPicker`,
  `EstimatePicker` (none when the team's scale is `notUsed`), `DateField`,
  `ProjectPicker` (Active projects, then Other projects; a project of another
  team says so), `MilestonePicker` (the current project's milestones),
  `TextAreaEditor` for the description (markdown source, ⌘/Ctrl
  - Enter saves) and the comment composer, `TaskRelationPicker` ("+ Add") on
    Blocked by and Blocks (searching `GET /api/issues/search`, never offering
    the issue itself or one already linked; "this blocks X" posts to X's
    blockers), and a remove button per relation row. Without it the values are
    read-only and one notice under the properties, "Allow edits in Linear",
    links `/api/auth/linear?intent=grant_write&returnTo=<the current URL>`,
    offered to **everyone** but a Linear guest (as is the timeline's own notice
    for date and lead; since the owner decision of 2026-10-22 no control
    anywhere checks a role). A guest's model is `readOnly` (from the result's
    `readOnly`, which also forces `canEdit` off): the values are read-only, with
    no composer, relation pickers or remove buttons, and the notice is the
    read-only one, with no grant link. The server decides: the routes check the
    write scope and the engine enforces it and validates again.
- **Saves.** Each control saves optimistically (the ui save contract: pending,
  kept, or rolled back with "Not saved · <reason>" beside it); a failure is also
  toasted ("Not saved", the route's sentence, and "Allow edits" when the answer
  is `needs_write_scope`), and a success calls `router.refresh()`, so the page
  shows what the mirror (patched by the engine) and Linear now hold rather than
  a local guess. A refusal whose goal already holds is not a failure
  (`lib/issue-writes.ts`): removing a relation answered 404 (already gone) just
  refreshes, and adding a blocker answered 409 (that issue already blocks this
  one) refreshes with an "Already linked" note; other 404/409 answers fail and
  refresh the stale view. Removing a relation row moves focus to the next row's
  remove button, or for the last row to the section's "+ Add", so a keyboard
  user stays inside the drawer.
- **Label colours.** Linear labels are colour-coded, so a label is Gr8r's label
  chip: a 20px bordered chip with the label's colour as a small rounded square,
  washed with a faint (8%) tint of that colour, its name in `--text-2`. The same
  chip appears in `LabelPicker` (options and chosen values) and in the read-only
  value. Only hex values are painted (anything else is a hollow square and a
  neutral chip). It is the one place a colour from data is drawn; everything
  else stays in the planner's marks (§8.2).
- **Look** (Gr8r's task drawer): the page is one `--r-lg` panel (a 46px header
  bar with the crumb trail, the key in Geist Mono, Linear and Copy link; the
  property rail set off by a `--border` rule at ≥ 760px; edge to edge on a
  phone); the drawer is one column. The title is 19px semibold. The status line
  has the mono key and the state as a bordered pill (glyph coloured, name
  neutral). Alerts are tinted callouts 8px apart. Properties are Gr8r's `.kv`
  with a 14px Lucide icon per label. Editable values are pills that fill
  `--surface-2` on hover and cut long values with an ellipsis; they open Gr8r
  popovers (10px radius, `--shadow-pop`, search row, 30px rows with
  `--surface-2` for the active one, eyebrow group titles, accent check; a bottom
  sheet on phones). People are round pastel avatars (initials on a 17% tint of a
  decorative hue picked from the name; nobody is a dashed empty circle). Section
  heads are 13.5px semibold with a quiet count. Relations are flat rows with a
  hover fill and a ghost remove button. Comments follow Gr8r (26px avatar,
  author, date, text), with the composer as one rounded box that takes the
  accent edge and halo on focus. Activity lines carry a small tone-coloured dot
  and the date on the right.
- **Routes** (`lib/issue-routes.ts`): the run/settings routes' order — CSRF
  guard and session (`requireApiActor`) → the read-only check (403 `read_only`
  for a Linear guest, no grant link) → strict zod body with only the documented
  keys (an empty patch, an unknown key, a blank title or comment, a priority
  outside 0–4, an estimate that is negative or not whole, a malformed date: 400
  before the engine) → Linear write scope (403 `needs_write_scope`, the body's
  `error.grantWriteHref` returning to `/issues/<id>`) → engine → `errorResponse`
  (`linear_forbidden` 403; `rate_limited` 429 with `error.retryAt` and
  `Retry-After` when Linear said when; the engine's own `needs_write_scope` also
  carries the link). `DELETE /api/relations/[id]` reads no body.
  `GET /api/issues/search?q=&near=` (q ≤ 200 characters) matches identifiers
  (exact, prefix, then containing, so "24" finds ENG-24) and then every word of
  the title, accent-folded; open issues first, then the `near` issue's milestone
  and project; at most 20; an empty q lists open issues by that nearness.
- **Audit.** Settings → Audit words each edit as "ENG-24 · assignee" with "Ana
  Moreno → Dev Patel" (descriptions and comments as their length only, "Added a
  comment (42 characters)", never their words, since the audit is open to
  everyone signed in; relations as "ENG-24 · blocked by" with "Added ENG-23"). A
  bulk change (§7.3) is folded (`foldAuditEntries`): inside one run of entries
  sharing an `at`, issue entries with the same person, action and value after
  become one row, "2 issues · milestone" with "→ Push notifications" and
  "ENG-54, ENG-55" (three keys, then "and N more"); they need not be adjacent,
  so a cross-project move reads as exactly two rows (project, milestone). The
  page reads the newest 500 entries and shows the newest 50 rows after folding.

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
  `partial`; and every workspace whose installation is revoked, which a run over
  all workspaces lists with `listRevokedWorkspaceIds` and reports as failed with
  an error log naming the reinstall, instead of skipping it in silence), a
  workspace-independent step failed (listing workspaces, `cleanup`), boot
  failed, or the hard timeout fired; `2` usage error (unknown command/option,
  missing `--dry-run|--live`, an option that does not apply). Undelivered
  digests do not fail a run (they include people with no Slack account); they
  are counted in the summary.
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
| `WATCHER_EMAILS`                            | engine          | comma-separated emails of the first watchers (else the installer) |
| `LINEAR_FIXTURE`                            | planner, worker | `1` = demo mode, no Linear needed                                 |
| `DAILY_RUN_AT`                              | worker          | `HH:MM` in each workspace's timezone (default `08:00`)            |
| `TICK_TIMEOUT_MINUTES`                      | worker          | hard limit per run (not `migrate`), minutes (default 10, ≤ 14)    |
| `SYNC_INTERVAL_MINUTES`                     | worker serve    | minutes between ticks (default 15)                                |
| `PGLITE_DIR`                                | all             | PGlite directory when `DATABASE_URL` is unset (local dev only)    |
| `SESSION_DAYS`                              | engine          | session lifetime in days (default 30)                             |
| `LOG_LEVEL`                                 | all             | debug/info/warn/error                                             |

`packages/engine` exports `loadEngineConfigFromEnv(env)` and
`createEngineFromEnv(env)` so the planner and worker build identical engines.

`PM_EMAILS` is retired (owner decision 2026-10-22: there is no PM role). It is
not read; a deploy that still sets it boots normally and logs one warning
("PM_EMAILS is no longer used…"). Remove it and set `WATCHER_EMAILS`.

## 11. Testing

- core: unit tests per rule above, including the doc's own examples (3/7 done
  with 2 days left; invalid next milestone blocks and never skips ahead; overdue
  stays next; weight changes display order only).
- linear: schema validation of every query/mutation; mapping fixtures;
  pagination with a fake fetch; OAuth URL/exchange/refresh with a fake fetch;
  webhook signature + timestamp tests with known vectors; the issue page's reads
  and writes with a fake fetch (label/comment paging and the comment cap,
  estimate-scale inheritance, readable refusals) and in the fixture (content on
  every team's scale, every refusal Linear would give).
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
  across days, overdue repeat; no roles (owner decision 2026-10-22): a member
  makes every milestone, lead and settings edit and starts dry and live runs,
  nobody is answered `not_pm`, Linear writes still need write scope, watchers
  can be emptied, old settings with `pmUserIds` read without it, `PM_EMAILS`
  logs one warning, two people saving different settings at once both stick; the
  issue page: a member with write scope edits with their own token, one without
  write scope is refused before Linear is called, every validation, mirror
  refresh and audit, Linear error mapping, live-read failure and app-token
  fallback (transient failures only); per-viewer visibility (§2.13): a private
  team and a guest across every read made for a person, the edits, run log,
  audit, digests and their preview; guests are read-only
  (`test/read-only.test.ts`, owner decision 2026-10-22): the demo's guest is
  refused `read_only` by every mutating method (also with a crafted
  `canWriteLinear`), nothing reaches Linear, the mirror, settings, runs or the
  audit, the same calls work for a member, and (`auth.test.ts`) a guest's
  `grant_write` and install are refused and the mirror decides `readOnly`; the
  issue list (owner request 2026-10-22): reads narrowed per viewer (a guest with
  the fallback, a project shared with a hidden team listing only the viewer's
  team), `me`, `wrong_workspace`, the mirror version
  (`test/issue-list.test.ts`); bulk edits (`test/bulk-issue-edits.test.ts`):
  moves within and across projects, "No milestone in P", "No project", no-ops,
  status by name across teams and a team without it, every whole-request refusal
  writing nothing, the person's gateway at most 4 in flight, one mirror patch
  per call, a newer or identical mirrored copy kept, the shared audit instant in
  field then request order, a forbidden issue, a rate limit part-way and before
  any change, a rejected sign-in, the issue locks with a single edit and between
  two bulk edits, and the allocation effects (handed over, already planned,
  Garnet stopped); identical Issue webhooks (`test/webhooks.test.ts`, in
  `mode: 'linear'`, since demo mode ignores webhooks) write nothing, changed
  fields and relation sets still apply, and the echoes of a bulk move and a bulk
  status change write nothing.
- core (issue list): the matcher (`test/issue-search.test.ts`); the list
  (`test/issue-list.test.ts`): every filter with `none` and `me`, OR within and
  AND across fields, the first-initiative rule and `alsoIn`, the quick filters,
  the text rule, unknown ids, the no-initiatives fallback, the weight order's
  tiers and ranks as goldens, every field sort both ways, every grouping's order
  and drop patch, sections and invalid pairs, empty targets, the row and group
  budgets, refs, preset counts, lenient normalization, and a weight change that
  reorders the list but leaves `planAllocation` equal; the list and options per
  viewer in `test/visibility.test.ts`; the 50k scale block in `test/api.test.ts`
  also builds the list five ways and its options.
- linear and store (issue list): `IssueFields` selects `dueDate`, `mapIssue`
  reads it (malformed or absent → null), the fixture's reads carry it from the
  fields store; `appendAuditEntries` writes in one statement, in order, with
  U+0000 dropped, and an empty list writes nothing.
- planner: unit tests for cookie signing/origin checks; the adapters; the route
  handlers with a fake actor resolver, and end to end on the demo engine
  (`test/workspace-routes-demo.test.ts`): no roles (owner decision 2026-10-22),
  so a member (Chloe, never a PM) resyncs, previews digests, starts dry runs,
  switches allocation live and starts a live run, empties and refills the
  watchers, re-dates a milestone, sets its weight and "done means…" and sets a
  project lead, each audited under her name, while cross-origin and signed-out
  requests are still refused first and the retired `pmUserIds` is a 400; a
  second resync within a minute is a 429; a JSON body past 1 MiB is a 413 before
  it is parsed; the demo's guest gets 403 `read_only` from every mutating route
  and changes nothing, while his reads work. The read-only views are rendered to
  HTML (`test/read-only-render.test.tsx`: drawer, timeline, settings) and must
  hold no inputs, Save buttons, drag handles or grant links.
- planner (issue list): `test/adapters-issue-list.test.ts` (the URL grammar:
  canonical order, defaults left out, `state=all`, `me` and `none`, dropped
  values, the 50-value and 200-character caps, `limit` steps, invalid section
  pairs; the project → milestone cascade; chips, tabs with counts equal to their
  own view, the Filter / Sort / Group menus and the no-initiatives fallback; the
  pickers' options with the 200 cut; the page model's receipts, notices in order
  worded by why, columns per grouping, tier dividers, group headings of every
  kind, row tones and an inactive project's quiet rows, empty milestone targets,
  budget footers and folded groups, the empty state), the options route in
  `test/issue-routes.test.ts` (private, the viewer passed, a guest too), the
  links into the page (`adapters-{shell,week,timeline, projects,graph}.test.ts`)
  and the page rendered for a guest and for someone without the write grant
  (`test/read-only-render.test.tsx`); in the browser, `e2e/issues.e2e.ts`: the
  default view, a filter kept by reload, Back and Forward, a project's unplanned
  issues with its milestones as targets, the slide-over, the search's one
  history entry, `/tasks`, no sideways scroll at 390px, and the guest's
  read-only page.
- planner (moving issues): `test/adapters-issue-moves.test.ts` (the page's cap
  equals the engine's; the move picker's grouping, the moving issues' projects
  first, inactive last, "not ENG's", the 200 cut; `movePatch` and the bulk
  change per choice; statuses joined across ENG and OPS and "not in {Team}"; the
  page model's row facts, drop targets and milestone menus; drops, a project
  group sending only the other projects' issues and "Already there.", one row on
  its own milestone; the confirmation at 19, 20 and for a cross-project drag,
  with the team sentence; the pending rows; leaving the filters; every
  `bulkResultToast` variant and the allocation sentences; `undoRequests` grouped
  by the before tuple of a two-field change, and an issue that left the planner
  reported, never retried; the row and milestone menus), `PATCH /api/issues` in
  `test/issue-routes.test.ts` (the order: cross-origin, signed out, a guest's
  `read_only` before the body; the 400s for 0 or 101 ids, a repeat, unknown
  keys, an empty patch, a bad state, a blank name, a live field such as `title`;
  `needs_write_scope` with the link back to the sanitized `/issues…` view or
  `/issues`; 200 with a partial result; 401; 429 with `Retry-After`; 404; 413),
  `foldAuditEntries` in `test/adapters-settings.test.ts` (a bulk move folded, a
  cross-project move as exactly two rows even interleaved, single edits and
  different values apart), `test/issue-list-demo.test.ts` (on the demo engine
  through the real route: Chloe moves ENG-54 and ENG-55 into "Push
  notifications", the mirror, the list and the audit show it, Undo puts them
  back; Gus is refused `read_only` and nothing changes, version and audit
  included, while his list reads Operations only with the fallback), and the
  page's controls rendered for a member, a member without the grant and a guest
  (`test/read-only-render.test.tsx`); in the browser, `e2e/issues.e2e.ts` adds a
  shift-click selection moved with the bulk bar and kept by a reload, the `m`
  key with Undo, a drag onto another milestone with Undo, the phone's Select
  mode, and the guest's refused `PATCH /api/issues`, each move put back for the
  tests after it.
- planner browser smoke (Playwright 1.56, `apps/planner/e2e/*.e2e.ts`,
  `playwright.config.ts`; moon `planner:test-e2e`, which builds first; CI runs
  it as a `moon ci` target whenever the planner or anything it depends on
  changed, after installing Playwright's Chromium): a production build served by
  `next start` in demo mode on `E2E_PORT` (default 3390 plus the worktree
  offset) signs in as Chloe and checks that every screen renders without a page
  error, that dragging a due date PATCHes the milestone and survives a reload,
  that an issue's title edit saves, that Ctrl K opens the palette, that a drawer
  swapped in place keeps focus in the panel, and that Esc in a drawer field with
  unsaved text resets it before closing; then, signed in as the demo's guest,
  that every page renders with no edit controls (no drag handle, drawer field,
  comment box, run button, Save or Resync), that the palette offers no run or
  resync, and that a direct PATCH or POST is refused 403. It needs Playwright's
  Chromium (`playwright install chromium`) or `PLAYWRIGHT_CHROMIUM_PATH` /
  `PLAYWRIGHT_BROWSERS_PATH` pointing at one.
- image: CI's `image` job builds `deploy/Dockerfile` and starts both services
  from it in demo mode (the web app must answer `/api/health`, the worker's
  `tick` must exit 0).
- ui: component tests with happy-dom (`packages/ui/test`), the stylesheet scope
  guard (`styles-scope.test.ts`), and `ui:typecheck-host`: the source under a
  host's looser flags (`tsconfig.host.json`, not strict, like Dispatch's
  `apps/desktop`).

## 12. Verified external facts

See `docs/research.md` (generated from the research pass with sources).
