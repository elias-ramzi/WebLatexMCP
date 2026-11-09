# Design: one shared server per workspace

Status: **accepted** (decisions in §14). All six milestones (§13) are implemented; the open items are listed just before §12.

## 1. Why

Today every MCP client session starts its own `web-latex-mcp` process over stdio. An active one
holds about 117 MB (measured on macOS with v0.9.0), so ten parallel Claude sessions cost about
1 GB. Each process also opens its own viewer and credential portal, and coordinates with its
siblings only through files under `<workspace>/.sessions/`.

The default workspace makes things worse for anyone with many papers. It depends on where the
client was launched: inside a git repository it is `<launch-dir>/.web_latex_mcp`, otherwise
`~/.web-latex-mcp/projects`. Projects registered from different repositories therefore end up in
different registries, with clones in different places.

## 2. Goals and non-goals

Goals:

- **One central workspace by default** (`~/.web-latex-mcp/projects`): one `registry.json`, one
  directory of clones, whatever directory the client was started from.
- **One server process per workspace by default**, shared by every client session that uses that
  workspace.
- **One implementation of tool behaviour.** Transports are entry points only; tools, services and
  the session model are the same whichever way a client connects.
- **No weaker guarantees.** Every invariant in `CLAUDE.md` holds across sessions that share one
  process exactly as it does across processes. The headline one: a commit contains one session's
  lines and nobody else's.
- **Existing client configs keep working.** `npx -y web-latex-mcp`, the Claude Code plugin and
  the Desktop extension all still start a stdio command.

Non-goals:

- Remote access. The server listens on loopback only and serves one OS user.
- Sharing a server between OS users.
- Moving CPU-heavy work (PDF rasterizing) off the main thread. This is noted as a risk in §11.

## 3. Decisions taken

From the discussion that led to this document:

1. The shared server is the **default**, not an opt-in.
2. Projects and clones live in **one place** by default; the workspace-local default is removed.
3. stdio stays available, but only as a **thin proxy** to the shared server, plus an in-process
   `--standalone` mode for tests, CI and single-shot environments. Neither carries tool logic of
   its own.

## 4. Architecture

```
 Claude session A ──stdio──▶ proxy A ─┐
 Claude session B ──stdio──▶ proxy B ─┼─HTTP (loopback, bearer token)─▶ daemon (one per workspace)
 Claude Code (type: http) ────────────┘                                  ├─ shared services
                                                                         └─ one SessionScope per MCP session
```

Three entry points, one `createServer`:

| Command                       | What it is                                                              |
| ----------------------------- | ----------------------------------------------------------------------- |
| `web-latex-mcp` (no argument) | **stdio proxy** (new default). Finds or starts the daemon and relays.   |
| `web-latex-mcp serve`         | **daemon**, in the foreground. Used by auto-start, launchd and systemd. |
| `web-latex-mcp --standalone`  | today's behaviour: one in-process server on stdio, one session.         |

`web-latex-mcp daemon status|stop|restart` manages the daemon from a shell.

### 4.1 One daemon per workspace

The workspace is the daemon's identity. Its discovery and lock files live **inside** the
workspace:

- `<workspace>/.daemon/daemon.lock`: held for the daemon's lifetime, through the existing
  `src/lib/fileLock.ts` (token, heartbeat, stale-holder reclaim), so only one daemon serves a
  workspace.
- `<workspace>/.daemon/daemon.json`, mode `0600` in a `0700` directory, written atomically
  (`writeAtomic`) after the listener is up: `{ pid, processNonce, port, token, version,
buildPath, startedAt }`.

A client that sets a different `WEB_LATEX_MCP_WORKSPACE` therefore gets its own daemon. That
settles workspace conflicts without any negotiation. The directory sits beside the project directories, and `projectIdProblem` already refuses an id
with a leading `.`, so no project can collide with `.daemon`.

### 4.2 Transport

`StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk` (1.29), stateful mode
(`sessionIdGenerator: randomUUID`), over `node:http`. Don't add express. One transport and one
`McpServer` per MCP session. `onsessioninitialized` creates the session's `SessionScope` (§5);
`onsessionclosed` and transport `onclose` release it.

## 5. The session model (the core change)

Today `createContext` builds one `AppContext` per process and bakes `config.sessionId` into
`SessionRegistry`, `ShelfStore` and `ShadowStore` (`src/context.ts`). The refactor splits it in two.

### 5.1 Shared vs. per-session state

| Piece                                                                                        | Scope                                                     | Why                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ProjectManager`: mutex table (`ProjectLocks`) and registry                                  | shared                                                    | The in-process mutex is what serializes sessions in one process; it must be one table.                                                                                                                                                                                                                                                                                                     |
| `ProjectManager` itself (session-only registrations, pins, in-process default)               | **per session**, over the shared table                    | Q4: a `project_sync { gitUrl }` registration and its pin are that session's own. One manager per scope keeps them so with no overlay inside the manager. The viewer resolves an id through the open scope that knows it, else through a manager of its own over the configuration and registry.                                                                                            |
| `GitService`, compiler, `PdfRenderer`, reference backends, `DoctorService`, `SyncTexService` | shared                                                    | Stateless or caching only.                                                                                                                                                                                                                                                                                                                                                                 |
| `ViewerService`, `CommentStore`                                                              | shared                                                    | One viewer port for everyone. Review comments become visible to every session, which is an improvement: today a comment left in one process's viewer is invisible to the others.                                                                                                                                                                                                           |
| `CredentialPortal`, `UpdateService`, `RewriteModeStore`                                      | shared                                                    | Project-wide or machine-wide already.                                                                                                                                                                                                                                                                                                                                                      |
| `SessionRegistry`, `ShadowStore`, `ShelfStore`                                               | **per session**                                           | Already keyed by session id; built per scope with the scope's id.                                                                                                                                                                                                                                                                                                                          |
| `FileService` (revision baselines, mutation recorder)                                        | **per session**                                           | **Must not be shared.** A baseline means "what this session last saw". Shared, session B's write through the server would update the baseline session A relies on, and A's next write would silently overwrite B's edit instead of throwing `ExternalChangeError`. Today that protection works because B is another process. The recorder must also feed the writing session's own shadow. |
| `CredentialResolver`                                                                         | shared base + per-session overlay                         | See §7.2.                                                                                                                                                                                                                                                                                                                                                                                  |
| `config`                                                                                     | shared, with per-session `sessionId` and `defaultProject` | See §7.                                                                                                                                                                                                                                                                                                                                                                                    |

`AppContext` keeps its shape, so no tool changes. `createContext` becomes
`createSharedServices(config, …)` plus `createSessionContext(shared, { sessionId, defaultProject,
credentialOverlay })`, which returns a `SessionScope`: the scope's `AppContext` and its `close()`. `--standalone` builds exactly one session
context, so it uses the same code path.

`ShadowStore.withIndexLock` is already module-level, keyed by session directory, and
`settleAll`/`clearAll` already reach across sessions through the filesystem. Both stay correct
with several stores in one process; add a test that pins it (§12).

### 5.2 Session identity

- The session id comes from the `X-Web-Latex-Mcp-Session` header on `initialize`. The proxy sets
  it from its own `WEB_LATEX_MCP_SESSION`. Without the header the id is random
  (`session-<8 hex>`), as today. Validate it with the existing `parseSessionId` rules, reserved
  names included. A bad header is a refused `initialize` carrying `parseSessionId`'s message.
- **Two open MCP sessions may not share an id inside one daemon.** A duplicate gets a `-2`, `-3`
  suffix. `server_info` and the startup log say so. Taking over a dead session's shadows by
  reusing its name keeps working as today, because a closed session no longer holds the name.

### 5.3 Liveness

Today a peer is live when its pid runs (boot-scoped) or its heartbeat is recent
(`SessionRegistry.peers`). In a daemon every session has the same pid, so a session whose client
went away would read **live** until the daemon exits. That fails closed (it refuses more) but
would wedge `commit`'s default scope and `push` for every other session.

Change:

1. Session records gain `processNonce` (the one exported from `src/lib/fileLock.ts`, so the
   process has one identity). `readRecord` tolerates its absence.
2. For a record with **this** process's pid **and** nonce, `live` is exactly "its scope is open in
   this process" (an injected `isOpenHere(sessionId)`). Pid, boot and heartbeat clauses are not
   consulted for it.
3. Every other record keeps today's rules unchanged. Peers in other processes (a
   `--standalone` server, an older version, a second machine on the same workspace) still
   coordinate as they do now.
4. Closing a scope calls `SessionRegistry.release(projectId)` for every project the scope touched.
   That is the same retraction a clean process shutdown does today. Daemon shutdown (SIGINT,
   SIGTERM) releases every scope.
5. **When is a scope closed?** On `DELETE` (the proxy always sends one when its stdin closes), on
   transport close, or after `SESSION_IDLE_MS` without a request **and** without an open SSE
   stream. Start with 30 minutes, the same as `STALE_MS`, so the rule stays: a session idle past
   `STALE_MS` may read dead. Q5 (§14) is still to measure: whether Claude Code's native HTTP client sends
   `DELETE` on exit. Answer it with the existing session probe (`src/lib/sessionProbe.ts`) before
   tuning this number.

Older servers that read a daemon's records see a running pid and call every record live. Records
of closed scopes are removed on close, so this only matters for a daemon that crashed, and then
its pid is dead. This needs no change.

## 6. Locks

`runExclusive` is already an in-process mutex in front of the file lock, so two scopes in one
daemon serialize on the mutex and only one of them ever reaches the file. `isAbandoned`'s
same-thread rule (`heldTokens`) stays correct. Nothing changes here. Add an integration test with
two scopes racing `compile` and `write_file` on one project (§12), because this invariant is now
load-bearing in a new way.

## 7. Configuration

### 7.1 Where each setting is read

The daemon reads its own environment plus an optional `~/.web-latex-mcp/config.json` (same keys
as the env vars, without the `WEB_LATEX_MCP_` prefix; env wins). A per-client env no longer
reaches the server, except for the per-connection settings the proxy forwards as headers:

| Setting                                                                                                                                                                        | Scope after this change                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `WEB_LATEX_MCP_WORKSPACE`                                                                                                                                                      | proxy side: chooses **which daemon** to use (§4.1)          |
| `WEB_LATEX_MCP_SESSION`                                                                                                                                                        | per connection, header `X-Web-Latex-Mcp-Session`            |
| `WEB_LATEX_MCP_DEFAULT_PROJECT`                                                                                                                                                | per connection, header `X-Web-Latex-Mcp-Default-Project`    |
| `WEB_LATEX_MCP_NO_OUTPUT_SCHEMA`                                                                                                                                               | per connection, header (it already is per client in spirit) |
| Credential env vars (see §7.2)                                                                                                                                                 | per connection overlay                                      |
| `WEB_LATEX_MCP_PROJECTS`                                                                                                                                                       | ignored, with a hint (Q2)                                   |
| everything else (`COMPILER`, `REFERENCE_SOURCE`, `REWRITE_MODE`, `CONTACT_EMAIL`, `WRITING_GUIDE*`, `VIEWER_*`, `AUTHOR_*`, `SKILLS_DIR`, `CONCURRENCY_GUIDE`, `INSTALL_KIND`) | daemon-wide                                                 |

If a proxy's env sets a daemon-wide variable to a value that differs from the daemon's, the proxy
does not silently drop it. It sends the names (never the values) in `X-Web-Latex-Mcp-Ignored-Env`,
and `server_info` and the first tool result of the session carry a one-line hint naming them and
where to set them instead. Values a user wrote stay theirs: they are named, not echoed.

### 7.2 Credentials

Tokens in a client's env (`OVERLEAF_GIT_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`,
`WEB_LATEX_MCP_TOKEN`, and the per-project `tokenEnv` names) are how the Desktop extension and
many configs pass credentials today. Decided (Q1): the proxy forwards the known credential
variables in a single `X-Web-Latex-Mcp-Credentials` header (JSON, loopback only, behind the bearer
token). The daemon keeps them **in memory, for that scope only**, as an overlay that
`CredentialResolver` consults before the daemon's own env. They are never written to disk and are
dropped when the scope closes. `errorResult` scrubs with the scope's `allSecrets()`, which
includes the overlay. The keychain path (`credential_portal`, `set_credential`) is unchanged and
shared, as today.

### 7.3 Writing guide and skills

They are loaded at startup today, and `add_writing_convention` says the rule takes effect from
the next start. A daemon lives for days, so load the guides **per new MCP session** (one small
file read each) and keep `instructions` per `McpServer`. Skills likewise. That keeps the documented
"next session" behaviour.

## 8. Workspace

### 8.1 New default

`resolveWorkspace` drops the workspace-local default: unset means `~/.web-latex-mcp/projects`
everywhere, standalone included. `WEB_LATEX_MCP_WORKSPACE=<path>` still works. The `cwd` sentinel
is refused with a message naming the replacement (an explicit path) and the migration command.
Removed with it: `src/lib/workspaceExclude.ts` and its call in `index.ts`, the
`workspaceExcludePattern` hints in `server_info` and `register_project`, and the workspace-local
wording in docs. The surfaced PDF stays at `<workspace>/<id>.pdf`, now in the central workspace.

### 8.2 Migration

`web-latex-mcp migrate-workspace <from> [--to <workspace>]` moves an old workspace-local
workspace into the central one:

- refuses while any session on any project in either workspace is live, or either daemon is
  running;
- refuses the whole run, changing nothing, if an id exists in both registries (names each);
- moves each clone, its `.sessions/<id>/` and `<id>.pdf`, then upserts the registry entry. Moves
  are renames when on one filesystem, else copy-then-verify-then-delete;
- prints what moved and leaves `<from>` holding a short README naming where everything went;
- leaves the host repository's `.git/info/exclude` line alone (it is harmless and the user's file).

So existing users find out: at startup, a proxy whose cwd holds `.web_latex_mcp/registry.json`
sends its path in `X-Web-Latex-Mcp-Legacy-Workspace`, and `server_info` plus the session's first
tool result name the command. Nothing is moved automatically.

## 9. The proxy and the daemon's lifecycle

### 9.1 Proxy

A message relay between `StdioServerTransport` and `StreamableHTTPClientTransport`, nothing else.
It never parses tool arguments or results. Rules:

- stdout carries only relayed JSON-RPC; every log goes to stderr.
- **Discovery:** read `<workspace>/.daemon/daemon.json`, check the pid is alive, then
  `GET /health` with the token (returns `{ version, processNonce }`).
- **Auto-start:** if there is no healthy daemon, spawn `process.execPath <own dist/index.js>
serve` detached, stdio to `<workspace>/.daemon/daemon.log` (rotated at 10 MB). Wait up to 10 s
  for a healthy `daemon.json`. Two proxies starting at once both spawn; the daemon lock lets one
  win and the other exits, and both proxies then find the winner.
- **Reconnect:** if the daemon dies mid-session, restart it once and replay the cached
  `initialize` with the same session header. The session id, and so the shadow and the ownership
  of its edits, survives. In-flight requests get a JSON-RPC error saying the server restarted. A
  second failure ends the proxy with a message on stderr.
- **Fallback:** if the daemon cannot be started (port refused, workspace unwritable), the proxy
  says why on stderr and runs `--standalone` in-process, so a broken daemon never leaves a client
  with no server. `server_info` reports `mode: "standalone (daemon unavailable: …)"`.

### 9.2 Versions

The proxy and daemon each know their version and build path.

- Same version: connect.
- Proxy newer: if the daemon has no open scope, stop it (`POST /shutdown`) and start the proxy's
  build. Otherwise connect, and `server_info` plus the first result say a restart is pending.
  The daemon restarts itself when its last scope closes and a newer build has asked.
- Proxy older: connect; the daemon is backward compatible with its own MCP surface.

A launcher that builds each commit into its own directory (a local "latest `main`" setup) works
too: the proxy from build X starts a daemon from build X, so the rule above makes the newest build win once the old sessions
end.

`update_server` acts on the daemon. When it installs a new version, it schedules the
restart-when-idle instead of telling the user to restart the client.

### 9.3 Idle exit

An auto-started daemon exits after `DAEMON_IDLE_EXIT_MS` (default 30 minutes) with no open scope,
releasing its lock and deleting `daemon.json`. A daemon started with `serve --keep-alive` (the
launchd/systemd unit) never idles out. See Q3.

## 10. Security

Stdio needed none of this: only the parent process could talk to the server. A loopback listener
can be reached by every local process and, through DNS rebinding, by web pages.

- Bind `127.0.0.1` only. Port `0` (random) by default; `WEB_LATEX_MCP_PORT` fixes it for direct
  `type: http` configs.
- **Bearer token:** 32 random bytes, in `daemon.json` (`0600`, directory `0700`), required on every
  request, `/health` included. Compare in constant time. Regenerated at each daemon
  start.
- **Host check:** the transport's `enableDnsRebindingProtection` with
  `allowedHosts: ["127.0.0.1:<port>", "localhost:<port>"]`. A request carrying an `Origin` header
  is refused outright (MCP clients send none; browsers always do).
- Body size cap (4 MB, above any legitimate `write_file`), and a cap on open scopes (64).
- On win32 the file mode is not enforced the same way. Say so in the docs, as the build-root
  bullet does, and don't claim more.
- The viewer and the credential portal keep their own loopback listeners and nonces. They get the
  same `Host` check while we're at it.
- Nothing about tokens changes on disk: the per-scope overlay (§7.2) is memory only.

## 11. Risks

- **One crash ends every session.** The proxy's reconnect (§9.1) recovers the session id and its
  shadows; in-flight calls fail with a clear error.
- **Main-thread work blocks everyone.** Compiles are subprocesses and regex search runs on a
  worker, but `render_pages` rasterizes on the main thread. Measure it with two scopes; moving it
  to a worker is a follow-up if the delay is noticeable.
- **Memory growth.** One long-lived process accumulates caches (comments, revision baselines per
  scope). Baselines go with the scope; the in-memory comment store has no cap today, so add one
  and a soak test.
- **Session-only registrations.** `project_sync { gitUrl }` that differs from the registry pins
  the URL "for this session" in `ProjectManager`, which is per process today. Shared, that pin
  would leak to every scope. Decided (Q4): pins stay per scope; each scope has its own manager.

Milestone 4 (the daemon, `src/daemon/`) settled the milestone-2 and -3 gaps as follows:

- **Duplicate session ids:** suffixed `-2`, `-3`, … against every open session and in-process
  scope (`uniqueSessionId`), compared **case-folded**, since `Alice` and `alice` are one session
  directory on macOS and Windows; `server_info` reports `sessionIdRequested`.
- **Calls after close:** a closing session leaves the routing table first (its id answers 404),
  then waits for its `ProjectManager`'s `runExclusive` calls (`whenIdle`) — every write runs in one,
  and it keeps running when the client cancels or the transport aborts the call — for up to
  `DEFAULT_DRAIN_MS` (10 minutes), cut to `STOP_DRAIN_MS` (10 s) for every session once the daemon
  stops. A write outliving the cap still lands after close.
- **Idle close:** `sessionIdleMs` (30 minutes) without a request, an open event stream or a
  running exclusive call. A connected client holds its event stream open, so in practice a session closes
  idle when its client vanished without a `DELETE`. Q5 is still to measure; it only matters for
  clients that keep no stream open.

Milestone 5 (the proxy, `src/proxy/`) follows §9 with these choices:

- **Build rule.** A build id is the version plus the entry file and its mtime (`currentBuildId`).
  Same version → connect, so two installs of one version (Desktop's bundle, `npx`) share a daemon;
  the exception is the same entry with another mtime (a launcher rebuilding `main` in place), which
  counts as newer. A newer version replaces an idle daemon now, a busy one once its sessions end
  (also when an idle one refuses `/shutdown` because a session just opened); `server_info` then
  shows `restartPending`. An older proxy connects. A keep-alive daemon is never replaced.
- **Ignored env (§7.1)** travels as `X-Web-Latex-Mcp-Client-Env`, each daemon-wide variable the
  client set mapped to a SHA-256 of its value, so the daemon names what differs without seeing a
  value.
- **Credentials and environment.** An auto-started daemon gets the client's environment minus the
  per-connection variables, `WEB_LATEX_MCP_PROJECTS`, every token variable the proxy forwards, and
  every variable whose name has a secret-like word (`TOKEN`, `SECRET`, `PASSWORD`, `AUTH`, …), so
  `GH_TOKEN` cannot serve every session through `gh`. It runs in the workspace, not the client's
  directory; relative guide and skills paths are resolved against the client's directory first,
  and preloaded modules (`--import tsx` in development) are made absolute.
- **Relay.** Only a request actually handed to a daemon that is then lost is answered "restarted,
  retry"; one queued behind the restart goes to the new daemon. A send the live daemon refuses (a 413) is passed back as an error and never triggers a restart. A client `initialize` still
  unanswered at a restart is re-sent as itself. `/health` answers 503 while a daemon stops.
  Reconnect restarts at most once per proxy; a second loss ends it.
- **Ending a session.** The proxy sends `DELETE` on stdin end and on SIGINT, SIGTERM and SIGHUP.
  For a kill it cannot see (SIGKILL, Windows `TerminateProcess`), the daemon closes a session that
  held an event stream and lost every one after `DEFAULT_STREAM_LOSS_MS` (60 s) instead of the
  30-minute idle timeout, freeing its id.
- **Fallback** is reported as `daemonUnavailable` beside `mode: "stdio"`, not as a `mode` string.
- **Q5** no longer gates anything for proxied clients: the proxy always ends its session. It still
  matters only for clients connecting over HTTP directly.

Still open, for milestone 6 or later:

- **`update_server`** does not yet schedule the restart-when-idle (§9.2); after an update the next
  client's proxy replaces the daemon by the build rule.
- **Windows job objects.** `detached: true` does not leave a kill-on-close job; a client running its
  servers in one kills the shared daemon when it quits. Unverified on Windows.
- **Token variables learned mid-session** (a `tokenEnv` given to `register_project` after the proxy
  started) are not forwarded until the next session. `gh`'s own login is the daemon's.

- **Viewer's view of a shared project.** The viewer resolves an id through the newest open scope
  that knows it, so a session's pin or session-only `rootFile` decides what the viewer shows while
  that session is open.
- **Overlay contents.** Every overlay value is scrubbed from the scope's output; the daemon accepts
  any variable-shaped name in `X-Web-Latex-Mcp-Credentials`, so the proxy must send credentials
  only.
- **The viewer and credential portal listeners** do not yet get the `Host` check (§10).
- **`~/.web-latex-mcp/config.json`** (§7.1) is not read yet; the daemon reads its own env only.
- **The ignored-env hint** reaches `server_info` only, not yet the session's first tool result
  (§7.1).
- **The session probe** (`WEB_LATEX_MCP_SESSION_PROBE`) is wired for stdio only.
- **Tests from §6 and §12** that need TeX or the proxy: two sessions racing `compile`, and the
  proxy relay, auto-start and reconnect tests.

## 12. Testing

All existing tests keep running against `createServer` over the in-memory transport, which is now
the `--standalone` path. They are the proof that tool behaviour did not change.

New, by tier:

- **Unit:** session-id header validation and duplicate suffixes; liveness for same-pid,
  same-nonce records (open → live, closed → dead, other nonce → old rules); idle-close timing;
  bearer and Host/Origin checks, including a token one byte off and a `Host` with the right name
  and wrong port; `daemon.json` mode and atomic write; credential overlay precedence and
  scrubbing; config-env mismatch reporting names without values; workspace default without the
  local branch; `cwd` sentinel refusal; migration refusals (live session, id collision) changing
  nothing.
- **Integration (real git, bare repo):** two MCP clients over HTTP to one in-process daemon:
  - each commits only its own lines (`scope: "session"`);
  - **A reads, B writes the same file, A's write throws `ExternalChangeError`.** This is the test
    for per-session `FileService`; it must fail against a shared one;
  - B's live edit makes A's `scope: "paths"` refuse; after B disconnects, B reads dead and A's
    default commit no longer refuses on it;
  - `push` peer guard with a live and a closed scope;
  - two scopes racing `compile` and `write_file` serialize (lock held by one at a time);
  - a `--standalone` process and a daemon on one workspace still see each other as peers;
  - proxy relay end-to-end (spawned proxy, spawned daemon), auto-start race with two proxies,
    reconnect after killing the daemon keeps the session id, version-skew restart when idle.
- **Smoke (TeX-gated):** one compile through the proxy.

Every test is written first and watched failing.

## 13. Milestones

Each milestone ships on its own and leaves the gate green.

1. **Central workspace default, `migrate-workspace` and `import-env-projects`.** Standalone only; no transport change.
   Smallest user-visible win and independent of the rest.
2. **Session scope refactor.** `createSharedServices` + `createSessionContext`, per-session
   `FileService` and credential overlay. stdio still runs one scope. No behaviour change; the
   existing suite is the proof.
3. **Connection-based liveness** (§5.3), with the record's `processNonce`.
4. **Daemon:** `serve`, HTTP transport, auth, discovery and lock files, `/health`, `/shutdown`,
   per-session guide loading.
5. **Proxy as the default:** discovery, auto-start, reconnect, version policy, fallback to
   standalone, `daemon status|stop|restart`.
6. **Docs and packaging:** `docs/install/*` (stdio stays the documented command; direct
   `type: http` with a fixed port and header documented as an option), `docs/configuration.md`
   (the per-connection vs daemon-wide table), `docs/CONCURRENCY.md` (sessions in one process),
   `CLAUDE.md` architecture section, `manifest.json`, plugin, `CHANGELOG.md`. Launchd and systemd
   unit examples.

## 14. Decisions on the open questions

Accepted on 2026-11-09:

- **Q1. Credentials from the client's env:** the proxy forwards them; the daemon keeps them as a
  per-scope, memory-only overlay (§7.2).
- **Q2. `WEB_LATEX_MCP_PROJECTS` from a client's env:** ignored by the daemon, with the hint from
  §7.1, plus a one-time `web-latex-mcp import-env-projects` command that upserts them into the
  central registry. Env projects configured one process; the shared registry replaces them.
- **Q3. Daemon lifetime:** an auto-started daemon exits after 30 minutes with no open scope;
  `serve --keep-alive` never idles out (§9.3).
- **Q4. Session-only `project_sync { gitUrl }` pins:** kept per session, so a pin never leaks to
  other scopes. Built (milestone 2) as one `ProjectManager` per scope over a shared mutex table
  (`ProjectLocks`) rather than an overlay inside one manager.
- **Q5. Does Claude Code's HTTP client send `DELETE` on exit?** Still to measure, with the session
  probe, before milestone 3 fixes `SESSION_IDLE_MS`. Until then the default stays 30 minutes.
- **Q6. Desktop extension:** runs the proxy, sharing the central workspace and daemon. Its
  `WEB_LATEX_MCP_WORKSPACE` user setting only selects which daemon it uses.
