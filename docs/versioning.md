# Versioning and releases

This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html): every release is
`MAJOR.MINOR.PATCH`. The version is the contract the MCP server advertises — it is reported in the
`initialize` handshake and by the `server_info` tool — so it describes the **tool surface an MCP client
sees**, not just internal code churn.

## What bumps which number

- **MAJOR** (`1.0.0`) — a breaking change to that surface: a tool removed or renamed, a required input
  added, an input/output schema changed incompatibly, an environment variable or default behaviour a user
  relied on removed. While the project is pre-`1.0.0`, breaking changes ride the MINOR slot instead (see
  below), but still call them out loudly in the changelog.
- **MINOR** (`0.3.0`) — new, backward-compatible surface: a new tool, a new optional input, a new skill or
  prompt, a materially new capability. Existing callers keep working unchanged.
- **PATCH** (`0.2.1`) — bug fixes, log-parsing tweaks, docs, CI, and internal refactors that leave the tool
  surface identical.

### Pre-1.0 rule

Below `1.0.0` the public API is still settling, so we shift everything down one slot: a **breaking** change
bumps MINOR (`0.2.x` → `0.3.0`) and a **feature** bumps PATCH only when it is purely additive and low-risk;
otherwise prefer MINOR. When in doubt between two levels, pick the higher one.

## Cutting a release

Releases merge from `dev` into `main` — a required CI gate (`only-dev-into-main.yml`) rejects a PR into
`main` from any other branch. The steps:

1. **Finish the changelog.** Move everything under `## [Unreleased]` in [CHANGELOG.md](../CHANGELOG.md)
   into a new `## [X.Y.Z] - YYYY-MM-DD` heading, leave an empty `## [Unreleased]` on top, and confirm every
   commit on `dev` since the last release is represented.
2. **Bump the version in all three manifests, in lock-step** — they must never drift:
   - [`package.json`](../package.json) (what the handshake and `server_info` report)
   - [`.claude-plugin/plugin.json`](../.claude-plugin/plugin.json)
   - [`.claude-plugin/marketplace.json`](../.claude-plugin/marketplace.json)

   Bumping `package.json` also updates `package-lock.json` — run `npm install --package-lock-only` (or let
   `npm version` do it) so the lockfile matches.

3. **Run the full gate** — `npm run typecheck && npm run lint && npm run format:check && npm test`.
4. **Open a PR from `dev` into `main`** titled `Release X.Y.Z`.
5. **After merge, tag `main`** as `vX.Y.Z` to match the existing tags (`v0.1.0` … `v0.2.0`) and push the
   tag. Pushing a `v*` tag triggers `publish.yml`, which runs the gate and publishes to npm; it fails fast
   if the tag does not match `package.json`, which is why step 2 keeps the manifests in lock-step.

## Keeping `dev` a superset of `main` (post-release back-merge)

Merging the release PR adds a merge commit to `main` that `dev` does not have. Because `main` requires
branches to be up to date before merging, that one commit leaves the _next_ release PR flagged `BEHIND`
and unmergeable — even though `dev` already contains all of `main`'s content. The remedy is to merge
`main` back into `dev` after every release (a no-op content-wise — it carries no file changes, only the
missing ancestry):

```bash
git checkout dev && git pull
git merge origin/main        # conflict-free; brings the release merge commit onto dev
# open a PR for this back-merge into dev (dev is protected), then merge it
```

This is **automated** by [`back-merge.yml`](../.github/workflows/back-merge.yml): on every push to `main` it
opens (and auto-merges, once the checks that already ran on `main` are green) a `main → dev` PR, skipping
when `dev` is already up to date. Keep the manual step above as the fallback if that workflow is disabled
or a genuine conflict needs a human.
