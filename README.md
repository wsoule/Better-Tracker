# Milestone Planner

A planning layer over Linear that **does the allocation and the noticing**:

- **My week**: every person sees their open issues grouped by milestone and
  sorted by due date, with issues the tool just assigned to them marked "new —
  given to you because you lead <project>".
- **Timeline** for everyone (there is no PM role): one lane per project, grouped
  by initiative, with milestone bars you can drag to change the date in Linear.
  Each milestone shows its rubric status (target date, "done means…", project
  lead, at least one issue). Banners list projects with no lead, milestones with
  no date, and issues with no milestone.
- **Dependency graph**: which milestones and issues block which, mermaid-style.
  It highlights chains that end in an unassigned or overdue issue, blockers in
  other projects, and cycles. "Copy Mermaid" exports the graph.
- **Auto-allocation** (daily, dry run first): unassigned issues in a project's
  _next_ milestone go to the project lead and move from Backlog to Todo, with a
  Linear comment saying why. If a next milestone is invalid or stuck, allocation
  stops for that project and says so loudly. It never skips ahead to a later
  milestone.
- **One-week warnings**: when a milestone is at risk or overdue, the lead and
  the configured watchers get one Slack digest per day.

Linear stays the source of truth. The tool's only automatic write is allocation
(an issue's assignee and state, plus one comment). People write everything else
with their own Linear token: a milestone's target date, a project's lead, and
any issue's title, description, state, assignee, priority, labels, estimate, due
date, project, milestone and blocking relations, plus comments (design §12). The
product design is in
[`docs/design/`](docs/design/2026-10-21-milestone-planner-design.md). The build
spec is [`docs/architecture.md`](docs/architecture.md). Deployment steps are in
[`docs/deploy.md`](docs/deploy.md).

## Try it without Linear

Demo mode runs against a fictional, in-memory workspace. Every screen works,
including dragging dates and allocation runs:

```bash
pnpm install
scripts/build-all.sh --skip-planner
cd apps/planner && LINEAR_FIXTURE=1 ./node_modules/.bin/next dev
# open http://localhost:3000 and pick a demo user
```

`LINEAR_FIXTURE=showcase` serves a much larger version of the same fictional
workspace (21 projects, about 400 issues and 250 blocking relations), made for
the live demo; `1` is the small scenario workspace the tests pin. The graph
draws all of it at every level (see `docs/architecture.md` §4 "Showcase demo
workspace", "Draw budget").

To use real Linear without an OAuth app, set `LINEAR_AUTH=api_key`: each person
pastes their own personal Linear API key, which the planner holds only in memory
and never saves (`docs/deploy.md` §7).

## Layout

```
apps/planner    Next.js app (pages, OAuth, webhooks, edits)
apps/worker     scheduled jobs CLI (tick = resync + daily allocation/warnings)
packages/core   pure domain rules and view models (heavily tested)
packages/linear Linear GraphQL gateway, OAuth, webhook verification, demo workspace
packages/store  Postgres persistence (PGlite locally and in tests)
packages/notify Slack DM digests and the outbox
packages/engine orchestration used by both apps
packages/ui     portable React task UI (shell, task table, timeline, graph), no Next.js
packages/logger structured JSON logs
```

This repo derives from the Pierre TypeScript monorepo template. It uses pnpm
workspaces with a catalog, moon tasks, proto pins, oxlint/oxfmt/stylelint and
Bun tests. `AGENTS.md` and `.agents/skills/` describe the conventions.

```bash
proto use          # install pinned bun, pnpm, node, moon
pnpm install
moon run root:format root:lint
moonx :build :typecheck :test
moonx planner:dev --ignore-ci-checks
moonx planner:test-e2e   # Playwright smoke in demo mode (also runs in CI)
moonx planner:test-e2e-api-key   # the API-key mode against a fake Linear (CI too)
```

When moon cannot download its toolchain plugins, run the tools directly as
described in `AGENTS.md`, or use `scripts/build-all.sh`.
