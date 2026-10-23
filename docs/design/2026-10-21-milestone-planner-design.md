# Milestone Planner — design

Status: draft for Wyat's approval · 2026-10-21
Working name: **Milestone Planner** (placeholder; naming is open)

## 1. Why this exists

On 2026-10-21 a workspace-wide audit of the team's Linear found ~115 open issues that
were already done, superseded, duplicated or empty, and live projects quietly
slipping: the Orion migration had ten issues past their due dates with nobody
assigned and nobody notified, three HALO "Urgent" issues were five weeks overdue, and
Triage had become a second backlog.

Wyat's diagnosis, in his words: issues sit in **"backlog forever and things fell
through."** The team already sets a priority on every initiative and project and tried
putting dates on milestones so that work would "basically have auto task allocation" —
but nothing performed the allocation, so it never happened. Nobody owned noticing a
slipping date; "we just hoped people would pick them up." He also said Linear's UI
"does not suit our needs," and that there is "not a good rubric for the milestones."

The fix is a tool that **does the allocation and the noticing**, and gives two
audiences a screen that fits how they actually work.

## 2. Goals

1. **My week.** Each person opens one screen and sees *their tasks for this week,
   sorted by milestone due date* (Wyat's words).
2. **PM milestone timeline.** A PM can *easily see and edit milestones* and *weight
   things by due dates and priorities* (Wyat's words). Layout: a **timeline**
   (Wyat picked it over an editable table as "good-ish" — the shape is right, the
   details are open). *(Since the owner decision of 2026-10-22, §12, there is no
   PM role: everyone signed in sees and edits it.)*
3. **Dependency graph.** "Better graphs/visuals for how things rely on others — like
   mermaid" (Wyat's words): see which issues and milestones block which.
4. **Auto-allocation.** Unassigned issues go to **whoever owns that project**, and an
   owner receives **only what's needed for the project's next milestone** — not the
   whole backlog.
5. **One-week warning.** When a milestone is at risk, **the project owner, Wyat, and
   Shanzer** are told **a week ahead** of its due date.
6. **A milestone rubric**, so "milestone" means the same thing everywhere and every
   milestone has what the automation needs (see §6).

## 3. Non-goals (v1)

- Replacing Linear. **Linear stays the source of truth "right now"** (Wyat). Issues are
  created, described, discussed and closed in Linear as today.
- ~~Editing issue titles/descriptions, comments, labels, estimates.~~
  **Superseded 2026-10-21 by an owner decision** (§12): every signed-in person can
  edit an issue, and read and add comments, from the planner.
- Time tracking, capacity planning by hours, sprint/cycle management.
- Being a portal page (see §4).
- Multi-tenant SaaS. Productization is a stated future possibility; v1 serves this one
  Linear workspace, but must not make productizing harder (see §4).

## 4. Anti-goals — it fails even if it "works" when…

- It becomes **another place things rot**: a second backlog, or a dashboard nobody opens.
- Auto-allocation **dumps work** on people (the whole backlog, or issues outside their
  project) — that recreates the noise it was meant to remove.
- Warnings become **spam** people mute. One week ahead, to three people, only when at risk.
- It **fights Linear**: writes that surprise people in Linear, or data drifting between
  the two.
- It **silently does nothing** when inputs are missing (no lead, no date) — that is
  exactly how the old process failed. Missing inputs must be loud.

## 5. Decisions made with Wyat

| Decision | Choice |
|---|---|
| Source of truth | Linear, for now |
| Where it lives | **Separate** from the intranet portal. Reasons (Wyat confirmed all three): keep engineering tooling out of a staff/advisor portal; may become its own product; ship faster than the portal's release cycle |
| Allocation rule | Project owner gets the unassigned issues of that project's **next** milestone only |
| Who is warned | Project owner + Wyat + Shanzer |
| Warning lead time | One week before the milestone due date |
| PM board layout | Timeline (draggable milestone bars along a date axis) |
| Dependencies | Must be visualized as a graph, mermaid-style |

*(2026-10-22, §12: there is no PM role any more. The "PM board" is the timeline
every signed-in person edits; "who is warned" stands, with Wyat and Shanzer as
configured watchers.)*

## 6. Builder's calls already made (my calls, not Wyat's — flagged for review)

These are sensible defaults chosen while writing; Wyat has not explicitly agreed to them.

1. **"Project owner" = the Linear project's *lead*.** A project with no lead is never
   allocated; it is flagged everywhere (timeline banner, PM view, warning digest).
2. **"Next milestone" = the project's open milestone with the earliest target date
   that is not complete.** When it completes (all issues done/canceled), the next one
   becomes "next" and its unassigned issues are released to the owner.
3. **Allocation moves issues Backlog → Todo** when it assigns them, so "assigned" means
   "ready this cycle." Issues already assigned are never reassigned. Issues in
   Triage are never auto-allocated.
4. **Issues with no milestone** are not allocated; they appear in a per-project
   "unplanned" bucket on the PM timeline so the PM attaches or cancels them.
5. **"At risk"** (drives the warning) = due within 7 days AND (any open issue
   unassigned, OR open issues > 0 with no state change in the last 7 days, OR the
   remaining-work ratio is worse than time remaining — e.g. 3/7 done with 2 days left).
   Overdue = past due with open issues. The exact formula is tunable.
6. **Weighting / sort order** everywhere: milestone due date first (nearest first, with
   overdue on top); ties broken by project priority, then issue priority, then age.
   A PM can set a per-milestone **weight override** (e.g. bump a milestone above its
   date order). Weight is stored by this tool (Linear has no field for it).
7. **Milestone rubric (proposed; Wyat to confirm):** a milestone is valid only if it has
   (a) a target date, (b) a one-line "done means…" outcome, (c) its project has a lead,
   and (d) at least one issue. The timeline shows each milestone's rubric status;
   invalid milestones are greyed with what's missing. Allocation and warnings skip
   invalid milestones but report them.
8. **Warnings go to Slack DMs** (the team already runs on Slack; #tech-requests feeds
   Linear) plus a red marker in the app. One digest per person per day, not one
   message per issue.
9. **Users:** everyone in the Linear workspace can see "My week" and the timeline;
   ~~only designated PMs (initially Wyat and Shanzer) can edit dates, weights and
   owners. PM list is a setting, not hard-coded.~~
   **Superseded 2026-10-22 by an owner decision** (§12): there is no PM role and
   no PM list; every signed-in person can edit dates, weights, owners, "done
   means…" and settings. The watcher list (initially Wyat and Shanzer) stays a
   setting, not hard-coded.
10. **Sign-in: "Sign in with Linear" (OAuth).** Your Linear identity is who "My week"
    is for, and it's the only thing a future customer would need — keeps productizing
    open. No portal accounts.
11. **An invalid or stuck "next milestone" blocks its project; it never skips ahead.**
    If the earliest open milestone fails the rubric, allocation stops for that project
    and the failure is reported loudly (timeline banner, PM digest), so nothing
    from a later milestone gets handed out early. A milestone that passes its date with open
    issues stays "next", goes overdue, and keeps escalating in the warnings until it
    is closed out or re-dated.
12. **"Reversible" means logged, not a one-click undo, in v1.** Every allocation writes
    a Linear comment and a run-log entry, which together are enough to undo it by hand. Dry-run
    comes first. An undo button is a possible v2.
13. **The weight override only changes sort order on screen.** It never changes
    which milestone counts as "next" for allocation or warnings. Those follow Linear's
    dates, so the tool can't drift from Linear on anything that drives a write.

## 7. What it does

### 7.1 My week
Per signed-in user. Sections = milestones that contain the user's open issues, ordered
per §6.6; each section header shows project › milestone, due date, progress (done/total)
and a risk color. Rows = the user's issues in that milestone (id, title, priority,
state), each opening in Linear. Issues assigned to the user that belong to no
milestone appear in a final "No milestone" section. Newly auto-allocated issues are
marked "new — given to you because you lead <project>."

### 7.2 PM timeline
*(Superseded in part 2026-10-22, §12: "PMs can" below now reads "everyone signed
in can"; the two Linear writes need that person's one-time write grant. The
original text is kept.)*

Horizontal date axis (default: 2 weeks back → 10 weeks ahead). One lane per project
(grouped by initiative, ordered by priority); each milestone is a bar ending at its due
date, showing owner, progress and risk color. PMs can:
- drag a bar's end to change the milestone date (writes the date to Linear);
- set/clear a weight override;
- set the project lead (writes to Linear);
- open a milestone to see its issues and rubric status, and fill in "done means…".
Banners: projects with no lead; milestones with no date; issues with no milestone
(counts, click to list).

### 7.3 Dependency graph
*(Extended 2026-10-22, §12 "graphs at every level": four zoom levels instead of
two — initiative, project, milestone and issue — each drawn for the whole
workspace or inside one initiative, project or milestone, plus one issue's
blocking chain. The original text is kept.)*

Rendered from Linear `blocks`/`blocked by` relations, as a mermaid-style directed graph.
Two zoom levels: **milestone level** (milestone A depends on milestone B if any issue in
A is blocked by an issue in B) and **issue level** within a milestone or project.
Highlights: chains ending in an unassigned or overdue issue; blockers in a different
project/owner; cycles. Reachable from the timeline (click a milestone → "what does this
wait on?").

### 7.4 Auto-allocation (scheduled)
*(2026-10-22, §12: "on demand by a PM" now means on demand by anyone signed in,
and anyone can switch it live in Settings, audited; it still starts in dry run.)*

Runs daily (and on demand by a PM). For each valid "next milestone" whose project has a
lead: every open, unassigned, non-Triage issue in it is assigned to the lead and moved to
Todo, with a Linear comment: "Assigned by Milestone Planner: you lead <project> and this
is in its next milestone <name>, due <date>." Produces a run log (what it assigned, what
it skipped and why). A **dry-run mode** shows what it would do; v1 ships with dry-run
on until Wyat switches it live.

### 7.5 One-week warnings (scheduled)
Daily. For each milestone that becomes at risk (§6.5) or overdue, notify the project
lead, Wyat and Shanzer once (not again until its status changes or it goes overdue).
The message names the milestone, due date, what's open, what's unassigned, and links to
the timeline. Also notify when a milestone has a date inside 7 days but fails the rubric.

### 7.6 All issues
*(Added 2026-10-22 by an owner request, §12.)* One page lists every issue the person
can see (open by default), filtered by initiative, project, milestone, assignee, team,
status, priority, text, blocked, at risk and next milestones, with tabs for All, Mine,
Unplanned, Unassigned, Blocked and At risk. It is ordered by the weight rule of §6.6
(active projects' milestones first, overdue on top, then the weight override, due date
and project priority; inside a milestone, issue priority then age; then unplanned
issues, issues with no project, and paused projects last) or by priority, the issue's
due date, last update, creation or title. It is grouped by milestone, project,
initiative, assignee, status or priority, optionally inside initiative or project
sections. Issues move to a milestone (and so to its project), a person, a status or a
priority one at a time or up to 100 at once, by menu, keyboard or drag, with an Undo.
Every move is an issue edit (§12, 2026-10-21) made with the mover's own Linear token
and audited per issue. Issues are still created in Linear.

## 8. Data and integration with Linear

- **Reads:** issues (state, assignee, priority, milestone, project, relations,
  updatedAt, due date), projects (lead, priority, initiative), milestones (name,
  target date, description), users, initiatives. *(The issue's due date is read
  since 2026-10-22, for the list of every issue.)*
- **Writes (only these):** issue assignee + state (allocation), issue comment
  (allocation note), milestone target date, project lead. Everything else is read-only.
  *(Extended 2026-10-21 by an owner decision, §12: a signed-in person's own issue
  edits, comments and blocking relations, always made with that person's Linear
  token. The automatic writes are unchanged.)*
- **Owned by this tool (not in Linear):** milestone weight override, "done means…" text
  if Linear's milestone description is not used for it, PM list, warning history,
  allocation run log. *(2026-10-22, §12: the PM list is gone; the watcher list
  and the audit log of who changed what are owned here instead.)*
- **Freshness:** Linear webhooks for changes + a periodic full resync to heal drift.
- Linear access via an OAuth app installed on the workspace (allows acting as the app
  for automation and as the signed-in user for PM edits — since 2026-10-22, §12,
  for everyone's edits).

## 9. Constraints

- **Repo:** lives in this monorepo as its own app (`apps/<name>`), following AGENTS.md
  (pnpm only, moon tasks, kebab-case files, no `any`, project Logger, `PrivilegesEnum`
  n/a since this app has its own auth). May reuse `packages/ui` and the `--wg-*` tokens so
  it looks like a sibling of the portal; must not depend on the portal's API or database.
- **Deploy:** its own Railway service and subdomain; independent release cadence.
- **Productization-friendly:** keep the Linear workspace id as a parameter, not a
  constant; no Waggoner-specific names in core logic (Wyat/Shanzer are configured
  PMs/watchers, not code; since 2026-10-22, §12, watchers only).
- **Safety:** auto-allocation must be idempotent, logged, reversible (the comment and run
  log say what changed), and start in dry-run.

## 10. Left to the builder

Stack and framework for the app; storage for the tool-owned data; graph rendering
library (mermaid itself or a mermaid-like library with interaction); exact timeline
interaction details; webhook vs polling balance; Slack delivery mechanism (bot token vs
webhook); exact at-risk formula tuning; naming.

## 11. Open questions for Wyat (not blocking a plan)

- Final name.
- Confirm the milestone rubric in §6.7.
- Whether anyone beyond engineers + Shanzer should see the timeline in v1.
- *(Added 2026-10-22 with the list of every issue, §7.6 and §12; the build goes ahead
  with each default and changes if the answer differs.)*
  - **Q1. Project and initiative weights.** Reorder projects or initiatives from the
    planner? Default: no; Linear's priority and manual order rank them. If yes:
    either a planner-only weight (order on screen only), or writing Linear's project
    priority (a new Linear write, so this document changes first).
  - **Q2. Name.** "Issues" (Linear's and the planner's word), with `/tasks` leading
    there, or "Tasks" on screen? Default: Issues.
  - **Q3. Phone tab bar.** Issues takes Graph's place, Graph moves into More?
    Default: yes.
  - **Q4. Priority-first order.** Should project priority outrank the milestone date
    ("an urgent project's later milestone before a low project's sooner one")?
    Default: no, §6.6 as written; if yes, a second "Priority order" sort is added.
  - **Q5. Paused projects last.** Issues of paused or not-started projects sort after
    all active work, unplanned work included (My week instead interleaves them under
    Later). Default: last.
  - **Q6. Bulk safety.** 100 issues per change, a confirmation at 20 or more or for a
    drag across projects, and Undo for 8 seconds. Default: as stated; the
    alternative is no confirmation, relying on Undo and the audit.
  - **Q7. Labels in the first version?** Default: no; they come next.

## 12. Owner decisions

### 2026-10-21 — everyone edits issues from the planner

Decided by the product owner. It supersedes the §3 non-goal "Editing issue
titles/descriptions, comments, labels, estimates" and extends the §8 "Writes (only
these)" list; the original text above is kept for the record.

- **Every signed-in person** (not only PMs) can edit an issue from the planner:
  title, description, status (workflow state), assignee, priority, labels,
  estimate, due date, project, project milestone, and blocking relations (add or
  remove "blocked by" / "blocks"). They can read the issue's comments and add
  their own.
- These edits are made with **that person's own Linear OAuth token** (actor=user,
  the existing "grant write access" upgrade, now offered to everyone, not only
  PMs). Linear's own permissions therefore apply, and Linear's history credits the
  person, never the planner's app user.
- The planner's only **automatic** write stays allocation: assignee + state and one
  comment per allocated issue (§7.4).
- PM-only edits are unchanged: milestone target date, project lead, weight
  override and "done means…". *(Superseded 2026-10-22, below: there are no
  PM-only edits any more.)*
- Linear stays the source of truth: every edit goes to Linear first and the
  planner's copy follows.
- Where (as built): each issue has a page in the planner and opens in a
  slide-over from My week, the timeline's milestone drawer and the
  dependency graph; My week's rows and the command palette now open the
  issue there instead of in Linear (§7.1 said "each opening in Linear"),
  and Linear stays one click away from every one of them.

### 2026-10-22 — no PM role

Decided by the product owner, in their words: "Don't do any PM distinction. All
devs are basically PMs now." It supersedes the PM list in §6.9, the "PMs can" of
§7.2, "on demand by a PM" in §7.4 and the "PM-only edits are unchanged" bullet of
the 2026-10-21 decision above; the original text is kept for the record and
marked where it stood. Wherever this document still says "PM" as a role, read
"anyone signed in".

- **There is no PM role.** Every signed-in person can do everything a PM could:
  change a milestone's target date, a project's lead, a milestone's weight
  override and "done means…", every workspace setting (modes, people, schedule,
  tuning), start a dry run or (when allocation is live) a live run, resync from
  Linear, preview the digests, and view anyone's My week. Nobody is refused for
  not being a PM, and the PM list, its "last PM cannot be unchecked" rule and
  the `PM_EMAILS` bootstrap are gone. *(Narrowed the same day for Linear guests, who
  are read-only: "guests are read-only", below.)*
- **Watchers stay.** The people warned about every at-risk milestone besides its
  lead (§5 "who is warned": Wyat and Shanzer, as configured watchers) are a
  setting. They are first set from `WATCHER_EMAILS`; if that names nobody, the
  person who installed the app becomes the first watcher (before, the installer
  became the first PM and the watchers defaulted to the PMs). The list may be
  emptied; then only each project's lead is warned.
- **Linear writes stay the person's own.** An edit that writes to Linear
  (milestone date, project lead, issue edits) is made with the editor's own
  token, so it still needs their one-time "grant write access", now offered to
  everyone. Planner-only edits (weight, "done means…", settings, runs, resync,
  digest preview) need only a signed-in session.
- **The audit log matters more.** With everyone able to change everything, every
  edit and every settings change keeps its audit entry (who, what, before and
  after), and Settings → Audit stays open to everyone signed in.
- **Allocation is unchanged.** It stays the only automatic write, and it stays
  in dry run until someone switches it live in Settings → Modes; anyone may now
  make that switch, and the switch is audited.

### 2026-10-22 — guests are read-only

Decided by the product owner, in their words: "Guests limited to read only." It
narrows the "no PM role" decision above (and the 2026-10-21 one) for one kind of
person; nothing else in them changes.

- **A Linear guest can look but not change anything.** A guest (Linear's own
  `guest` flag on the user, as the mirror holds it) may sign in and see what
  Linear lets them see (per-viewer visibility, unchanged: only the teams they
  belong to, no initiatives), including My week, the timeline, projects, the
  graph, runs, settings and the issues of their teams in the slide-over and on
  the issue page. Through the planner they change nothing: no issue edits,
  comments or blocking relations; no milestone target date, project lead,
  weight or "done means…"; no settings in any section; no runs, dry or live; no
  resync; no digest preview (it is computed from everyone's digests); and no
  write grant (the planner never asks Linear for write access for a guest and
  never keeps one). Navigation, the command palette's Jump to and navigation,
  and the theme switch stay.
- **It is Linear's distinction, not a role.** There is still no PM role and no
  planner-side list of who may do what: the one permission distinction in the
  app comes from Linear's guest flag. Someone the planner's copy of Linear does
  not know yet is treated like a guest until it does, as visibility already
  treats them.
- **Enforced on the server.** The engine refuses a guest's change before
  anything is read or written, and the routes refuse it before the request is
  looked at; the screens simply offer a guest no edit controls, run buttons or
  "Allow edits in Linear" links, and say once, quietly, where those would be:
  "You are a guest in Linear, so this view is read-only." The user line in the
  sidebar says "Guest".
- **Demo mode** has one guest, Gus Hart (a member of Operations only), so the
  read-only planner can be tried; the demo picker labels him Guest.

### 2026-10-22 — graphs at every level

Decided by the product owner, in their words: "The graphs need to be available
all the way from initiative to individual issues." It extends §7.3 (two zoom
levels); nothing else changes.

- **Four levels.** The dependency graph is drawn at the initiative, project,
  milestone or issue level, for the whole workspace or inside one initiative (or
  the projects with none), one project or one milestone; each offers the levels
  finer than itself. Above the issue level a box waits on another when an open
  issue in it is blocked by an open issue in the other, and the arrow counts how
  many.
- **One issue's chain.** Every issue can be drawn with everything it waits on
  and everything waiting on it, through open issues.
- **Reachable from where people are**: the timeline's initiative groups and
  toolbar, a milestone's drawer ("what it waits on"), the projects register, and
  every issue. Every existing graph link keeps its meaning; `/graph` still opens
  on milestones.
- **Read-only**, like every graph: it writes nothing to Linear. Guests see no
  initiatives in Linear, so their graphs cover every project they can see, and
  the page says so.

*Builder's calls, flagged for review:*
- a project in several initiatives counts under the first, as on the timeline
  (the page names it in the others);
- an arrow between projects or initiatives, and now between milestones too, is a
  risk chain only when a blocking issue it summarises is unassigned, overdue or
  waits on one (before, any risk in the blocking milestone counted);
- inactive projects are drawn quietly at every level;
- graphs over 200 boxes or 300 arrows are not drawn; the page offers narrower
  ones;
- a chain shows the nearest 150 issues;
- an initiative or a project whose boxes block nothing still lists them, each
  opening its own graph, so every level stays reachable from the one above it.

### 2026-10-22 — every issue in one list

Requested by the product owner, in their words: "Need good and intuitive ways to see
all tasks then filter by projects and initiatives and milestones and order by weight
based on those and easily group things and move them to milestones and stuff."

- **One Issues page** (`/issues`; `/tasks` leads there) to see, filter, order by
  weight, group and move every issue the person can see (§7.6). It is in the sidebar
  after My week, in the phone tab bar in Graph's place (Graph moves into More), and in
  the command palette ("G I"). My week links to it ("All my issues"), and so do the
  timeline's milestone drawer and unplanned banner, the projects register and the
  graph.
- **Moves are the issue edits of 2026-10-21** (project, milestone, assignee, status,
  priority), made with the person's own Linear token, so the §8 write list does not
  change. Linear guests are read-only here as everywhere. Nothing creates, deletes or
  archives issues, changes an issue's team or reorders issues by hand.
- *Builder's calls, flagged for review* (the open questions are Q1–Q7 in §11):
  - paused projects' work sorts after all active work;
  - unplanned issues of active projects sort before paused projects' milestones;
  - no planner-owned project or initiative weight (Linear's priority ranks them);
  - at most 100 issues per bulk change;
  - a confirmation at 20 or more issues, or for a drag that changes a project;
  - Undo from the confirmation message;
  - labels and estimates come later (the planner's copy of Linear does not hold them
    yet);
  - a list view only (a board comes next).
- **As built**: the page itself (every view is a link that can be shared,
  bookmarked and restored with Back and Forward), its filters, tabs, sorts and
  groupings, the issue slide-over and the links into it; and moving issues from it:
  a cell's picker for one issue, a row's menu and keys (M, A, S, P), a selection with
  the bulk bar, and dragging rows onto another group, each with a confirmation at 20
  issues or more (or for a drag across projects), a toast that says what happened
  (including what allocation will now do), and Undo. A milestone group's menu raises
  or lowers its weight, which changes only the order on screen. Settings → Audit
  shows a bulk change as one line per field ("2 issues · milestone").
