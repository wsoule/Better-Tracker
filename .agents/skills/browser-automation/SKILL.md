---
name: browser-automation
description:
  Use when opening, inspecting, clicking, filling, snapshotting, or otherwise
  automating web pages for this repo, including local dev servers and
  browser-based verification.
---

# Browser Automation

Use `agent-browser` for web automation in this repo. It is an external CLI, not
a workspace dependency, so check that it is installed first:

```bash
command -v agent-browser && agent-browser --help
```

If it is missing, do not install it globally. Use a browser tool your harness
provides, or drive Playwright from a throwaway script outside the repo (many
sandboxes preinstall Chromium; check `PLAYWRIGHT_BROWSERS_PATH`).

Core workflow:

```bash
agent-browser open <url>
agent-browser snapshot -i
agent-browser click @e1
agent-browser fill @e2 "text"
```

Re-run `agent-browser snapshot -i` after page changes so element refs stay
current.

Use browser automation for behavior that needs a rendered page, real DOM state,
or interactive verification. Prefer focused Bun tests for pure logic and
non-browser integration behavior.
