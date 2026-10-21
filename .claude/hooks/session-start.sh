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

if ! command -v pnpm >/dev/null 2>&1; then
  # package.json pins pnpm via `packageManager`; corepack honours it.
  corepack enable pnpm
fi

# Progress goes to stderr so only the note below reaches Claude's context.
pnpm install --frozen-lockfile >&2

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$PWD/node_modules/.bin:\$PATH\"" >>"$CLAUDE_ENV_FILE"
fi

if ! timeout 120 ./node_modules/.bin/moon tasks root >/dev/null 2>&1; then
  echo 'moon is unavailable in this session: it could not load its toolchain'
  echo 'plugins (the network policy likely blocks ghcr.io). Follow "When moon'
  echo 'cannot start" in AGENTS.md and run the underlying tools directly.'
fi
