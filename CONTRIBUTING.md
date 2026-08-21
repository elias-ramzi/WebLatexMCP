# Contributing

Contributions are welcome — this repo **accepts pull requests**. Bug reports, feature ideas, docs fixes,
and code changes are all appreciated.

## Getting started

```bash
npm install
npm run build        # emits dist/index.js
```

See [CLAUDE.md](CLAUDE.md) for the architecture overview and repository conventions.

## Submitting a pull request

1. **Open an issue first** for anything non-trivial, so we can agree on the approach before you invest time.
2. **Branch** off `main` and keep your change focused — one logical change per PR.
3. **Run the full local gate** before pushing — all four must pass:

   ```bash
   npm run typecheck
   npm run lint
   npm run format:check
   npm test
   ```

4. **Add or update tests** for behavior changes. Tests run against a local bare repo, so no secrets or
   network are needed.
5. **Update the docs** when you change configuration, tools, or behavior.
6. **Open the PR** against `main` with a clear description of what changed and why. CI runs the gate on
   ubuntu, windows, and macos; please make sure it's green.

## Tests and CI

```bash
npm run typecheck     # tsc --noEmit
npm run lint          # eslint
npm run format        # prettier --write
npm test              # vitest: unit + integration (bare-repo stand-in, no secrets)
npm run test:smoke    # full compile/loop smoke (needs latexmk; auto-skips otherwise)
```

CI (GitHub Actions) runs lint + typecheck + build + tests on **ubuntu, windows, and macos**, plus a
separate Linux job that installs a minimal TeX Live + `latexmk` (via `apt`) for the compile smoke.
Integration tests use a local bare repo as an Overleaf/GitHub stand-in, so **no secrets are ever needed**.

## Releasing (npm)

Publishing is tag-triggered, so a release is a deliberate act, not a side effect of a push:

```bash
# 1. bump the version in package.json (keep .claude-plugin/plugin.json + marketplace.json in lockstep)
# 2. commit, then tag and push the tag
git tag v0.1.0 && git push origin v0.1.0
```

The [`publish` workflow](.github/workflows/publish.yml) then runs the full gate, verifies the tag
matches `package.json`'s version, and runs `npm publish --provenance --access public`. It needs an
`NPM_TOKEN` repository secret (an npm automation/publish token) — set it once under
**Settings → Secrets and variables → Actions**. The `bin`/`files`/`prepublishOnly` fields in
`package.json` are already publish-ready, and the `web-latex-mcp` name is available on npm. Until the
first publish lands, the `npx -y web-latex-mcp` install path (README's npm section and the Claude Code
plugin) will not resolve — publishing is what makes them work.

## Feedback from a session

The most useful bug reports come from the sessions themselves — the call that failed, the detour that
should not have been needed, the capability that was not there. That evidence is sitting in the
transcript, and it evaporates when the session closes.

The [`session-feedback`](.claude/skills/session-feedback/SKILL.md) skill is how you keep it. Run it at
the **end** of a session spent working through the server:

```
/session-feedback
```

It walks back over the session's tool calls, keeps only what actually happened, and hands you **one
ready-to-file issue body per finding** — headings in the same order as the fields of the
[bug report](.github/ISSUE_TEMPLATE/bug_report.yml) and
[feature request](.github/ISSUE_TEMPLATE/feature_request.yml) forms, so you paste a block straight down
the form without editing it. Each finding is classified (`bug`, `friction`, `gap`, `docs`, `skill`),
rated for impact (**blocked** / **slowed** / **cosmetic**), given a frequency (once / every time /
intermittent), and checked against the existing issues so it does not re-file a known one. The findings
are ranked, the weakest are cut, and what got cut is said out loud — in the chat summary, not in the
issue body, which stays about the one thing it reports.

**The environment is measured, not recalled.** The block every finding carries is filled by running the
commands: server version from `server_info` (plus whether it is the latest on npm, and the commit if you
run from a clone), OS + architecture + whether this is WSL, `node --version`, the compiler and TeX
distribution from `doctor` when the session compiled, the workspace mode and whether the project is a
git remote or a local in-place directory, and whether parallel sessions shared the clone. Three things
cannot be read from inside a session — **which client** (CLI, VS Code extension, Desktop, Cursor, …),
**which model** drove it, and **how the server was installed** (npx, global npm, `.mcpb` bundle, plugin,
clone) — so it asks you, once, and writes `<unknown — please fill in>` rather than guessing. A blank
field costs a question; an invented version number costs an afternoon on the wrong commit.

Three properties make it safe to run and worth reading:

- **It changes nothing.** No `write_file` into a project, no `compile`, no `commit`, no `push`. It looks
  at the server and its skills, never at your paper.
- **It scrubs.** Tokens, credential-bearing remotes, private repo URLs, usernames in absolute paths, and
  the manuscript's own content (title, abstract, results, co-authors) are stripped or generalized before
  anything is printed — a finding that cannot be described without them is dropped, and the drop is
  reported. The report is written to be handed to someone who was not there.
- **It never files anything on its own.** You get the blocks in the chat; saving them to a file and
  opening a GitHub issue each need an explicit yes, and the titles are shown before anything is created.
  With `gh` installed it runs `gh issue create --repo elias-ramzi/WebLatexMCP --label bug` for you — one
  issue per finding, so each is one thing that can be closed, and the label is set explicitly because
  `gh` posts through the API and bypasses the form. Otherwise you get a title and a block to paste at
  [issues/new/choose](https://github.com/elias-ramzi/WebLatexMCP/issues/new/choose).

An empty report is a normal outcome — a clean session should produce two lines saying so, not a page of
invented nits. If the skill is not installed in your client, it ships with the server anyway: pick
`session-feedback` from the prompt menu, or ask Claude to fetch it with `list_skills`
(see [docs/skills.md](docs/skills.md#two-ways-a-skill-runs)).

## Reporting bugs

Open an issue with steps to reproduce, what you expected, and what happened. Include your OS, Node
version, and any relevant (token-free) error output. A `/session-feedback` report already contains all
of that — pasting one is a complete bug report.
