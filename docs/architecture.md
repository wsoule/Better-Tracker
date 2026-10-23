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

**Owner decision 2026-10-22, graphs at every level** (design doc §12): "The
graphs need to be available all the way from initiative to individual issues."
The dependency graph is drawn at the initiative, project, milestone or issue
level, for the whole workspace or inside one initiative (or the projects with
none), one project or one milestone, plus one issue's blocking chain; a project
in several initiatives counts under the first, as on the timeline; risk on an
aggregate edge is per relation. The core and engine contracts are in §2.10,
§2.11, §2.13, §3 and §7; the `/graph` page (URLs, trail, level tabs, panels,
draw limits) is in §8.1 and §8.4 "Graph"; the ways in (the timeline's group
links, "Open as graph" and the milestone drawer, the projects register's group
links, every issue's chain) are in §8.4 "Timeline" and "Projects" and §8.5. The
graph is read-only, so guests keep every graph link.

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
§7.3; the Issues page (`/issues`, the `/tasks` redirect, the toolbar, the list
and moving issues from it) is in §8.1, §8.3, §8.4 "Issues" and §8.5.

## 1. Layout

```
apps/
  planner/   Next.js 16 app: pages, route handlers (OAuth, webhooks, edits)
  worker/    CLI for scheduled jobs (daily run, periodic resync, migrations)
packages/
  core/      pure domain logic + shared types (no I/O, no dependencies)
  linear/    Linear GraphQL gateway, OAuth, webhook verification, demo workspaces
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

### 2.10 Dependency graph (§7.3; graphs at every level, owner decision 2026-10-22; every item, 2026-10-23)

`buildDependencyGraph(snapshot, ctx, assessments, scope)` (`graph.ts`) draws a
**level** (what one node is: `initiative`, `project`, `milestone` or `issue`)
inside a **container**: the whole workspace (as the viewer sees it), one
initiative (or `NO_INITIATIVE_ID = 'none'`, the projects in no mirrored
initiative), one project, one milestone, or one issue's blocking **chain**.
**What a graph draws** (owner decision 2026-10-23, "the graph is there to show
all issues not just blocking ones"): every item of the level in the container,
on a blocking relation or not; the relations are the edges, and `clusters` frame
the nodes by parent. Only a chain stays one issue's blocking chain.

- **Scope.** `GraphScope` is `{ level }` (the workspace) or a level with exactly
  one of `initiativeId`, `projectId`, `milestoneId`, `issueId` (the chain). Each
  container offers the levels finer than itself (`GRAPH_LEVELS_WITHIN`:
  workspace all four; initiative project, milestone, issue; project milestone,
  issue; milestone and chain issue) and opens at `DEFAULT_GRAPH_LEVEL`
  (workspace milestone, initiative project, the rest issue), so today's three
  shapes (`{ level: 'milestone' }`, `{ level: 'issue', milestoneId }`,
  `{ level: 'issue', projectId }`) keep their meaning. Code branches on a scope
  only through `graphContainer(scope)`
  (`workspace | initiative | project | milestone | chain`, with an id) and an
  exhaustive switch; `graphScopeFor(container, level?)` builds a scope (an
  unoffered level gives the default).
- **`resolveGraphScope(snapshot, raw)`** validates, in order: an object ("A
  graph scope is required."); one of the four levels; container ids are strings,
  at most one of them; the level is offered by the container (one message per
  container); then the **no-initiatives fallback**: a scope naming initiatives
  (the initiative level, or `initiativeId`) when the snapshot has none (a
  guest's, or a workspace without initiatives) resolves `ok` to the same level
  for the workspace (the initiative level to `project`) with
  `fallback: { reason: 'no_initiatives', requested }`; no id is checked, so
  every id gets the same answer and nothing leaks. Otherwise the container must
  exist in the given snapshot (`none` always does; unknown and hidden ids are
  both `not_found`); a chain may name its issue by id or identifier in any case
  (`findIssue`) and resolves to the id. The builder resolves the scope itself: a
  failure gives an empty graph for the scope as given (today's unknown-id
  answer), success draws `res.scope` and sets `fallback`.
- **Facts, once per build** over the viewer's snapshot: open, unassigned and
  overdue (the issue's milestone is overdue) issues; `waitsOnUnassigned` /
  `waitsOnOverdue` (transitively over open blockers, `waitingIssues`); `risky` =
  unassigned or overdue or waits on either; the open issues on a blocking cycle
  among open issues (one Tarjan pass); each open issue's distinct open blockers
  and, per blocker, how many open issues it alone blocks (readiness, below);
  each project's first initiative (`homeInitiativeIds`, the timeline's rule,
  §2.11; `none` when it has none); project activity (§2.8; an issue with no
  mirrored project counts as active). O(issues + relations), no per-node scans.
- **Membership and units.** An issue is under the workspace always; under
  initiative X when its mirrored project's first initiative is X (an issue with
  no project is in no initiative); under a project or milestone by its ids.
  Above the issue level each issue counts toward one **unit**: its mirrored
  milestone, its mirrored project, or its project's first initiative (a project
  in several initiatives counts once, under the first: no duplicated boxes, no
  invented cycles); no such unit → none.
- **Aggregate levels** (initiative, project, milestone). A relation b blocks w
  counts when both ends are open and one end is under the container, paused work
  included (until the 2026-10-23 review the workspace also needed one end in an
  active project; since every unit is drawn, a relation between two paused
  projects joins two drawn boxes, and leaving its arrow out made a waiting box
  name a drawn blocker "outside this graph"). An end without a unit adds to
  `unplacedRelations`; ends in one unit make no edge; otherwise the edge unit(b)
  → unit(w) gets `weight` += 1 and `onRiskChain` ||= `risky(b)` (risk is **per
  relation** at every aggregate level, so drilling from a project edge to its
  milestone edges keeps the risk chain consistent; before 2026-10-22 a milestone
  edge was a risk whenever its blocker milestone held any risk). The timeline
  draws its connectors from the workspace milestone edges and leaves out an edge
  whose two ends are milestones of inactive projects (`chartDependencies`,
  §8.4), so it draws exactly what it drew before. **Nodes** (`levelUnits`):
  every unit under the container, whether open, done, empty or inactive (every
  mirrored milestone; every mirrored project; every initiative, plus `none` when
  some project has none), plus both ends of every edge; `external` = the unit is
  not under the container (only ever an edge end, never in the workspace; edges
  between two externals cannot exist). The `graph.test.ts` golden keeps every
  node and edge it pinned before, in the same order, with the complete and
  paused units now drawn in their slots and the one paused-to-paused arrow
  between them.
- **Readiness** (owner request 2026-10-22, "graph highlights"): every node says
  whether its work can start. The facts are mirror-wide like risk: built over
  the viewer's whole snapshot, never just the drawn nodes, and before the
  container and activity filters, so a node reads the same in every graph that
  draws it, externals included. A **blocking relation** is a `blocks` relation
  whose two ends are open. Relations to issues the mirror does not hold never
  count (`indexWorkspace` and `visibleSnapshot` drop them first), so an issue
  can read ready while Linear shows a blocker. **Issue:** `readiness` is `done`
  when completed or canceled, `blocked` when it has an open blocker, otherwise
  `independent` ("No dependencies") when it is open and on no `blocks` relation,
  either way, with a mirrored issue that is not canceled (a self-loop and a
  relation to a done issue both count as relations: an issue whose blocker is
  done reads ready), otherwise `ready` (dependency-ready: in the blocking flow,
  nothing open blocks it, Triage and Backlog included); `blockedBy` = its
  distinct open blockers (a self-loop counts: an issue blocking itself is
  blocked by 1); `unblocks` = the open issues other than itself whose only open
  blocker it is (exact inside cycles: in A ⇄ B, A unblocks B; 0 when done);
  `openIssues` / `readyIssues` are 1/1 ready, 1/0 blocked, 0/0 done. **Above the
  issue level**, for a unit u: `blockerUnits(u)` = the units other than u of the
  open blockers of u's open issues, and `unplaced(u)` = those open blockers with
  no unit at this level (blockers inside u are u's own business); `blockedBy` =
  |blockerUnits| + |unplaced|, and `unplacedBlockers` = |unplaced| (issues, not
  boxes: copy counts them apart, "Waiting on 1 milestone: B, and 2 issues with
  no milestone"; 0 for an issue); `readiness` is `empty` when no issue at all
  counts toward u in the viewer's mirror (any state, canceled included, as
  milestone progress counts them, so it agrees with the "No issues yet" status:
  a milestone with no issues, an initiative whose projects count under another
  initiative or are hidden from the viewer; never "Complete"), `done` when
  issues count toward u and none is open, `blocked` ("waiting") when
  `blockedBy > 0`, `independent` ("No dependencies") when it is also the blocker
  of no other unit's (or unplaced) open issue and `readyIssues > 0` (a box that
  is "None ready" behind a cycle inside stays stuck; one fold,
  `blocking: Set<unit>`, adds no pass), otherwise `ready` ("clear", which may
  still hold blocked issues); `unblocks` = the units v whose blockerUnits is
  exactly {u} with no unplaced blocker (so it is exact: finishing u alone clears
  them); `openIssues` = the unit's open issues and `readyIssues` = those with no
  open blocker anywhere in the mirror. `blockedBy` and `unblocks` may exceed
  what is drawn (a chain's side blockers, an external's own blockers, units no
  graph edge reaches). Cost: one pass over the open issues and their blockers
  (`GraphFacts.openBlockers`, `soleBlockerOf`), a fold inside the aggregate
  loop's existing pass and one O(units) pass: O(issues + relations).
  **Classifiers** (`mermaid.ts`, next to `isRiskNode`): `readinessLabel(node)`
  is the chip word ('' when done or empty; "No dependencies" when independent,
  which hosts say in names and readouts but draw as no chip; "Ready", "Blocked
  by N"; above the issue level "Clear", "None ready" (clear, with
  `readyIssues` 0) or "Waiting on N"). `readinessClass(node)` is the one status
  class the planner's tones and the Mermaid export share: `quiet` (done, empty,
  or not `active`: §2.8, never loud; it wins, so a paused independent issue is
  quiet), `stuck` (an issue that is blocked and `holdsCycle`; a box with
  `readyIssues === 0 && holdsCycle`, waiting or clear), `blocked`, `independent`
  (neutral: a graph of every item is not a sea of green), `ready`. It never
  reads `inCycle`, which depends on the drawn edges, so a box whose arrows
  merely form a cycle stays `blocked` with its own cycle marks, and finishing an
  outside blocker never turns a box from waiting to stuck. A clear box with none
  ready is only possible behind a cycle inside (every open issue waits on
  another inside), so it is always stuck.
- **Node fields** (`GraphNode`): `id` (initiative id or `none`, project,
  milestone or issue id), `kind` (the level), `label` (name; "No initiative"),
  `sublabel` (issue "ENG-12 · Ana"; milestone its project; project its lead,
  "Unknown user" or "No lead"; initiative "4 projects", the visible projects
  whose first initiative it is), `url` (issue and project; null for milestone
  and initiative), `initiativeId` (the project's first initiative or `none`; an
  initiative itself; null only for an issue with no mirrored project),
  `projectId`, `milestoneId`, `ownerId` (assignee; project lead; null for an
  initiative), `external`, `clusterId` (its innermost cluster, below; null at
  the initiative level and in a chain), `active` (its project is active; an
  initiative: one of its projects is), `open`, `unassigned`, `overdue`,
  `waitsOn*` and `holdsCycle` (an open issue under the node is on a blocking
  cycle among open issues, anywhere in the viewer's mirror; for an issue node,
  itself), each folded over the unit's open issues (all of them, also for an
  external); `inCycle` (Tarjan SCC over the drawn unresolved edges, size > 1 or
  a self-loop); `status`: issue its state type; milestone its assessment;
  project its next milestone's (§2.6) status, `empty` without one; initiative
  the most severe (overdue, at_risk, unscheduled, empty, on_track, complete) of
  its active projects' statuses, of all its projects when none is active;
  `readiness`, `blockedBy`, `unblocks`, `openIssues`, `readyIssues` (Readiness,
  above; a milestone's `openIssues` is its folded open issues, not its
  assessment). Milestone nodes keep their assessment-based `open`, `unassigned`
  and `overdue`. Chains add `distance` and `hiddenNeighbours` (below).
- **Edge fields** (`GraphEdge`): `resolved` (issue level: the blocker is
  closed), `blocking` (both ends open: the blocker still holds the waiting end
  up; false when the blocker or the waiting issue is closed; always true above
  the issue level, whose edges count open→open relations only), `crossProject`
  (always at the project and initiative levels), `crossInitiative` (both ends
  have a project and their first initiatives differ; always at the initiative
  level; never for a guest, whose projects have none), `crossOwner` (assignees;
  leads at the milestone and project levels; never at the initiative level),
  `inCycle`, `onRiskChain`, `weight`.
- **Order.** Nodes under the container first, then externals, each group sorted
  together (listed units and unlisted in-container edge ends alike): initiatives
  by `compareInitiatives` with `none` last, projects in `orderProjects` order,
  milestones by `compareMilestones`, issues by `compareIssues`. Edges in node
  order (`sortEdges`), so output is stable.
- **Issue level, in every container** (workspace, initiative, project,
  milestone; one builder, `containerIssueGraph`): **nodes** are every issue
  under the container, open and done; canceled and Duplicate issues (Linear's
  duplicate maps to canceled) are never nodes. **Edges** are every `blocks`
  relation touching the container whose two ends are not canceled, closed↔closed
  and paused↔paused ones included (drawn dotted: they no longer block), so "No
  dependencies" is exactly "no arrow"; `resolved` when the blocker is closed.
  **Externals** are the outside end of such a relation, one hop away (issues
  with no project are externals of an initiative; the workspace has none). In
  container nodes come first, then externals, each in `compareIssues` order.
- **Clusters** (`GraphCluster`, `graphClusters`, built for every container but a
  chain): labelled frames around the nodes that share a parent.
  `{ id, kind, refId, label, parentId, projectId, active, external }`: `id` is
  `project:<id>`, `project:none`, `milestone:<id>`,
  `milestone:none:<projectId>`, `initiative:<id>` or `initiative:none`; `refId`
  the milestone, project or initiative it stands for (null for "No milestone"
  and "No project"); `label` its name or "No milestone" / "No project" / "No
  initiative"; `parentId` the enclosing cluster; `active` one of its nodes is
  active (an inactive one is drawn muted); `external` every node in it is an
  external. **Per level:** the issue level gets one per milestone, "No
  milestone" per project and "No project", milestone clusters nested in project
  clusters when the drawn issues span more than one project (an external
  milestone's bare name would be ambiguous otherwise); the milestone level one
  per project; the project level one per first initiative, "No initiative" last,
  and none in a mirror without initiatives; the initiative level and a chain
  none. Only clusters holding a drawn node exist. `DependencyGraph.clusters`
  lists them parents before their children, siblings in display order,
  in-container clusters before external-only ones; each node's `clusterId` is
  its innermost one.
- **One issue's chain** (`{ level: 'issue', issueId }`): breadth-first from the
  focus F upstream over its blockers and downstream over what it blocks. F's
  direct relations are always walked, in any state; past F the walk goes through
  open issues only (a closed issue holds nothing up and waits on nothing), and a
  closed F is one hop. Side blockers of downstream issues are not part of F's
  chain. `distance` is 0 for F, otherwise −(hops upstream) when that is no
  longer than the downstream path, else +(hops downstream).
  `chain: { focusId, upstream, downstream, hidden }` counts the full walk. Past
  `CHAIN_MAX_NODES = 150` walk issues only the nearest are kept (by |distance|,
  upstream first, then issue order; F always), `hidden` counts the rest and a
  kept issue with relations to left-out walk issues carries `hiddenNeighbours`.
  Edges: every relation between two kept issues; nodes are never external; F
  comes first. O(the component) plus sorting. The chain cap is the only cap in
  core: everything else is uncapped (the timeline's connectors come from the
  workspace milestone level), and the planner decides what is drawn (§8.4).
- **Visibility.** Every level is built from the viewer's narrowed snapshot
  (§2.13), so hidden teams' issues, hidden projects and their milestones, and
  relations with a hidden end never become nodes, edges, externals, clusters,
  weights, counts (`unplacedRelations`, "N projects") or risk inputs; nothing
  hidden is counted. Risk follows the viewer's mirror too: a member may see an
  edge off the risk chain although a hidden team's blocker is unassigned.
  Readiness follows the viewer's mirror too: a member may see an issue ready
  although a hidden team's issue blocks it, and a hidden issue is never counted
  in `blockedBy`, `unblocks`, `openIssues` or `readyIssues`.
- **`DependencyGraph`** =
  `{ scope (resolved), nodes, edges, cycles (node ids in walk order), clusters, fallback, unplacedRelations, chain }`.
  `unrelatedIssues` (open issues counted but not drawn) was removed on
  2026-10-23: nothing is counted and left out any more.
- **Mermaid** (`mermaid.ts`, for Copy Mermaid and docs):
  `mermaidParts(graph, { critical? })` returns `{ body, styles }`. The body is
  the same in every highlight, and `styles` holds what each `GraphHighlight`
  (`status`, `risk`, `critical`) appends to it;
  `toMermaid(graph, { highlight?, critical? })` is
  `body + styles[highlight ?? 'status']`. **Body:** `flowchart LR` with stable
  sanitized ids (`n0`, `n1`, …), quoted labels whose second line ends in the
  `readinessLabel` word
  (`n1["Typo tolerance<br/>ENG-23 · Dev Patel · Blocked by 1"]`; the word is the
  whole second line when there is no sublabel, and a done node gets none, so the
  export never says readiness by colour alone), `-->` for a blocking edge and
  `-.->` when `!blocking` (the blocker or the waiting issue is closed), `|n|`
  weights, and, for a cut chain, the comment
  `%% Showing the nearest {kept} of {kept + hidden} issues on this chain`. Each
  node is written inside nested `subgraph c<k>["Label"] … end` blocks, one per
  cluster (ids positional, in cluster order; a cluster holding none of the given
  nodes is dropped, and nodes with an unknown cluster come first, at the top
  level). An independent node carries no readiness word and no status class,
  like its neutral box; the export adds no cluster styling (theme-safe).
  **Styles:** each block ends in a line break, and every one classes the
  externals (`classDef external`, dashed `3 3`, opacity 0.7) and, in a chain,
  the focus (`classDef focus stroke-width:3px`).
  - **status** (the default): `readinessClass` (above) as `ready`
    (`stroke:#16853c`), `blocked` (`#bd790a`, 2px), `stuck` (`#d92d20`, 2px,
    dashed `5 3`) and `quiet` (opacity 0.6), and a green `linkStyle` on the
    edges that no longer block.
  - **risk** (the export before the highlights): `overdue` (`stroke:#d92d20`,
    2px), `risk` (`#bd790a`, 2px), `cycle` (`#d92d20`, dashed `5 3`, the drawn
    `inCycle`) and an amber `linkStyle` on risk-chain edges.
    `isOverdueNode(node)` (an active node that is overdue itself, or a project
    or initiative whose status is overdue: the nodes the canvas tints red) is
    classed `overdue` first, and such a node is never also `risk`.
    `isRiskNode(node)`, only in an active project (a paused project's work is
    never loud, §2.8, and gets neither class): issue and milestone nodes when
    unassigned, overdue or waiting on either; project and initiative nodes when
    overdue or at risk. That is wider than the canvas's amber rule (§8.2 "graph
    node"), which shows the waiting only on the amber risk-chain edges, so the
    export also rules in amber an issue or milestone that waits on risk.
  - **critical:** the critical path is a walk over the drawn edges (§8.4 Graph),
    so core does not compute it: the host passes it as `critical: MermaidChain`
    (`{ nodeIds, edges }`, blocker first, a cycle's members together; the ui's
    `longestChain` result fits as it is). The block opens with
    `%% Critical path: n0 → n1 + n2 → n3 (4 issues)` (members of one cycle of
    the chain's own edges share a step, joined by `+`; the count takes the node
    kind's noun), then `classDef critical stroke-width:3px` with no colour (the
    theme's own stroke, readable on light and dark Mermaid themes) on the
    chain's drawn nodes and `linkStyle … stroke-width:3px` on its drawn edges.
    With no chain, or none of it drawn, the block holds only the external and
    focus classes.
  - **Hues:** `MERMAID_HUES` (`red #d92d20`, `amber #bd790a`, `green #16853c`)
    are the status hues of §8.2 "Status colours" (`--red`, `--amber`, `--green`)
    at a mid tone, since pasted Mermaid cannot read CSS variables and renders in
    either theme (the app's light hues are deeper text-safe steps that would
    fall under 3:1 on a dark page); `test/mermaid-hues.test.ts` reads
    `packages/ui/src/styles/tokens.css` and keeps each the same hue as its token
    (within 12°; `core:test` lists that file as an input). As strokes they hold
    3:1 or more on white, on Mermaid's default node fills (`#ececff` light,
    `#1f2020` dark) and on GitHub's dark page (`#0d1117`): red 4.83, 4.14, 3.38,
    3.92; amber 3.56, 3.05, 4.59, 5.32; green 4.71, 4.04, 3.46, 4.01. In the
    status highlight a hue only repeats the label's readiness word (blocked and
    stuck also widen the stroke, stuck dashes it, and an edge that no longer
    blocks is dotted). The purple accent is not a status and never appears in
    the Mermaid text.

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
  then `sortOrder`; projects in several initiatives appear under the first, as
  computed by `homeInitiativeIds`, which the dependency graph shares, §2.10),
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
- Dependency graphs (§2.10) are built from the viewer's snapshot at every level:
  nothing hidden becomes a node, an external, an edge, a weight, a risk input or
  a count. A container id the viewer cannot see (a project, milestone or chain
  issue of a hidden team) is `not_found` exactly like an unknown one. A guest
  has no initiatives, so every project's first initiative is `none`, and a scope
  naming initiatives answers the workspace with `fallback` (`no_initiatives`)
  for every id alike (`resolveGraphScope`).
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

- With personal API keys (`LINEAR_AUTH=api_key`, §7.4) the mirror is not the
  app's view but the **reader** account's (a connected workspace member's), so
  what that account cannot see is missing for everyone; views stay per viewer as
  above, and run and audit entries fail closed (`failClosed`: no `everything`
  shortcut, and an entry about something the mirror does not hold is hidden from
  members too).

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
  left, status, risk reasons, rubric, `isNext`, weight and progress).
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
// The issue a URL names: its id, or its identifier in any case. Moved from
// the planner's issue adapter (2026-10-22), which re-exports it.
export function findIssue(
  issues: ReadonlyMap<string, Issue>,
  key: string
): Issue | undefined;
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
export const NO_INITIATIVE_ID = 'none'; // "No initiative" group, node, container
// Each mirrored project's first initiative (the timeline's grouping, §2.11).
export function homeInitiativeIds(
  snapshot: Snapshot
): ReadonlyMap<string, string | null>;
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
// graph.ts / mermaid.ts — the dependency graph at every level (§2.10)
export function buildDependencyGraph(
  snapshot: Snapshot,
  ctx: EvalContext,
  assessments: ReadonlyMap<string, MilestoneAssessment>,
  scope: GraphScope
): DependencyGraph;
export const CHAIN_MAX_NODES = 150;
export const GRAPH_LEVELS_WITHIN: Readonly<
  Record<GraphContainer['kind'], readonly GraphLevel[]>
>;
export const DEFAULT_GRAPH_LEVEL: Readonly<
  Record<GraphContainer['kind'], GraphLevel>
>;
export function graphContainer(scope: GraphScope): GraphContainer;
export function graphScopeFor(
  container: GraphContainer,
  level?: GraphLevel
): GraphScope;
export type GraphScopeResolution =
  | { ok: true; scope: GraphScope; fallback: GraphFallback | null }
  | { ok: false; problem: 'invalid' | 'not_found'; message: string };
export function resolveGraphScope(
  snapshot: Snapshot,
  raw: unknown
): GraphScopeResolution;
/** Light-theme status MARK hexes of ui tokens.css (a core test keeps them equal). */
export const MERMAID_HUES: {
  readonly red: string; // '#d92d20'
  readonly amber: string; // '#bd790a'
  readonly green: string; // '#16853c'
};
/** The critical path to export, passed in (the ui's longestChain fits). */
export interface MermaidChain {
  nodeIds: readonly string[];
  edges: readonly { from: string; to: string }[];
}
export interface MermaidParts {
  body: string; // the same in every highlight
  styles: Record<GraphHighlight, string>;
}
export function mermaidParts(
  graph: DependencyGraph,
  options?: { critical?: MermaidChain | null }
): MermaidParts;
export function toMermaid(
  graph: DependencyGraph,
  options?: { highlight?: GraphHighlight; critical?: MermaidChain | null }
): string; // body + styles[highlight ?? 'status']
export function escapeMermaidLabel(text: string): string;
export function isOverdueNode(node: GraphNode): boolean;
export function isRiskNode(node: GraphNode): boolean;
export function readinessLabel(node: GraphNode): string; // "Ready", "Waiting on 2", "No dependencies", …
export function readinessClass(
  node: GraphNode
): 'ready' | 'blocked' | 'stuck' | 'independent' | 'quiet';
// types.ts: DependencyGraph.clusters: GraphCluster[] (built inside
// buildDependencyGraph; §2.10 "Clusters"), GraphNode.clusterId,
// GraphReadiness 'ready' | 'blocked' | 'done' | 'independent' | 'empty',
// GraphNode.unplacedBlockers
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

Graph types (`types.ts`, §2.10): `GraphLevel`, `GraphScope`, `GraphContainer`,
`GraphFallback`, `GraphChain`, `GraphNode`, `GraphEdge`, `DependencyGraph`,
`GraphReadiness` (`'ready' | 'blocked' | 'done' | 'independent' | 'empty'`:
`independent` "No dependencies", open and on no `blocks` relation; `empty` a box
no issue counts toward, "No issues") and `GraphHighlight`
(`'status' | 'risk' | 'critical'`, the highlight a graph is drawn or exported
with).

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
  workspace so demo drags and allocation runs "write back". Its numbers are
  pinned by hundreds of tests and the browser smoke, so it never changes:
  `test/base-snapshot.test.ts` deep-equals it against main's output. The generic
  builders (dates, people, workflow states, the issue builder) live in the
  internal `fixture-kit.ts`, shared with the showcase.
- `showcase.ts` (+ the tables in `showcase-data.ts`): the **showcase demo
  workspace** (`LINEAR_FIXTURE=showcase`, for the live demo), see "Showcase demo
  workspace" below.
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

### Showcase demo workspace (`showcase.ts`)

Owner feedback 2026-10-23: the demo needs "a ton of tasks", and "the graph is
there to show all issues not just blocking ones". The base fixture stays the
scenario fixture tests pin; the showcase is a second dataset for live demos.

- **It grows the base workspace.** `createShowcaseWorkspace(today)` contains
  `createFixtureWorkspace(today)` unchanged, entity by entity (the base teams
  only gain members), so every base scenario, person, the watchers, the
  installer, the guest Gus Hart and the workspace id are the same and the engine
  seeds it exactly like the base demo. On top: 12 people (22 users), the Data
  (DATA, linear estimates) and Growth (GRO, T-shirt estimates) teams, the
  Enterprise readiness and Self-serve insights initiatives, 12 projects (21;
  Sorrel in Backlog status, so with paused Fjord two are inactive), 50
  milestones (67: complete, overdue, at risk for each reason, on track soon and
  far out, no target date, empty, Willow's next milestone with no "done means…"
  as missing inputs) and about 365 issues (418, about 73% open, every state and
  priority, unassigned and unplanned work, open issues with no project), with
  issue-page content (labels from the title, estimates on the team's scale, due
  dates, descriptions and a seeded discussion on the issues the story runs
  through).
- **Due dates** (`Issue.dueDate`, which the mirror reads since the Issues view):
  98 of the 418 issues (23%; the base keeps its own 9), all relative to `today`
  and picked by the identifier's hash, so the same issues on any day. Each falls
  on or a few days before its milestone's target (base milestones included),
  never before the issue was filed, and none is on a canceled issue. Open work
  in a milestone that is not yet overdue is never overdue itself; half of the
  open work in an overdue milestone is, which with the base's two makes 9
  overdue open issues (five in Plume's Streaming ingestion, two in Ridge's EU
  data residency, Atlas's two in Dual-write). Two in three open issues of a
  milestone due within two days carry a date, so 5 are due today and 5 tomorrow;
  a quarter to a third of the rest of the open work in dated milestones, a sixth
  of the open work with no milestone date (4 to 25 days out) and a fifth of the
  closed work carry one.
- **Blocking relations (247)** follow three flow rules, so the layered layout
  reads left to right: a blocker's milestone is due no later than the blocked
  issue's (undated last); cross-project relations follow one project order
  (plume, orchard, atlas, beacon, juniper, harbor, ridge, thistle, delta, fjord,
  quarry, lagoon, nettle, marble, saffron, ember, umber, compass, sorrel,
  garnet, willow); cross-initiative ones flow Platform / Insights → Enterprise →
  Growth → No initiative (Insights receives from nobody, Enterprise sends only
  to No initiative). Only the designed cycles break them, plus the base chain
  ENG-12 → ENG-23 → OPS-20, so the initiative level's only cycle is the base's
  Platform ⇄ Growth.
- **Structure**: a 13-issue critical path, the enterprise launch
  (`SHOWCASE_CRITICAL_PATH`: ENG-60 → ENG-186 → ENG-187 (unassigned, so a risk
  chain from there) → ENG-194 → ENG-196 → ENG-240 → ENG-242 → ENG-225 → GRO-31 →
  GRO-33 → GRO-40 → GRO-41 → OPS-106, six projects), the unique longest chain;
  fan-out hubs (DATA-45 the overdue event schema rollout, blocking 9; OPS-52 the
  unassigned overdue capacity plan and base ENG-73 form components, 5 each) and
  fan-in hubs (GRO-40 the go/no-go with 10 blockers: 9 workstreams plus GRO-33
  on the critical path; DATA-75 scheduled report delivery with 5); exactly three
  cycles (`SHOWCASE_CYCLES`: base ENG-70 ⇄ ENG-71, ENG-243 → ENG-215 → ENG-244 →
  ENG-243 across Nettle and Marble, OPS-55 ⇄ OPS-73 across Ridge and Thistle,
  all Operations so the guest sees one); done blockers (16 resolved, 27 closed
  history); about 17% cross-project; every milestone mixes linked and unlinked
  work (paused Fjord aside); about 190 issues on no relation.
- **Draw budget**: every level draws every item in scope (all non-canceled
  issues, every milestone, project and initiative), so the whole workspace must
  fit the graph's draw limits (`GRAPH_DRAW_LIMITS`, 700 boxes and 1,000 arrows);
  the dataset keeps itself to at most 450 issue boxes and 600 relations. For a
  member the workspace's issue level is 406 boxes and 247 arrows in 100 frames,
  its milestone level 67 boxes, its project level 21 and its initiative level 5;
  the guest's issue level is 70. A new relation adds only an arrow, so a shared
  demo takes some 750 visitor-made relations before its issue level shows "Too
  many to draw". Measured on this sandbox (production build),
  `GET /graph?level=issue` for a member takes 0.36–0.50 s on a fresh server
  (`buildGraphPage` 174 ms, most of it the framed layout) and 0.10–0.19 s once
  its layout is cached (`buildGraphPage` 7 ms), a slide-over opening on it or a
  `?highlight=` in its URL included, since both reuse the same layout.
- **Deterministic**: the tables are text (one row per issue, `A > B > C`
  relation chains) parsed at load; the builder throws on a reference Linear
  would refuse. Timestamps a row leaves out come from an FNV-1a hash of the
  identifier and the milestone's timing profile, so the output depends only on
  `today`. `createShowcaseStore(today)` is a `FixtureStore` like the base one,
  served by the same `createFixtureGateway`. `createDemoStore(today, dataset)`
  and `demoMilestoneMeta(dataset)` (`FixtureDataset = 'base' | 'showcase'`) are
  what boot uses; `SHOWCASE_MILESTONE_META` is the base rows plus the
  showcase's.

### 4.1 Linear facts this design relies on

Verified against Linear's SDL (vendored at `packages/linear/schema/`, SDK
98.0.0) and Linear's SDK source; sources in `docs/research.md`.

**GraphQL** (`https://api.linear.app/graphql`, `Authorization: Bearer <token>`
for OAuth tokens; `Authorization: <key>`, raw, for a personal API key)

**Personal API keys** (`LINEAR_AUTH=api_key`, §7.4; checked 2026-10-23, sources
and the unverified points in `docs/research.md` "Personal API keys"):

- F1: a personal key is sent **raw** in `Authorization`, with no `Bearer`
  (Linear's SDK: `accessToken ? Bearer … : apiKey`). F2: keys start `lin_api_`,
  OAuth tokens `lin_oauth_`, so `/lin_(api|oauth)_[A-Za-z0-9_-]{16,}/` finds
  every credential the planner handles (core's `redactLinearSecrets`). F3: the
  body's length and alphabet are unverified, so the accepted shape is one
  constant (`LINEAR_API_KEY_SHAPE`, 16–200 URL-safe characters).
- F4: a key may have full access or chosen permissions (Read, Write, Admin,
  Create issues, Create comments), may be limited to teams, and admins can stop
  members creating keys. F5: the API has **no** field for a key's own
  permissions or teams and **no** mutation to revoke a key. F6: the identity
  query (`viewer`, `organization`) is the "whose key is this" check. F7: how
  Linear refuses a Read-only key's write is unverified (most likely type
  `forbidden`), so read-only detection is a narrow heuristic (§7.4) that fails
  safe. F8: 2,500 requests/hour and 3,000,000 complexity points/hour per user,
  shared by all their keys; the reset headers are the same as OAuth's.
- F9: `Query.rateLimitStatus.identifier` may echo the key: the planner never
  queries it (tested). F10: webhooks need admin permission and this mode turns
  them off. F11: Node (undici) and Bun echo an invalid header value in their
  error. F12: Railway's edge documents `X-Real-IP` as the client IP (not
  `X-Forwarded-For`), always forwards `https`, turns a plain-HTTP POST into a
  GET after its body crossed in clear, and logs no bodies. F13: `railway ssh`
  reaches the container, and Node opens its inspector on `SIGUSR1` unless
  `--disable-sigusr1`. F14: on a cross-origin redirect, Node and Bun drop
  `Authorization` but resend the POST body.
- The client (`client.ts`) takes exactly one of `accessToken` (OAuth, `Bearer`)
  or `apiKey: () => string | null`, a getter read before every attempt (first
  try, each retry, after each rate-limit wait); null fails at once as
  `unauthorized` ("No Linear credential is held for <op>") without a fetch.
  Before any fetch the header must be printable ASCII with at most the one space
  after `Bearer` (F11). Every fetch sets `cache: 'no-store'` (never in Next's
  Data Cache) and `redirect: 'error'` (F14; Linear's API does not redirect).
  Every string a failure carries — the fetch error and each GraphQL error's
  `message` and `userPresentableMessage` — is scrubbed of the exact credential
  sent and then of anything credential-shaped; a raw fetch error is never
  attached as `cause` (a scrubbed copy keeping its name is).

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

**Credential-free store** (`LINEAR_AUTH=api_key`, §7.4):
`openStore({ encryptionKey: string | null })` — null opens a store that keeps no
Linear credential at all. Its `tokenParams` throws the exported
`StoreCredentialError` ("This store keeps no Linear credentials
(LINEAR_AUTH=api_key)."; never a value) for any non-empty access or refresh
token and binds `''`/null otherwise; `tokensFromRow` never decrypts and hands
back blank tokens whatever the columns hold (an earlier OAuth deploy's
ciphertexts). A keyed store reads an `''` access token as `''` (a binding row
written in api_key mode), and the OAuth provider treats such an installation as
lost access without calling Linear. In api_key mode the `installations` row is
the **workspace binding** (`appUserId ''`, blank tokens; §7.4); adopting an
earlier OAuth row of the same org blanks its token. **Nothing is purged at
boot**: leftover sessions and ciphertexts are never read in this mode, and the
operator cleanup (revoke the OAuth app, delete `TOKEN_ENCRYPTION_KEY`) is in
deploy.md.

**Planner-owned text is scrubbed, the mirror is not** (every mode):
`credentialFree(text)` (core's `redactLinearSecrets`) runs on settings JSON,
milestone meta (done-means), `sync_state.last_full_sync_error`, run summaries
and errors, run entries' detail and error, audit before/after, notification
digests and errors (through `jsonParam(value, { credentialFree: true })` or
directly), so a key pasted by mistake into "done means…" or echoed into an error
is stored as `lin_api_[redacted]`. It is never applied to
`replaceMirror`/`applyMirrorChanges`, sessions, installations or webhook
records: the mirror is Linear's data (a key in a title is already in Linear),
and the editors are pre-filled from it, so a rewritten title would be written
back. `finishJob` stores no text.

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
  written: not Linear, the mirror, settings, the run log or the audit log. With
  personal API keys (§7.4) one more reason exists, **`read_only_key`** (Linear
  refused one of the key's writes as out of its scope): "Your Linear API key
  only allows reading, so you can look but not change anything here. Connect a
  key with Write access to edit." (`READ_ONLY_MESSAGES`, exported).
- **getGraph(workspaceId, scope, viewer?)** (§2.10): a read. The scope is
  checked by core's `resolveGraphScope` against the viewer's narrowed mirror (no
  hand-written checks): a malformed scope or a level the container does not
  offer is `EngineInputError('invalid')`, a container id the viewer's mirror
  lacks (unknown or hidden alike, including a `?chain=` issue) is `not_found`.
  The graph is built for the resolved scope: a chain carries the issue id even
  when asked by identifier, and a scope naming initiatives for a viewer whose
  mirror has none (a guest, a person the mirror does not know, a workspace
  without initiatives) is drawn for the workspace with `fallback` set, never
  a 404. It writes nothing and never calls `requireWritable`, so a guest gets
  every level.
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
from `milestone-edits.ts` (was `pm-edits.ts`). API-key mode (additive, §7.4):
`linearAuthFromEnv`, `isApiKeyEnv`, `apiKeyUnusedEnvVariables`,
`processFlagProblem`, `createApiKeyEngine` (the api_key engine over an open
store, for tests), `API_KEY_IDLE_MS`, `API_KEY_MAX_MS`, `KEY_SHAPE_MESSAGE`,
`KEY_TEXT_MESSAGE`, `KEY_FORGOTTEN_MESSAGE`, `KEY_REJECTED_MESSAGE`,
`NO_READER_MESSAGE`, `OAUTH_OFF_MESSAGE`, `SCHEDULED_OFF_MESSAGE`,
`READ_ONLY_MESSAGES`, `isKeyPermissionRefusal` and the types
`ApiKeyConnectResult`, `KeyConnectionStatus`, `ApiKeyConfig`, `LinearAuthMode`.
The `Engine` contract gains `connectApiKey(input)`, `getKeyConnection(actor)`
and `signOut(token, { everyDevice? })`, which now resolves to a `SignOutResult`
`{ known, keysForgotten }` in every mode (`known`: the token named a session
row, or in api_key mode a connected key, live, expired or recently ended);
`CreateEngineFromEnvOptions` gains `migrateOnly` (the worker's `migrate`, §9);
`EngineAuthError['code']` gains `key_rejected`, `key_cannot_read`,
`guest_cannot_bind` and `no_reader` (error codes, not permission distinctions);
`ReadOnlyReason` gains `read_only_key`; `IssueBulkResult.stopped.code` gains
`read_only`; `EngineConfig` gains `auth` and `apiKey`
(`{ idleMs, absoluteMs, syncIntervalMs, workspacePin, endpoint, deployed }`,
null outside api_key mode); `EngineDeps` gains `keys` and `apiKeyGateway`.

`createEngineFromEnv`:

- Retired variables (`RETIRED_ENV_VARIABLES` in `config.ts`): `PM_EMAILS` seeded
  the PM list, which the owner decision of 2026-10-22 retired. It is neither
  read nor validated (a malformed old value never blocks a boot); when a deploy
  still sets it, boot logs exactly one warning saying it is unused and to set
  `WATCHER_EMAILS` instead.

- `LINEAR_FIXTURE=1` or `LINEAR_FIXTURE=showcase` (demo mode; any case, and
  `true` = `1`; `fixtureDatasetFromEnv(env)` gives `'base' | 'showcase' | null`
  and `isFixtureEnv(env)` is every "is this demo mode" check, the worker's, the
  webhook route's and the `/ui-gallery` guard's included; any other value than
  those and `0`/`false` is a config error): in-memory PGlite unless `PGLITE_DIR`
  is set; ephemeral random `TOKEN_ENCRYPTION_KEY` if unset; `APP_URL` defaults
  to `http://localhost:3000`; `oauth: null`. Seeds the demo workspace
  (`createDemoStore(today, dataset)`: the base fixture for `1`, the showcase for
  `showcase`, §4 "Showcase demo workspace"; the "engine ready" log line names it
  as `demoWorkspace`), a fake installation (installed by
  `FIXTURE_INSTALLER_USER_ID`, Ana), settings (watchers =
  `FIXTURE_WATCHER_USER_IDS`, Ana and Ben; `dry_run`, `preview`; no PM flags:
  every demo person may edit everything, except the one Linear guest, Gus Hart
  (`FIXTURE_GUEST_USER_ID`, a member of Operations only), who is read-only),
  milestone meta from `demoMilestoneMeta(dataset)` (`FIXTURE_MILESTONE_META`, or
  `SHOWCASE_MILESTONE_META`, which adds the showcase's rows), then `fullSync`.
  Settings → Status names the demo workspace and its `LINEAR_FIXTURE` value.
  `devSignIn` creates sessions with scopes `read,write`. Webhooks are ignored.
  The `LinearProvider` serves `createFixtureGateway` (app actor or the session's
  user).
- `LINEAR_AUTH=api_key` (§7.4; a config error with `LINEAR_FIXTURE`): requires
  only `APP_URL` (https when **deployed**: `NODE_ENV=production` on a
  non-loopback `APP_URL`) and, when deployed, `LINEAR_WORKSPACE`; refuses
  `--inspect*`, `--debug*`, `--heapsnapshot-near-heap-limit` and
  `--heapsnapshot-signal` in `process.execArgv` or `NODE_OPTIONS`, and when
  deployed requires `--disable-sigusr1` (`processFlagProblem`). Logs one warning
  per variable it does not read (`TOKEN_ENCRYPTION_KEY`, `LINEAR_CLIENT_*`,
  `LINEAR_WEBHOOK_SECRET`, `SESSION_SECRET`, `SLACK_BOT_TOKEN`, `SESSION_DAYS`:
  "X is unused when LINEAR_AUTH=api_key") and, when the test-only
  `LINEAR_API_URL` is set, one error-level line naming its origin. Opens the
  **credential-free store** (`encryptionKey: null`, even when
  `TOKEN_ENCRYPTION_KEY` is set), migrates (nothing is purged), and builds the
  vault, the key provider and the sync scheduler (`createApiKeyEngine`); the
  channel is the outbox. `engine ready` logs `auth`, `deployed` and `pinned`.
  Only the planner connects keys; the worker never boots this mode except for
  `migrate` (§9).
- Otherwise (OAuth): requires `APP_URL`, `TOKEN_ENCRYPTION_KEY`,
  `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`; `DATABASE_URL` or PGlite at
  `PGLITE_DIR` (default `.data/pglite`); redirect URI
  `${APP_URL}/api/auth/linear/callback`; Slack channel when `SLACK_BOT_TOKEN` is
  set, else the outbox. Runs `store.migrate()` before returning.
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

### 7.4 API-key mode (`LINEAR_AUTH=api_key`, owner request 2026-10-23)

The owner's words: "Also update it so I can just give my own api key. Dont save
it anywhere though make sure it is secure" (design doc §12, 2026-10-23). A third
way to reach Linear beside OAuth and demo mode, explicit in config
(`LINEAR_AUTH=api_key`, §10; `EngineConfig.auth` is `demo | oauth | api_key`,
read without booting by `linearAuthFromEnv(env)`). It needs no OAuth app, no
`TOKEN_ENCRYPTION_KEY`, no webhook secret and no `SESSION_SECRET`: each person
pastes their own Linear **personal API key**, which lives only in the planner
process's memory and is never written to the database, disk, logs, audit,
caches, payloads, URLs, variables or the browser. OAuth and demo mode are
unchanged.

**The key vault** (`key-vault.ts`, not exported from the engine index):

- `byHash` (SHA-256 of the cookie token → entry), `byId` (internal id → entry)
  and a **separate** `keys` map (id → key), so no entry, `VaultSession` or
  anything handed out ever references the key. Its only reader is a private
  `liveKey(id)`; `gateway(id)` builds `deps.apiKeyGateway(() => liveKey(id))`,
  and the linear client reads that getter before **every** attempt (§4.1), so
  work in flight stops using a key the moment it is forgotten.
- Limits: `API_KEY_IDLE_MS` (2 h without the person's own request) and
  `API_KEY_MAX_MS` (12 h after connecting, never extended). Only `use(token)` (a
  person's own request through `authenticate`) touches `lastUsed`; background
  syncs, status reads and the getter never do, so nothing keeps an idle key
  alive. Caps: 200 live entries (`VaultFullError` → `conflict`), 5 per person
  (the oldest is evicted).
- Forgetting (`removeByToken`, `forgetPerson`, `remove`, expiry, `clear`)
  deletes from all three maps; a restart or redeploy loses everything (people
  paste again). JS cannot wipe a string, so the GC reclaims it later.
- **Ended records** (fix stage 2026-10-23): an entry that ends on its own (idle
  or absolute expiry, by `use`, `peek`, `gateway` or a sweep, or evicted by the
  per-person cap) leaves `cookie hash → { workspaceId, userId, untilMs }` in a
  fourth map, **no key and no token**, until the end + `API_KEY_MAX_MS` (the
  last moment another entry of that person can still be alive), at most 2,000
  (oldest dropped first), swept with the entries and cleared by `clear`. A
  sign-out, `removeByToken` or `remove` leaves none. `forgetPerson(token)` finds
  the person through the token's entry (live or expired) or its ended record and
  returns `{ person, dropped }` (`person` null when the token names nobody), so
  "sign out everywhere" from a browser whose own connection already ended still
  forgets that person's other browsers.
- `markGuest(workspaceId, userId)` marks every entry of a person `guest` (Linear
  made a connected member a guest): from then on they are no reader and
  read-only (`guest`).
- The vault exposes only functions; `VaultSession`s are frozen plain data.
  `JSON.stringify`, `util.inspect(showHidden, depth ∞)` and `structuredClone` of
  anything it returns hold no key (tested).

**Connect** (`key-auth.ts`, `Engine.connectApiKey({ apiKey })` →
`ApiKeyConnectResult = SignInResult & { syncAfter }`): any other mode →
`invalid` ("Personal API keys are off on this server."). The key is trimmed and
must match `LINEAR_API_KEY_SHAPE` (core, `lin_api_` + 16–200 URL-safe
characters; no zod, and the fixed message never includes the input). The one
validation call is `whoAmI()` (viewer and organization) through
`deps.apiKeyGateway(() => key)`: `unauthorized` → `key_rejected`, `forbidden` →
`key_cannot_read`, `rate_limited` → `rate_limited`, transport failures are
rethrown (the route answers `linear_unreachable`). App users and deactivated
people → `not_signed_in`. Then, under `rt.serialize('api-key-binding')`:

- **The binding** reuses the `installations` row (§5): `appUserId ''`, blank
  tokens, `installedByUserId` the first member who connected (or an adopted
  row's installer). A guest is never written as the installer: a guest who
  connects first to a pinned planner leaves it `''`, and the next member's
  connect fills it, so the binder (who reads first and is the default watcher)
  is always a member. `bindingFor(store, pin)`: with `LINEAR_WORKSPACE` the row
  whose id or URL key (case-insensitive) is the pin; without it (local runs and
  tests; it is required when deployed, §10) the oldest row with `appUserId ''`,
  so a leftover OAuth or demo row never binds by age. A key of another org →
  `wrong_workspace` (the message never names the bound workspace). Unpinned and
  unbound, a guest → `guest_cannot_bind` ("A member of the workspace has to
  connect first…"); a pinned planner lets a guest connect. Adopting a row of the
  same org (an earlier OAuth install) keeps its `createdAt`, installer and
  everything keyed by the workspace; an OAuth process left over that store then
  sees "lost access" (§7.1) and never acts as the app.
- `vault.add`; when the mirror is missing or does not know the person,
  `fullSync` runs now (a `no_reader` failure is logged at info), else
  `syncAfter` is true unless a sync landed in the last 60 s (the route runs it
  in `after()`). Anything that throws after `vault.add` (reading the mirror is a
  database round trip) forgets the entry again before the error goes on
  (`warn 'a connect failed after the key was held; forgot it'`), so a person
  told the connect failed never leaves a key behind. One log line,
  `connected a Linear API key` (ids only: never the key, a prefix, a suffix or a
  fingerprint).

**authenticate / signOut / cleanup** in this mode: `authenticate(token)` →
`vault.use(token)`, then `mirrorForPerson` (exported from `auth.ts`); a person
the mirror shows deactivated or as an app user is forgotten; `readOnlyReason` is
`readOnlyReasonFor(…, installed = true)`, then `guest` when Linear said so at
connect, then **`read_only_key`** when Linear refused one of the key's writes as
out of its scope. A member the mirror now shows as a guest is marked
(`vault.markGuest`) so their key stops reading at once. The `Session` handed out
has the vault entry's internal id, `createdAt` = connect time, `expiresAt` = the
absolute limit and tokens
`{ accessToken: '', refreshToken: null, scopes: ['read','write'] | ['read'] }`.
`canWriteLinear = !readOnly`; there is no separate write grant, so
`needs_write_scope` cannot arise. `signOut(token, { everyDevice: true })` (the
logout route) forgets every entry of that person (`vault.forgetPerson`, found
through an ended record too) and returns `{ known, keysForgotten }`; without it
(a reconnect replacing its cookie) only that entry. `known` is false for a token
the vault no longer knows of (after a restart, past the record's time, or no
record), and the route then never claims the key was forgotten everywhere
(§8.1). Nothing is revoked: Linear has no API for it (§4.1), so the key keeps
working in Linear until its owner revokes it. `cleanup()` sweeps the vault;
there are no sessions rows or revocations. `startOAuth`, `finishSignIn`,
`finishInstall` and `devSignIn` → `invalid` ("Linear OAuth is off: this planner
uses personal API keys.").

**Which key each Linear call uses** (`key-provider.ts`,
`createApiKeyLinearProvider({ vault, logger, appName, binding })`):

| call site                                                                                          | OAuth                                                     | `api_key`                                                                                                                  |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| a person's edits (issue, bulk, milestone date, project lead, relations, comments) via `forSession` | the person's token                                        | **the person's own key**                                                                                                   |
| issue page live read (`issue-detail.ts readerFor`)                                                 | the person's token, else the app's on a transient failure | the person's own key only: a failure shows "Linear did not answer for your key just now; showing the planner's copy only." |
| full sync (`sync.ts`) and the relation re-read after a relation edit, via `forApp`                 | app token                                                 | **the reader key**, behind a gateway whose seven writes throw `read_only` without calling Linear                           |
| live allocation writes (`allocation-run.ts`)                                                       | app token                                                 | **the run starter's own key**                                                                                              |
| webhooks                                                                                           | app token                                                 | none: the route answers 404 and `handleWebhook` returns `ignored`                                                          |

- `forSession(session)` needs a live vault entry of that very person (same user
  and workspace), else `not_signed_in` ("The planner forgot your Linear key (you
  signed out, were idle, reached the time limit, or the planner restarted).
  Paste it again.").
- `forApp(workspaceId)`: not the bound workspace → `not_installed`; the
  **reader** is
  `vault.readers(ws, { preferUserId: binding.installedByUserId })[0]` —
  workspace members only (never a guest), the binder first, then the earliest
  connected, ties by id; none → **`no_reader`** ("No workspace member has a
  Linear key connected right now, so the planner cannot read Linear. It shows
  its last copy.", 503 on the web, never "signed out").
- **The reader is checked against what it reads**: the gateway `forApp` hands
  out sends every call to the current reader, and a full read (`fetchWorkspace`)
  whose users list the reader as a guest throws that read away, marks the person
  (`markGuest`) and reads again with the next reader (as deactivated or an app
  user: their key is forgotten, as `authenticate` does), at most
  `MAX_READER_TRIES` (3) full reads; with no reader left it fails `no_reader`
  and the mirror is not replaced. So a member Linear makes a guest while
  connected never shrinks the mirror to a guest's teams. A reader missing from
  the users list is let through (the users read includes everyone, disabled
  people too).
- Every gateway method is guarded: on `unauthorized`, a key the vault no longer
  holds was forgotten mid-call (`not_signed_in` for a person, `no_reader` for
  the reader); a key it still holds was revoked in Linear and is forgotten
  (`warn 'Linear refused a connected API key; forgot it'`), so the person's next
  request is signed out. A reader failure never signs anyone out. A person's
  write refused with `isKeyPermissionRefusal(error)` (kind `forbidden` whose
  first GraphQL error speaks of a scope, an API key or read-only; generic
  "permission to perform" deliberately not, since per-issue refusals use it)
  marks the entry `writeRefused` and throws `read_only` with the read-only-key
  sentence; from then on `requireWritable` refuses every change before Linear is
  called. Linear has no API that reports a key's permissions (§4.1), so this is
  how a read-only key is found.

**The mirror is the reader account's view.** A private team the reader is not
in, or anything outside a team-restricted reader key, is missing for everyone
until a wider key reads (Settings → Status names whose key reads). Views stay
per viewer (§2.13), and run and audit entries are filtered **failing closed**:
`visibleRunEntries` / `visibleAuditEntries` get `{ failClosed: true }`, so there
is no `everything` shortcut and an entry about something the mirror does not
hold is hidden from everyone (settings entries stay visible). With no member
connected the mirror stays as last synced.

**Background sync** (`key-sync.ts`, `createKeySyncScheduler`): one unref'd
60-second timer, started when the vault gets its first entry and stopped when it
empties (and on `close()`). Each tick sweeps expired keys, then every
`SYNC_INTERVAL_MINUTES` (default 15) runs `fullSync` while a member is connected
(single-flight; a failure is logged and recorded on `sync_state`). Other syncs:
on connect (above), on Resync (`POST /api/sync`), and on a first page with no
mirror. A full sync's error is shared with every caller that joined it, so
`runFullSync` rethrows it through `withoutCredentials` (`runtime.ts`): a copy
with credential-shaped text redacted, same class, code and kind.

**Runs** (`allocation-run.ts`): only a signed-in person starts one
(`actor: null` → `not_signed_in`); `runDaily` and a live `runWarnings` →
`invalid` ("Scheduled runs are off when the planner uses personal API keys…");
the digest preview still works (it reads only the mirror). A person's run plans
over **their own view** (`loadWorkspace(…, { viewer: actor })`), dry and live,
and its live writes (the same assignee + state and one comment as ever) go out
with **their key**, so Linear credits them. A re-check that finds nothing under
their key is `failed` with "Linear did not return this issue for your key: it
was deleted, or your key cannot see it." (not `stale/not_found`). An
`EngineAuthError` from the gateway (forgotten, revoked, read-only) stops the
live loop and finishes the run `failed` with that sentence. Bulk edits stop the
same way with `stopped.code === 'read_only'` (the rest `not_attempted`: "Not
attempted: your Linear API key only allows reading."; nothing changed → thrown).

**Status** (`Engine.getKeyConnection(actor)` → `KeyConnectionStatus | null`,
null outside this mode): `{ connectedAt, expiresAt, idleMinutes, reader }`, the
reader as `{ userId, userName }` or null. It holds no key or token by
construction.

**Key-shaped text** (security S14): in this mode `addComment` refuses a body
holding a credential-shaped run, and `updateIssue` a title or description that
**introduces** one (`introducesLinearCredential(current, next)`: an existing
description that already quotes one can still be edited), with `invalid` ("That
looks like a Linear API key; it was not sent.") before Linear is called.
Planner-owned text is stored redacted instead (§5).

**Other touch points:** `listWorkspaceIds()` returns only the binding,
`listRevokedWorkspaceIds()` `[]`; `close()` stops the scheduler, clears the
vault, then closes the store; `requireInstallation` without a row says the
planner "serves no Linear workspace yet: a workspace member connects their API
key first."

**Limits** (documented, not enforced): one planner instance (the vault is per
process; on Railway one replica, App Sleeping off); every deploy forgets every
key; a deployed planner needs `DATABASE_URL` (PGlite on the container's disk
loses the settings, weights, "done means…" and the audit log on every deploy;
boot warns when `deployed` and `DATABASE_URL` is unset). Whoever can deploy,
change variables or open a shell in the container could still capture keys (§8
"Security"); the connect page and deploy.md say so.

## 8. Web app (apps/planner)

One reference: **layout, interaction and look from Gr8r Studio
(github.com/gr8rstudio/gr8r-studio)**, with one exception, the accent, which is
our purple `#9747ff` (an earlier owner decision) in the role Gr8r gives its
indigo. Gr8r decides where things go and how they behave (sidebar shell, topbar,
command palette, grouped task lists, Gantt timeline, slide-over drawer, projects
register, phone tab bar) and, since the owner decision of 2026-10-23 ("I think
we should go with that reskin that you were proposing before", design doc §12),
how everything looks: warm neutral surfaces, soft low-contrast borders, 4–12px
radius, soft shadows only on things that float, tinted status colours,
sentence-case Geist at Gr8r's scale and weights, Geist Mono only for identifiers
and keys (§8.2). The status hue mapping of the owner decision of 2026-10-22 (red
overdue and failed, amber at risk, blocked, missing and unassigned, green on
track and succeeded, blue in progress and live, grey paused and inactive) is
unchanged; only its rendering is Gr8r's (§8.2 "Status colours"). The earlier
visual language from the Analytics `competitors-site` (paper/ink, black
hairlines, mono uppercase labels, hatched chrome, numbered blocks, zero radius,
no shadows) is retired; its token names were deprecated aliases while the last
sheets moved and are now removed (§8.2 "Old token names"). The restyle was first
built on the branch `claude/ui-reskin` (declined on 2026-10-22, then adopted on
2026-10-23); this is that visual language applied to today's screens, not a
merge of the branch. Gr8r is a reference only; nothing is imported from it.

### 8.1 Routes

| route                            | who               | what                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`                              | all               | signed out: "Sign in with Linear" (fixture mode: demo user picker); signed in → `/week`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `/week`                          | signed in         | My week (the landing screen); anyone may pass `?user=<id>` to see a person's week; `?issue=<key>` opens the issue slide-over (§8.5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `/timeline`                      | signed in         | Gantt timeline; `?milestone=<id>` opens the drawer (with `&issue=<key>`, one of its issues in its place, §8.5), `?project=<id>` focuses a lane; edit controls for everyone but a guest (date and lead need Linear write access)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `/projects`                      | signed in         | projects register: next milestone, status, progress, lead, allocation state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `/graph`                         | signed in         | dependency graph (§8.4) at four levels inside the workspace or one container: `?initiative=<id\|none>` (default: projects), `?project=<id>` (default: issues), `?milestone=<id>` (issues), `?chain=<identifier or id>` (one issue's chain); most specific wins; `?level=initiative\|project\|milestone\|issue` picks another level the container offers (otherwise ignored); no params = the workspace's milestones; `?node=<id>` selects a box on arrival; `?highlight=status\|risk\|critical` picks what the drawing emphasises (lenient: any case, `critical-path` too, anything else ignored; without it the `graph-highlight` cookie remembers the last one picked on the device, else Status; never part of a scope's URL); an unknown or hidden id renders the not-found page (streamed with status 200, like every `(app)` page, below), except initiative ids for a viewer with no initiatives (the workspace, with a notice); `?issue=<key>` opens the slide-over (§8.5) |
| `/runs`, `/runs/[id]`            | signed in         | allocation run log; everyone but a guest gets "Preview (dry run)" and, while allocation is live, "Run now"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `/settings`                      | signed in         | modes, watchers, schedule, status, digest preview, notifications, audit; editable by everyone but a guest (read-only for them)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `/setup`                         | signed in         | install the app into the workspace (admin; nothing to start for a guest)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /api/palette`               | signed in         | command-palette index (pages, projects, milestones, the user's open issues → `/issues/<key>`), fetched when the palette opens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /api/auth/linear?intent=`   | —                 | starts OAuth (sets `mp_oauth` cookie); `install` and `grant_write` need a session and are refused for a read-only person (`/?auth_error=read_only`), except `install` while the first sync has not landed (`not_synced`); `grant_write` is offered to everyone else                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /api/auth/linear/callback`  | —                 | finishes OAuth                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `POST /api/auth/logout`          | —                 | ends session                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `POST /api/auth/demo`            | fixture mode only | demo sign-in                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `POST /api/auth/key`             | api_key mode only | connect with a personal Linear API key (§7.4): the connect form's urlencoded `apiKey` and optional `returnTo` → 303 to `returnTo` with the session cookie, or 303 to `/?auth_error=<code>`; 404 in other modes (see "API-key mode" below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `POST /api/webhooks/linear`      | Linear            | verify, ack 200, process in `after()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PATCH /api/milestones/[id]`     | not a guest       | `{ targetDate?, weight?, doneMeans? }`; `targetDate` needs Linear write access                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `PATCH /api/projects/[id]`       | write access      | `{ leadId }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `/issues`                        | signed in         | the Issues page: every issue the person can see; the URL is the whole view (`?q=&initiative=&project=&milestone=&assignee=&team=&state=&priority=&quick=&group=&sections=&sort=&dir=&limit=`); `?issue=<key>` opens the slide-over (§8.5); read-only for a guest                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `/tasks`                         | all               | a 307 to `/issues` (a `next.config.ts` redirect, query kept), never a page                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `/issues/[id]`                   | signed in         | the issue page (§8.5), by identifier (`/issues/ENG-24`) or id; edit controls for anyone with Linear write access (never a guest)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /api/issues/[id]`           | signed in         | `{ result: IssueDetailResult }` by id or identifier, private, never cached (the pages render the issue on the server)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /api/issues/options`        | signed in         | `{ options: IssueListOptions, mirrorVersion }`: the Issues page's picker data (initiatives, projects with their milestones, people, teams with their states) as the person may see it, fetched on the first popover open; private, never cached                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `GET /api/issues/search?q=`      | signed in         | the relation picker's mirror search (`&near=<issue id>` ranks that issue's milestone and project first) → `{ results }`, at most 20, private                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `PATCH /api/issues/[id]`         | write access      | `[id]` is the issue id (not the identifier, unlike the GET); an `IssuePatch` (§3) → `{ result: IssueUpdateResult }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `PATCH /api/issues`              | write access      | the Issues page's bulk change, drop and Undo (§7.3): `{ issueIds (1–100, distinct), patch: IssueBulkPatch, returnTo? }`, strict → `{ result: IssueBulkResult }` (partial results included), private; a guest 403 `read_only` before the body; no grant 403 `needs_write_scope` with the link back to the sanitized `/issues…` `returnTo` (else `/issues`); a stop with nothing changed 401 or 429 with `Retry-After`; an unknown or hidden target 404                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `POST /api/issues/[id]/comments` | write access      | `{ body }` → 201 `{ comment }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `POST /api/issues/[id]/blockers` | write access      | `{ blockerIssueId }` (it blocks `[id]`) → 201 `{ relation }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `DELETE /api/relations/[id]`     | write access      | removes a blocks relation (no body) → 204                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `POST /api/runs`                 | not a guest       | `{ mode: 'dry_run' \| 'live' }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `POST /api/sync`                 | not a guest       | full resync, answering `{ sync: { workspaceId, ok, version, durationMs, error } }` (no counts); 429 `resync_cooldown` with `Retry-After` within 60 s of the workspace's last web resync                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `POST /api/warnings/preview`     | not a guest       | digests without sending                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `PATCH /api/settings`            | not a guest       | settings patch (audited)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `GET /api/health`                | —                 | `{ ok, db }` for Railway healthchecks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `/ui-gallery/*`                  | demo mode only    | the `@better-tracker/ui` component gallery with fixture props (no engine); 404 unless demo mode (`LINEAR_FIXTURE=1` or `showcase`) or `next dev`, checked per request                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

`/graph` also takes `?lock=<id or issue identifier>` (owner request 2026-10-23,
§8.4 Graph "Lock on"): the box the reader locked, client state written in place
like `?highlight=`, never read by the server and never part of a scope's URL; a
box that is not drawn locks nothing, and the address bar drops it.

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
rendering of every page, which only API-key mode does, below; development adds
`'unsafe-eval'`),
`Strict-Transport-Security: max-age=31536000; includeSubDomains` (ignored by
browsers over plain HTTP), `X-Frame-Options: DENY`, `nosniff`, a strict-origin
referrer policy and a Permissions-Policy.

**API-key mode** (`LINEAR_AUTH=api_key`, owner request 2026-10-23, §7.4;
binding):

- `/` signed out shows the **connect form** (§8.4) instead of "Sign in with
  Linear"; the OAuth routes (`/api/auth/linear`, its callback) redirect to `/`
  and `POST /api/auth/demo` is off as in real mode. `POST /api/webhooks/linear`
  answers a bare 404 before reading the body. `POST /api/auth/logout` calls
  `signOut(token, { everyDevice: true })` (every key of that person is
  forgotten, on every device, even when this browser's own connection already
  ended, §7.4 "Ended records") and clears both cookie names. It lands on
  `/?signed_out=1` ("Signed out", muted: the key was forgotten in every browser
  and still works in Linear until it is revoked there) only when the result is
  `known`; with no cookie, or one the vault no longer knows of, it lands on
  `/?signed_out=ended` ("Already disconnected", warning: this browser's
  connection had already ended, so the planner could not tell whose key to
  forget; it may still be connected in another browser; paste it again and sign
  out to forget it everywhere). A browser that still sends a cookie the vault no
  longer knows (idle, time limit, too many browsers, restart) sees "CONNECTION
  ENDED" on `/`.
- `POST /api/auth/key` (`lib/api-key-connect.ts handleConnect`, a route handler
  on purpose: Next logs Server Function arguments in development) checks, in
  this order: (1) api_key mode, else 404; (2) with a test endpoint
  (`LINEAR_API_URL`) only loopback hosts, else a bare 404; (3) the CSRF guard
  (`rejectCrossOrigin`, as every mutating route); (4) on an https `APP_URL`, an
  `X-Forwarded-Proto` that is not `https` → `insecure_transport` (Railway turns
  a plain-HTTP POST into a GET, F12, so this is a backstop); (5)
  `Content-Type: application/x-www-form-urlencoded`, else 415; (6) the body, at
  most `CONNECT_MAX_BYTES` (4096), never logged; (7) the rate limits; (8) the
  key's shape, without the engine; (9) `engine.connectApiKey`; (10) the
  browser's previous session (if any) is signed out, the post-connect sync goes
  to `after()`, and the answer is a 303 to the sanitized `returnTo` with the
  session cookie. Failures are 303s to `/?auth_error=<code>` (`key_shape`,
  `key_rejected`, `key_cannot_read`, `key_wrong_workspace`, `guest_cannot_bind`,
  `not_signed_in`, `connect_rate_limited` with `Retry-After`,
  `insecure_transport`, `key_capacity`, `linear_unreachable`,
  `linear_rate_limited`, `invalid_request`, `internal`), each with one fixed
  sentence (`lib/adapters/landing.ts`); no answer, header or URL ever carries
  the key.
- **Rate limits** (`lib/connect-limit.ts`, in memory): per client IP 10 failures
  per 10 minutes (every failure counts), keyed on Railway's **`X-Real-IP`**
  (never `X-Forwarded-For`, which a client can set; requests without a usable IP
  share one bucket); globally 60 failures per 10 minutes counting only failures
  that reached Linear. **A try is counted when it begins** (`limiter.begin`,
  synchronously after the body is read, before anything is awaited), so
  concurrent posts cannot all pass while Linear answers: at most 10 tries per IP
  are ever in flight or failed in the window. `finish(outcome)` keeps the count
  for a failure that counts and takes it back for a success or an outcome that
  does not (`linear_unreachable`, `linear_rate_limited`, `key_capacity`,
  `not_signed_in`, `internal`). **The global window refuses only a client that
  failed itself in the window**: a client with no failure of its own always gets
  its try (its failure then counts), so one source filling the window can never
  lock out everyone re-pasting their key after a redeploy (fix stage
  2026-10-23). Successes count toward neither; the per-IP map is LRU-capped at
  10,000.
- **The session cookie**: `__Host-mp_session` on an https `APP_URL` (`Secure`,
  `Path=/`, no `Domain`, so a sibling subdomain cannot plant one; a plain
  `mp_session` is then ignored) and `mp_session` on http, both `HttpOnly`,
  `SameSite=Lax`, and with **no `Max-Age` or `Expires`** (a browser-session
  cookie; the vault's limits end the session). The token is the vault's opaque
  random token; only its SHA-256 is kept.
- **No key in a page URL** (`proxy.ts`, api_key mode only; verify stage
  2026-10-23): Next echoes the request URL (path and query) in every rendered
  page's RSC payload, so a key pasted into the address bar or a link would come
  back in the page whatever the page does with it. Before anything renders, a
  page request whose path or query (raw or decoded once) holds a
  credential-shaped run gets a **303** to the same path without the query
  parameters that hold one, or to `/` when the path does (`lib/key-text.ts`
  `urlWithoutKeys`; a `returnTo` holding one is dropped too). The host's HTTP
  log may still record the URL the browser sent; the search box and palette
  refusals below keep the planner from ever producing one.
- **Nonce CSP** (`proxy.ts`, Next 16's Proxy on the Node runtime, read at
  request time so one build serves every mode): in api_key mode only, every page
  (not `/api`, static assets or prefetches) gets a fresh 16-byte nonce and
  `contentSecurityPolicy({ nonce })` (`lib/security-headers.ts`):
  `script-src 'self' 'nonce-…' 'strict-dynamic'`, `form-action 'self'`,
  `worker-src 'none'`, `upgrade-insecure-requests` on https, the rest as above.
  The proxy sets it on the forwarded request (Next reads the nonce there for its
  own scripts) and the response; the three layouts with inline scripts read
  `x-nonce` through `headers()` and put it on them. So an injected inline script
  cannot draw a fake connect form. OAuth and demo responses keep the static
  policy. `next.config.ts` sets `experimental.serverComponentsHmrCache: false`,
  so development never caches a fetch that carried a key.
- **No request capture**: the planner has no `instrumentation.ts` or
  `middleware.ts`, and none may be added that captures headers or bodies (a
  static test fails on one). `deploy/Dockerfile` runs the planner with
  `NODE_OPTIONS=--disable-sigusr1` and `ulimit -c 0` (F13), which the engine
  checks when deployed (§7.1).
- `lib/http.ts` maps the engine's `no_reader` to **503** (the page shows the
  last copy) and, in this mode, a missing session to 401 "Connect your Linear
  API key first."

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
- The fixture-mode picker on `/` is Gr8r's sign-in card: the demo people as
  full-width secondary buttons (round avatar, name, email, a chevron; named
  "Sign in as <name>", the email or guest note as its description), with no role
  column or ordering by role, and says that everyone can make every edit, except
  the guest. The demo's one Linear guest, Gus Hart (Operations only), carries a
  `Guest` chip and the note "Guest in Linear · sees one team, read only"
  (`DemoUserRow.label`; Linear's guest flag, not a role). `?auth_error=not_pm`
  is no longer a known code (it reads as an unfinished sign-in).
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
  its sync), `/api/sync` 200 `{ sync }` (a `SyncResult` without its `counts`:
  they are of the whole mirror, which may hold private teams the caller cannot
  see, §2.13, so the route drops them in every mode; `ok: false` carries the
  error), `/api/warnings/preview` 200 `{ preview }` (the digests mapped for
  display with app-relative `/timeline?…` links; nothing recorded or sent),
  `/api/settings` 200 `{ settings }`. A partial `tuning` is passed through; the
  engine merges it over the saved tuning.
- `/settings?section=modes|watchers|schedule|status|notifications|audit`
  (default Modes; the old `?section=people` opens Watchers) shows one section
  beside the sub-nav; each section's form PATCHes only its own fields. Every
  section is editable by everyone signed in but a Linear guest; there is no PM
  copy, and each block bar's meta says what the section does ("Audited" for
  Modes, Watchers and Schedule) rather than who may use it. A guest (owner
  decision 2026-10-22, "Guests limited to read only") gets the read-only mode:
  every section shows its values as plain text (`ReadOnlySettings` /
  `ReadOnlyWatchers` in `settings/read-only-sections.tsx`, rows from
  `modesReadOnlyRows` and `scheduleReadOnlyRows`) with no switch, box, input,
  Save or Reset, Status has no Resync or Preview, the block bar meta reads "Read
  only", and one read-only notice sits under the section's sentence in Modes,
  Watchers, Schedule and Status. Watchers (the section that was People) lists
  active non-app people plus deactivated people still watching, with one Watcher
  box each (no PM column, no locked box: the watcher list may be emptied, and
  then only leads are warned; the hint and the save toast say so). The Audit
  section reads entries saved before 2026-10-22 as they were saved: a change to
  the retired PM list reads "PM list (retired): … → …", and the save that
  dropped the field is not reported as a change. Slack status is not shown: the
  engine exposes no "Slack configured" flag.
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
- `/graph` draws every item of its scope (owner decision 2026-10-23, design doc
  §12 "the graph shows every issue"): every issue (done ones too, faint;
  canceled and duplicate ones never), milestone, project or initiative the
  viewer can see in the container, on a blocking relation or not, plus the
  externals one relation away; the relations are the arrows. The boxes sit in
  labelled frames by parent (core `clusters`, §2.10: issues by milestone, inside
  project frames when they span projects; milestones by project; projects by
  initiative; none at the initiative level or in a chain), so the ones on no
  relation pack into a grid instead of one long column. The empty state is only
  for a scope with nothing in it ("No issues in Push notifications.") and for a
  chain whose issue has no relation; the level tabs then move to the section
  title row. The empty state is Gr8r's centred `EmptyState` with the Graph nav
  item's icon. There is no register of boxes "with no blocking relations" any
  more (it was removed with that rule). The receipts, the block meta and the
  aria summary count what is drawn ("51 issues in the workspace, 45 of them in
  16 milestones; 6 blocking relations: 3 on a risk chain, 1 unblocked and 1
  cycle."; "17 milestones in 9 projects; 3 blocking edges: …"; "51 issues · 6
  edges · 1 cycle"), and Copy Mermaid copies the drawn graph, a `subgraph` per
  frame. Slide-over details are built for every drawn node. The server lays the
  drawn graph out once, in its frames
  (`layoutGraph(nodes, edges, { direction: 'LR', clusters })`; a chain keeps one
  dagre flow), passed to `DependencyGraph` as `layout`, so the browser never
  runs dagre.
- `/graph` draws at most 700 boxes and 1,000 arrows (`GRAPH_DRAW_LIMITS` in
  `lib/adapters/graph-scope.ts`; raised from 200 and 300 on 2026-10-23, since
  every item is drawn: §8.4 Graph has the measured times; core stays uncapped
  except a chain's 150 issues, so the timeline's connectors keep every milestone
  edge). Past either limit the page builds no node data, details, layout or
  Mermaid: a neutral "Too large" notice (`Notice tone="default"`: a size limit,
  not a risk, so no status tone) says how many boxes and arrows it would need,
  and a "Narrow to" register (name / kind / on edges, at most 50 rows, most
  boxes first, ties in node order) offers the workspace's initiatives (its
  projects without initiatives), an initiative's projects or a project's
  milestones at the same level; inside a milestone its 20 most connected issues,
  and in a chain the focus's direct neighbours, each opening its own chain. An
  issue level whose issues have no smaller container (no project, or in a
  project no milestone) falls back to the 20 most connected issues, so the list
  is never empty; the message ends "Narrow it down:" only when rows follow. A
  `?node=` box's own container (a milestone's project, a project's first
  initiative) is the first row, with `node` kept.
- `/graph` notices (quiet lines under the receipts, in this order): the
  no-initiatives fallback, worded by `Actor.readOnlyReason` ("Linear shows
  guests no initiatives, so this graph covers every project you can see."; a
  person the mirror does not know; otherwise "This workspace has no initiatives
  in Linear…"); relations this level cannot place (an end with no milestone, or
  no project: "the Issues tab shows them"); in an initiative, its projects that
  count under another first initiative ("Juniper design system is also in
  Customer growth in Linear and counts under Platform reliability, its first
  initiative, as on the timeline."); a closed chain focus ("only its own
  relations are drawn"); a cut chain ("Drawn: the nearest 150 issues; N more are
  further out…").
- `/graph` emphasis comes in three highlights (owner request 2026-10-22, design
  doc §12 "graph highlights"; §8.4 Graph): **Status** (the default,
  `DEFAULT_GRAPH_HIGHLIGHT`) tones each box by where it stands in the blocking
  flow (core `readinessClass`, §2.10 "Readiness": ready green edge, blocked
  amber rule, stuck red rule, done or paused faint, and a box on no relation at
  all, "No dependencies", neutral with no chip) and draws arrows that no longer
  block as green dots; **Risk** is the emphasis below, unchanged; **Critical
  path** numbers the longest chain of open blocking arrows and recedes the rest.
  Every box carries its readiness chip in every highlight, so switching never
  moves a box. Paused work is quiet in all three.
- `/graph` emphasis under Risk: an inactive project's work is never loud.
  Initiative, project and milestone boxes of inactive projects are muted with
  "Inactive"; issue boxes of inactive projects keep the default tone, with no
  "Overdue" chip, and carry "Inactive" while open (so the quiet box of Status
  has its word). Otherwise milestone boxes take a status tone only when at risk
  (amber) or overdue (red) (a later milestone's unassigned issues are normal;
  they keep the "Unassigned" chip); project and initiative boxes when their
  (most severe) next milestone is at risk or overdue (no "Unassigned" chip: they
  always hold some later unassigned work; an active project without a lead gets
  "No lead"); issue boxes when open and unassigned or overdue. Boxes above the
  issue level holding an issue loop get "Cycle inside". The same holds in the
  register and the panels: an inactive project's milestone or issue row, and its
  panel's properties and Overdue strip, say the same facts without a status hue.
- `/runs/[id]` answers the not-found page for an unknown id; already-assigned
  skips are collapsed into one count per project.
- The run and settings registers stack into cards by their own width
  (`stackWithin`), not the viewport's: inside the 252px sidebar a 1024px window
  leaves the settings content about 440px wide (700px at 1280). Run cards flow
  their eight cells into as many ~120px columns as fit (two rows at 1024 and
  1280, three on a phone). The Notifications register leads with the recipient
  (channel under the name) in five columns, so it stays a table at 700px; the
  Audit "When" column is fixed at 152px so the time fits one line.

### 8.2 Visual language (Gr8r Studio, purple accent)

The tokens live in `packages/ui/src/styles/tokens.css` (light block, then two
identical dark blocks: `html[data-theme='dark']`/wrapper, and
`data-theme="system"` under `prefers-color-scheme: dark`); the reset, block
chrome and the `data-tone` hook in `tokens.css`, the shared classes in
`primitives.css`, all scoped as the ui README describes. Gr8r's values are
copied, not approximated; the changes are the purple accent, a darker text step
for the status hues in light, a softer dark (below), `--control-border` and the
planner's own extra tokens (`--accent-ink*`, the `-ink-inverse` set,
`--on-<hue>`, `--shadow-raised`, `--shadow-drawer`, the `-line` tints,
`--r-chip`, `--r-xl`, the `--fw-*`, `--lh*` and `--ls-*` steps, the
theme-dependent component tokens).

- **Surfaces**, back to front: `--bg` (page behind everything; signed-out
  pages), `--bg-side` (sidebar), `--surface` (main column, panels, cards,
  drawer, menus), `--surface-2` (hover fill), `--surface-3` (pressed / on,
  tracks, the sidebar hover), `--sunken` (recessed wells: group rows, weekends,
  footers, the banner strip), `--overlay` (scrim, no blur). Light
  `#fbfaf8 / #f4f3f0 / #ffffff / #f6f5f2 / #eeede9 / #f7f6f3`. Dark is a warm
  charcoal, redefined, not inverted, and soft (owner 2026-10-23: the old
  near-black was "too dark"): nothing is darker than `#1a1a19`, the sidebar, and
  the main column sits a few steps above Gr8r's own `#1d1d1c`:
  `#1c1c1b / #1a1a19 / #20201f / #272726 / #2e2e2c / #1c1c1b`
  (`test/styles-contrast.test.ts` holds the floor).
- **Lines**, by weight: `--divider` (row separators inside a container) <
  `--border` (container edges, section rules, toolbars, column headers) <
  `--border-strong` (secondary buttons, chips, hover outlines). Light
  `#f0eeea / #e9e7e2 / #dad7d0`. They are decoration. The edge of anything you
  type in or toggle (input, select, textarea, checkbox, the switch's off track)
  is `--control-border` (`#8c8880` light, `#7c7974` dark), 3:1 on every surface
  (WCAG 1.4.11). No `#000` line anywhere; no `-1px` margin collapses.
- **Text**: `--text` (`#1d1c1a`, never `#000`), `--text-2` (secondary, idle nav,
  ghost buttons), `--text-3` (meta, counts, placeholders, column headers),
  `--text-4` (idle icons and glyphs only, never words), `--text-inv` (on an
  inverted fill: toast, tooltip, bulk bar). Every text token is 4.5:1 or better
  on every surface in both themes.
- **Accent** `#9747ff` in both themes, with `--on-accent` white (4.51:1). Its
  roles, as Gr8r's: the primary button, focus rings, selection (`--accent-soft`
  row fill with a 2px accent bar, checked checkbox / switch), progress fills,
  the today marker, unread / new dots and counts, query highlights, links. It
  never means a status. Tints derive by `color-mix`: `--accent-soft` 10%,
  `--accent-line` 38%, `--accent-hover` / `--accent-active` (88% / 78% toward
  warm black). Purple **text** is `--accent-ink`, 4.5:1 or better on every
  surface and on `--accent-soft`: `#7c33ea` in light, `#b385ff` in dark; hovered
  `--accent-ink-hover` `#6b28d0` / `#c4a0ff`.
- **Status hues** carry status and risk only: `--red` (danger), `--amber`
  (warning), `--green` (success), `--blue` (info), and `--gray` for the inactive
  mark (dots and outlines, never words). Each is text-safe (4.5:1 on every
  surface and on its own tint) and a mark (3:1), so one value serves dots,
  icons, outlines, bars and words; each has `-soft` (10–12%) and `-line` (38%)
  tints and `--on-<hue>` for text on a solid fill (white in light, `#1a1a19` in
  dark; `--on-danger` is `--on-red`). Light uses Gr8r's hues one step darker
  (`#b03b2f`, `#88590d`, `#247149`, `#2f63ae`; Gr8r's `#3570c4` blue is only
  4.33:1 on its tint); dark uses Gr8r's pastels (`#e57d70`, `#d8a443`,
  `#5cba86`, `#72a5ea`). On an inverted (`--text`) fill (a toast, a tooltip, the
  bulk bar) the accent and the hues use their `-ink-inverse` step (the other
  theme's value, 4.5:1 there). `--violet`, `--teal`, `--rose`, `--orange` are
  for avatars and swatches only, never a status.
- **Workflow-state hues** for `StateGlyph`, in the status mapping:
  `--st-triage`, `--st-backlog`, `--st-canceled` (grey), `--st-todo` (the
  neutral ring), `--st-progress` (blue), `--st-done` (green). Glyph colours, not
  text colours: the state name beside the glyph stays neutral.
- **Tones in code**: `UiTone = 'default' | 'muted' | 'accent' | SemanticTone`
  and `SemanticTone = 'danger' | 'warning' | 'success' | 'info'`
  (`packages/ui/src/types.ts`); `ChipTone` adds `'inverse'` for old callers. A
  component renders its tone as `data-tone`, and the hook in `tokens.css` gives
  that element `--tone` (the hue: fills, dots, icons, outlines), `--tone-ink`
  (text, 4.5:1), `--tone-soft` (the tint), `--tone-line` (a tinted border) and
  `--on-tone` (text on a solid fill): danger → red, warning → amber, success →
  green, info → blue, muted → `--gray` / `--text-3`, accent → `--accent` /
  `--accent-ink`; default leaves the surrounding text alone. Components colour
  themselves from these, never from one rule per tone and never from a hex.
- **Elevation** only for things that float or can be picked up: popovers, menus,
  pickers, modals, the command palette, toasts and the bulk bar `--shadow-pop`;
  the drawer `--shadow-drawer` plus a 1px `--drawer-edge` left edge
  (`--border-strong` in dark); dragged bars and rows `--shadow-drag`; a card
  that can be picked up `--shadow-card`; secondary buttons `--shadow-sm`; the
  raised pill of the current sidebar / settings nav item or a selected segment
  `--shadow-raised` (through `--nav-current-shadow`; dark uses a `--surface-3`
  fill instead). Panels, rows, banners, chips and inputs have none. Shadows are
  warm (`rgba(28, 25, 20, …)`) in light; dark keeps only rings and deep drops.
- **Radius**: `--r-xs` 4px (checkbox, kbd, focus ring, tiny icon buttons),
  `--r-chip` 5px (chips, badges, segmented options, tooltips, skeleton bars),
  `--r-sm` 6px (buttons, inputs, nav and menu items, timeline bars, graph boxes,
  the segmented track), `--r` 8px (notices, alerts, toasts, cards), `--r-lg`
  10px (panels, boxed lists, popovers, pickers, empty states, the bulk bar),
  `--r-xl` 12px (modals, command palette, full drawer), 50% (avatars, dots, the
  rubric discs), 0 for full-bleed chrome and rows inside a panel.
- **Panels vs flat**: a list, table, register, chart or rubric inside a
  scrolling page sits in a panel (`--surface`, 1px `--border`, `--r-lg`, no
  shadow), with rows split by `--divider` that never touch the panel edge; a
  four-number strip is one such panel split into cells by 1px rules; a view that
  fills the main column edge to edge is flat on `--surface`. Recessed areas use
  `--sunken`, not boxes. Panels sit 12–16px apart; panel insets are 14px; the
  page's edge is the shell gutter (24px, 16px at ≤ 900px).
- **Type**: Geist (`--font-sans`) for every word, 400 body at `--fs` 13.5px and
  `--lh` 1.45 with `ss01` + `cv11`; weights 450 (`--fw-soft`: nav items, dense
  titles), 500 (buttons, labels, meta, active nav), 600 (headings, group
  headers, stat values); never 300 or 700. Scale: `--fs-2xs` 11 (counts,
  eyebrows, keys), `--fs-xs` 12 (meta, chips, column headers), `--fs-sm` 12.5
  (buttons, group headers, secondary), `--fs` 13.5 (body, rows, inputs),
  `--fs-md` 14.5 (section titles), `--fs-xl` 19 (drawer / issue title),
  `--fs-2xl` 23 (page title, `--ls-title`). Everything is sentence case; copy
  that relied on mono caps is written in sentence case ("Demo data", "Not
  found", "Today"). The one uppercase voice is the `.eyebrow` (11px, 600,
  `0.06em`, `--text-3`) for sidebar, menu, palette and day section headers.
  **Geist Mono** (`--font-mono`, via `next/font` `--font-geist-mono`) is only
  for issue keys, `kbd`, code and error codes (`.mono`: 0.92em, `-0.01em`);
  dates, counts and numbers are Geist with tabular figures (`.num`). Icons are
  Lucide at a 1.8 stroke.
- **Controls**: `Button` primary (purple fill, one per view), secondary (white,
  strong border, `--shadow-sm`), quiet (ghost: fill on hover), danger (red fill,
  for a destructive or irreversible write), 30px (sm 26px; lg 36px for a card's
  one call to action; `block` stretches it across), toggled (`aria-pressed`)
  `--surface-3`, pressed `scale(0.97)`; fields come in Gr8r's two sizes only:
  toolbar fields (search, filter selects) 26px at 12.5px (`--h-sm`, `--fs-sm`;
  30px at 16px on touch screens) and form fields 30px at 13.5px (`--h-md`,
  `--fs`; the drawer's fields and their 30px Save buttons, the page-header
  person picker), `--control-border`, `--r-sm`, focus = accent border + a 1px
  accent shadow + a 4px `--accent-soft` halo over a transparent outline (so
  forced colours keep a ring; a native date input keeps it on `:focus-within`
  while its calendar button has focus), refused = a red edge and a red shadow
  (`aria-invalid`) that, focused, keeps the edge and takes the 2px
  `--focus-ring` 2px outside it; checkbox 15px rounded, `--control-border`,
  accent when checked; switch a 30×18 track (`--control-border` off, accent on)
  with a sliding knob; segmented control a `--surface-3` track with a raised
  white thumb ringed in the accent, its focus ring standing 2px outside the
  option so it never lies on that selection ring (Tab lands on the checked
  option); tabs a `--border` bar with a 2px `--text` underline (not the accent);
  icon buttons 26px ghosts, `--text-2`, hovering to `--surface-2` (`--surface-3`
  on the grey sidebar and the signed-out page). Focus elsewhere is a 2px
  `--focus-ring` outline, offset 1px (inset by 2px inside a clipped box); never
  `outline: none`. `--focus-ring` is the accent in light and its lighter step
  `--accent-ink` (#b385ff) in dark, where #9747ff falls under 3:1 on the dark
  status tints (an alert's link, a toned timeline bar); an inverted fill (a
  toast, the bulk bar) sets it to `--focus-ring-inverse` (the fill purple, 3.7:1
  on `--text`). The contrast test holds it at 3:1 on every surface and tint in
  both themes. The global ring rounds to `--r-xs` only an element with no radius
  of its own: that radius is a rule with no specificity
  (`:where(:focus-visible)`), so a pill, a button or a graph box keeps its own
  corners when focused.
- **People**: `InitialsAvatar`, round (20px in pickers, 22px in the sidebar,
  26px beside comments and in people lists, 36px as a header), 600 initials at
  0.4× the size on a 17% tint of a decorative hue picked from the name, inside a
  1.5px `--surface` ring; nobody (unassigned) is a dashed empty circle. Never
  square.
- **Chips and notices**: a `Chip` is Gr8r's badge (20px, `--r-chip`, 12px 500):
  neutral by default, plain quiet text when muted, the accent's text on its tint
  for new / unread, and for a status tone either Gr8r's tinted badge (`filled`:
  the stronger claim, the tone's text on its soft tint) or Gr8r's status pill
  (unfilled: neutral and bordered, the hue in a 6px dot or the leading status
  mark). A `Notice` or `AlertStrip` is a `--r` box: neutral (`default`, `muted`)
  bordered, any other tone filled with its soft tint, the lead-in in the tone's
  text colour and the copy in `--text`; an `AlertStrip` leads with a 14px icon
  in the hue. Empty states are Gr8r's: a centred 22px icon, a title
  (`--fs-md` 600) over the `--fs-sm` `--text-2` sentence and an action, in a
  soft `--r-lg` box; one that reports a missing input gets a dashed edge
  (`.hatched`).
- **No texture, no numbers, no floods**: hatching is retired (`--hatch` is
  `transparent`); "missing" is a dashed or dotted `--text-3` edge; loading is a
  shimmer. `BlockBar` / `.blockBar` is a section heading row (14.5px semibold,
  quiet meta on the right) with no box and no section number (`index` is
  ignored). Hover is a soft fill, never an ink or purple flood; selection and
  the current item are tints, the raised pill or a 2px accent bar.
- **Kept from before**: hover styles only behind
  `@media (hover: hover) and (width >= 901px)`; a designed
  `prefers-reduced-motion` state (transitions off, no scale, lift or shimmer);
  forced-colours handling (`forced-color-adjust: none` and system colours for
  anything drawn with backgrounds only); form fields 16px on phones and touch
  screens (`width <= 640px` or `pointer: coarse`) so iOS Safari does not zoom;
  the scoped-stylesheet mode (ui README). Motion uses Gr8r's `--ease`,
  `--spring`, `--ease-drawer` and `--dur` 140ms. A timeline bar's sticky label
  is capped to the part of the bar still visible beside the lane column (the
  bar's end less the chart's scroll offset), so the receipts drop out and the
  name stays readable rather than sliding under it.
- **Old token names** are removed. They were deprecated aliases onto the Gr8r
  tokens while the sheets moved, kept until the branches written before the
  restyle (the graph lock-on, the API-key connect page) had merged and been
  restyled; both are in, so `tokens.css` declares none of them and nothing reads
  them (a test reads every file in `packages/ui/src`, `tokens.css` included,
  `styles-contrast.test.ts`, and every file in `apps/planner/app`, the planner's
  `gr8r-tokens.test.ts`). A sheet that still used one would get nothing from it.
  Each mapped to the Gr8r token that does its job: `--paper`, `--background` →
  `--surface`; `--ink`, `--foreground`, `--ink-soft` → `--text`; `--muted` →
  `--text-2`; `--grey-2-ink` → `--text-3`; `--grey-2` → `--text-4`; `--grey-3` →
  `--border-strong`; `--grey-4` → `--surface-3`; `--grey` → `--gray`;
  `--hairline-faint` → `--divider`; `--tint` → `--surface-2`; `--red-ink`,
  `--amber-ink`, `--amber-ink-strong`, `--green-ink`, `--blue-ink` → the hue
  itself; `--hatch` is `transparent`; `--muted-inverse`, `--ink-soft-inverse`
  and `--hairline-inverse` went with the ink floods that swapped them;
  `--ease-out-quint` / `--ease-out-expo` → `--ease-drawer` / `--ease`. The
  data-tone hook's `--tone-ink` reads the hue itself (`--red`, `--amber`,
  `--green`, `--blue`), no longer the `-ink` alias. The list is `RETIRED` in
  `test/contrast-helpers.ts` (the planner's copy is `test/retired-tokens.ts`),
  and `retiredNamesIn(files)` checks a file reads none of them.
  `test/styles-contrast.test.ts` checks every text token at 4.5:1 on every
  surface and on its own tint, every mark and control edge at 3:1, the tone
  hook's mapping and the dark floor, in both themes.

**Status colours** (owner decision 2026-10-22; drawn the Gr8r way since the
owner decision of 2026-10-23, design doc §12). The mapping is unchanged: red is
overdue and failed; amber is at risk, blocked, unassigned and a missing input;
green is on track and the words of success (succeeded, assigned, sent); blue is
in progress and live; grey is paused and inactive. They colour the status marks,
dates, timeline bars, chips, alerts, the graph and the rubric. The purple accent
never means a status or a risk: it stays for the brand, selection and focus,
links and follow-ups, new or unread, progress and the timeline's today.

- **Four looks, loud to quiet**: the **tinted** look (the tone's text on its
  `-soft` tint, no border: `Chip filled`, a `Notice`, an `AlertStrip`, a count
  badge) for a stronger claim or a call to action; the **dot pill** (a neutral
  bordered chip with a 6px dot in the hue: `Chip` with a status tone, unfilled)
  for a lifecycle status that is not a problem; **toned text**
  (`color: var(--tone-ink)`, no fill) for a bare number, date or word; **plain
  quiet** text for muted. No solid status slab and no row rule: a row that needs
  action says so with a tinted chip or a toned cell.
- **The shapes stay; colour is never the only cue.** Every status keeps its
  shape and its words (a visible label, an `aria-label` or a tooltip): the
  milestone status is a diamond (solid, lower half filled, open, solid with a
  tick, dotted), issue states are circles, so the two never look alike. Done and
  overdue share the solid diamond, so they differ in lightness, not only in hue:
  done is the neutral `--text` fill with a knocked-out tick, since a green fill
  is as light as the red one (1.0:1) and the two would read the same to someone
  without red-green vision or in greyscale. Forced-colours mode keeps every
  shape (in `CanvasText`, the tick in `Canvas`).
- **Chips keep their strength.** A status chip that stated the stronger claim
  (blocked, live, a failed run, assigned, failed, sent, the digest's overdue /
  invalid / stopped items, the graph's flags) is the tinted badge
  (`Chip filled`); one that did not is the dot pill.

| what                                                                     | value                                                                                                                           | tone                                                   | drawn as (the Gr8r look)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| milestone status (`StatusMark`)                                          | complete                                                                                                                        | default                                                | solid neutral (`--text`) diamond with a tick knocked out in `--surface`: never green, because a green fill has the red fill's lightness and done and overdue would read the same without red-green vision or in greyscale; done's words and chips ("Complete", "Succeeded") are green                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
|                                                                          | on track                                                                                                                        | success                                                | open diamond, 2px `--green` edge                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
|                                                                          | at risk                                                                                                                         | warning                                                | diamond with its lower half filled, `--amber`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
|                                                                          | overdue                                                                                                                         | danger                                                 | solid `--red` diamond                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
|                                                                          | unscheduled, empty, on track but rubric-invalid (`missing`)                                                                     | muted                                                  | dotted `--text-3` diamond; the missing input is named in amber text where it is shown                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
|                                                                          | any status of an inactive project (`muted`)                                                                                     | muted                                                  | open `--gray` diamond; no status hue anywhere in that row. Its shape is on track's, and grey and green are close in lightness, so the words carry the state: the mark's label adds "· inactive project", the row's text is quiet and its Linear status pill names the project's status (Paused in the demo)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
|                                                                          | open (an issue box on the graph: its status is its milestone's)                                                                 | default                                                | open `--text-2` diamond (never the on-track green)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| timeline bar, its due-date diamond and the "Milestones" summary marks    | as the milestone status                                                                                                         | same                                                   | a 24px `--r-sm` bar filled with its hue at 16% over `--surface` and edged in the full hue (1px, 3:1), its name led by the `StatusMark`: overdue red, at risk amber, on track green, complete neutral (a `--text-2` edge and words over a 10% fill, never faded by opacity: a 60% label falls under 4.5:1 on the tint), inactive `--gray` at an 8% fill; missing a dashed `--text-3` outline on `--surface` with its "Missing: …" line in amber. The due-date diamonds and the Milestones summary marks are the `StatusMark` shapes at bar size (2px edges; forced colours keep them)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| timeline legend                                                          | the five statuses                                                                                                               | as above                                               | the same diamonds as the bars, with sentence-case labels                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| timeline today line and "Today" label                                    |                                                                                                                                 | accent                                                 | the 2px `--accent` line at full opacity; today's day number in `--accent-ink` 600 with no fill; "Today" in months zoom; `Highlight` in forced colours                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| timeline banners                                                         | no lead, no date, unplanned, blocked                                                                                            | warning                                                | one `--r-lg` panel of rows split by `--divider`, each a 14px icon in amber and the lead-in in amber 600 before a `--text-2` sentence; no tint and no frame; every row at every width                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| lane sublabel                                                            | "No lead", a deactivated lead                                                                                                   | warning                                                | amber text in sentence case ("No lead"; chart lane and phone card); never on an inactive lane                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| dependency arrow                                                         | on a risk chain (the blocker is unassigned or overdue, or waits on one)                                                         | warning                                                | 1.3px `--amber` line (Gr8r's connector stroke; the hue is text-safe, so the timeline's connectors hold 3:1 where they cross the weekend columns and group bands)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| rubric item (`Checklist`)                                                | met / missing (no date, no "done means…", no lead, no issues)                                                                   | default / warning                                      | met: a neutral (`--text`) disc with a tick and a quiet "Met", like a complete milestone (a column of green would drown the one item that needs action) / missing: a dashed amber ring and a tinted amber "Missing" chip: the only hue in the list                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| risk reason                                                              | unassigned open issues, stalled, behind pace                                                                                    | warning                                                | amber text or a tinted amber chip                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| warning kind                                                             | overdue / at risk, invalid due soon, allocation blocked                                                                         | danger / warning                                       | a tinted chip (`Chip filled`) for overdue, invalid due soon and allocation stopped; a dot pill for at risk; no row rule; the due date is coloured by the date alone (`dueTone`, as wherever a date is coloured: red overdue, amber today, tomorrow or undated, neutral later), never by the row                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| allocation (projects register)                                           | allocating N                                                                                                                    | info                                                   | dot pill (a neutral bordered chip with a blue dot); "Nothing to do" (default) is plain `--text-2` words with no box, as Gr8r prints quiet meta                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
|                                                                          | nothing to do                                                                                                                   | default                                                | neutral badge                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
|                                                                          | blocked (no lead, lead inactive, next milestone invalid)                                                                        | warning                                                | tinted amber chip (`Chip filled`) and the reason line under it in amber (the one cell that opts its sub line into the tone: `RegisterCell toneSub`, set by the adapter's `toneDetail`); no row rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
|                                                                          | no open milestone, inactive, not evaluated                                                                                      | muted                                                  | plain quiet text, no box                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| needs attention (My week)                                                | blocked, N unassigned                                                                                                           | warning                                                | tinted amber chip ("2 unassigned"); no row rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| issue and milestone alerts (`AlertStrip`)                                | overdue / blocked, holds up, stalled, unassigned                                                                                | danger / warning                                       | Gr8r's tinted alert: the tone's soft fill, no border, a 14px icon in the hue, the lead-in in the tone's text colour, the sentence in `--text`; the follow-up link stays purple and underlined; a strip without a tone is warning (never the purple). One tinted strip per drawer or page, the most severe; the rest are `plain` rows of one bordered list                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| issue state (`StateGlyph`)                                               | triage, backlog, canceled / todo / in progress / done                                                                           | muted / default / info / success                       | grey circles (dashed for triage and backlog, struck for canceled) / the neutral ring / a blue ring with a half disc / a green disc with a tick; the state name stays neutral text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| priority (`PriorityGlyph`)                                               | urgent / high, medium, low, none                                                                                                | danger / default                                       | a red rounded square with a white "!" and the label "Urgent" in red / `--text-2` bars over `--border-strong` ghosts (no priority: three dashes); a priority picker in a list cell takes the colour from the level its face shows (`PickerOption.tone`), so a pending "High" is never red and a pending "Urgent" is red at once                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| due date                                                                 | overdue / due today or tomorrow / later / an undated milestone (a missing input) / an issue with no due date                    | danger / warning / default / warning / muted           | text colour, tabular figures; on the Issues list a toned date carries its state in a word under it ("Overdue", "Today", "Tomorrow", the same tone), so the red and the amber are never the only difference                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| progress (`ProgressRule`)                                                | overdue / behind pace / complete / inactive / otherwise                                                                         | danger / warning / success / muted / default           | the fill of Gr8r's 4px bar on a `--surface-3` track; default is the accent fill; the "3/7" receipt stays quiet text (one fact, coloured once)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Assignee "Unassigned"                                                    | open in a loud (active) project, or in no project, in any milestone and in triage / closed, or in an inactive project           | warning / muted                                        | text (the picker's empty face) beside a dashed empty avatar; the same rule on every screen (Issues list, milestone drawer, graph slide-over, issue page); the Issues list, which has no alert strip to word it, says "Needs assignee" in the amber case, so its amber and grey differ in words too                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| run status                                                               | running / succeeded / partly failed / failed                                                                                    | info / success / warning / danger                      | dot pill for running and succeeded; tinted chip (`Chip filled`) for partly failed and failed; no row rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| allocation mode                                                          | dry run / live                                                                                                                  | default / info                                         | neutral badge / tinted blue chip                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| run issue outcome                                                        | would assign / assigned / failed / not written, skipped                                                                         | default / success / danger / muted                     | chip: assigned and failed tinted (green and red), would assign a neutral badge, not written and skipped plain quiet text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| run detail numbers                                                       | assigned / failed / blocked projects / not written, skipped                                                                     | success / danger / warning / muted                     | value and note (only when the count is not zero; a zero is quiet)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| digest status (Settings → Notifications)                                 | sent / sending / preview / failed, undeliverable                                                                                | success / info / muted / danger                        | chip: sent, failed and undeliverable tinted; sending a dot pill; preview plain quiet text; a failed or undeliverable digest's error in red text; no row rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| issue activity (allocation history)                                      | assigned by a live run / assigned but the comment failed / the write failed / would assign, skipped, not written                | success / warning / danger / muted                     | an 8px dot in the hue (`--gray` for muted); the label also in the hue for warning and danger (success keeps the neutral label)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Linear project status                                                    | backlog, planned / started / paused / completed / canceled                                                                      | default / info / warning / success / muted             | Gr8r's status pill (a dot pill) for started, paused and completed; backlog and planned a neutral badge (grey means inactive); canceled plain quiet text; always muted for an inactive project, there drawn as the status pill with a grey dot (`Chip tone="muted" dot`), so grey still means inactive                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| settings status                                                          | working access, a sync that went through, installed / not installed, never synced / revoked, sync failed / no webhook yet, demo | success / warning / danger / muted                     | value text; the line under a value stays secondary text (as under every coloured register value), except a failed sync's error, which is why the row is red and takes the red too (as a failed digest's error and a blocked project's reason do; `toneDetail`); on Setup, "Reinstall needed" is a tinted red notice and "First sync pending" a tinted amber one                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| My week numbers                                                          | overdue milestones / at risk / new to you, open issues                                                                          | danger / warning / default                             | value and note in the tone, only when the count is not zero (new to you is not a status and stays neutral); each key has a 14px icon                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| upcoming deadlines groups                                                | Overdue / Today, Tomorrow (when they hold something) / This week                                                                | danger / warning / default                             | label text (600); the dates under the label stay neutral (the label already says it for the whole group), so this list is the one place a due date is not coloured by `dueTone`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| graph node (Risk highlight)                                              | overdue / at risk, unassigned / closed or inactive                                                                              | danger / warning / muted                               | overdue: a `--red-soft` fill with a 1px red edge (no flood; its Unassigned chip stays a tinted amber chip); at risk, unassigned: a 2px amber edge; closed or inactive: quiet (`--text-3` words), a done box keeping its neutral done diamond and a paused or inactive one its mark in `--gray` (shape kept; a missing input stays dotted); the status mark in its hue, an issue box's open mark neutral; selection an `--accent-soft` fill inside a 2px accent edge, hover `--surface-2`, focus the accent ring, the box being read a 2px accent ring over the `--accent-soft` tint (never a purple flood); Copy Mermaid (Risk) classes the red nodes `overdue` (2px red edge) and core's other risk nodes `risk` (2px amber; `isRiskNode`, §2.10, which also takes an issue or milestone that waits on risk, shown on the canvas only by its amber edges)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| graph edge (Risk highlight)                                              | risk chain / cycle                                                                                                              | warning / danger                                       | amber line / dashed red line (and a dashed red outline round each box in a cycle)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| graph readiness (Status highlight, the default)                          | ready / blocked or waiting / stuck / done, empty or paused / no dependencies (on no relation at all)                            | success / warning / danger / muted / default           | a box: ready a 1px green edge only (no fill; the chip's words tell it from blocked); blocked a 2px amber edge; stuck (an issue on an open cycle, a box none of whose open issues can start with a cycle inside) a 2px red edge; done quiet, keeping its neutral done diamond; a box with no issues ("No issues") and paused work quiet, the mark in `--gray` (shape kept; a missing input stays dotted); always with its chip in sentence case: "Ready" a green dot pill, "Blocked by N", "Waiting on N", "None ready" tinted amber, "Clear" a green dot pill, and a stuck box also says "Cycle", "On a cycle" or "Cycle inside" (tinted red); the readiness chip itself is tinted red when stuck; "Overdue" is a red dot pill, the red fill being Risk's; under Risk and Critical path the chip keeps its word, neutral; Copy Mermaid (Status) classes `ready` (green stroke), `blocked` (2px amber), `stuck` (2px dashed red), `quiet` (faded); a box on no relation at all ("No dependencies") is drawn neutral, as a plain box with no chip (its word is in its name and the readout), so a graph of every item is not a sea of green, and Copy Mermaid gives it no class and no word                                                                                                                                                                                                                                                                                                                       |
| graph edge (Status highlight)                                            | blocking / unblocked (one end is done)                                                                                          | default / success                                      | neutral `--text-2` line / 2px round green dots (`--text-3` dots under Risk and Critical path); a boundary-crossing arrow that still blocks is dashed; Copy Mermaid's `linkStyle` draws unblocked edges green                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| graph paths (every highlight; selection-derived, never a status)         | waits on / holds up / ready next, clear next / critical path / locked                                                           | accent / default / success / default / accent          | what the box pointed at waits on: a 2px accent ring and accent arrows (`Highlight` in forced colours); what it holds up: a 2px `--text` ring and `--text` arrows (dashed `CanvasText` in forced colours); what finishing it would unblock: a green dot pill riding the box ("Ready next", "Clear next"); the critical path: a 2px `--text` ring, 2.5px `--text` arrows and a 16px step disc (`--text` with `--text-inv` digits); the rest recedes to `--text-3` words, `--divider` card edges and `--text-3` arrows, never by opacity; the locked box (owner request 2026-10-23, "lock on"): the box being read's `--accent-soft` tint and 2px accent ring plus its own mark, four rounded 2px corner ticks in `--accent` inside the box (3:1 or better on the card, the accent tint and the overdue red tint, both themes), never a ring of its own, so it never reads as the keyboard focus ring, which still shows on the locked box when it has focus (in forced colours the box being read's 4px double `CanvasText` rule plus the ticks in `Highlight`), and its action strip: a small floating `--surface` bar (`--border`, `--r`, `--shadow-pop`) of Gr8r buttons in sentence case, Open the one primary (`--accent` fill, `--on-accent` words), Open graph a secondary and the × Unlock a ghost icon button; a box off the lock's paths hovered while one is locked gets the `--surface-2` hover fill and a thin 1px `--control-border` ring 2px out (a box on them keeps its path ring); no new token |
| graph frames (every highlight; owner decision 2026-10-23)                | a parent's frame / a frame of paused work / a frame of outside boxes                                                            | default / muted / default                              | a 1px `--control-border` edge (3:1: the frame is the only cue that groups) with `--r-lg` corners, no fill or shadow, its name in sentence case (`--fs-xs` 600: `--text-2` at the top, `--text-3` nested and in a paused frame) on a patch of the `--sunken` canvas over the arrows; a paused frame dashed in `--gray`, a frame of outside boxes dashed; never a status hue: the frame only groups, the boxes say where they stand; forced colours draw it `CanvasText` (`GrayText` paused)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| graph panel Readiness row                                                | waiting / clear / none ready, or waiting and none can start / complete, no dependencies; "Start here", "Clear next" chips       | warning / success / danger / default, default; success | value text in the hue (`--tone-ink`); an inactive box's row takes no tone; the lists' chips are dot pills                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| sidebar count (`ShellNavItem.countTone`)                                 | a count that needs action, e.g. blocked projects                                                                                | warning (any status tone)                              | Gr8r's badge: the tinted pill in the status hue (warning: blocked projects); accent (new, unread) is the solid accent pill                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Issues row chips                                                         | Blocked (open blockers), Holds up <milestone>                                                                                   | warning                                                | tinted amber chip (`Chip filled`), as the projects register's Blocked (never in an inactive project)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Issues "Not moved · …" / "Not saved · …" row note                        | the write failed, Linear refused it, or it was skipped (its team lacks the status, a rate limit stopped the run)                | danger                                                 | red `--fs-xs` text after the title: an unsaved change is red wherever "Not saved" appears (the error toast above the rows, its lead-in)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Issues filter chip                                                       | a value the planner cannot find ("Not found")                                                                                   | warning                                                | the chip's edge in `--amber-line`, its fill `--amber-soft` and its values in amber, with "Not found" in its words                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Issues group line under the heading                                      | "Missing: …", "No lead", "Allocation stopped: …"                                                                                | warning                                                | amber `--fs-xs` line (the checklist's "missing" voice)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Issues tier dividers                                                     | Overdue / Upcoming / No milestone / Inactive projects                                                                           | default                                                | a group header row (`--sunken`, `--fs-sm` 600 `--text`, the count in `--text-3`), like My week's This week / Later: each milestone group under "Overdue" already says it with its red diamond, its red "N days overdue" date and its red progress fill, so the list colours that status once, on the group (the deadlines list colours its "Overdue" label because its dates stay neutral)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Issues selection and drop target                                         | a selected row, its checkbox, a group a drag may land on, the Filter count                                                      | accent                                                 | a selected row takes the `--accent-soft` tint with a 2px accent bar inside its left edge (`Highlight` outline in forced colours), its checkbox the accent fill; a group a drag may land on a faint accent wash (6% over `--sunken`) in a 1px `--accent` edge (3:1; `--accent-line` is 1.7:1); the Filter count the accent badge: selection, not a status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Issues row in flight                                                     | a change is being sent                                                                                                          | default                                                | a `--surface-2` fill (or a shimmer) with the busy words, no hue                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| "New — given to you because…"                                            |                                                                                                                                 | accent                                                 | tinted purple chip (new, unread)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| errors (`Notice role="alert"`, error toasts, "Not saved" / "Error" keys) |                                                                                                                                 | danger                                                 | tinted red notice with its lead-in in red; an error toast is Gr8r's inverted toast with its icon and timer in `--red-ink-inverse`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| risky change notice                                                      | "Live allocation" and "Live warnings" before saving, "First sync pending"                                                       | warning                                                | tinted amber notice, its lead-in in amber                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| refused input                                                            | a field the form or the server refused, a description past its length limit                                                     | danger                                                 | a red field edge thickened by a 1px red shadow (with a soft red halo on focus: `aria-invalid`), a red error line or count                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| risky write (`Button variant="danger"`)                                  | "Assign in Linear now"                                                                                                          | danger                                                 | red fill with `--on-danger` text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| demo-data and read-only notices                                          |                                                                                                                                 | accent / default                                       | demo data: the shell's banner strip, one line on `--sunken` under the topbar with its info icon in the accent (a bordered neutral notice on the landing page) / read only: a bordered neutral notice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### 8.3 Layout and interaction (from Gr8r Studio)

- **Shell** (`AppShell` and the rest of `packages/ui/src/shell/*`, wired up by
  the planner's `app/(app)/components/planner-shell.tsx`), Gr8r's two-tone
  frame: a fixed left **sidebar** (252px, `--bg-side`, 1px `--border` right
  edge, no texture) containing: a brand row in Gr8r's workspace-switcher form (a
  22px dark tile with the product's initials, "Milestone Planner" at `--fs` 600
  over the workspace name in `--text-3`, the collapse icon button; the brand
  link is named "Milestone Planner <workspace>", as on main, so the rail keeps
  it), primary nav (My week with a count of this-week issues, Issues, Timeline,
  Projects, Graph, Runs: 30px rows at `--fs` / 450 in `--text-2` with 16px
  Lucide icons in `--text-4`, hover `--surface-3`; the current item the raised
  pill, `--nav-current-bg` + `--nav-current-shadow` at 500 with its icon in
  `--accent-ink`, in dark a `--surface-3` fill), a `Projects` section (an
  uppercase eyebrow header with an "All" link) listing active projects as Gr8r's
  quiet rows (an 18px folder tile, the name, and the status diamond of the
  project's next milestone on the right only when it is overdue or at risk;
  every row's status is in its accessible name and rail tooltip: one explicit
  name, the visible name first, "Delta exports, Missing input", the mark on a
  loud row hidden beside it so it is not read twice; click →
  `/timeline?project=<id>`), and a footer with Settings, the signed-in user (a
  22px round `InitialsAvatar`; no role chip: there are no roles since the owner
  decision of 2026-10-22; a Linear guest's line carries a `Guest` badge,
  `GUEST_BADGE`, and someone read-only for another reason a `Read only` badge,
  `userBadge` from `ShellFrame.readOnly` and `readOnlyReason`), theme toggle and
  sign out as ghost icon buttons. The shell also provides `readOnlyReason` to
  every read-only notice and to the (app) error page, which says "The first sync
  from Linear has not landed yet." with Try again and Open Setup while it is
  `not_synced` (every mirror-backed page fails then). A nav count is a quiet
  `--fs-2xs` `--text-3` number; a `countTone` makes it a Gr8r badge (accent: the
  solid accent pill for new / unread; a status tone: its tinted pill). A 46px
  white **topbar** (`--border` bottom): a sentence-case breadcrumb on the left
  (`Timeline / Atlas migration`: `--fs-sm` `--text-2`, the current crumb
  `--text` 500, "/" in `--text-4`), and on the right the recessed "Search or
  jump to… Ctrl K" palette trigger (26px, `--sunken`, `--border`, `--r-sm`, one
  key cap). A `banner` (the demo-data line) is a thin full-bleed strip under the
  topbar (`--sunken`, `--border` bottom, one `--fs-sm` line; a `Notice` placed
  there loses its box). `[` collapses the sidebar to a 52px icon rail (choice
  remembered in localStorage) with inverted tooltips.
- **Phone (≤ 900px)**: the sidebar becomes a 280px off-canvas drawer
  (`--shadow-pop`, over the `--overlay` scrim) opened from a topbar menu button;
  a fixed white bottom **tab bar** (`--border` top; 19px icons over 11px labels,
  `--text-3` idle, `--text` current: My week / Issues / Timeline / Projects /
  More; Graph and Runs live in More's drawer since the Issues page took Graph's
  place, owner request 2026-10-22) like Gr8r's phone layout; at ≤ 640px the
  topbar is 50px and shows only the current crumb; pages become single column.
- **Command palette** (Ctrl/⌘ K, or the topbar trigger): a centered 640px white
  card (`--r-xl`, `--shadow-pop`) over the `--overlay` scrim (no blur; dark mode
  darkens the page rather than veiling it); a 50px input row, uppercase eyebrow
  section headers with their counts, 38px rows whose keyboard-active one takes
  `--surface-2` with a 2px accent bar inside its left edge (the fill alone is
  under 3:1), query matches in `--accent-ink` 600, a `--sunken` footer of key
  hints; the Esc cap is named "Esc, close command palette". Sections
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
  `?` opens a shortcuts sheet (the same card). The palette API's
  `isSequencePending()` is true between a sequence's first key and its second
  (1.2 s); a page's own single-key commands (the issue list's `m`, `a`, `s`, `p`
  on a focused row) yield while it is true, so G S and G P still navigate with a
  row focused.
- **Acting on lists** (`packages/ui`, for the Issues page; Gr8r's list view):
  `TaskGroupTable` takes optional `selection` (a checkbox per row: Gr8r's 15px
  rounded box in `--control-border`, the accent fill with an on-accent check
  when on; tri-state group and column-header boxes, shift-click ranges, `x`,
  Shift+↑/↓, ⌘/Ctrl+A; a selected row takes the `--accent-soft` tint with a 2px
  accent bar inside its left edge, which forced colours keep as an outline, the
  checkbox carrying the state, never `aria-selected` on the list items), `drag`
  (HTML5, from an 18px grip shown on row hover under
  `(hover: hover) and (pointer: fine)` only; a selected row carries the
  selection; the dragged rows dim, the drag image is a small `--surface` card
  with `--shadow-drag` naming the count, a target group gets a faint accent wash
  (6% over `--sunken`) in a 1px `--accent` edge (3:1; `--accent-line` would be
  1.7:1), a refused one the not-allowed cursor and its reason in the header; no
  reordering inside a group), and slots (`renderCell` for cell pickers with
  `appearance="cell"`, `rowActions`, `groupActions`, `onRowContextMenu`).
  Without them it renders My week exactly as before. `ViewToolbar` (a 44px strip
  with a `--border` bottom: a 26px search field with a leading icon and a
  `--control-border` edge, Filter / Sort / Group as 26px ghost buttons, end
  actions, and a 2px accent progress line along its bottom edge while busy),
  `FilterChips` (Gr8r's filter chips: 26px `--accent-soft` chips with an
  `--accent-line` edge, the field as a `--text-2` 500 key, "is", then the
  values, joined by a quiet "and"; a value the planner cannot find in the
  warning tint (`--amber-soft`, an `--amber-line` edge, its values in
  `--amber`), a missing input, with "Not found" in its words; Clear all; a
  removed chip hands focus to its neighbour, Clear all to "+ Filter") and
  `BulkBar` (fixed at the bottom centre of the content column, past the sidebar
  or rail through the shell's `--shell-content-left`, while rows are selected:
  Gr8r's inverted pill, `--text` fill and `--text-inv` ink, `--r-lg`,
  `--shadow-pop`; "{n} selected" spoken through a polite status that stays
  mounted while nothing is selected so the first selection is heard; the host's
  ghost actions, ✕, an inline confirm strip, busy and limit notes, focus back on
  the action after a busy spell, Esc clears) complete it; menus are
  `PickerPopover` with `searchable={false}`. Details in `packages/ui/README.md`.
- **Toasts**: a bottom-right stack (full width above the tab bar on phones) of
  Gr8r's inverted cards (`--text` fill, `--text-inv` ink, `--r`,
  `--shadow-pop`): a 15px icon (an error's in `--red-ink-inverse`), the semibold
  lead-in word and one sentence, an optional action (the Issues page's Undo),
  auto-dismiss after 4 s (or the toast's own `duration`: 8 s for an Undo) with a
  thin countdown line, paused on hover or focus, `aria-live="polite"` (errors
  assertive; a toast's `announce` replaces its sentence there only, e.g. "›"
  spoken as a comma and "Press Z to undo."; `onClose` hears it leave); used
  after saves, runs and copies. While a bulk bar is up the stack sits above it
  (the bar publishes its height through `useBulkBarHeight` and the stack sets it
  as `--bulk-bar-h` on its own element, never on `<html>`, whose every
  descendant would restyle), so an Undo toast never covers its actions or ✕, on
  a phone too.
- **Loading**: `loading.tsx` per route renders Gr8r's shimmer skeletons
  (5px-radius bars shimmering from `--surface-3` to `--surface-2`, round marks,
  40px rows split by `--divider`) in the page's real layout, not spinners;
  reduced motion holds them still.
- **Alerts, properties and key caps**: `AlertStrip` is Gr8r's alert tinted by
  `tone` (data-tone, default `warning`): a 14px icon in the hue, the lead-in in
  the tone's text colour, the sentence in `--text`, the follow-up an underlined
  accent link; `default` / `muted` are a bordered neutral box; `plain` is a row
  of a neutral list of alerts. `PropertyList` is Gr8r's `.kv`: a 112px label
  column (96px on phones), 30px rows, `--text-2` labels with `--text-4` icons,
  no rules. `Kbd` is Gr8r's keycap: Geist Mono 11px in an 18px `--surface` cap,
  `--r-xs`, 1px `--border` with a 1.5px bottom edge, `--text-2`, printed in the
  key's case.
- **Signed out**: `SignedOutFrame` is Gr8r's auth frame: the `--bg` page with a
  plain top row (the brand tile and product name, an optional neutral badge such
  as "Demo", the theme toggle), no box, rule or texture.
- **Slide-over drawer** (milestone details): opens from the right over the
  content (no scrim on desktop; on a phone full width over the `--overlay`
  scrim), 620px (`SLIDE_OVER_WIDTH`), white with `--shadow-drawer` and a 1px
  `--drawer-edge` left edge, easing in from 48px (`--ease-drawer`); a 46px
  header bar with the `Project / Milestone` breadcrumb (`--fs-sm` `--text-2`)
  and ghost actions (open in Linear, copy link, close; at 640px and below a
  worded action shows its icon only, its words hidden visually so its name is
  unchanged, and the crumb keeps its room); the title (`--fs-xl` 600) scrolls
  with the body; an alert strip when overdue (`AlertStrip tone="danger"`:
  "Overdue by 3 days. Reschedule" focusing the date field), then Gr8r's property
  list: Status, Due date, Lead, Progress, Weight, Next milestone, Done means…;
  then the rubric checklist, risk reasons, issues, and "Waits on". Linkable via
  `?milestone=<id>`; Esc closes; focus is trapped while open and returned on
  close. Esc in the Weight or "Done means…" field while it holds unsaved text
  puts the saved value back instead (the drawer stays); the next Esc closes.
  When the panel swaps its content in place (milestone → one of its issues, a
  relation row → another issue, "‹ Back to <milestone>", a "Waits on" row),
  SlideOver's `contentKey` changes: the body scrolls to the top and focus that
  was in the panel, or fell to `<body>` because the focused row unmounted, moves
  to the panel, so the new title is announced and Tab starts at the header;
  focus on a page row that swapped it stays there.
- **Names and headings the restyle changed** (accepted; every other role, name
  and heading level is main's, and this list is how a change stays visible): the
  palette's close button is "Esc, close command palette" (it shows "Esc"; WCAG
  2.5.3, a visible label starts the name); the demo sign-in buttons are "Sign in
  as <name>" (the card shows the full name); the Modes switches are "Allocation
  live" and "Warnings live" (two controls were both "Live"); the sidebar's
  project links are "<project>, <status>" (main: "<status> <project>"), since
  the mark moved to the right and shows only on overdue and at-risk rows, so the
  visible name leads; the 404 and landing pages print their small labels ("Not
  found", "Sign in") as text, not as an h2 above the page's h1; My week's issue
  list is a region headed "Your issues" (h2, with its "N open"); Setup's
  "Installed" is a chip's words, no longer a status image beside the same word
  (it was read twice); the landing page's feature cards are an unordered list
  (they are no longer numbered); the digest preview's recipients are h4 under
  its h3 title (main had them at h2, above the preview's own h3).

### 8.4 Pages

- **My week** (Gr8r Home + My Tasks, one screen as §2 Goal 1 asks): header "Good
  morning, Pat" (the page title, §8.2) + a quiet receipts line ("Wednesday,
  October 21 · 4 issues due this week · 1 milestone overdue") with "All my
  issues" and the "Showing" person picker on the right; a four-cell stats strip
  (Open issues · this week, Overdue milestones, New to you, At risk in your
  projects) as Gr8r's stat strip: one `--r-lg` panel split by soft rules, each
  cell with a 14px key icon; then two columns, each panel under its section
  title (`BlockBar`, no numbers), so the three panels share one top line. Main
  column: "Your issues" ("{n} open"; "<name>'s issues" on someone else's week)
  over the list in Gr8r's grouped-list form, one panel — column headers (Issue /
  State / Priority / Due; no Project column, because every group heading names
  the project and beside the deadlines panel a fifth column left titles
  unreadably narrow), "This week" (always shown once anything is open) and
  "Later" section bands on `--sunken`, collapsible group rows per milestone in
  Gr8r's group-header form (chevron, status mark, `Project / Milestone`, issue
  count, then due + days left and `completed/scope` with a 4px progress bar),
  flat 40px rows split by `--divider` with the identifier (Geist Mono), title
  (opens the issue slide-over, `?issue=<key>`, §8.5; a separate ↗ icon beside it
  opens the issue in Linear; the open row takes the accent tint and a 2px accent
  bar), state and priority glyphs in their hues beside neutral labels ("Urgent"
  in red beside its red "!" square), the due date (red overdue, amber due today
  or tomorrow), and the tinted accent chip "New — given to you because you lead
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
  project", "Inactive project" for the days left, no status colour on its date
  and a grey progress fill), but This week, the this-week counts (receipts, the
  Open issues note, the sidebar's My week count), "Overdue milestones", "At risk
  in your projects", the deadlines and "Needs attention" leave them out; the two
  stats add "+1 in an inactive project" and the empty "Needs attention" names
  the inactive project it left out. The two columns sit side by side only while
  the content area (not the viewport) is at least 1040px wide; below that the
  deadlines and attention panels stack under the list. The grouped list stacks
  its rows (key and title, then state · priority · due) by its own width, under
  720px (a container query, not the viewport's 900px: beside the deadlines a
  901–1100px window leaves the table 550–750px); a group heading keeps the mark,
  `Project /`, milestone and count on one line (the project ellipsizes first,
  the milestone wraps in place), and a row's ↗ stays on its title's last line,
  beside the last word (title and ↗ share one no-wrap run in which only the
  words before the last wrap: CSS always allows a break before the ↗'s box
  otherwise, and the word joiner the row had did not hold it in Chrome). Right
  column, each a `--r-lg` panel: "Upcoming deadlines" (Gr8r's panel): milestones
  the user leads or has issues in, grouped Overdue / Today / Tomorrow / This
  week (up to 6 days out; a group's label is red for Overdue and amber for Today
  / Tomorrow, the dates beside its items stay quiet; every group is always
  shown, and one with nothing in it says "Nothing due" in a faint line under its
  label, as Gr8r's panel does); and "Needs attention" for projects the user
  leads that are blocked (the reason under the name) or have unassigned
  next-milestone issues, each row's flag a tinted amber chip ("Blocked", "2
  unassigned"), no row rule. The stats colour a non-zero status number and its
  note: Overdue milestones red, At risk amber (New to you and Open issues are
  not statuses and stay neutral). A group's due date follows the due-date rule
  (red overdue, amber due today or tomorrow or undated; the days left stay quiet
  beside it) and its progress the progress rule. Everyone gets a person picker
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
    replaces. While the server answers, the old list stays at full contrast (no
    fade: a fade would drop the status, accent and muted text under 4.5:1),
    marked by `aria-busy`, a progress cursor and the toolbar's 2px accent
    progress line. The island follows the address bar (Back, Forward, a tab or
    sidebar link), skipping the URLs it wrote and keeping a half-typed search
    while the URL still means the view shown. Changing a filter starts the row
    budget over; removing a project from the project filter drops that project's
    milestones from the milestone filter (`withFilterValues`).
  - **Header**: "Issues", "Every issue across {n} projects.", and a quiet
    receipts line (`--fs-xs`, `--text-3`): "{all} open issues · {unplanned}
    without a milestone · {blocked} blocked · {at risk} at risk" with the
    default filters, else "{total} match these filters · {all} open in all",
    plus " · showing {shown}" when the row budget cut the list. Under it the
    preset tabs (`NavTabs`, scrolling sideways on a phone): All · Mine ·
    Unplanned · Unassigned · Blocked · At risk, each with its own preset's count
    (`IssueListView.counts`, so the count is what the tab then shows), each
    keeping the grouping, sections and sort, current only when the filters are
    exactly its preset's. A plain click on a tab goes through the island like
    any other view change (`NavTabItem.onFollow`): the tab, chips and busy list
    follow at once; its href still opens a new tab.
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
    (`f` opens it; an accent pill counts the set fields, the default status not
    counted), **Sort: Weight**, **Group: Milestone** ("· by initiative" with
    sections; on a phone the "Sort:" / "Group:" words drop), and at the right
    **Open as graph** (`issueListGraphHref`: the narrowest single container the
    filters name, one milestone's issues, `/graph?milestone=<id>`, else one
    project's, `/graph?project=<id>`, a `none` value of either being no
    container; else one initiative's projects, `/graph?initiative=<id|none>`;
    otherwise `/graph`) and **Copy link** (the address bar's URL; "Link
    copied."), both Gr8r ghost buttons (`Button variant="quiet" size="sm"`) with
    a leading icon. The search is the toolbar's 26px field with a leading icon
    and a `--control-border` edge; the toolbar and the chips bar are rows over a
    soft rule spanning the content column (`--view-toolbar-gutter: 0`). Every
    menu is a `PickerPopover` with `searchable={false}`: Filter lists the fields
    (Initiative only for a viewer with initiatives, Team only with two or more
    teams) and the quick filters (Blocked, At risk, In next milestones; hinted
    "On" while set); Sort and Group are one multi-select list with one choice
    per part, each chosen one marked with a trailing tick (`marks="tick"`), not
    checkbox squares (sort and direction; grouping and sections, a section level
    that cannot divide the grouping disabled with "Already grouped by …"; for a
    viewer without initiatives the initiative choices are disabled, and the
    island applies core's fallback to the URL's view too, `withoutInitiatives`,
    so a guest's `?group=initiative` reads "Group: Project", as the list is
    grouped). A "?" sheet group "Issues" lists `/`, F and G I while the page is
    mounted. The search's first change pushes one history entry and later
    changes replace it only once that entry is in the address bar (a replace
    sent while the push is pending would cancel it, and Back would skip the
    unfiltered list).
  - **Chips** (`FilterChips`): one per set field in URL order, "{Field} is
    {values}" ("3 projects" from three values on; "Not found", the chip in the
    warning tint (`--amber-soft`, an `--amber-line` edge) with its values in
    `--amber`, a missing input, for an id the planner lacks; a set chip is the
    accent tint), then one per quick filter ("Issue is blocked"), joined by
    "and"; the default status reads "Status is open" and removing it means every
    status (`state=all`), which then reads "Status is any" (counted in the
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
  - **List**: one `TaskGroupTable` (column header sticky under the topbar,
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
    date and countdown, the whole milestone's progress and the amber "Missing:
    …" line when it fails the rubric (the date by the due-date rule, red
    overdue, amber undated or due today or tomorrow, and the progress by the
    progress rule, red overdue, amber behind pace, green complete, as on My
    week, §8.2; the list's milestone refs carry the assessment's risk reasons
    for this; none of it in an inactive project, whose progress is the grey
    fill); a project's "No milestone" and "No project" groups; project groups
    (the next milestone's mark or "No open milestone", the first initiative as
    eyebrow, "Lead: <name>", the same amber line saying "No lead" or "Allocation
    stopped: <why>" on an active project); initiative groups ("{n} projects");
    people ("<name> (you)" first, "· deactivated", Unassigned last, avatar
    marks); statuses by name across teams; all five priorities; "All issues".
    Rows: the key (Geist Mono), the title (opens the slide-over, §8.5; the ↗
    opens Linear), the tinted amber "Blocked" (open blockers) and "Holds up
    <milestone>" chips (as the projects register's tinted Blocked), the assignee
    (an open issue of an active project, or of none, in any milestone and in
    triage, reads "Needs assignee" in amber, the same rule as the milestone
    drawer, the graph slide-over and the issue page; otherwise a grey
    "Unassigned"), the state glyph (in progress blue, done green) and the
    priority glyph ("Urgent" red, label and bars, in the cell and its picker,
    the picker's face coloured by the level it shows, pending included), and the
    issue's own due date (red overdue, amber due today or tomorrow, as on the
    issue page, with "Overdue" / "Today" / "Tomorrow" under it in the same tone,
    beside it on a phone card); a closed issue is struck through. A closed
    issue's or an inactive project's row has no status tone: no chips, a grey
    "Unassigned", a neutral date with no word; its state and priority glyphs
    keep their hues, as in the drawer and on the issue page. The tier dividers
    are neutral `--sunken` section bands (§8.2). Selection (the `--accent-soft`
    tint with a 2px accent bar inside the row's left edge), the drop target (a
    faint accent wash in a 1px accent edge), focus and the links stay purple; a
    row with a change in flight takes the `--surface-2` fill (no hatch, no
    fade). A group showing fewer rows than it holds ends with "Showing 12 of
    212" (or "212 issues not shown") · **Show more** (+500 rows, up to 2,000,
    then "Narrow the filter to see the rest.") · **Only this milestone**
    (project, person, priority, "Only In progress issues", …: that group's own
    filter in place of the field's value). With one to five projects in the
    project filter (grouped by milestone) their open milestones are listed even
    when empty: "No open issues here yet." when the milestone has none ("… Drag
    issues here, or use Move to milestone." for someone who can move), else
    "None of its 3 open issues match these filters. · Only this milestone".
    Nothing matching at all: "No open issues match these filters." (or "No
    issues …" with an explicit status) and Clear filters.
  - **Phone** (≤ 768px 16px gutters): the header and tabs as above, the toolbar
    in two rows (search, then the controls scrolling sideways), rows as cards by
    the list's own width (as My week), the slide-over full screen. A touch
    screen or a phone (`(pointer: coarse), (width <= 640px)`) has no checkboxes
    until the toolbar's **Select** button turns selection mode on ("Done" turns
    it off and clears the selection); a tap on a card then selects it instead of
    opening it, and the card's title is drawn and named as what it does (a
    checkbox named by the title, its state the selection, not a link). Both are
    decided in CSS (`hideOnTouch`, and the Select button rendered always and
    shown by the same query), so the server's markup and the hydrated page agree
    and no checkbox flashes on load. The bulk bar sits above the tab bar with
    Move to milestone, Assignee and **More** (statuses and priorities in one
    grouped list), its labels hidden at 390px; while anything is selected the
    list keeps room under its last row for the bar. Pickers open as bottom
    sheets; there is no drag.
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
      its own chain, `/graph?chain=<KEY>`); Open issue page; Open in Linear ↗;
      Copy link. Choosing an edit turns the same "…" button's popover into that
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
      stack above it (the bar publishes its height through `useBulkBarHeight`),
      so the Undo toast never covers its actions or ✕, on a phone too, and the
      list ends in room of the bar's height plus 44px (`BulkBarRoom`, in place
      of its bottom padding) so the last rows scroll above it.
    - **Cost of a click.** A selection, a fold, the Filter menu or a row's "…"
      redraws only what it touches: `TaskGroupTable` memoizes its groups and
      rows (a group redraws when its own rows' selection changes, a row when its
      own props do), the page keeps its render slots (`renderCell`,
      `rowActions`, `groupActions`) and the options state stable, and the open
      row menu lives in a small store each row's "…" reads for itself. Before
      (2026-10-23 showcase review, 304 open rows, 26k elements) every click
      re-ran about 11,000 components (0.15–0.3 s), and the first selection and
      clearing it took 0.5–0.7 s more, restyling the whole page for a custom
      property on `<html>`.
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
      the new value at once on the `--surface-2` fill (never a spinner; the text
      keeps its contrast) with "Moving to Push notifications…" (or "Saving…"),
      and stay where they are; unchanged, skipped and failed rows are back at
      once, the failed and skipped ones noted "Not moved · {reason}" (small, red
      whether the write failed, Linear refused it or it was skipped, as the
      error toast's "Not saved" key, `failureNotes`) until the selection changes
      or the next change; changed rows wait for the refresh started after the
      answer, which places them. Keyboard focus that was in a row when its
      change was sent (a row key's picker, the "…" menu, a cell picker) comes
      back once the refresh has placed the rows: to that row's title where it
      now is, else to the row that took its place, else to the group's toggle; a
      bulk change gives it back to the bar's action that sent it (the bar blurs
      it while busy). A picker a row key opened returns focus to the row's title
      on Esc or a choice, not to the "…" button.
    - **Toasts** (`bulkResultToast`, one action each): "Moved 2 issues to Garnet
      mobile app › Push notifications." ("Moved ENG-12 to …"; "Assigned …",
      "Unassigned …", "Set … to In Review.", "Set … to High priority.") with
      **Undo** for 8 s (while it is up, the page's **Z** key runs it: the toast
      sits after the list, beyond Tab's reach in 8 s; its live text reads the
      target as "Garnet mobile app, Push notifications" and ends "Press Z to
      undo."), plus " 1 already had that."; "Nothing to change: the 3 issues
      already had that."; "Partly saved · Changed 2 of 3 issues. 1 not changed:
      {reason}" with **Select them**; Linear's rate limit ("… Try the rest after
      3:05 PM.") or a rejected sign-in, with Select them; then the allocation
      sentences from the plans before and after ("2 of them are unassigned in
      Garnet mobile app's next milestone: the next allocation run gives them to
      Ben Carter." / "… a live allocation run would give them to … (allocation
      is in dry run)." / "Allocation is stopped for Garnet mobile app: …") and "
      2 no longer match these filters." (judged on the fields the change sets).
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
- **Timeline** (Gr8r Studio's timeline, owner decision 2026-10-23): banners
  first (no lead / no date / unplanned / blocked, each a count that expands to a
  list) as one Gr8r panel (`--border`, `--r-lg`) with a `--divider` row per
  banner and no tint: a 14px icon in the banner's hue, the lead-in ("No lead",
  sentence case) in the tone's ink, one sentence with the count in `--text-2`,
  and a quiet Show / Hide with a chevron that opens the list on a `--sunken`
  well; banners at zero left out. Every banner is a warning (§8.2 "Status
  colours"; `TimelineBanner.tone`, emitted as `data-tone` beside
  `data-banner-id`): a missing lead or date, open issues that are never
  allocated, a blocked project. Every row shows at every width; at ≤ 768px the
  sentence wraps under the lead-in and its Show. A flat toolbar: project search
  (26px, a magnifier), the initiative select, zoom **Weeks / Months** (segmented
  control), **Today** (a quiet button, scrolls to today), **Dependencies**
  switch, **Show All / Active / At risk** (one segmented control, since at risk
  only ever keeps active lanes) and a quiet **Open as graph** button after the
  filters (below). It is one row in a 1440px window with the sidebar open (the
  search gives up width, 220 → 80px, before anything wraps, and the initiative
  select is capped at 188px with an ellipsis so a long initiative name cannot
  push it or the button over the zoom control); narrower, the Show control wraps
  under it. Under it a legend line: the five status marks (StatusMark,
  aria-hidden) with sentence-case labels, and the due-date diamond. The receipts
  line counts overdue and at-risk milestones in active projects only and says
  how many projects are inactive ("9 projects (1 inactive) · …"). The chart is
  one `--r-lg` panel: a sticky left column of lanes grouped by initiative
  (sunken initiative rows, the name semibold and its count in `--text-3`; lane =
  project name, the lead under it in `--text-3`, "No lead" or a deactivated lead
  in the warning tone), a two-row sticky header (month names 12px semibold; day
  numbers 11px tabular `--text-3`, weekend cells sunken; today's number in the
  accent ink at 600 with no fill, or with week columns the word "Today" in the
  month row on the surface), sunken weekends and `--divider` week rules behind
  the rows, today as a 2px accent line at full strength (over the initiative
  bands, under the bars), a "Milestones" summary row with Gr8r's diamond at each
  due date in the most urgent status, and bars per milestone (start → due date,
  24px, `--r-sm`) filled with the status hue at 16% over the surface and edged
  in the full hue, so the edge holds 3:1 (overdue red, at risk amber, on track
  green; complete the neutral `--text-2` at a 10% fill with `--text-2` words,
  never green next to red and never faded by opacity, which would take its words
  under 4.5:1; an inactive lane `--gray` at 8%). Each bar's name is led by its
  StatusMark, and the 10px diamond at the due date and the summary marks take
  StatusMark's shapes (overdue solid, at risk the lower half filled, on track
  hollow, complete a solid `--text` diamond with a tick, missing a dotted
  `--text-3` outline, inactive a grey outline), so status is never the hue
  alone; forced colours keep every shape (`CanvasText` / `Canvas`) and the today
  line and the open bar's ring take `Highlight`. Rubric-invalid bars are a
  dashed `--text-3` outline on the surface with their "Missing: …" line in
  `--amber` (4.5:1 on every bar tint; `test/timeline-contrast.test.ts`).
  Hovering a bar doubles its edge in its own hue (a deeper tint would take the
  amber line under 4.5:1). Undated milestones are dashed 24px chips at the
  lane's end (StatusMark, name, "No date" in the warning tone on an active
  lane). Small neutral pills: "Next" on each lane's next milestone, "↑2" for a
  weight override. With Dependencies on, milestone-level edges are Gr8r's 1.3px
  curved connectors in `--text-3` (amber on a risk chain, dashed when the
  waiting milestone is due before its blocker, `--text` for the open
  milestone's). A re-date that fails says "Not saved" in red. Anyone with Linear
  write access drags a bar's right edge to re-date (an accent grip shows on the
  due-date diamond on hover or focus; the dragged bar lifts with
  `--shadow-drag`; snaps to days, an inverted date tooltip, Esc cancels, PATCH
  on drop, optimistic with rollback + toast); keyboard: focus the handle, ←/→ ±1
  day, ↵ commit, and a keyboard-focused bar, handle or chip is scrolled clear of
  the sticky lane column and header. Clicking a bar opens the slide-over drawer
  (the open bar takes the accent ring). Below 900px: per-project cards (Gr8r's
  phone list: bordered `--r-lg` cards under initiative headings, rows split by
  `--divider`, the open row in the accent tint with a 2px accent bar). Built
  while wiring it (binding):
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
  - The way into the dependency graph (graphs at every level, owner decision
    2026-10-22; `lib/adapters/timeline.ts` writes every URL through
    `lib/adapters/graph-scope.ts`). Each initiative row of the chart (under its
    project count, in one right-aligned column, so the initiative name keeps its
    width) and each phone card head (after the count) carries a quiet **Graph**
    link (a ghost button's look) (ui `TimelineGroup.link`, accessible name
    "Dependency graph of <group>") to `/graph?initiative=<id|none>`, or to
    `/graph?level=project` when no group is an initiative (a guest, or a
    workspace without initiatives: that is the graph such a viewer gets for any
    initiative). The toolbar ends its filters with a quiet **Open as graph**
    (`timelineGraphHref`): `/graph` while every initiative is shown or there are
    none, `/graph?initiative=<id>&level=milestone` when filtered to one. The
    drawer's "What does this wait on?" ends with **What it waits on** (only when
    it waits on something) and **Its issues** (`/graph?milestone=<id>`). The
    first selects the milestone on a milestone graph: `/graph?node=<id>` when
    its lane is active, otherwise (or when the drawer was built without the
    view) `/graph?project=<project>&level=milestone&node=<id>`, because the
    workspace graph drops relations between two inactive projects (§2.10) and a
    paused project's milestone may be no box there, while its project's graph
    has no activity filter and draws everything it waits on. Only the
    workspace's milestone graph feeds the chart's connectors
    (`chartDependencies` gives none for any other scope).
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
    amber when the project is blocked (or a quiet "Inactive project" note); on
    any other milestone, which one is next. A deactivated lead is amber in the
    Lead cell and named as deactivated in the met "Project lead" check.
  - The drawer's status colours (§8.2): the Overdue alert is `tone="danger"`
    (Gr8r's tinted alert, the red icon and lead-in; Reschedule stays a purple
    link); the status's risk lines ("Open issues unassigned · More work left
    than time left", "Missing: …") are amber (`data-tone="warning"`); the due
    date takes the shared `dueTone` (`lib/adapters/projects.ts`: red overdue,
    amber with no target date or due today or tomorrow); the progress rule the
    shared `progressTone` (red overdue, amber behind pace, green complete, grey
    in an inactive project, the accent fill otherwise); "No lead" (text, the
    lead select's rule and text, and its note), a missing "done means…" ("Not
    set") and an open issue's "Unassigned" and "Blocked by" are amber; a "done
    means…" over its limit is red (an error). The rubric checklist is a neutral
    disc with a tick when met (as done) / a dashed amber ring and a "Missing"
    chip when missing, with its count beside the heading ("4/4 met"; the heading
    itself stays "Checklist"). The drawer keeps its forms (a field and a Save
    button per value) in Gr8r's fields (`--control-border`, the accent focus
    ring); the checklist, issues and "What does this wait on?" are `--r-lg`
    panels with `--divider` rows and a `--surface-2` hover; the header's Open in
    Linear (↗) and Copy link are ghost buttons with icons.
  - An inactive (muted) lane is never loud anywhere: its bars, its phone card
    rows (grey hollow marks) and the "Milestones" summary diamonds (a day with
    only inactive milestones is drawn in greys; a shared day takes the active
    lanes' status); it is in no banner, receipt count or At risk filter. Its
    milestones' drawer is quiet too: no overdue strip, a grey status mark named
    "<status> · inactive project", no status hue on the risk lines, due date or
    the issues' "Unassigned" / "Blocked by", and a grey (muted) progress fill.
    On the chart its bars, diamonds and summary marks take the inactive grey
    (`--gray`), and its "Missing: …" line, "No lead" and undated "No date" carry
    no hue.
  - A complete milestone is never overdue: wherever its date is printed with a
    countdown (`dueLabel` in `lib/format.ts`: the drawer, the register, the
    graph's details and rows) it reads "Oct 1 · complete", never "Oct 1 · 20
    days overdue".
  - A phone card row whose mark is dotted (missing input) and that carries its
    "Missing: …" line leaves the status label out of its receipts, so an empty
    milestone reads "0/0 · Missing: issues", not "No issues yet · 0/0 · Missing:
    issues". A row's receipts take a status tone (`receiptsTone` in
    `packages/ui/src/timeline/tones.ts`): the status word red when overdue,
    amber when at risk or missing an input (the "Missing: …" part amber too, the
    progress quiet); its due date is red when overdue, and an undated row's "No
    date" is amber. An inactive lane's rows carry no hue.
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
  initiative, Linear status (a dot pill: blue started, amber paused, green
  completed; a neutral badge for backlog / planned; plain grey canceled; for an
  inactive project always the grey-dot pill, e.g. "Paused"), next milestone
  (name with its status mark, the due line in the due-date colour),
  next-milestone progress bar (`completed/scope`, in the progress colour), lead
  or "No lead" (amber text in an active project), allocation chip ("Allocating
  n" a blue dot pill / "Blocked" a tinted amber chip with the reason in amber
  under it, no row rule, worded as on the timeline's Blocked banner and My
  week's "Needs attention": "Project has no lead", "Next milestone is missing:
  done means…" / "Nothing to do" plain `--text-2` words / "No open milestone"
  and "Inactive" plain grey text), links to its timeline lane (the row), graph,
  issues (`/issues?project=<id>`) and Linear, the last three as 26px ghost icon
  buttons that keep the links' names (Graph, Issues, "<project> in Linear (opens
  in a new tab)"). Each initiative's section title carries a quiet **Graph**
  button (accessible name "Dependency graph of <group>") to
  `/graph?initiative=<id|none>`, or `/graph?level=project` when the viewer has
  no initiatives; a row's Graph button is its project's issue graph
  (`/graph?project=<id>`). An inactive project's row carries no status colour:
  grey mark, muted date, grey progress, its name in secondary text. The seven
  columns stay a table down to 900px of register width (a 1280px window with the
  sidebar open), each column keeping a floor that fits its content; narrower,
  each row becomes a card. Search (with its icon) + status filter (All / Blocked
  / At risk = an active project's next milestone at risk or overdue / Inactive)
  in a flat toolbar, mirrored to `?q=` and `?filter=` so a filtered register can
  be linked; the register also follows the URL when it changes under it
  (back/forward, a link to `/projects` while filtered).
- **Graph** (graphs at every level, owner decision 2026-10-22; every item, owner
  decision 2026-10-23): one page for every level and container (§8.1 routes;
  `lib/adapters/graph-scope.ts` reads and writes the URLs,
  `lib/adapters/graph.ts` builds the page model on the server). It draws every
  item of its scope, on a blocking relation or not, framed by parent (§8.1,
  §2.10 "Clusters"); the relations are the arrows. In Gr8r's look like the
  timeline (owner decision 2026-10-23): rounded cards on a recessed canvas,
  sentence-case chips in their §8.2 tones, soft rounded frames, thin connectors,
  quiet key rows for the legend; the styles live in
  `dependency-graph.module.css`, `graph-legend.module.css` and the page's
  `page.module.css`, on tokens only.
  - **Header.** Above the h1 a trail (`TaskCrumbs`, labelled "Graph scope"; the
    page title, receipts and quiet `--text-2` notices are the timeline's
    header):
    `Workspace / <first initiative | No initiative> / <project> / <milestone> / <KEY>`,
    levels the scope lacks skipped, the initiative crumb left out for a viewer
    with no initiatives, none at the four workspace levels. Each ancestor links
    to itself one level below it, so drilling up zooms out: Workspace →
    `/graph?level=initiative` (`?level=project` without initiatives), an
    initiative → `/graph?initiative=<id>`, a project →
    `?project=<id>&level=milestone`, a milestone → `?milestone=<id>`; the last
    crumb is the page. The h1: "Dependencies" for the workspace at every level;
    "Projects / Milestones / Issues in <initiative>" ("Projects with no
    initiative", "Milestones of projects with no initiative", …); "Milestones /
    Issues in <project>"; "Issues in <milestone>"; "Blocking chain of <KEY>".
    The topbar crumb is `Graph / <h1>` ("Chain of <KEY>" for a chain; nothing
    for the workspace). Receipts and notices (§8.1) follow; the receipts count
    what is drawn: "<N issues> in <container>, <k> of them in <M milestones>"
    (", in M milestones" when all are; none for a milestone, one frame), then
    the externals (", plus 2 issues outside it that block or wait on them"),
    then "; 6 blocking relations: 3 on a risk chain, 1 unblocked and 1 cycle."
    ("no blocking relations" when there are none); aggregate levels "17
    milestones in 9 projects; 3 blocking edges: …", "9 projects in 2
    initiatives, 1 with no initiative; …", "2 initiatives and the projects with
    no initiative; …". "No initiative" is a group of projects, not a name, so
    its sentences read "1 project with no initiative; no blocking edges.", "2
    milestones in projects with no initiative; …" and "No issues in projects
    with no initiative.". The workspace initiative receipts name each cycle in
    parentheses, keeping one colon: "…; 2 blocking edges: 1 cycle (Platform
    reliability and Customer growth wait on each other)."
  - **Level tabs** (route links, "Graph level"): exactly the levels the
    container offers (workspace: Initiatives, without initiatives left out,
    Projects, Milestones, Issues; an initiative: Projects, Milestones, Issues; a
    project: Milestones, Issues); none for a milestone or a chain (the trail is
    the way up). They sit in the graph panel's toolbar while something is drawn
    (without their own rule: the toolbar draws one under them) and in the
    section title row when nothing is (the empty and too-large states), so the
    other levels stay one click away exactly when this one shows nothing. The
    section title (`BlockBar`, right over its panel) is the level (Initiatives,
    Projects, Milestones, Issues) or "Chain", its meta the drawn counts.
  - **Highlights** (owner request 2026-10-22, design doc §12 "graph
    highlights"). A switch after the level tabs (`SegmentedControl` "Highlight":
    **Status** · **Risk** · **Critical path**, its own toolbar row at 640px and
    below, left out when nothing is drawn) picks what the drawing emphasises. It
    is client state: no server round trip, no relayout (the layout never sees
    the mode), no remount. A switch writes the `graph-highlight` cookie
    (`Path=/graph`, a year, `SameSite=Lax`, `Secure` on https; an unsigned
    viewing preference, validated on every read, allowed for guests, no Linear
    write, not audited) and `?highlight=` in place (`withHighlightParam`: only
    that parameter changes, every other one keeps its place and encoding). The
    mode shown is the history entry's own: its `?highlight=`, then the cookie,
    then Status (`effectiveHighlight`). The client island reads both itself (the
    URL through `useSearchParams`, the cookie from `document.cookie`), never a
    cached server prop, so Back and Forward show what each entry says
    (2026-10-23 review: the router cache used to bring back the first render's
    mode and write it over the entry). A page loaded at another path (`/issues`,
    `/timeline`, `/week`) never sees the `Path=/graph` cookie from script, even
    once a link has moved it to `/graph` (browsers match a script's cookies to
    the path the page was loaded at), so where `document.cookie` has none the
    island takes the mode last picked in this tab, else the server's read made
    for that navigation (`initialBare`): the Issues page's "Open as graph" and a
    row's Blocking chain, the timeline's "Open as graph" and the sidebar's Graph
    open in the mode picked on this device, as a reload does. The cookie is read
    as the first valid `graph-highlight` pair in the raw Cookie header
    (`highlightFromCookies`; browsers send the reader's own `Path=/graph` pick
    before a wider one, while Next's `cookies()` kept the last). The address bar
    (`addressHref`) leaves `?highlight=` out only when the mode and what a bare
    URL shows on this device are both Status, so a copied link shows anyone what
    is seen and an explicit `?highlight=status` survives a cookie that says
    Risk; it is written on arrival, after each switch and after each navigation
    lands, never while one is on its way (the issue drawer's open, swap and
    close run in a transition; a link click holds it until the URL moves on):
    Next turns a history write into a restore that would cancel that navigation.
    `graphHref` stays canonical; the links the screen draws (level tabs, the
    trail, panel and narrower-graph links) carry the mode when it is not what
    the next page would pick on this device anyway (`carryHighlight`), so a mode
    that arrived in a shared link survives a click. The island therefore draws
    the page header (trail, h1, receipts, notices) too. What each highlight
    draws (ui `DependencyGraph highlight`):
    - **Status** (the default): each box in its readiness tone (§2.10
      "Readiness", core `readinessClass`, planner `READINESS_TONE`): ready (an
      issue in the blocking flow that nothing open blocks, a box nothing outside
      holds up) a 1px green edge and no fill; blocked / waiting a 2px amber
      edge; stuck (an issue on an open cycle, a box none of whose open issues
      can start with a cycle inside) a 2px red edge; done or paused work, and a
      box with no issues at all (`empty`), quiet; a box on no relation at all
      ("No dependencies", `independent`) neutral, a plain box with no chip, so a
      graph of every item is not a sea of green. Arrows that no longer block
      (one end is done) are green dots; boundary-crossing arrows that still
      block are dashed whatever their kind (`GraphEdgeData.cross`).
    - **Risk**: the risk tones and arrows below, as before the highlights.
    - **Critical path**: the longest chain of open blocking arrows over what is
      drawn (ui `longestChain`, O(V + E): a cycle is one step whose members
      share a number and all count; ties go to display order; shown only from 2
      boxes), each box on it with a 2px `--text` ring and a 16px `--text` step
      disc with `--text-inv` digits on its top-left corner, its arrows 2.5px
      `--text`; everything else recedes. A chain graph's path runs through its
      focus. On a big graph the path can span the whole canvas (the showcase's
      workspace issue level: 13 steps over 6,600px, with no step in view on
      arrival and Fit stopping at 30%; 2026-10-23 review), so switching to
      Critical path, Back or Forward to an entry that shows it, or arriving on
      it with nothing to centre scrolls the frame (never the page) to step 1
      unless a step of the path shown at rest already shows whole, or a box is
      locked (the frame then stays on it, and the path shown at rest is the
      chain through it). A **step control**, a small floating bar over the
      canvas's bottom-left corner (the zoom group's ghost ‹ › around "13 steps",
      then "Step 2 of 13"; a `--surface` pill with `--shadow-pop`, since it
      floats over the drawing), walks that path: › goes to step 1 first, then to
      each next step, ‹ back; the walked step lights like a lock (the accent
      tint and ring, the readout on it, the path's own numbers kept; over a
      lock, until a press, Escape or the background drops the walk) and the
      frame centres it. `]` and `[` do the same from anywhere in the graph,
      moving focus along when pressed on a box; Escape or a tap on the
      background drops the walked step, as does switching the highlight.

    In every highlight each open box in the blocking flow leads its chips with
    its **readiness chip** ("Ready", "Blocked by 2"; above the issue level
    "Clear", "Waiting on 1", "None ready"; none when done, and none for "No
    dependencies", which the name and the readout say), a `Chip` toned only
    under Status (a green dot pill when ready or clear, tinted amber when
    blocked or waiting and red when stuck, quiet text for paused work; the
    neutral badge under Risk and Critical path, its dot's room kept in every
    highlight so no box moves); "Overdue" is a red dot pill in every highlight,
    and only under Risk is the box tinted red too. A **readout line**, the graph
    panel's last row under the canvas (not a live region), names what is pointed
    at ("ENG-23 · Blocked by 1 · Waits on 1 open, start with ENG-12 · Holds up 1
    · Done would unblock 1: OPS-20"; under Critical path its step and the
    longest chain through it), the locked box ("Locked on ENG-23 [Open] [Open
    its graph] [Unlock] · Blocked by 1 · …"; Lock on, below), a chain's focus at
    rest, else the highlight's idle text over every drawn box ("3 ready · 5
    blocked · 36 with no dependencies · 7 done"; "1 clear · 3 waiting · 11 with
    no dependencies · 1 complete · 1 with no issues · 38 open issues: 33 can
    start, 5 blocked", "can start" because "Ready" is kept for issues in the
    blocking flow, and a box with no issues counted apart from the complete ones
    (its name says "No issues yet"); a box on no relation reads "Public beta ·
    No dependencies"; "3 edges on a risk chain · no cycles" (the workspace's
    milestones; "3 relations on a risk chain · 1 cycle" at its issue level);
    "Critical path: 3 milestones, each waiting on the one before: Dual-write →
    Search v2 beta → Tokens and type. Start with Dual-write (clear).", or why it
    cannot start, or that it runs through a cycle; above the issue level a cycle
    of boxes is said to follow box arrows, with the Issues level to check it)
    and how to trace a box, in the highlight's terms ("Point at or focus a box
    to trace what it waits on and holds up."; under Critical path "… to show the
    longest chain through it."). With nothing drawn waiting on the box it says
    "Nothing here waits on it" (not "Nothing waits on it": "Done would unblock
    1: 1 not drawn" may follow). Boxes are worded per level (`pathWordsFor`:
    issues "Done would unblock", boxes "Waits on 1", "Nothing outside it holds
    it up", "Finishing it would clear 1", "Clear next", "Complete"). Name lists
    in copy stop at 3 names ("+k more") and 6 chain steps ("…").

  - **Paths.** Pointing at, focusing, locking or selecting a box lights both
    directions over the drawn arrows (it used to light only what it waits on).
    The box being read (pointed at, focused or locked: the reader is on it,
    `data-pointed`) gets the soft accent tint (`--accent-soft` over the card)
    under a 2px accent ring on every input, never a purple flood, so the subject
    is never one more ring; a selection is the same tint inside a 2px accent
    edge (it keeps it while another box is read), and a chain's focus an accent
    ring standing 3px off its box; a tinted overdue box keeps its red tint. In
    forced colours the box being read and the selected box get a 4px double
    `CanvasText` outline, apart from the solid `Highlight` ring and the dashed
    one. What it waits on (transitively) with a 2px accent ring and accent
    arrows (`data-state="lit"`), what it holds up with a 2px `--text` ring and
    `--text` arrows (`down`; dashed in forced colours), the rings hugging the
    box outside its edge so its status edge still shows; the rest recedes to
    `--text-3` words, `--divider` card edges and `--text-3` lines (no opacity,
    so receding words stay readable; the colour is set on the words themselves,
    never as an inherited colour or token on the box, and nothing but the fills
    and the rings fades: see "Hover cost" below; a tone edge, a risk chain under
    Risk, a cycle and the unblocked dots keep their look); the boxes finishing
    it alone would unblock (exact, from core's mirror-wide `blockedBy`) carry a
    green dot pill "Ready next" riding their top edge ("Clear next" above the
    issue level). A selection-derived highlight, never a status. Above the issue
    level paths follow the box arrows, which an arrow in and an arrow out may
    carry for different issues; the legend and the panel say so. Contrast, light
    / dark (ui `test/graph-contrast.test.ts`; marks need 3:1, text 4.5:1), on
    the `--sunken` canvas: `--text` rings and arrows 15.76 / 14.19, resting
    `--text-2` arrows 6.98 / 8.06, receding `--text-3` arrows and grey dots 5.20
    / 6.09, the accent 4.17 / 3.79 (3.78 / 3.75 from the `--text` ring beside
    it), `--green` 5.50 / 7.17, `--amber` 5.58 / 7.56, `--red` 5.53 / 6.09,
    frames' `--control-border` 3.27 / 3.93 and a paused frame's `--gray` 3.35 /
    5.03; on the card, tone edges 5.94 / 6.85, 6.03 / 7.23 and 5.98 / 5.82
    (green, amber, red), quiet and receding `--text-3` words 5.62 / 5.82 (4.83 /
    5.02 on the overdue tint, 4.94 / 5.31 on the accent tint), step digits 17.03
    / 14.49, a lit count's `--accent-ink` 5.97 / 5.99; frame titles on their
    canvas patch 6.98 / 8.06 (`--text-2`) and 5.20 / 6.09 (`--text-3`). A tinted
    chip on a tinted box (overdue, selected, being read) is laid over the card's
    own surface, so it keeps the 4.5:1 it has on any card. Each node's
    accessible name gives its readiness word and the transitive counts ("waits
    on 1, holds up 3; done would unblock 2"; scoped when the host counts what is
    not drawn: "waits on 1, holds up 0 in this graph; done would unblock 1 (1
    not drawn)", direct counts past ui `PATH_NAME_BUDGET`, whose V counts only
    the boxes on a blocking arrow, so hundreds of loose boxes keep the names
    transitive) and the frames it sits in ("… in Dual-write, Atlas billing
    migration. …"), and the aria summary, which says what is drawn ("Issue
    dependency graph of the workspace: 51 issues, 45 of them in 16 milestones,
    with 6 blocking relations, …"), adds "3 ready, 5 blocked, 36 with no
    dependencies, 7 done." and "Critical path: 3 issues: ENG-12, ENG-23,
    OPS-20.".
  - **Lock on** (owner request 2026-10-23, design doc §12: "lock on to the thing
    so it stays highlighted (along with its path) but I can still scroll";
    "there must still be a way to open it obviously"). A click, a tap or Enter /
    Space on a box **locks** it: it becomes the box being read, and its paths,
    "Ready next" tags and readout stay lit. It has its own mark beside the box
    being read's soft accent tint and 2px accent ring (`data-locked`, `.locked`,
    `data-lock-mark`): four rounded corner ticks, 2px wide and 9px long, just
    inside the box, a viewfinder's "locked on", in `--accent` on every box (3:1
    or better on the card, the accent tint and the overdue red tint, in both
    themes: ui `test/graph-contrast.test.ts`; a 2px edge with a 4px radius
    masked to its four corners), in the box's padding, clear of its words. It is
    not a ring, so it never reads as the keyboard focus ring (2px accent, 1px
    out; the lock used to be a ring of its own, 2026-10-23 review), which still
    shows on the locked box when it has focus: a hover (the `--surface-2` fill),
    a focus preview (the tint and the ring), a lock (the tint, the ring and the
    ticks) and a focused lock (the tint, the focus ring and the ticks) each look
    different. In forced colours the locked box keeps the 4px double
    `CanvasText` rule of the box being read and its ticks in `Highlight`
    (`forced-color-adjust: none` on the ticks alone), apart from a box pointed
    at (the double rule alone) and the solid `Highlight` ring of what it waits
    on. While a box is locked, pointing at or focusing another one moves nothing
    (a hovered box off the lock's paths gets only Gr8r's `--surface-2` hover
    fill and a thin neutral ring, 1px `--control-border` 2px out, so it still
    reads as clickable; a box on them keeps its 2px path ring under the pointer,
    which the ring used to replace, turning a downstream box's `--text` ring
    purple; no state is set, so a locked graph does not re-render on hover);
    panning by drag (from the background, or from a box past 8px of travel; a
    drag that starts on a box also drops the trace its press's focus gave it, so
    a pan never leaves a box lit with no lock), the wheel or a trackpad,
    zooming, Fit and switching the highlight never drop or move it (under
    Critical path the lock shows the longest chain through it, switching to
    Critical path then leaves the frame where it is instead of scrolling to step
    1, and the step control walks that chain; a box on no open chain leaves the
    control on the chain at rest; a walked step lights over the lock until a
    press, Escape or the background drops the walk). A **second click** (tap,
    Enter) on the locked box **opens** it, whatever a click opened before: the
    issue slide-over for an issue, the box panel otherwise, the lock kept.
    Opening is idempotent, never a toggle (the planner's `open`, apart from the
    panel rows' toggling `select`): a box already open stays open, so arriving
    from a timeline or issue link with its panel open (`?node=`, `?issue=`), a
    third click, Open pressed twice or a double-click on Open all leave it open
    (each used to close it, 2026-10-23 review); closing is the panel's × and
    Escape. When the box has a graph to drill into, a mouse's second click waits
    out the double-click window (`DOUBLE_CLICK_MS`, 500 ms: Windows and macOS
    count two clicks up to about 500 ms apart as a double-click, so 300 ms let a
    slow one open the slide-over on its way down) and a tap's the double-tap
    window (`DOUBLE_PRESS_MS`, 300 ms), so a double-click never opens it on the
    way, while a key, and the strip's Open, open at once. The locked box carries
    an **action strip** attached to the box, at its zoomed place but its own
    size (`data-graph-lock-strip`, ui `lockStripPlace`): a small floating bar in
    the step control's look (`--surface`, a 1px `--border`, `--r` corners and
    `--shadow-pop`, since it floats over the drawing) holding Gr8r's buttons in
    sentence case, 26px tall and at least 26px wide (32px on a coarse pointer,
    which keeps the height so the strip covers no more of the box under it):
    **Open** the one primary (the `--accent` fill, `--on-accent` words), **Open
    graph** a secondary (bordered `--surface`, `--text` words, the small button
    shadow; the drill-down, below; left out when the box has none) and an ×
    **Unlock** ghost icon button (`--text-2`, `--surface-2` on hover). It hangs
    4px outside the box (room for the path and focus rings), under it, over it,
    beside it on the right or beside it on the left, in that order of
    preference, on a side the box's own arrows do not use when beside it (left
    to right: blockers come in on the left, what it holds up leaves on the
    right, and the strip's surface would hide the start of the path the reader
    locked on). A place counts only when the strip fits whole in what of the
    frame shows on screen: the frame's own visible part (less a host panel's
    cover), clipped to the visual viewport and kept 4px clear of the bars fixed
    over the page's edges (`data-ui-edge-bar="top"` / `"bottom"`: the shell's
    sticky top bar and a phone's fixed tab bar, where the strip used to sit
    under the tab bar with no button tappable, 2026-10-23 review), and when it
    meets nothing it must not cover: the critical path's step control over the
    frame's bottom-left corner (it used to be drawn over it, z-index 4 over 3,
    hiding ‹ and › there). Of the places that count, the one covering the least
    of the words nearby wins (other boxes' words and frame titles,
    `data-graph-words`, less 2px of leading, measured once per lock and zoom: in
    a dense drawing the gap between two rows, 12 to 22px, is narrower than the
    strip), the earlier on a tie; with none, the one most on screen (a box half
    out of the frame's corner may then cover the step control rather than hang
    off screen). Under or over the box it is slid across to stay inside the
    visible frame, beside it up or down, never off the box's side and never on
    the box itself. Measured on the showcase's issue level (50 locks centred in
    the frame, the strip hiding at least 40% of another line's glyphs): 2 → 0 at
    100%, 10 → 3 at 83% and 24 → 7 at 58% (frame titles 5 → 1 and 9 → 2), the
    rest where every side covers some words. It is placed again on every scroll
    of the frame or the page, every resize of the window or the visual viewport
    and whenever the step control comes or goes, straight on the element, which
    finds the canvas and the frame from itself (a lock from the URL draws it in
    the graph's first render, before the graph's refs are attached, and it was
    never placed again: it stayed under the box whatever the scroll). It follows
    the boxes in the DOM, so Tab from the box reaches Open, Open graph and
    Unlock. The **readout** leads with "Locked on <name>" (the lead-in semibold
    in `--accent-ink`) and the same three as small inline buttons, 24px tall
    ("Open" the primary, "Open its graph" a secondary, "Unlock" a ghost), then
    the box's paths. **Unlock**: Escape (one Escape for the lock; a host panel's
    own Escape waits for the next; from anywhere on the page, not only from
    inside the graph, since a drag on the background leaves focus on the page,
    unless an open panel, a menu or a text field nearer to the key takes it
    first), a click or tap on the background (not the end of a pan, which
    swallows its click), Unlock on the strip or in the readout, or locking
    another box (a click on another box moves the lock). A screen reader hears
    the lock once, in a polite status line ("Locked on ENG-23 Typo tolerance.",
    "Unlocked."; the readout stays plain), and the box exposes it
    (`aria-pressed` on a button box, which meant the selection before;
    `aria-current` on a link or plain box). The key help names Enter, Shift +
    Enter ("opens its graph (the box itself when it has none)": on a box with no
    graph it locks and opens the box, as a double-click does there; it used to
    do nothing), Tab and Escape, and the touch gestures. While a box is locked a
    new selection from a panel (a "Waits on" row, a drawer's link to another
    issue) moves the lock to it, so the canvas lights what the panel shows. The
    lock never moves a box or lays anything out again. **In the URL**:
    `?lock=<id>` (an issue by its identifier, `lockParam`; read by id, else by
    identifier in any case, `lockedNodeId`), written in place with `?highlight=`
    (`addressHref`, the lock before the highlight, `withLockParam` keeping its
    place), so a reload, Back and Forward and a shared link keep it and a lock
    leaves no history entry of its own; dropped when the box is not drawn;
    carried on the graph's own links (level tabs, trail, panel and
    narrower-graph links: `carryLock`), where the next graph keeps it only if it
    draws that box; never on a drill-down link. The first paint centres the
    locked box (before the focus and the selection). The island reads and writes
    the URL only while it is its own page (`scopeQuery`: Back and Forward render
    the page being left with the arriving entry's URL, and its writes used to
    wipe that entry's `?lock=`). **Touch** (`pointerType` touch only, not
    width): a tap locks (it used to trace without locking), a second tap on the
    locked box opens it, two taps within 300 ms drill down, a tap on the
    background or Escape unlocks; the focus a tap gives a box in Chromium never
    traces on its own, and a tap after an unlock is never half of a double tap.
  - **Drill down** (owner request 2026-10-23: "when I double click on the graph
    item, it should take me to that items graph so I can quickly drill down"). A
    **double-click** on a box (a double tap, Shift + Enter, or its strip's and
    readout's Open graph) opens its own graph one level down, keeping the
    highlight on screen (never the lock): an initiative its projects
    (`/graph?initiative=<id|none>`), a project its milestones
    (`?project=<id>&level=milestone`), a milestone its issues
    (`?milestone=<id>`), an issue its blocking chain (`?chain=<KEY>`); on a box
    with none, a double-click and Shift + Enter open the box as a second click
    would. A double-click on a **frame's title** opens what the frame stands for
    at the level being drawn (a milestone frame its issues, a project frame its
    issues at the issue level and its milestones at the milestone level, an
    initiative frame its projects; "No milestone" its project at that level, "No
    project" nothing; the zoom-in cursor marks a title that drills, a single
    click on it does nothing, not even unlock). When that graph is the page
    itself, empty, or past the draw limits, the box goes where its panel's
    drill-down links go, in their order (an initiative: its milestones, then its
    issues; a project: its issues; a milestone: its project's milestones with it
    selected, `&node=`; an issue: its milestone's issues; a frame: then its
    item's box's): the first that draws, else the first that holds anything (a
    too-large page lists narrower graphs), else none (a loose issue in its
    milestone's own graph: no Open graph, and a double-click opens it as a
    second click would). The sizes come from one pass over the viewer's mirror
    per page (`graph-drill.ts` `DrillSizes`: the issue level inside a milestone,
    project or initiative, the milestone level inside a project or initiative,
    the project level inside an initiative, and whether an issue has a
    relation), counted by core's membership rules without building a graph; a
    test checks them against core's built graphs for every container of the demo
    and the showcase. The model carries them as `GraphNodeData.drillHref` and
    `GraphClusterData.drillHref` (canonical); the island adds the highlight
    (`drillHrefFor`) and follows a double-click with a client navigation held
    clear of the address-bar write (`onDrill`). The first click of a
    double-click locks the box in place (no history entry), so Back from the
    graph drilled into returns to that box, locked. No text is selected on a
    double-click (`user-select: none` on boxes and drilling titles, and the
    second press's mousedown is prevented), and a double tap never zooms the
    page (`touch-action: manipulation` on the frame). The toolbar hint reads
    "Click to lock · Double-click to drill in · Drag to pan · Ctrl + wheel to
    zoom", and the idle readout "…; click it to lock the trace, double-click to
    open its graph." ("Tap a box to lock …; tap it again to open it, or
    double-tap for its graph." on touch).
  - **Frames** (owner decision 2026-10-23). Every graph but a chain lays its
    boxes out in labelled frames by parent (`model.clusters`, core
    `DependencyGraph.clusters` mapped by `clusterData`: muted when nothing in it
    is active, dashed when it holds only outside boxes; `GraphNodeData.cluster`
    on each box): issues by milestone ("No milestone" per project, "No
    project"), nested in project frames when they span projects; milestones by
    project; projects by first initiative ("No initiative" last; none without
    initiatives); the initiative level has none and packs its loose boxes. The
    server lays it out once with
    `layoutGraph(nodes, edges, { direction: 'LR', clusters })` (ui, §9.3):
    inside each frame the boxes on an arrow flow left to right by dagre over
    that frame's own items, the ones on no arrow pack into a compact grid under
    the flow (open first, done and empty last; two or more boxes get at least
    two columns, so a few wide ones never stack), frames on no arrow go onto
    shelves, and a chain of frames longer than 2,400px shelves too, decided
    before dagre runs when the flow's longest chain alone is already longer
    (`flowChain`, a lower bound computed on dagre's own acyclic graph: a
    workspace frame over many project frames used to spend seconds of dagre on a
    row the cap then threw away); flows past 120 items or 180 links rank with
    tight-tree. dagre centres each rank on its neighbours, so a later rank that
    stacks higher left the first ones hanging under an empty band (about 130px
    above the showcase's first box at the workspace issue level, 2026-10-23
    integration); after dagre, when that band is at least `liftMin` (64px, about
    a box) tall, each rank of a flow rises by the space above it and above every
    rank before it (`liftOpening`; arrow points count as content and move with
    their rank, a point between two ranks with the later one; a route's end on
    the side facing along the direction moves with its box, any other end is
    found again on its border), so every frame's flow starts in its top-left
    corner. A thinner band is left: moving ranks bends the arrows between them,
    and at the milestone level closing bands under 64px put 4 more of 54 arrows
    behind a box. dagre's edge weights are whole numbers (a link 100 per edge,
    twice for a risk or cycle edge, a port edge 100, a port-ranking edge 1): a
    fractional weight could leave a network-simplex cut value at -2e-16 that
    never settles, and the server's render looped forever on about 1 small
    project in 100 (2026-10-23 review). An arrow between frames leaves the
    blocker's far side and enters the waiting box's near side, following dagre's
    lane to the far side of each frame it leaves and from the near side of each
    it enters, and running level to that side (2px inside the border) before it
    crosses to the next frame when the run passes no box: a frame's grid and
    shelves sit under its flow and are often wider, and an arrow that left its
    port route straight for the next frame's route cut across them (in a flow
    small enough for network-simplex, each frame's ports rank after and before
    its whole flow; in a bigger one they sit beside their own items, which saves
    about 0.35 s at 600 boxes in one frame), so it passes the other boxes there
    instead of running behind them (a regression test pins the demo's Dual-write
    → Search v2 beta beside Read path switch). Last, every arrow between frames
    (and an arrow inside one frame whose dagre route would pass a box of its
    grid) turns round each box in its way (`routeAround`): between its straight
    leads, each run of its control points that would enter a box (or a frame
    title's patch) is replaced by a run round the box's nearer side, 6px out
    (half a grid row's gap), checked again in turn up to 128 points; where the
    smooth curve through the result would still cut behind a box, it is eased
    into straight runs with rounded bends (a point 14px from each end of a run,
    since a B-spline runs straight through three points in a line), and an arrow
    with nothing in its way keeps its smooth curve. Before it (2026-10-23
    showcase review, in Chromium), 69 of the showcase's 247 issue-level arrows,
    25 of 54 at the milestone level, 8 of 27 at the project level and 28 of
    Enterprise readiness's 86 ran behind some box; after it 10, 5, 0 and 3
    counted the same way, or 4, 3, 0 and 2 behind a box they do not join (a test
    pins the workspace levels). At the draw limits (700 boxes, 1,000 arrows) it
    adds up to about 160 ms (the slowest shape measured 0.69 s in all). Many
    arrows can share one gap between frames there, as a bundle; pointing at a
    box traces its own. Arrow keys move to the nearest box that way (columns are
    per frame). A frame is a 1px `--control-border` edge (3:1 on the canvas: the
    frame is the only cue that groups) with `--r-lg` corners, no fill or shadow,
    its name a sentence-case `--fs-xs` semibold title (12px on a 16px line,
    `CLUSTER_METRICS`) on a patch of the canvas drawn over the arrows:
    `--text-2` at the top, `--text-3` nested and in a paused frame; a paused
    frame is dashed in `--gray`, an outside one dashed. Never a status hue: the
    frame only groups, the boxes say where they stand. Forced colours draw
    frames `CanvasText`, paused ones `GrayText`, both still dashed where they
    are. Frames are decorative (`aria-hidden`): the names carry them. A done box
    keeps its solid neutral done diamond even when quiet. The legends end their
    Nodes row with the frame: "Milestone — a frame of its issues, inside its
    project's" ("a frame of its issues" in one project), "Project — a frame of
    its milestones", "Initiative — a frame of its projects (each under its first
    initiative)", and "Inactive — a dashed frame of paused work" when one is
    drawn.
  - **Draw limits and cost.** At most 700 boxes and 1,000 arrows
    (`GRAPH_DRAW_LIMITS`, §8.1; 200 and 300 before every item was drawn), the
    largest size that lays out in about a second here, whatever the shape.
    Re-measured 2026-10-23 after the review fixes (whole dagre weights, the
    chain estimate that shelves frames before dagre runs, port-ranking edges
    only in small flows), core graph + adapter with its layout + the model's
    JSON, median of 3 seeds (max), on synthetic workspaces' issue level: N
    issues in N/40 projects × 5 milestones (7 in 10 relations inside a project)
    117 (130) ms at 200 / 300, 215 at 400 / 600, 344 (386) at 500 / 800, 443 at
    600 / 900 and 410 (429) at 700 / 1,000; at 700 / 1,000 by shape, 1 project ×
    1 milestone 676 (782), 1 × 3 548 (580), 3 × 3 770 (936), 10 × 5 357 (368),
    40 × 3 513 (583), 70 × 3 819 (893) and 140 × 1 698 (708) ms (with half the
    relations across projects). Before the fixes the many-project shapes took
    1.6–3 s (40 to 70 projects) and up to 5.6 s (140), all spent on a dagre row
    of project frames the cap then discarded, and about 1 small project in 100
    never finished. The island's HTML render adds 15–60 ms. Past the limits the
    too-large state draws nothing (4–6 ms). An unchanged drawing asked for again
    (a slide-over opening or closing) reuses its layout (Canvas, below).
  - **Hover cost.** Pointing at a box re-renders the island and restyles every
    box that recedes and every arrow, so its cost grows with what is drawn. The
    receding `--text-3` is set on each box's words (not as an inherited colour
    or token on the box, which restyled every element inside every box), and
    nothing but the fills and the path rings fades (no colour transitions on
    boxes or arrows, which repainted the whole drawing for several frames).
    Measured in Chromium on this sandbox (production React, the planner's own
    model), long frames (≥ 50 ms) per move from the background onto a box or
    back: 4 ms at 200 boxes, 111 at 400 and 107 at 700 (worst frame 132 ms),
    against 92, 299 and 406 (worst 292 ms) before; the hidden edge table is
    built once per edge list. A laptop is about twice this sandbox's speed.
  - **Canvas.** One `--r-lg` panel (`--surface`, a soft `--border`): a flat
    toolbar (level tabs, the highlight switch; "Drag to pan · Ctrl + wheel to
    zoom" in `--text-3`; ghost − / + icon buttons around the percentage and
    Fit), a recessed `--sunken` canvas (Gr8r's board well), and the readout row.
    SVG laid out with `@dagrejs/dagre` (rankdir LR) once on the server, in
    frames (above; the planner keeps its last 24 layouts by their exact input,
    boxes, edges and options with the frames, so an unchanged drawing, such as
    the page re-rendered for a slide-over opening or closing, is not laid out
    again, and a highlight switch never asks the server, since no highlight
    moves a box). Boxes are Gr8r cards: `--surface`, a 1px `--border`, `--r-sm`,
    10 × 12px padding, a 12px status diamond (the `StatusMark` family, drawn in
    the module so a quiet box can grey its hues and keep its shape), a 13.5px
    medium title wrapped to two lines by Geist's measured widths (ui `layout.ts`
    `textWidth`, a per-character width table; the box grows to 264px), a 12px
    `--text-3` line (an issue's key in Geist Mono), and sentence-case `Chip`s;
    hover is the `--surface-2` fill. In the status hues (§8.2 "Status colours");
    under Risk: an overdue box is tinted (the `--red-soft` tint over the card
    inside a 1px red edge; never a flood, so its words, diamond and chips keep
    their colours, its Unassigned chip a tinted amber one); a box that needs
    action (an unassigned issue, an at-risk milestone, a project or initiative
    whose next milestone is at risk) carries a 2px amber edge, and one that is
    overdue without the Overdue tag a 2px red edge (`GraphNodeTone` `warning` /
    `danger`, drawn through `data-tone`); a closed or inactive box is quiet
    (`--text-3` words): a done one keeps its solid neutral done diamond, a
    paused or inactive one its mark in `--gray` (shape kept; a missing input
    stays dotted). Each status mark keeps its shape (done a solid `--text`
    diamond with a knocked-out tick, on track an open green one, at risk amber
    with its lower half filled, overdue solid red, a missing input a dotted
    `--text-3` outline); an issue box's open mark is the open `--text-2` diamond
    (`UiStatus` `open`: an issue makes no status claim of its own, its milestone
    does); forced colours keep every shape in `CanvasText`. Flags are `Chip`s:
    Unassigned tinted amber, Overdue a red dot pill, Cycle, On a cycle and Cycle
    inside tinted red, No lead an amber dot pill, Inactive quiet text, +N more a
    neutral badge. Arrows are Gr8r's thin connectors: blocks a 1.25px `--text-2`
    curve; risk chains amber, 2px under Risk; cycles long red dashes (and a
    dashed red outline standing off each box in the cycle); cross edges short
    dashes (crossing a project at the issue and milestone levels, a first
    initiative at the project level, never at the initiative level); resolved
    edges 2px `--text-3` dots; weights as counts in a small surface pill, the
    figure in the edge's text-safe hue; externals (outside the container, one
    hop) dashed in `--control-border` (dashed in their tone when they carry one,
    an overdue external dashed red on its tint). The purple is never a status
    here: it is the selection (the accent tint inside a 2px accent edge), the
    box being read (the tint under an accent ring; pointer, keyboard focus, the
    lock), the lock's corner ticks and its strip's Open button, what it waits
    on, a chain's focus ring and keyboard focus; Copy Mermaid (one panel: a
    secondary button that says Copied with a green tick, or Copy failed with a
    red cross, and a "Mermaid source" disclosure showing the code on a
    `--sunken` well) uses none of it. Hover/focus lights both paths (above); a
    click locks a box and a second click opens its slide-over (Lock on, above);
    "Copy Mermaid" copies the drawn graph in the current highlight (core
    `mermaidParts`: one body, whose labels end in the readiness word, plus the
    highlight's classes; the planner ships `{ body, styles }` with the critical
    path shown at rest, and the client joins them; each frame is a `subgraph`).
    Every item is drawn, on a relation or not (§8.1). Sublabels: an initiative
    "4 projects · <target date | no target date>", a project its lead or "No
    lead", a milestone "<project> · <date>", an issue "KEY · assignee"; a box
    has one sublabel line, and when a milestone's or initiative's line is too
    long for it (measured with ui `measureNode`, in Geist) the part before the "
    · " is cut, never the date. Chips, after the readiness chip, in order:
    "Unassigned" (issues, milestones), "Overdue" (active work only), "Cycle" (a
    drawn cycle, with the dashed red outline), "On a cycle" (an issue on an open
    cycle this graph does not draw whole: the word without the outline, so its
    stuck red always has one), "Cycle inside", "No lead", "Inactive" (a box with
    no active project, and an open issue of an inactive one), "+N more" (a chain
    issue leading on past the cap). The empty state is Gr8r's centred
    `EmptyState` with the Graph nav item's icon (Network).
  - **Legends** per level and highlight (`model.legends`, the screen shows its
    own mode's, labelled "Graph legend: Status" and so on, under the drawing and
    its readout, as a figure's key: above it, the legend's 190–290px pushed the
    canvas below the fold, a phone's first screen showing none of it, 2026-10-23
    showcase review; all three sit stacked in one grid cell, the others hidden
    and inert, so the cell keeps the tallest one's height and a switch never
    moves what follows it), as quiet key rows (no box; a sentence-case row name
    in `--text-3`, then swatch + name + note; notes drop under 1200px), in rows
    Nodes, Edges, Paths. Status: issues Ready "nothing open blocks it", No
    dependencies "it neither blocks nor waits on another issue" (a plain box;
    not in a chain), Blocked "an open issue blocks it", Stuck "on a blocking
    cycle (it may run outside this graph)", In a cycle, Done or paused "closed,
    or in a paused project (Inactive)", External / Focus as they apply, Blocks
    "the blocker is still open", Unblocked "one end is done: no longer blocking"
    (green dots), Cycle, Cross-project; boxes Clear "nothing outside it holds it
    up", No dependencies "it neither waits on nor holds up another <level>",
    Waiting "an open issue in it waits on another <level>", Stuck "nothing
    inside can start: a cycle inside holds it", In a cycle, the level's faint
    box (below), External, Blocks, Cycle, the level's cross arrow, Count.
    Critical path: Critical path "numbered in order; each waits on the one
    before", Off the path "faded", In a cycle, External / Focus, the chain's
    arrow "the longest chain of open blockers, counted in issues" (milestones,
    projects, initiatives), Blocks, Cycle, Unblocked (issue levels). Every
    highlight but Critical path ends with the Paths row: Reading "the box you
    point at or focus" (the accent tint under its ring), Locked "the box you
    click or tap: its paths stay lit, Open beside it" (that tint and ring plus
    the lock's four rounded accent corner ticks, `path-locked`; the double rule
    and `Highlight` ticks in forced colours), Waits on "what the box you point
    at waits on", Holds up "what waits on it" ("…, through box arrows" above the
    issue level), Ready next "ready once it is done" (Clear next "clear once it
    is finished"); Critical path's is Reading, Locked, then "through the box you
    point at: the longest chain it is on", drawn as the chain's own `--text`
    ring and step disc (never the accent ring, which means Waits on). In forced
    colours the edge swatches turn `CanvasText` like the drawn edges, keeping
    their dashes. The Risk legends are the ones below, with "Resolved — blocker
    closed" now "Unblocked — one end is done". Risk: initiatives and projects
    ("blockers sit left of what waits", Overdue = a project's milestone is past
    due, At risk = a project's next milestone, In a cycle, Inactive = no active
    project / paused or not started, Blocks, Risk chain = a blocking issue is
    unassigned or overdue or waits on one, Cycle, Cross-initiative at the
    project level with initiatives, Count); milestones (the muted swatch reads
    "Complete or inactive — nothing open, or a paused project"); issues
    unchanged, except that the workspace's issue level (which has no externals)
    leaves out External; a chain: the issue legend without External plus "Focus
    — the issue this chain is about". Wherever frames are drawn the level's box
    reads "in a frame, blockers sit left of what waits" instead: each frame's
    flow runs left to right, but the frames pack onto shelves that wrap, so an
    arrow between two frames can run back (2026-10-23 showcase review: 41 of 247
    arrows at the workspace issue level, none inside a frame). Inside an
    initiative or a project, the aggregate legends add "External — outside this
    initiative / this project". Swatches draw the canvas's own marks: Overdue
    the red tint inside its red edge (`node-overdue`), At risk / Needs action
    the 2px amber edge (`node-warning`), In a cycle the dashed red outline, Risk
    chain amber, Cycle dashed red, Inactive / Closed / Complete the quiet box,
    Ready next a green dot riding the box.
  - **Panels** (the same slide-over; links in this order, a link to the page
    itself left out). An initiative: breadcrumb "Initiative" ("Projects with no
    initiative"), its status mark, Target date, Projects ("5 projects · 1
    inactive"), Open issues ("20 open · 7 unassigned"), At risk (the active
    projects' next milestones at risk or overdue, "Atlas billing migration ›
    Dual-write (overdue)", red when any is overdue, else amber); links "Projects
    in X", "Milestones in X", "Issues in X", "Open as list"
    (`/issues?initiative=<id|none>`, its projects' issues on the Issues page by
    the same first-initiative rule), "Open on the timeline"
    (`/timeline?initiative=`); no Linear link (the mirror keeps no initiative
    URL). A project: breadcrumb its first initiative ("Project" without
    initiatives), the next milestone's mark (or "No open milestone"), Linear
    status, Lead ("No lead" amber when active), Next milestone (its date in
    `dueTone`), Progress (amber while open issues are unassigned), Allocation
    (the register's cell, in its chip's tone: blue allocating, amber blocked,
    grey inactive / no open milestone / not evaluated), Initiatives when it is
    in several ("Platform reliability · also in Customer growth"), Scope for an
    external ("Outside <container>: it blocks or waits on a project here");
    links "Milestones of P", "Issues of P", "Open as list"
    (`/issues?project=<id>`), "Lane on the timeline", "Project in Linear". A
    milestone: today's panel plus "Milestones of <project>"
    (`?project=&level=milestone&node=<id>`) after "Issues of this milestone",
    "Open as list" (`/issues?milestone=<id>`, the same issues on the Issues
    page) before "Open on the timeline", and Scope for an external; its Overdue
    strip is red, Due follows `dueTone`, and "No lead", unassigned progress,
    risk reasons and missing inputs are amber (none of it in an inactive
    project). Initiative, project and milestone panels also say where the box
    stands, mirror-wide: **Readiness** in its Status tone ("Waiting on 1
    milestone: Dual-write", amber, naming the drawn direct blockers, "(1 not
    drawn)" when it waits on more boxes, and the blockers with no box at this
    level counted apart as issues: "Waiting on 1 milestone: Dual-write, and 2
    issues with no milestone"; "Clear: nothing outside it holds it up", green;
    "None ready: every open issue in it waits on another", red; a waiting box
    none of whose issues can start adds "None of its open issues can start: a
    cycle inside holds some of them", red; "No dependencies: it neither waits on
    nor holds up another milestone", no tone; "Complete" when it has issues and
    none open; "No issues" when nothing counts toward it in the viewer's mirror;
    an inactive box takes no tone) and **Open issues** ("4 open · 3 can start ·
    1 blocked", counting issues on no relation too; an initiative's row adds "·
    7 unassigned"), after Progress (an initiative's after Projects). Under
    Critical path a "Critical path" row gives the box's step ("Step 2 of 3
    (Dual-write → Search v2 beta → Tokens and type)") or "Not on an open chain".
    An issue box opens the issue slide-over (`?issue=`, §8.5). Under the links a
    summary line ("Waits on 1 · Holds up 1 · Finishing it would clear 1") leads
    two lists that select neighbours at every level, both transitive over the
    drawn arrows (the paths the canvas lights): "Waits on · N", nearest first,
    the heads where work can start chipped "Start here" (green; never a box
    where nothing can start), the rest their readiness chip, with "1 more
    blocker is outside this graph." when the box waits on undrawn ones; and
    "Holds up · N" (it was the direct "Blocks"), the boxes finishing it alone
    would clear chipped "Clear next", with "Finishing it would also clear 1
    milestone outside this graph." when that is so. One caveat follows: "Box
    paths follow the arrows between boxes: an arrow in and an arrow out may be
    different issues. The Issues level shows the exact chains." A neighbour row
    carries its box's tone in the current highlight as data (Gr8r's rows have no
    rule; its chip and diamond say it), and its chip is a dot pill.
  - **Arrival.** `?node=<id>` (initiative, project or milestone levels only, and
    not while `?issue=` is open) selects that box (every box is drawn), opens
    its panel and scrolls it into view; the page remounts the client island per
    scope and `?node=` (`pageKey`) and never writes `?node=` back. Until the
    panel opened on arrival (the `?node=` panel, or a `?issue=` slide-over, as
    on `/graph?chain=ENG-23&issue=ENG-23`) first closes, the canvas keeps room
    beside it (ui `coveredRight`, the slide-over's width, `SLIDE_OVER_WIDTH`),
    so the box the visit is about is brought into the part the panel leaves
    uncovered instead of lying under it (scrolled only as far as it takes to
    show it whole, so what it waits on stays in view to its left); on a phone,
    where the sheet covers everything, nothing moves. With nothing to centre on
    (no `?node=`, no chain focus, no selection) the canvas opens where its flow
    starts, not at dagre's empty top-left corner: scrolled to the left end, and
    down to the band, starting at a box, where the most boxes of that first
    frame-width show whole (the topmost on a tie), so a big graph opens on boxes
    on a phone too. A framed level (every level but a chain) opens on its first
    frame, which the packing puts at the top-left: it stays at the origin while
    that frame shows a box whole there (the showcase's workspace issues open on
    Atlas, not on a fuller band of a later project), and otherwise slides down
    to that frame's own boxes. A graph whose height fits its frame does not
    move.
  - **A chain** (`?chain=<KEY>`): the issue is ringed as the focus (ui
    `focusId`: a 2px accent ring standing 3px off its box, lighting nothing; not
    a selection) and kept; no panel opens. Clicking any box opens its
    slide-over, whose Graph link re-centres the graph on that issue's chain:
    that is how long chains are followed. `?chain=<KEY>&issue=<KEY2>` draws the
    chain with KEY2's slide-over open.
  - **A viewer with no initiatives** (a guest, or a workspace without them)
    asking for the initiative level or an initiative gets the workspace at the
    same level (the initiative level at the project level) with the fallback
    notice, never the not-found page, the same for every id; no Initiatives tab
    and no initiative crumb.
- **Runs**: a Gr8r page head (title, receipts) with the run controls at its top
  right and their note under the receipts, then one register panel of runs (mode
  as a chip: Dry run the neutral badge, Live the tinted blue one; status:
  Running and Succeeded dot pills in blue and green, Partly failed and Failed
  tinted amber and red; trigger; tabular counts with a non-zero Failed in red
  and Blocked in amber; no row rule). Detail: the page head with the mode and
  status chips, the stats strip, the run's own error as a red notice, the run's
  properties as a flat list in two columns, then per project a heading row (a
  tinted amber "Blocked" chip beside the name when allocation stopped there, so
  the counts on the right leave the word out; the reason and its gaps as plain
  sentences under it, never a tinted box) over a register of assigned / would
  assign / failed / stale / skipped issues (outcome chips: would assign the
  neutral badge, assigned tinted green, failed tinted red, not written and
  skipped plain grey; a Linear error in red text) and one quiet line for the
  already-assigned skips. Everyone signed in gets "Preview (dry run)" in the
  head and, while allocation is live, "Run now" behind a second click; in dry
  run the note says anyone can switch allocation live in Settings → Modes and
  that the switch is audited. There is no list of who may run; a Linear guest
  gets the read-only notice instead of the buttons (owner decision 2026-10-22).
  An issue's activity names a hand-started run "Manual run".
- **Settings** (Gr8r settings layout): a 220px sub-nav column (`NavTabs`
  vertical with a 16px icon per section — Modes, Watchers, Schedule, Status,
  Notifications, Audit — the current one a raised pill; the page's h1 "Settings"
  heads it as an eyebrow) with a `--border` rule beside the section; at 900px
  and below it becomes one sideways-scrolling strip above it, scrolled so the
  current section shows. The section's name (19px semibold, an h2) has a quiet
  chip (Audited, Sync · preview, Newest 50, or Read only for a guest) and its
  one-line lead; then Gr8r setting rows (`.srow`: the name 13.5px medium over
  one 12px `--text-3` help line, the control or value on the right, `--divider`
  rules; on a phone the control drops under the text), grouped under small
  headings with a `--border` rule where a section has groups (Schedule: Time,
  Risk and warnings, My week and the timeline, Projects; the guest's read-only
  rows use the same headings). The page's own line on what Settings is closes
  the section as a quiet foot. Modes are two switches named by their row
  ("Allocation live", "Warnings live"); turning one live shows an amber "Live
  allocation" / "Live warnings" notice until it is saved. Watchers is Gr8r's
  member list (round avatar, name, email, a visible Watcher box). A refused
  number or timezone is the red error field (a red edge thickened by a 1px red
  shadow, a soft red halo on focus) beside a red error line; the save bar is
  Save, Reset and a status line that turns red when a field or the last save
  failed. Status colours its values (Working and a sync that went through green;
  Not installed and a never-run sync amber; Revoked and a failed sync red, the
  failure's help line red too; demo data and no webhook yet grey), then Resync
  and Preview today's digests; the preview is one small heading per recipient
  over a register, each item's warning kind a chip in its hue (Overdue tinted
  red, invalid due soon and allocation stopped tinted amber, At risk an amber
  dot pill), its Due column in the due-date colour (`dueTone`), as the other
  coloured dates do (My week's Upcoming deadlines colours its group labels
  instead). Status, Notifications and Audit take a wider column. Notifications:
  Sent tinted green, Sending a blue dot pill, Preview plain grey, Failed and
  Undeliverable tinted red (error text red). Empty logs are Gr8r's centred empty
  state with an icon.

- **With personal API keys** (`LINEAR_AUTH=api_key`, owner request 2026-10-23,
  §7.4):
  - **`/` (the connect page)**: Gr8r's sign-in card, as on the OAuth landing
    (440px wide, centred on the page background): the headline "Your week, from
    Linear." with "Connect with a personal API key from Linear." under it, a
    paragraph in quiet running copy saying where to create a key, that the
    planner asks Linear whose it is, keeps it only in this server's memory, uses
    it for what the person does and (for members) to refresh its copy every
    `SYNC_INTERVAL_MINUTES`, never saves, logs or sends it back, and forgets it
    on sign-out, after 2 h idle, after 12 h or on restart; a trust line in
    `--text`, medium ("Whoever runs this server could still capture a key, so
    connect only to a planner you trust."). The form is a plain server-rendered
    `<form method="post" action="/api/auth/key">` (a Server Component: no React
    state ever holds the key) with a sentence-case "Linear API key" label and a
    password input (the shared `.input`: a `--control-border` edge, 36px tall,
    the field focus ring, and the red refused edge, `aria-invalid`, when the
    last connect refused the key itself, `isKeyRefusal`: its shape or Linear's
    answer; `autocomplete="off"`, no autocapitalize/autocorrect/spellcheck, the
    password managers' ignore attributes, `maxLength` 256, never a `value`), a
    quiet help line (starts with `lin_api_`; one key just for this, named
    "Milestone Planner", Read and Write on all teams, never Admin; a Read-only
    key makes the planner read-only; revoke it when done; choose Never if the
    browser offers to save it) and the one primary button, Connect, full width.
    At the top of the card, notices coloured through their tone (`data-tone`),
    each with a sentence-case lead-in: a red tinted "Could not connect" alert
    with the failure's sentence, a neutral bordered "Signed out" note after
    sign-out (`?signed_out=1`), an amber tinted "Already disconnected" note
    after a sign-out that could not tell whose key it was (`?signed_out=ended`:
    the key may still be connected in another browser; paste it again, then sign
    out), or a neutral "Connection ended" note. "What it does" below keeps the
    feature cards, three entries reworded for this mode (`landingFeatures`): the
    timeline's date drag "as themselves", allocation "when someone starts it,
    over what they can see, written as that person in Linear", and warnings
    "Preview only". There is no demo picker.
  - **Settings → Status**: the section's sentence reads "Your key and when it is
    forgotten, whose key reads Linear for the planner and the last sync, and
    today's digest preview." (`sectionDescription`), and three rows replace the
    install rows: "Your key" ("Connected 3:39 PM · forgotten by 3:39 AM
    tomorrow, or after 2 h idle", clock times in the workspace's timezone,
    "tomorrow" when the limit falls on the next day; "Held in the planner's
    memory only; never saved"; green, amber "Not connected" when the vault
    forgot it), "Mirror read with" (<name>'s key, the refresh interval and the
    last sync; amber "Nobody's" with no member connected; red with the error
    when the last sync failed) and "Scheduled jobs" (grey Off: "Nothing is
    stored that could read Linear. Runs happen when someone starts one; no
    digests are sent."). Below them "Forget my key and sign out", a secondary
    button with the sign-out icon in a row of its own (a plain form posting to
    `/api/auth/logout`, offered to read-only people too). Rows name people,
    never a key.
  - **Settings → Modes**: the allocation consequence says live runs write with
    the starter's own key and nothing runs on a schedule; the warnings row reads
    "Digests: off with personal API keys", its value a quiet "Off" where the
    switch would be. **Watchers** and **Schedule** each carry one neutral
    bordered "Personal API keys" notice ("With personal API keys no digests are
    sent: watchers see warnings only in the preview." / "No scheduled runs with
    personal API keys (DAILY_RUN_AT does nothing).").
  - **Setup**: the installed layout's panel under a "Personal API keys" title
    with a quiet "Memory only" chip: the bound workspace and its URL key, then
    Go home beside "This planner uses personal API keys: there is nothing to
    install."
  - **Runs**: in the header under the run controls and their note, "Runs plan
    over what you can see. Live runs write with your Linear key: assignments and
    their comments appear in Linear as you."; the empty log says runs appear
    "when someone starts one with Preview (dry run); nothing runs on a schedule"
  - **Read-only and error copy**: `read_only_key` shows "Your Linear API key
    only allows reading…"; `not_synced` says the planner reads Linear with a
    workspace member's key and to reload once one connects, and the error page's
    `not_synced` block reads "Waiting for a workspace member's key."

  - **Key-shaped input** (security S14): the issue list's search and the
    relation picker's search never run a query that looks like a key (the Issues
    page shows a red "Not searched" notice, and a page URL that holds one is
    redirected without it by `proxy.ts` before rendering, with
    `parseIssueListParams` dropping such a `q` as a second layer), the command
    palette shows no matches with one alert sentence (`refuseQuery`), and the
    comment and edit forms are refused by the engine (§7.4).

Fixture mode shows a permanent demo strip under the topbar (`DemoNotice`, the
shell's full-bleed banner: an info icon in the accent, "Demo data" and one
sentence saying nothing reaches Linear, shortened below 1180px so it stays one
line). The signed-out landing page shows the same words as a neutral bordered
notice above the sign-in card.

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
  keeps the whole view beside `?issue=`; the open row keeps its selected fill),
  from the milestone drawer's issue list (the issue replaces the milestone in
  the same panel, the crumb "‹ <Milestone> / <KEY>" goes back to it; ✕ and Esc
  close both), from the graph's issue nodes (same panel as the node details; the
  node stays selected on the canvas; every issue of the scope is a node since
  2026-10-23), and from the relation rows inside it (a plain click swaps the
  issue in place, a modified click opens its page). The command palette's issues
  open the page.
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
  edit options. Alerts (`AlertStrip` tones): **Overdue** (its milestone; red),
  **Blocked** (the open blockers), **Holds up** (at-risk or overdue milestones
  waiting on it), both with a Graph action to the issue's own blocking chain
  (`/graph?chain=<KEY>`; Blocked linked its milestone's issue graph before
  graphs at every level, owner decision 2026-10-22), **Stalled** (with the
  milestone's countdown) and **Unassigned** (in the next milestone: who the next
  live run gives it to, or why allocation is stopped — no lead, a deactivated
  lead, the milestone failing the rubric). Blocked, Holds up, Stalled and
  Unassigned are amber. The view shows the most severe alert (danger before
  warning) as the one tinted `AlertStrip` and every other one as a `plain` row
  of one neutral bordered list under it (icon and lead-in in the tone, the
  sentence quiet), never a stack of tinted boxes; the model's alerts and their
  order are unchanged. Closed issues and issues of inactive projects (§2.8) get
  none, and an inactive project's issue is quiet throughout (grey milestone mark
  named "<status> · inactive project", no status colour on the assignee, due
  date or time in state). Otherwise "Unassigned" (and the assignee picker's
  empty face) is amber, as are a missing or deactivated lead and a stalled time
  in state with its note; the due date and its countdown are red when overdue
  and amber due today or tomorrow; an open blocker nobody holds reads
  "Unassigned" in amber in the relation lists. The "Blocked by" heading carries
  a **Graph** link to the same chain (`chainHref`, accessible name "Blocking
  chain of <KEY> as a graph") whenever the issue blocks or waits on an issue the
  planner holds, before the "+ Add" picker; when nothing blocks the issue the
  link heads "Blocks" instead, never an empty "Nothing blocks this task."
  section; a guest gets it too, alone (the graph only reads). A slide-over drawn
  over its own chain (`/graph?chain=ENG-24&issue=ENG-24`) offers neither the
  link nor the alerts' Graph action: the chain is already the page
  (`IssueTaskInput.pageHref`). Facts: assignee ("(you)" for the viewer; "Given
  by the planner on Oct 14: they lead <project>." after a live allocation;
  deactivated people noted), priority, labels, estimate ("3 points", or the
  T-shirt size), due date with its countdown, project with its lead, milestone
  with its status line ("At risk · due Oct 23, in 2 days · 3 of 7 done · next
  milestone"), time in state (whole days; under a day reads "Since today" or
  "Since yesterday" by the workspace calendar). The description is printed as
  plain text with its line breaks; it is markdown source and is never parsed
  into HTML. Comments are oldest first, a bot's or integration's muted, with
  "First 200 · more in Linear" when Linear holds more. Activity lists the
  allocation run entries about the issue (identical repeats, such as the same
  dry-run plan every day, folded into the newest with "Seen in N runs"; a live
  assignment's mark is green, one whose comment failed amber, a failed write
  red, plans and skips grey) and the created / started / completed / canceled /
  moved-to-state instants, newest first.
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
  chip: a 20px neutral bordered chip with the label's colour as a small rounded
  square, its name in `--text-2`. The same chip appears in `LabelPicker`
  (options and chosen values) and in the read-only value (the guest's view, from
  the live label ids and the team's label choices). Only hex values are painted
  (anything else is a hollow square). It is the one place a colour from data is
  drawn; everything else stays in the planner's marks (§8.2).
- **Look** (Gr8r's task drawer): the page is one `--r-lg` panel (a 46px header
  bar with the crumb trail, the key in Geist Mono, Linear and Copy link; the
  property rail set off by a `--border` rule at 760px and wider; edge to edge on
  a phone); the drawer is one column. The title is 19px semibold. The status
  line has the mono key and the state as a bordered pill (the glyph coloured,
  the name neutral). Properties are Gr8r's `.kv` with a 14px Lucide icon per
  label; editable values are pills that fill `--surface-2` on hover and open
  Gr8r popovers (§8.3). People are the one round pastel avatar
  (`InitialsAvatar`, a decorative hue picked from the name; nobody is a dashed
  empty circle), beside the read-only assignee too. Section heads are 13.5px
  semibold with a quiet count; "+ Add" and the relations' Graph link are small
  ghost buttons. Relations are flat rows with a hover fill and a ghost remove
  button. Comments follow Gr8r (26px avatar, author, date, text); the composer
  is one rounded box with the `--control-border` edge that takes the accent edge
  and halo on focus, and the red error field when refused. Activity lines carry
  an 8px dot in their tone (a live assignment green, a failed comment amber, a
  failed write red, noise a hollow grey ring) and the date on the right. A due
  date is the browser's date field drawn as a quiet pill with a ghost Clear (X)
  icon button named "Clear Due date".
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
- **`LINEAR_AUTH=api_key`** (§7.4): keys live only in the planner's memory, so
  the worker has nothing that could read Linear. After parsing the arguments
  (usage errors still exit 2) and **before** loading its config or booting (the
  store is not even opened), `run.ts` asks `linearAuthFromEnv` and
  `apiKeyModeOutcome(command)` decides: `tick` and `serve` print "api-key mode:
  no scheduled sync, allocation or digests (keys live only in the planner's
  memory)" and exit 0, so a cron left in place stays green; `sync`, `daily`,
  `allocate` and `warn` log and print "<command>: off when LINEAR_AUTH=api_key:
  keys live only in the planner's memory; start a run or a resync from the
  planner" and exit 1; `migrate` boots and migrates as usual, with
  `createEngineFromEnv(env, { migrateOnly: true })`: it never handles a key, so
  the deployed-only checks that guard keys (the `LINEAR_WORKSPACE` pin, an https
  `APP_URL`, the process flags) are skipped for it and the worker needs no pin.
  `serve` now exits at once, so a long-running worker service left from OAuth
  mode is deleted or set to restart Never (deploy.md §7). The planner process
  syncs instead (§7.4 "Background sync").

## 10. Configuration

| env                                         | used by                               | meaning                                                                                                                                                                                                                                                     |
| ------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_URL`                                   | planner, worker                       | public base URL                                                                                                                                                                                                                                             |
| `APP_NAME`                                  | all                                   | display name (default `Milestone Planner`)                                                                                                                                                                                                                  |
| `DATABASE_URL`                              | all                                   | Postgres; unset → PGlite at `PGLITE_DIR` (default `.data/pglite`)                                                                                                                                                                                           |
| `LINEAR_AUTH`                               | planner, worker                       | how the planner reaches Linear: `oauth` (default) or `api_key` (personal API keys held in the planner's memory, §7.4); a config error together with `LINEAR_FIXTURE`; set it as one shared variable for web and worker                                      |
| `LINEAR_WORKSPACE`                          | planner (api_key)                     | the Linear workspace URL key (or organization id) the planner serves; **required when deployed** in api_key mode (`NODE_ENV=production`, non-loopback `APP_URL`); unset locally, the first member to connect binds; the worker's `migrate` does not need it |
| `LINEAR_API_URL`                            | planner (api_key)                     | **test-only**: the GraphQL endpoint of a local fake Linear; accepted only with a loopback `APP_URL` and a `127.0.0.1` or `[::1]` URL without user info; logged at error level when set; the connect route then answers only loopback hosts                  |
| `NODE_OPTIONS`                              | planner (api_key)                     | must include `--disable-sigusr1` when deployed in api_key mode (`deploy/Dockerfile` sets it); `--inspect*`, `--debug*` and the heap-snapshot flags are refused in api_key mode                                                                              |
| `TOKEN_ENCRYPTION_KEY`                      | all                                   | oauth mode only: 32 random bytes, base64 (unused and warned about in api_key mode)                                                                                                                                                                          |
| `SESSION_SECRET`                            | planner                               | oauth mode only: ≥ 32 chars, signs the OAuth cookie                                                                                                                                                                                                         |
| `LINEAR_CLIENT_ID` / `LINEAR_CLIENT_SECRET` | planner, worker                       | oauth mode only: OAuth app                                                                                                                                                                                                                                  |
| `LINEAR_WEBHOOK_SECRET`                     | planner                               | oauth mode only: webhook signing secret                                                                                                                                                                                                                     |
| `SLACK_BOT_TOKEN`                           | worker, planner                       | optional; without it digests stay in the outbox                                                                                                                                                                                                             |
| `DEFAULT_TIMEZONE`                          | all                                   | IANA zone for new workspaces (default `UTC`)                                                                                                                                                                                                                |
| `WATCHER_EMAILS`                            | engine                                | comma-separated emails of the first watchers (else the installer)                                                                                                                                                                                           |
| `LINEAR_FIXTURE`                            | planner, worker                       | `1` = demo mode, no Linear needed; `showcase` = the big demo                                                                                                                                                                                                |
| `DAILY_RUN_AT`                              | worker                                | `HH:MM` in each workspace's timezone (default `08:00`)                                                                                                                                                                                                      |
| `TICK_TIMEOUT_MINUTES`                      | worker                                | hard limit per run (not `migrate`), minutes (default 10, ≤ 14)                                                                                                                                                                                              |
| `SYNC_INTERVAL_MINUTES`                     | worker serve; planner in api_key mode | minutes between ticks (default 15); in api_key mode, minutes between the planner's background syncs while a member is connected (1–1440, default 15)                                                                                                        |
| `PGLITE_DIR`                                | all                                   | PGlite directory when `DATABASE_URL` is unset (local dev only; a deployed api_key planner without `DATABASE_URL` logs a warning at boot)                                                                                                                    |
| `SESSION_DAYS`                              | engine                                | session lifetime in days (default 30); unused in api_key mode (2 h idle, 12 h at most)                                                                                                                                                                      |
| `LOG_LEVEL`                                 | all                                   | debug/info/warn/error                                                                                                                                                                                                                                       |

`packages/engine` exports `loadEngineConfigFromEnv(env)` and
`createEngineFromEnv(env)` so the planner and worker build identical engines.

In api_key mode `TOKEN_ENCRYPTION_KEY`, `LINEAR_CLIENT_ID`,
`LINEAR_CLIENT_SECRET`, `LINEAR_WEBHOOK_SECRET`, `SESSION_SECRET`,
`SLACK_BOT_TOKEN` and `SESSION_DAYS` are not read; boot logs one warning per
variable that is set ("X is unused when LINEAR_AUTH=api_key"). `DAILY_RUN_AT`
and `TICK_TIMEOUT_MINUTES` do nothing (the worker schedules nothing, §9);
`WATCHER_EMAILS` still seeds who the digest preview would warn.

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
  every team's scale, every refusal Linear would give); the base fixture
  deep-equals main's snapshot (`test/base-snapshot.test.ts`); the showcase
  (`test/showcase.test.ts`): it contains the base unchanged, counts in range and
  inside the draw budget, every reference, timestamps, determinism for several
  todays, the milestone scenarios, the flow rules with their exact exceptions,
  the designed cycles as the only ones, the critical path as the unique longest
  chain, the hubs, linked and unlinked work in every milestone, core's graph at
  every level and container (cycles per level), the guest's view, issue-page
  content, the due dates (the share, the exact overdue, today and tomorrow sets,
  each date against its milestone's target and the day the issue was filed, the
  same issues on any day, the gateway carrying them) and the store.
  `test/base-snapshot.test.ts` also pins that the mirror reads the base
  snapshot's issues plus only their due dates.
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
  status change write nothing; `LINEAR_FIXTURE`'s values and a boot with
  `showcase` (`test/showcase-boot.test.ts`: seeded like the base demo with the
  showcase's meta, every view and graph level for a member, the guest's
  Operations-only, read-only view).
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
  HTML (`test/read-only-render.test.tsx`: drawer, timeline, issue page,
  settings) and must hold no inputs, Save buttons, drag handles or grant links,
  while keeping every graph link (the drawer's two, the timeline's group links
  and "Open as graph", the issue's Blocked-by Graph). On the showcase engine
  (`test/showcase-pages.test.ts`), `/graph` at every level and inside an
  initiative, a project, a milestone and a chain, `/timeline`, `/projects` and
  `/week` build their models through the pages' engine calls and adapters, draw
  (never "Too many to draw") with a layout and Mermaid text (a body and each
  highlight's styles), no box's sublabel is cut, every workspace level draws
  every box and arrow for Chloe and for Gus (406 boxes and 247 arrows at Chloe's
  issue level), a highlight in the URL or a slide-over reuses the same layout,
  and each page's server time is measured against a budget. A milestone box
  keeps its date on any day, cross-year dates included, in both demo workspaces
  (`test/adapters-graph-sublabel.test.ts`), and the layout cache reuses only an
  identical drawing, frames included (`test/graph-layout-cache.test.ts`).
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
  links into the page (`adapters-{shell,week,timeline,projects,graph}.test.ts`)
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
  unsaved text resets it before closing; for the graphs at every level, that the
  extra graph screens render (`?level=initiative`, `?initiative=`,
  `?project=&level=milestone`, `?chain=`, `?node=`), the drill walk (select
  Platform reliability on `/graph?level=initiative`, "Projects in Platform
  reliability", then the trail's Workspace back to the initiatives), that every
  item is drawn in its frame (`/graph?project=proj-compass&level=milestone`
  draws Compass's three unrelated milestones in its one frame, saying "no
  dependencies", with the level tabs in the toolbar; `/graph?level=issue` draws
  all 51 issues in 28 frames, the 36 with no dependencies chipless, and says so
  in the receipts), that an empty graph (`/graph?milestone=ms-garnet-2`) says
  "No issues in Push notifications." with no highlight switch, and that a
  milestone drawer's "What it waits on" lands on `/graph?node=` with the box
  selected; for the graph highlights, that `/graph?chain=ENG-23` opens in Status
  with the focus's readout, that pointing at ENG-12 marks ENG-23 and OPS-20 as
  what it holds up (`data-state="down"`) and ENG-23 "Ready next", and focusing
  OPS-20 lights what it waits on, that the three highlights redraw the 51 boxes
  of `/graph?level=issue` in place (Critical path numbering ENG-12 → ENG-23 →
  OPS-20 at rest, its legend shown) and pointing at ENG-12 there lights what it
  holds up across frames, that choosing Critical path writes
  `&highlight=critical`, numbers steps 1–3, switches the legend and Copy
  Mermaid, survives a reload and, through the cookie, the trail's Workspace link
  (whose address gains `&highlight=critical` on arrival), that Status drops the
  parameter, that `?highlight=RISK` is written back as `risk` and junk as
  nothing, and, on a 390px touch screen, that a tap on ENG-12 locks it ("Locked
  on ENG-12", `&lock=ENG-12`, no dialog) and a later tap opens its issue, and
  that Escape and a tap on the background unlock; `graph-lock.e2e.ts` (owner
  request 2026-10-23) that a locked ENG-23 stays lit through a wheel scroll, a
  drag, pointing at another box, a zoom and a highlight switch, with its strip
  inside the frame, and Escape unlocks; that the strip's Open and a second click
  open its slide-over and a reload keeps the lock; that a double-click on Search
  v2 beta lands on its issue graph with no panel opened, and Back returns to it
  locked; that a frame title's double-click, the strip's Open graph and Shift +
  Enter drill down keeping Risk; and that Enter locks, Tab reaches the strip's
  Open and Enter on the locked box opens it; then, signed in as the demo's
  guest, that every page renders with no edit controls (no drag handle, drawer
  field, comment box, run button, Save or Resync), that
  `/graph?initiative=init-platform` falls back to his projects (all four drawn,
  unframed, though he sees no relation) with the guest notice and no Initiatives
  tab (never the not-found page, checked by its headline: both answer 200), that
  the palette offers no run or resync, and that a direct PATCH or POST is
  refused 403. It needs Playwright's Chromium (`playwright install chromium`) or
  `PLAYWRIGHT_CHROMIUM_PATH` / `PLAYWRIGHT_BROWSERS_PATH` pointing at one.
- **personal API keys** (`LINEAR_AUTH=api_key`, §7.4; every key in tests is an
  obvious fake, `lin_api_TESTKEY…`, and no test calls real Linear):
  - core `test/secrets.test.ts` (the shape accepts every test key and refuses
    the rest; redaction in text, JSON, a URL query and a header line, OAuth
    tokens too, idempotent; `introducesLinearCredential` counts only new runs);
    logger (every string value, `msg`, an Error's name, message, stack and cause
    are redacted; `key`/`apiKey`/`credential` fields hidden).
  - linear: the raw `Authorization` header, exactly one credential option, the
    getter read before every attempt (a key forgotten mid-request sends no
    further request, `test/api-key-gateway.test.ts`), a header that cannot be
    sent refused before fetch, `cache: 'no-store'` and `redirect: 'error'`,
    every echoed credential scrubbed from errors and causes, and no query
    selects `rateLimitStatus` (F9).
  - store `test/credential-free.test.ts` (PGlite, and Postgres with
    `TEST_DATABASE_URL`): blank tokens round-trip and any token is refused
    without its value; adopting an OAuth row blanks it; a keyed store reads an
    `''` token; planner-owned and error text is stored redacted; the mirror
    round-trips byte for byte, credential-shaped text included.
  - engine: `test/api-key-config.test.ts` (the mode matrix, only `APP_URL`
    locally, deployed needs https, the pin and `--disable-sigusr1`, refused
    inspector and heap-snapshot flags, `LINEAR_API_URL` loopback-only, unused
    variables, `migrateOnly` skipping only the key checks), `test/boot.test.ts`
    (a deployed planner on PGlite warns), `test/key-vault.test.ts` (fake clock:
    idle and absolute expiry, only `use` touches `lastUsed`, the getter turning
    null, caps, reader order, a stale browser's `forgetPerson` finding its
    person after idle, absolute expiry, a sweep or eviction, ended records
    ending with their time, their cap and `clear`, `markGuest`, nothing returned
    serialises a key), `test/key-sync.test.ts` (fake timers: starts and stops
    with the vault, one sync per interval while a member is connected, never
    with only guests, never keeps an idle key alive, a failure logged) and
    `test/api-key-mode.test.ts` over a fake key gateway, PGlite and a private
    Security team only Chloe is in: binding by the first member, each person
    writing with their own key and the binder reading, another org and a guest
    refused, a pinned planner a guest connects to first (the first member
    becomes the binder, the reader and the watcher, and reads again after
    reconnecting), a connect failing after the key was held (forgotten, no later
    sync uses it), a leftover demo row never binding, adopting an OAuth row
    (OAuth then sees lost access), revoked keys forgotten mid-session, a
    read-only key turned read-only after one refused write (a per-issue refusal
    stays per-issue), a bulk edit stopping with `read_only`, live runs by Chloe
    and Ben with their own keys and their own views, nothing unattended, the
    issue page reading with the viewer, expiry, restart and sign-out, signing
    out everywhere from a browser whose own connection ended (idle, evicted, the
    time limit) and from an unknown token (`known: false`), the reader gateway
    never writing, a guest alone (`no_reader`), a reader Linear makes a guest
    (the read is thrown away and the next member reads; alone, nothing replaces
    the mirror) and a member the mirror shows as a guest, run and audit entries
    failing closed when the reader changes, key-shaped text refused unless
    already there, the status holding no key, and a scan of every table, log
    line and returned value for the test keys after each case.
  - worker: `apiKeyModeOutcome` per command, and through `run.ts` with
    `LINEAR_AUTH=api_key`: `tick` and `serve` print the note and exit 0, `sync`,
    `daily`, `allocate` and `warn` exit 1 with the sentence, neither boots, and
    `migrate` boots, over the real engine too with a deployed environment and no
    workspace pin.
  - planner: `test/api-key-connect.test.ts` (`handleConnect`'s order: another
    mode 404 with the body unread, loopback-only with a test endpoint, the CSRF
    guard, `Origin: null` and non-form bodies, plain HTTP behind https, a 4 KiB
    body, every engine failure's code, both cookie names and their attributes,
    the per-IP and global windows keyed on `X-Real-IP`, 100 concurrent posts
    with Linear held: 10 reach it, a person elsewhere still connects; a clean
    client served after others filled the global window; a try that does not
    count taken back), `test/api-key-auth-routes.test.ts` (logout on every
    device, an unknown or missing cookie landing on `signed_out=ended`, the
    OAuth routes redirecting), `test/workspace-routes.test.ts` (the resync
    answer carries no counts), `test/http-api-key.test.ts` (`no_reader` 503, the
    401 sentence), `test/proxy.test.ts` and `test/security-headers.test.ts` (the
    nonce policy only in api_key mode, a fresh nonce per page, API routes and
    prefetches skipped), `test/api-key-render.test.tsx` (the connect form, the
    notices, the three Status rows, the read-only-key notice, the key-refusing
    inputs), `test/api-key-routes-demo.test.ts` (the real route files over a
    real api_key engine whose gateway talks to the e2e's fake Linear in-process:
    an edit with the member's key, a replayed cookie after sign-out 401, a
    read-only key, a guest alone 503 `no_reader`) and
    `test/no-key-leak-static.test.ts` (no `'use server'` module mentions
    `apiKey`, no code assigns `process.env`, the connect form is a Server
    Component, every inline script carries the nonce, the image's
    `--disable-sigusr1` and `ulimit -c 0`, no `instrumentation.ts` or
    `middleware.ts`).
  - browser (`e2e/api-key.e2e.ts`, `playwright.api-key.config.ts`, moon
    `planner:test-e2e-api-key`, a CI target): the production build in api_key
    mode against a local fake Linear GraphQL server
    (`e2e/fake-linear-server.ts`, refuses to start without `FAKE_LINEAR=1` or in
    production; on `E2E_PORT + 1`; a fictional org with members, a guest, a
    private team and keys that are member, second, read-only, revoked, other org
    and guest), with no traces, videos or screenshots kept: the connect form (a
    password field, framing refused, every script nonced), a bad shape, a
    revoked key, a member connecting (My week, the session cookie, Settings →
    Status), an edit that reaches the fake with that member's key, a key pasted
    into the address bar dropped by the proxy before the page renders, another
    workspace refused without naming this one, a read-only key refused once by
    Linear and then by the planner, per-viewer visibility, sign-out on every
    device (and a second sign-out with the stale cookie landing on
    `signed_out=ended`, "Already disconnected", never "every browser"),
    cross-site, `Origin: null` and multipart posts refused, the eleventh failure
    from one `X-Real-IP` limited while another connects, and no test key (or a
    fragment of one) in any response, the server log, the build output or the
    fake's request log (keys travel only in its `Authorization` header). Then
    `e2e/scan-api-key-leaks.ts` scans every file the server wrote under
    `E2E_ARTIFACTS_DIR` (the PGlite directory, `server.log`, the server's
    `TMPDIR`) byte by byte, and every table of that database through SQL (a byte
    scan alone would miss TOAST-compressed jsonb).
- image: CI's `image` job builds `deploy/Dockerfile` and starts both services
  from it in demo mode (the web app must answer `/api/health`, the worker's
  `tick` must exit 0).
- ui: component tests with happy-dom (`packages/ui/test`), the stylesheet scope
  guard (`styles-scope.test.ts`), and `ui:typecheck-host`: the source under a
  host's looser flags (`tsconfig.host.json`, not strict, like Dispatch's
  `apps/desktop`).

## 12. Verified external facts

See `docs/research.md` (generated from the research pass with sources). The
personal-API-key facts this design relies on (F1–F14, checked 2026-10-23) are
summarised in §4.1 "Personal API keys" and sourced in `docs/research.md`
"Personal API keys (2026-10-23)", with the points still unverified: how Linear
refuses a Read-only key's write, the key body's format, whether a
team-restricted key can read `initiatives`, and whether Linear's error text can
ever echo a credential.
