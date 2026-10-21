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
   details are open).
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
- Editing issue titles/descriptions, comments, labels, estimates.
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
   only designated PMs (initially Wyat and Shanzer) can edit dates, weights and
   owners. PM list is a setting, not hard-coded.
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
Rendered from Linear `blocks`/`blocked by` relations, as a mermaid-style directed graph.
Two zoom levels: **milestone level** (milestone A depends on milestone B if any issue in
A is blocked by an issue in B) and **issue level** within a milestone or project.
Highlights: chains ending in an unassigned or overdue issue; blockers in a different
project/owner; cycles. Reachable from the timeline (click a milestone → "what does this
wait on?").

### 7.4 Auto-allocation (scheduled)
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

## 8. Data and integration with Linear

- **Reads:** issues (state, assignee, priority, milestone, project, relations,
  updatedAt), projects (lead, priority, initiative), milestones (name, target date,
  description), users, initiatives.
- **Writes (only these):** issue assignee + state (allocation), issue comment
  (allocation note), milestone target date, project lead. Everything else is read-only.
- **Owned by this tool (not in Linear):** milestone weight override, "done means…" text
  if Linear's milestone description is not used for it, PM list, warning history,
  allocation run log.
- **Freshness:** Linear webhooks for changes + a periodic full resync to heal drift.
- Linear access via an OAuth app installed on the workspace (allows acting as the app
  for automation and as the signed-in user for PM edits).

## 9. Constraints

- **Repo:** lives in this monorepo as its own app (`apps/<name>`), following AGENTS.md
  (pnpm only, moon tasks, kebab-case files, no `any`, project Logger, `PrivilegesEnum`
  n/a since this app has its own auth). May reuse `packages/ui` and the `--wg-*` tokens so
  it looks like a sibling of the portal; must not depend on the portal's API or database.
- **Deploy:** its own Railway service and subdomain; independent release cadence.
- **Productization-friendly:** keep the Linear workspace id as a parameter, not a
  constant; no Waggoner-specific names in core logic (Wyat/Shanzer are configured
  PMs/watchers, not code).
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
