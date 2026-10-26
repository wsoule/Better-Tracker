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
- ~~Multi-tenant SaaS. Productization is a stated future possibility; v1 serves this one
  Linear workspace, but must not make productizing harder (see §4).~~
  **Amended 2026-10-25 by an owner decision** (§12, "Several workspaces on one
  deployment"): one deployment may serve several Linear workspaces, closed to new ones
  unless the person who runs it admits them. Billing, a Slack bot per workspace and a
  listing in Linear's integration directory remain non-goals.

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
*(Extended 2026-10-22, §12 "graph highlights": every box says whether its work
can start; pointing at or selecting one traces what it waits on and what it
holds up; a switch picks Status, Risk or Critical path. The original text is
kept.)*
*(Corrected 2026-10-23, §12 "the graph shows every issue": each level draws
every item in its scope, not only those on a blocking relation; the relations
are the arrows, and boxes are framed by their milestone, project or
initiative. The original text is kept.)*
*(Extended 2026-10-23, §12 "lock on and drill down": a click locks a box so its
paths stay lit while you scroll, with an Open button beside it; a
double-click opens the box's own graph one level down. The original text is
kept.)*

Rendered from Linear `blocks`/`blocked by` relations, as a mermaid-style directed graph.
Two zoom levels: **milestone level** (milestone A depends on milestone B if any issue in
A is blocked by an issue in B) and **issue level** within a milestone or project.
Highlights: chains ending in an unassigned or overdue issue; blockers in a different
project/owner; cycles. Reachable from the timeline (click a milestone → "what does this
wait on?").

### 7.4 Auto-allocation (scheduled)
*(2026-10-22, §12: "on demand by a PM" now means on demand by anyone signed in,
and anyone can switch it live in Settings, audited; it still starts in dry run.)*
*(2026-10-23, §12: with personal API keys there is no daily run: allocation runs
only when someone signed in starts it, over what they can see, written with
their own key.)*

Runs daily (and on demand by a PM). For each valid "next milestone" whose project has a
lead: every open, unassigned, non-Triage issue in it is assigned to the lead and moved to
Todo, with a Linear comment: "Assigned by Milestone Planner: you lead <project> and this
is in its next milestone <name>, due <date>." Produces a run log (what it assigned, what
it skipped and why). A **dry-run mode** shows what it would do; v1 ships with dry-run
on until Wyat switches it live.

### 7.5 One-week warnings (scheduled)
*(2026-10-23, §12: with personal API keys no daily digest is sent; the warnings
are only previewed in Settings.)*
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
  *(2026-10-23, §12: with personal API keys there are no webhooks; the planner
  refreshes its copy on connect, on Resync and every 15 minutes while a
  workspace member is connected.)*
- Linear access via an OAuth app installed on the workspace (allows acting as the app
  for automation and as the signed-in user for PM edits — since 2026-10-22, §12,
  for everyone's edits). *(2026-10-23, §12: or, instead, each person's own
  personal API key, held only in the planner server's memory.)*

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

### 2026-10-22 — keep the current look; status colours

Decided by the product owner after comparing the current look side by side with
a restyle in Gr8r Studio's own look (rounded panels, warm greys, soft shadows),
in their words: "I like the left for the ui, just needs color updates." The
restyle was declined; it is kept on the branch `claude/ui-reskin` for reference
only. This refines the "risk color" of §7.1 and §7.2; nothing else changes.
*(The look part is superseded 2026-10-23, below: the Gr8r restyle is adopted
after all. The status colours stay as decided here.)*

- **The look stays exactly as it is**: layout, spacing, type (Geist with the
  mono uppercase labels), black hairlines, no radius, the hatching, the
  numbered block chrome and the ink floods on hover. Only colour changes, and
  only where something carries a status or a risk.
- **Status colours**: red for overdue and failed; amber for at risk, blocked and
  unassigned; green for on track and done; blue for in progress; grey for
  inactive. They apply to the status marks, dates, timeline bars, chips,
  alerts and the graph.
- **Purple stays for the brand, selection and links**, and stops meaning risk
  ("needs action" used to be the purple). The purple still marks what is new or
  unread, the selected thing, focus, and today.
- **Never by colour alone.** Every status keeps its shape (filled, hollow,
  outlined or hatched square) and its words, so the screens read the same to
  someone who cannot tell the colours apart, in either theme. Coloured text
  reads at 4.5:1 and coloured marks at 3:1 on their real background, light and
  dark.

### 2026-10-22 — graph highlights

Asked for by the product owner, in their words: "There needs to be different
highlights for the graphs as well, like paths and stuff showing what's unblocked
and not and everything." It extends §7.3; nothing else changes.

- **Every box says where it stands:** an issue is ready, blocked by N or done;
  above the issue level a box is clear, waiting on N, or has none ready. An
  arrow whose blocker (or waiting issue) is done reads "unblocked". The words
  are on every box, so the colours only repeat them.
- **Pointing at, focusing, tapping or selecting a box** lights what it waits on
  and what it holds up, in two styles, and marks what finishing it alone would
  unblock ("Ready next"; "Clear next" above the issue level). A line under the
  graph says it in words, and a box's panel lists both, transitively.
- **A switch** offers Status (the default), Risk (the earlier look) and Critical
  path: the longest chain of open blocking relations, or with a box selected
  the longest one through it, numbered. The choice is in the link and
  remembered on the device.
- **Read-only and per viewer,** like every graph: no Linear write, no new
  permission, nothing audited; it counts only what the viewer can see.

*Builder's calls, flagged for review:*
- Status is the default;
- "Ready" means nothing open blocks it, as far as the viewer can see (Triage
  and Backlog included);
- box paths follow box arrows (an arrow in and an arrow out may be different
  issues; the Issues level shows the exact chains);
- the critical path counts issues (or boxes), not estimates, and ties go by
  display order;
- an arrow into a closed issue reads "unblocked";
- a box is "stuck" (red) only when none of its open issues can start and a cycle
  inside holds some of them; boxes whose arrows merely form a cycle stay amber
  with their Cycle mark;
- on touch, the first tap traces and the second opens;
- the mode is remembered per device;
- Mermaid follows the chosen highlight;
- on the current look (§12 "keep the current look") a ready box is a thin green
  edge and a blocked one a heavier amber rule, with no tints; the waits-on path
  is the purple (a selection highlight, never a status), the holds-up path and
  the critical path ink.

### 2026-10-23 — the graph shows every issue, not only blocking ones

Owner, in their words: "the graph is there to show all issues not just blocking
ones". It corrects §7.3 and the two 2026-10-22 graph entries above; nothing
else changes.

- **Every item in the scope is drawn,** related or not: at the issue level
  every issue in the workspace, initiative, project or milestone the viewer
  can see, done ones included (faint, with their filled done mark), canceled
  and duplicate ones left out; above it every milestone, every project, every
  initiative (and the projects with no initiative). One issue's blocking chain
  stays a chain. The blocking relations are the arrows, as before.
- **Boxes sit in labelled frames by their parent,** so the unrelated ones pack
  together instead of piling into one long column: issues by milestone ("No
  milestone" per project), inside their project's frame when the graph spans
  projects; milestones by project; projects by initiative. A paused project's
  frame is quiet.
- **The list under the graph of boxes "with no blocking relations" is gone;**
  the counts say what is drawn ("51 issues in the workspace, 45 of them in 16
  milestones; 6 blocking relations").
- **An item on no relation at all reads "No dependencies"** and stays neutral,
  so a graph of every issue is not a sea of green; "Ready" (green) is for work
  in the blocking flow that nothing open holds up. Paths, the critical path and
  the three highlights are unchanged.
- **A graph draws up to 700 boxes and 1,000 arrows** (it was 200 and 300).
  Past that it still offers narrower graphs instead.

*Builder's calls, flagged for review:*
- the frames are dim hairlines with mono caps titles, in the current look;
- milestone frames nest in project frames whenever the drawn issues span more
  than one project (an outside issue's frame is dashed);
- at the issue level every relation between drawn issues is an arrow, closed
  ones dotted, so "No dependencies" means exactly "no arrow";
- an empty milestone is drawn faint like a complete one, but reads "No
  issues" and is counted apart ("1 complete · 1 with no issues"), never
  "Complete" (review fix below);
- a milestone box still names its project on its second line, inside that
  project's frame;
- above the issue level the open-issue counts say "can start", not "ready"
  ("38 open issues: 33 can start, 5 blocked"; a box's "4 open · 3 can start ·
  1 blocked"), because they include issues with no dependencies, which the
  Issues level does not call Ready;
- an arrow between frames runs round the other boxes in the frames it leaves
  and enters (it no longer cuts behind them); in a big, dense workspace long
  arrows between distant frames still cross boxes.

*Review fixes, same day (builder's calls, flagged for review):*
- **The box you are reading is purple.** Pointing at a box, focusing it with
  the keyboard or tapping it on a phone floods it in the purple, so the box
  whose paths are lit is never just one more ring; the legend's Paths row
  calls it "Reading". The selected box keeps its ink fill.
- **A relation between two paused projects is now an arrow** at the
  milestone, project and initiative levels, because both boxes are drawn; the
  timeline still leaves those connectors out, as before.
- **A box with no issues says so:** "No issues" in its panel and counted apart
  in the summaries, never "Complete" (it used to count a milestone with no
  issues, and for a guest one whose issues he cannot see, as complete).
- **Blockers with no box at this level are counted as issues:** "Waiting on 1
  milestone: Dual-write, and 2 issues with no milestone".
- **The highlight follows the page you are on:** Back and Forward show the mode
  each page had; a mode that came in a shared link carries on when you click a
  level tab, the trail or a panel link; a link that says Status keeps Status
  on a reload even when you usually use Risk; switching while an issue opens
  never cancels it.
- **The legend sits under the graph and keeps one height,** so the first
  screen is the drawing (above it, the legend pushed the canvas below the fold,
  on a phone entirely; 2026-10-23 showcase review) and switching the highlight
  never moves the switch, the drawing or what follows.
- **Hovering stays smooth on big graphs:** the rest of the graph dims at once
  instead of fading (about four times cheaper at the limit).
- **Large workspaces lay out in under a second** at the 700 boxes / 1,000
  arrows limit whatever their shape (they took up to 5 s with many projects,
  and a rare small project hung the server's render).
- Wording: "Nothing here waits on it" (something not drawn may still wait on
  it); under Critical path the hint says "show the longest chain through it".
- A box of two or three loose boxes lays them side by side, not in a column.

### 2026-10-23 — owner: adopt the Gr8r restyle after all

Decided by the product owner after seeing the before / after comparison of the
restyle declined on 2026-10-22, in their words: "I think we should go with that
reskin that you were proposing before." It supersedes the look part of the
2026-10-22 entry "keep the current look; status colours"; the status colours
of that entry stay.

- **The look is Gr8r Studio's**, as it already was for layout and interaction:
  warm neutral surfaces, soft low-contrast borders, 4–12px radius, soft
  shadows only on things that float (menus, the palette, the drawer, toasts),
  sentence-case Geist, Geist Mono only for ids and keys, round avatars, the
  Gr8r sidebar, palette, drawer and toasts. The black hairlines, mono capital
  labels, hatching, numbered blocks and ink floods on hover are retired.
- **The purple stays the one brand colour**, in the role Gr8r gives its accent:
  the primary button, focus, selection, progress, today, unread and links. It
  never means a status.
- **Status colours keep their meaning**: red for overdue and failed; amber for
  at risk, blocked, a missing input and unassigned; green for on track and
  success; blue for in progress and live; grey for paused and inactive. Only
  the drawing changes, to Gr8r's: tinted chips and alerts, small coloured dots
  on neutral pills, coloured text for dates and numbers, and milestone statuses
  as small diamonds. A finished milestone keeps a filled neutral mark with a
  tick, never a green fill next to a red one.
- **Dark mode is a soft dark** (the owner, same day: the old near-black was
  "too dark"): warm charcoal, nothing darker than Gr8r's own dark page.
- **Never by colour alone, readable everywhere.** Every status keeps its shape
  and its words; coloured text reads at 4.5:1 and marks, field edges and focus
  rings at 3:1, light and dark; high-contrast (forced colours) mode keeps every
  shape.
- **Built on today's screens, not merged.** The Issues view, the every-issue
  graph and its highlights, the showcase workspace and everything since the
  2026-10-22 restyle get the same look; behaviour, routes, keyboard paths and
  names do not change, and only copy that relied on capital letters is
  rewritten in sentence case ("Demo data", "Not found").

### 2026-10-23 — lock on and drill down

Owner, in their words: "In the graphs, I want to like 'lock on' to the thing
so it stays highlighted (along with its path) but I can still scroll. [...]
when I double click on the graph item, it should take me to that items graph so
I can quickly drill down", and then: "For the lock on, there must still be a
way to open it obviously". It extends §7.3 and the graph entries above. It was
built in the look of the day and is drawn in the Gr8r look of the entry above
since the two were merged (the same request asked for a lighter dark
background, which that restyle's soft dark answers).

- **A click locks a box** (a tap on a phone, Enter on the keyboard): it stays
  the box being read, with its paths, its "Ready next" marks and the line under
  the graph, while you scroll, drag, zoom, fit or switch Status, Risk and
  Critical path. Pointing at other boxes no longer moves the highlight (they get
  a faint outline, so they still look clickable). A locked box has its own
  mark beside the soft purple tint and ring a pointed-at box gets: four rounded
  corner ticks inside it, like a viewfinder locked on, so it never looks like
  the keyboard's focus ring.
- **Opening is one obvious click away:** a small floating strip rides the
  locked box with **Open** (the purple primary button), **Open graph** and an
  **×** to unlock, kept inside the visible graph when the box is near an edge; the line under the
  graph repeats them ("Locked on ENG-23 · Open · Open its graph · Unlock").
  A second click on the locked box opens it too, as before: an issue's
  slide-over, or a box's panel. Open always opens: pressing it when the
  panel already shows that box leaves it open (only the panel's × and Escape
  close it).
- **Unlocking:** Escape, a click on empty space (not the end of a drag), the ×,
  or clicking another box (which moves the lock there).
- **A double-click opens the box's own graph,** one level down, keeping the
  highlight: an initiative its projects, a project its milestones, a milestone
  its issues, an issue its blocking chain; a frame's title (a milestone,
  project or initiative frame) that frame's graph. When that graph would be
  empty or too big to draw it goes where the box's panel links go instead.
  Open graph on the strip and Shift + Enter do the same, so nothing needs a
  double-click.
- **The lock is in the link:** a reload, Back and Forward and a shared link keep
  it; Back from a graph you drilled into returns to the box you drilled from,
  still locked.

*Builder's calls, flagged for review:*
- a second click on a locked box that has a graph to drill into opens it after
  a short pause (half a second with a mouse, the longest usual double-click
  time; 300 ms for a tap), so a double-click never opens the panel on its way
  to the next graph; Enter and the Open button open at once;
- Shift + Enter on a box with no graph below it opens the box, as a
  double-click does there;
- the strip goes under the box, over it, or beside it (never on the side
  where the box's own arrows start, so it never hides the path you locked
  on), whichever covers the fewest words nearby; it stays clear of the
  critical path's step control and, on a phone, of the tab bar at the bottom
  of the screen;
- dragging the canvas from a box never leaves that box lit;
- a frame's title drills at the level being drawn: a project frame around
  issues opens the project's issues (not its milestones, which a double-click
  on the project's own box opens), and the frame of the page you are on opens
  the next level down within it;
- an issue on no relation drills to its milestone's issues; one with nowhere
  else to go has no Open graph;
- the lock is written into the address in place (Back never steps through
  locks) and carried on the graph's own links, where the next graph keeps it
  only if it draws that box; drill-down links never carry it;
- pressing on a box and dragging past a few pixels now pans the canvas too, and
  never locks;
- a screen reader hears "Locked on ENG-23 Typo tolerance." once, and the box's
  pressed state now means locked (it meant selected);
- Escape drops the lock first; a second Escape closes an open panel. It works
  from anywhere on the page (after dragging the canvas the focus is on the
  page, not on the graph), except where something nearer wants it: with the
  focus in an open panel the panel closes first;
- under Critical path a locked box keeps the frame where it is (switching to
  Critical path no longer jumps to step 1 of the workspace's path), and the
  step control walks the chain through the locked box;
- on a phone the strip's buttons are wider but no taller (26px), so it covers
  no more of the box below.

### 2026-10-23 — connect with your own Linear API key

Owner, in their words: "Also update it so I can just give my own api key. Dont
save it anywhere though make sure it is secure". It adds a way to reach Linear;
the OAuth app and demo mode stay as they are.

- **A third mode, `LINEAR_AUTH=api_key`,** chosen in the server's settings.
  OAuth (the default) and demo mode (`LINEAR_FIXTURE`) are unchanged.
- **Each person pastes their own personal API key** from Linear. It is held
  only in the planner server's memory and never saved (not in the database, on
  disk, in logs, the audit or the browser), logged or sent back. It is
  forgotten when the person signs out (on every device at once), after 2 hours
  without using the planner, 12 hours after connecting, and whenever the
  planner restarts or is redeployed; then they paste it again. Signing out
  does not revoke the key in Linear (Linear offers no way to); the person
  revokes it there when they stop using the planner.
- **Edits and comments go out with the person's own key,** so "always with
  their own Linear token" (2026-10-21) holds: Linear shows them as the author.
- **A Read-only key makes the person read-only, like a guest** (the same one
  guard). Linear does not say what a key may do, so the planner finds out when
  Linear first refuses one of that key's writes; from then on it refuses every
  change itself and says why.
- **Allocation keeps exactly its writes** (an issue's assignee and state, plus
  one comment), but in this mode it runs only when someone signed in starts
  it, over what that person can see, written with their key and so credited to
  them in Linear. Nothing is automatic: there is no daily run, no digests (the
  warnings are only previewed) and no webhooks. This narrows "the only
  automatic write" and adds no new Linear write.
- **The planner refreshes its copy of Linear** when someone connects, on
  Resync, and every 15 minutes while a workspace member is connected, reading
  with the key of the member who connected first (the one who chose the
  workspace) or else the earliest-connected member's; a guest's key never reads
  it, not even when Linear makes a connected member a guest (that key stops
  reading at once and the next member's reads). What that account cannot see (a private team it is not in) is missing for
  everyone until a wider key reads, and the run and audit logs then hide what
  the copy does not hold. With nobody connected the planner shows its last
  copy.
- **One workspace:** `LINEAR_WORKSPACE` fixes which (required on a deployed
  planner); locally the first member to connect chooses it. Keys of any other
  workspace are refused.
- **One planner instance,** since the keys live in that one server's memory.

*Builder's calls, flagged for review:*
- a key is checked once, when it is pasted (Linear is asked whose key it is);
  the paste form is a password field the browser is told not to save, and it
  posts only over HTTPS, from the planner's own page, with a limit on failed
  tries per address;
- the connect page says plainly that whoever runs the server could still
  capture a key, so people connect only to a planner they trust;
- Settings → Status shows when the person's key will be forgotten and whose key
  reads Linear (names, never keys), with "Forget my key and sign out";
- a key pasted by mistake into a comment, a title or a description is not sent
  to Linear, one typed into a search is not searched, and any address that
  holds one (pasted into the address bar, even a mistyped or made-up one) is
  opened without it, so no page shows it back (final stage, 2026-10-23: every
  address, not only real pages);
- the worker's scheduled jobs do nothing in this mode (its cron can stay; it
  exits at once).

*Fix-stage calls (2026-10-23), same entry, flagged for review:*
- signing out forgets the key in every browser even when that browser's own
  connection had already ended (idle, time limit, or connected in too many
  browsers): the planner remembers whose connection it was, without the key,
  for 12 hours. When it cannot tell (after a restart, or later), the page says
  the key may still be connected in another browser and how to forget it
  there, instead of claiming it was forgotten everywhere;
- a connect that fails after the key was checked (a database error) forgets
  the key again, so a person told it failed never leaves it behind;
- a guest who connects first never becomes "the member who chose the
  workspace": the first member to connect does, reading first and becoming the
  first watcher;
- failed connect tries are counted as they start, so many at once cannot slip
  past the limit, and the overall limit only refuses addresses that failed
  themselves, so one address cannot lock everyone out after a deploy;
- Resync's answer no longer carries counts of the whole copy, which could
  reveal the size of a private team the person is not in (all modes);
- a deployed planner must use the project's Postgres (`DATABASE_URL`); it
  warns at boot when it would keep its data on the container's disk.

### 2026-10-25 — Several workspaces on one deployment

Owner, in their words: "can i connect my work to this?" (they are an admin of
their work Linear workspace), "i need a feature to switch workspaces.", "i want
to make it so that anyone can use this eventually." and "I don't care about the
slack stuff at all. but do all of that stuff for the 'before strangers can use
it' except slack." It amends the §3 non-goal "v1 serves this one Linear
workspace".

- **OAuth mode only.** One deployment serves several Linear workspaces, and one
  browser holds a session for each and switches between them. API-key mode
  stays pinned to one workspace, and demo mode stays one fictional workspace.
- **Closed by default.** `LINEAR_WORKSPACES` lists the workspaces the planner
  serves (org ids or URL keys); unset, only workspaces already installed may
  sign in, so an existing deployment keeps working and nobody new gets in;
  `*` opens it to every Linear workspace. The person who runs the planner can
  also block a workspace. These gate workspaces, not people: they are not a
  permission distinction, and inside a workspace everyone signed in can still
  do everything (guests stay read-only). A workspace left off
  `LINEAR_WORKSPACES` is not served but nothing is deleted automatically; only
  the operator's remove, block or purge revoke or delete.
- **A switcher.** Switching only changes which of the browser's own sessions is
  active; it is not a write, so guests may switch. Adding a workspace signs in
  to whichever workspace is open at linear.app, so the planner says to open it
  there first.
- **Uninstall, then purge.** When an admin uninstalls the app in Linear (or the
  person who runs the planner removes a workspace), the workspace's sessions end
  and its data is deleted 30 days later unless someone reinstalls. When Linear
  only refuses the app's token (`grant_dead`, the cause unknown), nothing is
  ever purged automatically. The audit log and the run log stay "kept for good"
  for every active workspace (2026-10-22 decision unchanged); only the
  post-uninstall purge deletes them.
- **Operator commands instead of an operator screen.** The person who runs the
  planner lists, removes, blocks and purges workspaces with the worker's command
  line (an in-app screen would be a person permission distinction).
- **Public pages.** Privacy, terms and contact pages, readable without signing
  in, and plain copy for people from other workspaces.
- **Slack untouched**, except one fail-safe: one Slack bot is never used while
  more than one workspace may be served (every digest stays in the planner's
  outbox), and the planner promises Slack DMs only when a Slack channel is
  active. `WATCHER_EMAILS` likewise seeds watchers only in workspaces
  `LINEAR_WORKSPACES` names.

*Builder's calls, flagged for review:*
- a URL key in `LINEAR_WORKSPACES` (or in a block) is tied to the workspace it
  first matches, because Linear lets admins rename URL keys: afterwards it
  admits (or blocks) only that workspace, also after a rename and after that
  workspace's data is purged (the tie is kept, like a block);
- a workspace taken out of `LINEAR_WORKSPACES` after installing (also by a
  typo, or a URL key that no longer matches after a rename) is not served
  (sign-in refused, its people signed out, skipped by the worker) but keeps its
  installation, app token, sessions and data, and putting it back on the list
  restores it as it was; boot and every worker cleanup log a warn naming it and
  the fix (the lead engineer's call after the 2026-10-26 review, replacing
  "removed by the next cleanup"). A blocked workspace is still removed: a block
  is the operator's explicit act. When the only reason is a rename the planner
  has not seen yet (a URL-key entry not tied to any workspace), the worker's
  cleanup reads the workspace's current URL key from Linear (a few workspaces
  per tick, after its other work) and serves it again, and people who signed
  in under the new key stay signed in;
- a live allocation the operator starts by hand (`allocate --live`) runs in one
  named workspace and, where that workspace's Settings still say dry run, only
  with an explicit `--override-mode`, as the terms page says;
- a write grant (or an install) Linear issues for another workspace than the
  one it was asked for is refused and revoked, and the person is told to open
  the right workspace at linear.app;
- rate limits, in each web process's memory: per network address, 120 Linear
  sign-in starts (one address is often a whole office behind NAT, signing in
  together) and 60 workspace switches per 10 minutes and 100 refused webhook
  deliveries a minute; per session, 6 allocation runs and 20 digest previews per
  10 minutes and 300 other changes a minute. Never limited: Linear's sign-in
  callback (a refusal would waste its one-time code), the demo sign-in, a
  webhook Linear signed, and every sign-out (someone on the same network could
  otherwise make it fail and keep a session alive). The per-session limits apply
  with personal API keys and in the demo too;
- every page now carries a per-request nonce Content-Security-Policy in every
  mode (it was only with personal API keys), so an injected script cannot run;
- the privacy page is written from what the code stores and names Railway as
  the host; the terms are plain words, not legal advice. Both want an owner's
  read before strangers arrive.

### 2026-10-26 — the public pages are approved

The owner read the privacy, terms and contact pages as this deployment serves
them (OAuth mode, `OPERATOR_NAME` and `OPERATOR_EMAIL` set, no Slack) and
approved the wording: "Look fine, mark approved". This closes the 2026-10-25
call above that both "want an owner's read before strangers arrive". A change
to what the planner stores or writes still updates those pages in the same
change (`apps/planner/lib/adapters/public-pages.ts`), and a deployment run by
someone else still has its own wording reviewed (`docs/deploy.md` §5, step 7).
The owner also kept the bulk safety of Q6 (§11) as stated, and answered Q1:
the planner's own order (§6.6: milestone date first, then project priority,
issue priority and age, with the per-milestone weight override) is what they
want, because Linear's priority alone cannot say that an urgent milestone
ending tomorrow outranks an urgent one ending in three weeks. Nothing changes
and Linear's project priority is not written.
