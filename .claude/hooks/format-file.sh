#!/usr/bin/env bash
#
# PostToolUse hook: formats the file Claude just wrote or edited with the
# repo's oxfmt, so agent edits match `moon run root:format` without a
# separate pass. oxfmt applies .oxfmtrc.json ignore patterns and skips file
# types it does not support. The hook never fails the edit.

set -uo pipefail

project_dir="${CLAUDE_PROJECT_DIR:-$PWD}"
oxfmt="$project_dir/node_modules/.bin/oxfmt"

# The hook payload arrives as JSON on stdin; tool_input.file_path is the
# edited file for Write, Edit, and MultiEdit.
file=$(node -e '
  let raw = "";
  process.stdin.on("data", (chunk) => (raw += chunk));
  process.stdin.on("end", () => {
    try {
      process.stdout.write(JSON.parse(raw).tool_input?.file_path ?? "");
    } catch {}
  });
')

if [ -z "$file" ] || [ ! -x "$oxfmt" ]; then
  exit 0
fi

# Only format files inside this repo.
case "$file" in
  "$project_dir"/*) ;;
  *) exit 0 ;;
esac

cd "$project_dir" && "$oxfmt" --no-error-on-unmatched-pattern "$file" >/dev/null 2>&1
exit 0
