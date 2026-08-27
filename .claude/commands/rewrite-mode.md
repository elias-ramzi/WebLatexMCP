---
description: Get or set a project's rewrite-preservation mode (off/prose/always) — whether edit_file comments out rewritten prose instead of discarding it.
argument-hint: <project id> [off|prose|always]
---

Get or set the rewrite-preservation mode for the project below via the `set_rewrite_mode` tool.
This command is a front door only — it does not re-implement or second-guess the tool.

Target: $ARGUMENTS

1. **Resolve the project id and the mode.** Parse `$ARGUMENTS` as `<project id> [off|prose|always]`.
   If no project id is given, call `list_projects` and ask me which one — do not guess. If a mode
   is given, it must be exactly one of `off`, `prose`, or `always`; if anything else was typed, stop
   and tell me rather than guessing which one I meant.

2. **Call the tool.** `set_rewrite_mode({ project, mode })` — omit `mode` entirely when none was
   given, so the call reports the current effective mode without changing anything.

3. **Report.** State the resulting mode plainly. If you changed it, say what it changed from and
   to. If you only read it, say where it came from, derived from the result's `source` and
   `envConfigured` fields — never guess or assume: `source: "project"` means this project's own
   stored setting; `source: "default"` with `envConfigured: true` means the server's
   `WEB_LATEX_MCP_REWRITE_MODE` default; `source: "default"` with `envConfigured: false` means the
   built-in `prose` default.
