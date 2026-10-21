#!/usr/bin/env bash
#
# Builds every workspace package and both apps in dependency order, without
# moon. moon is the task runner everywhere it can start; this script exists
# for container builds (deploy/Dockerfile) and sandboxes where moon cannot
# download its toolchain plugins (see "When moon cannot start" in AGENTS.md).
# Each step mirrors a moon task: <pkg>:build is `tsdown --clean`,
# planner:build is `next build`.
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

# Dependencies before dependents: core and logger have no workspace deps;
# linear, store and notify need core; engine needs all of them.
for pkg in logger core linear store notify engine; do
  echo "[build-all] packages/$pkg" >&2
  (cd "packages/$pkg" && ./node_modules/.bin/tsdown --clean --log-level warn)
done

echo "[build-all] apps/worker" >&2
(cd apps/worker && ./node_modules/.bin/tsdown --clean --log-level warn)

if [ "$skip_planner" = false ]; then
  echo "[build-all] apps/planner" >&2
  (cd apps/planner && ./node_modules/.bin/next build)
fi
