# The shared server

Nothing on this page is needed to use WebLatexMCP. However you installed it, the command your MCP
client starts already relays every session on a workspace to **one shared server**, starting it in the
background when none is running and stopping it after 30 minutes with no session. This page is for
running that server yourself — always on, as a login service — or connecting a client to it over
HTTP directly. [Configuration → One shared server](../configuration.md#one-shared-server-for-every-session)
says which settings are per session and which are the server's.

## Check on it

```bash
npx web-latex-mcp daemon status
```

`daemon stop` stops it (`--force` even with sessions open; they reconnect to a fresh one on their
next call), `daemon restart` restarts it from the current environment — the way to change a
server-wide setting such as `WEB_LATEX_MCP_COMPILER`. Its log is `<workspace>/.daemon/daemon.log`
(`~/.web-latex-mcp/projects/.daemon/daemon.log` by default).

To go back to one in-process server per session, start the server with `--standalone` or set
`WEB_LATEX_MCP_STANDALONE=1` in its environment.

## Run it as a login service

A service keeps one server up from login, with `--keep-alive` so it never idles out. Clients find it
the same way they find an auto-started one. Two things to know:

- **It is never replaced by a newer client.** A client normally replaces an older shared server
  once its sessions end; a `--keep-alive` server belongs to the service manager, which would only
  start the same build again. After updating, restart the service.
- **Give it no tokens.** Each session sends its own git token; a token in the service's environment
  would serve every session. The OS keychain (`credential_portal`) and the GitHub CLI work as usual.

The examples use a global install (`npm install -g web-latex-mcp`); `npm root -g` prints where it is.
Use absolute paths: a service does not get your shell's `PATH`.

### macOS (launchd)

Save as `~/Library/LaunchAgents/io.github.elias-ramzi.web-latex-mcp.plist`, with your paths:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.github.elias-ramzi.web-latex-mcp</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/opt/homebrew/lib/node_modules/web-latex-mcp/dist/index.js</string>
    <string>serve</string>
    <string>--keep-alive</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <!-- The TeX binaries, so compile finds latexmk. -->
    <key>PATH</key>
    <string>/Library/TeX/texbin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardErrorPath</key>
  <string>/tmp/web-latex-mcp.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.github.elias-ramzi.web-latex-mcp.plist
```

After an update: `launchctl kickstart -k gui/$(id -u)/io.github.elias-ramzi.web-latex-mcp`.

### Linux (systemd user unit)

Save as `~/.config/systemd/user/web-latex-mcp.service`, with your paths:

```ini
[Unit]
Description=WebLatexMCP shared server

[Service]
ExecStart=/usr/bin/node /usr/lib/node_modules/web-latex-mcp/dist/index.js serve --keep-alive
Restart=on-failure
# The TeX binaries, so compile finds latexmk.
Environment=PATH=/usr/local/texlive/2025/bin/x86_64-linux:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now web-latex-mcp
```

After an update: `systemctl --user restart web-latex-mcp`. Logs: `journalctl --user -u web-latex-mcp`.

### Windows

Not verified yet. A Task Scheduler entry that starts at logon does the same:

```powershell
schtasks /Create /TN web-latex-mcp /SC ONLOGON /TR "\"C:\Program Files\nodejs\node.exe\" \"%APPDATA%\npm\node_modules\web-latex-mcp\dist\index.js\" serve --keep-alive"
```

## Connect a client over HTTP directly

The relay is the recommended route: it starts the server when needed, restarts it once if it dies
without losing the session, and ends the session when the client exits. A client can instead speak
MCP over Streamable HTTP to the server, which then has to be running already — run it as a service,
on a fixed port:

- add `WEB_LATEX_MCP_PORT=41700` (any free port) to the service's environment;
- every request needs the bearer token from `<workspace>/.daemon/daemon.json`, which changes each
  time the server starts. `web-latex-mcp daemon headers` prints the headers to send, as JSON:
  the token, and your `WEB_LATEX_MCP_SESSION` and `WEB_LATEX_MCP_DEFAULT_PROJECT` when set.

Claude Code runs a command for a server's headers on each connection (`headersHelper`), so a
project's `.mcp.json` can say:

```json
{
  "mcpServers": {
    "web-latex-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:41700/mcp",
      "headersHelper": "web-latex-mcp daemon headers"
    }
  }
}
```

Without the relay, git tokens from the client's environment are not sent: use the keychain
(`credential_portal`) or the GitHub CLI. Whether Claude Code ends an HTTP session when it exits is
not documented; a session whose client goes away is closed within a minute of its event stream
dropping, or after 30 minutes idle.
