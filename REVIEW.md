# Review Instructions

Review-only guidance for Claude Code Review. General conventions live in
`AGENTS.md` and `.agents/skills/`; flag violations of those as usual.

## What counts as Important

Reserve Important for changes that break builds, tests, publishing, or CI for
other contributors, weaken a supply-chain guard, or silently change behavior of
a published package. Everything else is a nit.

## Always check

- **Dependencies go through the catalog.** A version string (anything other than
  `catalog:` or `workspace:*`) in a package-level `package.json` is wrong unless
  the package is published and the range is intentional.
- **New dist-producing packages are wired in.** A new package under `packages/`
  or `apps/` must appear in the root `moon.yml` `dependsOn` list and the root
  `tsconfig.json` `references`. Missing `dependsOn` lets `root:lint` run before
  the package is built.
- **No cross-package tsconfig `references`.** Workspace imports resolve through
  each dependency's built `dist`; a `workspace:*` dependency is all that is
  needed.
- **Tool pins move together.** moon must match in `.prototools`,
  `.moon/workspace.yml` `versionConstraint`, and the `@moonrepo/cli` catalog
  entry. pnpm must match in `.prototools` and `package.json` `packageManager`.
  node must match in `.prototools` and `.node-version`.
- **moon `runInCI` rules.** `runInCI: 'always'` is only safe for tasks with no
  graph edges (no `deps`, no dependents). A task connected to the build graph
  with `'always'` gets pulled into every `moon ci` run.
- **`package.json` scripts are lifecycle hooks only.** New build, test, or lint
  entry points belong in a `moon.yml` task.
- **`minimumReleaseAgeExclude` additions need a reason.** Exempting a package
  from the 7-day release-age policy should be limited to toolchain packages that
  are already exempt as a family (moon, rolldown bindings, `@types/bun`).
- **Hooks stay safe.** Changes to `.claude/hooks/` or `.moon/workspace.yml` git
  hooks must not fail on machines missing optional tools, and the PostToolUse
  formatter must never block an edit.

## Do not report

- Formatting, import order, or lint findings: oxfmt and oxlint enforce these.
- Type errors and failing tests: CI runs typecheck and tests on affected
  projects.
- Unpinned GitHub Actions: the `actions-pinned` CI job enforces SHA pins.
- Contents of `pnpm-lock.yaml`, beyond checking it changed alongside the
  manifests that require it.
