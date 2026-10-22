#!/usr/bin/env bash
#
# SessionStart hook for Claude Code on the web (cloud sessions only).
#
# Cloud containers start from a fresh clone without proto, so the pinned
# toolchain from .prototools is not on PATH. This installs workspace
# dependencies and puts node_modules/.bin first on PATH, which exposes the
# catalog-pinned moon/moonx, oxlint, oxfmt, tsc, and stylelint binaries.
#
# moon downloads its toolchain plugins from ghcr.io on first use. When the
# environment's network policy blocks that, every moon task fails, so the
# hook prints a note (stdout is added to Claude's context) pointing at the
# direct-tool fallback documented in AGENTS.md.

set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"

# Prints a note for Claude (stdout reaches its context) and ends the hook
# without failing the session: a missing optional tool must never block it.
skip_install() {
  echo "The SessionStart hook could not $1, so dependencies are not"
  echo 'installed and node_modules/.bin is not on PATH. Install the pinned'
  echo 'pnpm (package.json "packageManager") and run `pnpm install`.'
  exit 0
}

if ! command -v pnpm >/dev/null 2>&1; then
  # pnpm 12 ships as a native binary that corepack cannot launch, so install
  # the pinned version (package.json "packageManager") with npm, as
  # deploy/Dockerfile does.
  version_js='require("./package.json").packageManager.split("@")[1].split("+")[0]'
  pnpm_version="$(node -p "$version_js" 2>/dev/null)" ||
    skip_install 'read the pinned pnpm version'
  npm install --global "pnpm@$pnpm_version" >&2 ||
    skip_install "install pnpm@$pnpm_version"
  pnpm_bin="$(npm prefix --global)/bin" || skip_install 'find the npm global bin'
  export PATH="$pnpm_bin:$PATH"
  if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
    echo "export PATH=\"$pnpm_bin:\$PATH\"" >>"$CLAUDE_ENV_FILE"
  fi
fi

# Progress goes to stderr so only the notes reach Claude's context.
pnpm install --frozen-lockfile >&2 || skip_install 'run `pnpm install`'

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$PWD/node_modules/.bin:\$PATH\"" >>"$CLAUDE_ENV_FILE"
fi

if ! timeout 120 ./node_modules/.bin/moon tasks root >/dev/null 2>&1; then
  echo 'moon is unavailable in this session: it could not load its toolchain'
  echo 'plugins (the network policy likely blocks ghcr.io). Follow "When moon'
  echo 'cannot start" in AGENTS.md and run the underlying tools directly.'
fi
