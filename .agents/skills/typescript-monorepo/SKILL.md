---
name: typescript-monorepo
description:
  Use when adding or changing packages/apps, TypeScript configs, workspace
  dependencies, package references, exports, or monorepo project-reference
  relationships.
---

# TypeScript Monorepo

## TypeScript

Use TypeScript everywhere practical. Compiler settings are intentionally fairly
strict.

- Shared compiler options live in `tsconfig.options.json`.
- Root `tsconfig.json` manages project references across the monorepo.
- Typechecking uses TypeScript 7 (`tsc`, the native compiler) and runs through
  moon: `moonx <project>:typecheck` (moon builds workspace dependencies first,
  since types resolve through each dependency's built dist).

## Adding a Package

Copy `packages/template` and wire the copy into four places. Example for a new
library `@template/utils`:

```bash
cp -r packages/template packages/utils
rm -rf packages/utils/dist packages/utils/node_modules packages/utils/*.tsbuildinfo
```

1. `packages/utils/package.json` — set `"name": "@template/utils"`.
2. `packages/utils/moon.yml` — keep `language`, `layer`, and `tags`; shared
   tasks come from `.moon/tasks/*.yml` via tags or project language. The moon
   project id is the directory name (`utils`), so tasks run as
   `moonx utils:test`.
3. Root `moon.yml` — add `'utils'` to `dependsOn`. Type-aware lint resolves
   workspace imports through built dist, so every dist-producing package must be
   listed or `root:lint` can run before it is built.
4. Root `tsconfig.json` — add `{ "path": "packages/utils/tsconfig.json" }` to
   `references` (editor/project discovery only; tasks do not use it).

Then run `pnpm install` and `moonx utils:build utils:typecheck utils:test`. Apps
follow the same steps under `apps/`.

## Depending on Another Workspace Package

Cross-package imports resolve through the dependency's published `dist`, not
through TypeScript project references, and moon builds dependencies first via
`deps: ['^:build']`. So when `@template/app` imports `@template/utils`:

- Add `"@template/utils": "workspace:*"` to the consumer's `package.json` and
  run `pnpm install`. moon infers the project dependency from it.
- Do not add a `references` entry between the two package tsconfigs.

## Workspace Dependencies

Use the `pnpm-workspace.yaml` catalog rules from `tooling-and-dependencies` for
external packages. Use `workspace:*` for internal package dependencies.

If a package is published, review its `exports`, `typesVersions`, `files`, peer
dependencies, and its moon `prepublish` task chain before changing public
entrypoints or dependency ranges.
