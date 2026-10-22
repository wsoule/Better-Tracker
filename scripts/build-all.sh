#!/usr/bin/env bash
#
# Builds every workspace package and both apps in dependency order, without
# moon. moon is the task runner everywhere it can start; this script exists
# for container builds (deploy/Dockerfile) and sandboxes where moon cannot
# download its toolchain plugins (see "When moon cannot start" in AGENTS.md).
# Each step mirrors a moon task: <pkg>:build is `tsdown --clean`,
# planner:build is `next build`. pnpm derives the order from the workspace.
#
# Usage: scripts/build-all.sh [--skip-planner]

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
export PATH="$root/node_modules/.bin:$PATH"
export NEXT_TELEMETRY_DISABLED=1

skip_planner=false
if [ "${1:-}" = "--skip-planner" ]; then
  skip_planner=true
fi

# Every workspace project with a tsdown.config.ts (the packages with a dist,
# and the worker), dependencies before dependents. pnpm runs recursive
# commands in topological order of the package.json workspace dependencies
# (the same edges moon infers) and builds independent projects in parallel,
# so a new package needs no change here. packages/ui ships source and the
# planner builds with Next below; neither has a tsdown config.
pnpm --recursive exec sh -c '
  if [ -f tsdown.config.ts ]; then
    echo "[build-all] $PNPM_PACKAGE_NAME" >&2
    ./node_modules/.bin/tsdown --clean --log-level warn
  fi'

if [ "$skip_planner" = false ]; then
  echo "[build-all] apps/planner" >&2
  (cd apps/planner && ./node_modules/.bin/next build)
fi
