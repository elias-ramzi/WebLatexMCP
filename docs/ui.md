# The web UI

`web-latex-mcp ui` opens a page in your browser with three parts:

- **at the left, your papers**: every project registered in the workspace, in groups you make
  (folders) and with labels you give them;
- **in the middle, Claude**: one conversation per paper, with Claude Code's whole toolset plus the
  web-latex-mcp tools;
- **at the right, the live PDF**: the server's own viewer, which reloads on each compile. You can
  comment on it and Claude reads the comments, as in the browser viewer.

It runs on top of the [shared server](install/shared-server.md): the UI is a client of it, as a
Claude Code session is.

```bash
npx web-latex-mcp ui            # starts the UI (and the shared server if none runs), opens the page
npx web-latex-mcp ui --no-open  # prints the address only
npx web-latex-mcp ui --port 7778 --to ~/papers-workspace
```

Ctrl+C stops it. Launching it again while one runs opens the running one's page.

## The chat needs the Agent SDK

The conversations run Claude through the
[Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), an **optional**
dependency: npm installs it with web-latex-mcp unless optional packages are skipped. It uses your
Claude Code login (or `ANTHROPIC_API_KEY`), as `claude` does. Without the SDK the page still lists
the papers and shows their PDFs, and the chat says how to install it:

```bash
npm install @anthropic-ai/claude-agent-sdk   # next to web-latex-mcp
```

## What Claude can do in it

Each paper's Claude is a full Claude Code session:

- It runs in the paper's folder (its clone, or a local project's own directory).
- It loads your Claude Code settings, `CLAUDE.md` files, hooks and permission rules.
- It reaches the shared server's tools as `mcp__web-latex-mcp__*`, with that paper as its default
  project. It also has the skills, commands and agents: type `/` in the box for the list.

The web-latex-mcp tools are allowed outright: they keep to the server's sandbox. Any other call that
Claude Code would ask you about comes to the page as a card:

- **Allow** runs it once.
- **Always allow** adds the rule Claude Code suggests (for example `Bash(latexmk:*)`).
- **Deny** refuses it. Anything typed in the box goes to Claude as the reason, or as what to do
  instead.

Claude's questions (`AskUserQuestion`) and its plans (in Plan mode) get cards of their own.

The **mode** pill sets the permission mode for the paper, and it applies at once:

| Mode         | What Claude asks about                        |
| ------------ | --------------------------------------------- |
| Manual       | Edits and commands.                           |
| Accept edits | Commands only.                                |
| Plan         | Nothing yet: Claude writes a plan first.      |
| Auto         | Claude Code decides what needs your approval. |

The **model** pill picks the model and the effort, and takes effect from the next turn.

A message sent while Claude works reaches it at its next step. **Esc**, or the ■ button, interrupts
it. **⌄ → New conversation** starts afresh; the old conversation is set aside on disk, not deleted.

## The side bar

- **+ Add paper** registers a project, through `register_project` and all its checks. You give a
  git URL (Overleaf, GitHub…) or a local folder. Never put a token in the URL: the server finds it
  in your environment or with `gh`, or asks for it.
- **New group** makes a folder. Move a paper into one by dragging it onto the group's name, or with
  the paper's **⋯ → Move to group**.
- **⋯ → Labels** tags a paper. The label chips under the search box filter the list.
- Drag a paper, or a group's name, to reorder. **⋯ → Rename** gives a paper a title shown instead of
  its id; the id itself does not change.
- A paper's dot shows its Claude's state: working, waiting for you, idle, or off.

Settings (the ⚙ at the bottom): the theme (the same nine as cc-servers), the font and the text size.
They are kept in the browser. **Alt+S** hides the side bar, and **Alt+A** hides the PDF. **⇄** moves
the PDF to the other side, and dragging a bar's edge resizes it.

## Where things are kept

Everything stays in `<workspace>/.ui/`, owner-only (`0700` folders, `0600` files):

| File                 | What                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `papers.json`        | Groups, labels, titles and the order of the side bar. Not in `registry.json`, so a label never changes a registration. |
| `chats/<hash>.jsonl` | Each paper's conversation, as the page shows it.                                                                       |
| `chats/<hash>.json`  | The Claude Code session it resumes, and the model, effort and mode chosen.                                             |
| `ui.json`            | The running UI's port and token. Removed when it stops.                                                                |

Claude Code also keeps its own transcript of each session, under `~/.claude/projects/`.

## Security

The UI listens on `127.0.0.1` only, on its own port; the shared server itself refuses every browser
request.

- **The page:** the address carries a random token (`/?token=…`), and every API call sends it back.
- **Other sites:** a request with another `Origin`, or a `Host` that is not this listener, is
  refused.
- **Scripts:** the page runs under a nonce CSP, and it frames only loopback pages (the viewer).
- **The shared server's token:** a chat's Claude gets it through its environment, never on its
  command line, which other users of the machine can read.
- **Chat content:** what Claude reads and writes stays between your machine and the Claude API, as
  in Claude Code.

## Inside cc-servers

The page is built like cc-servers' (vanilla JS, no build step) and keeps its look:

- the same CSS tokens and themes;
- the same ids and classes (`#c-side`, `#c-log`, `#c-box`, …);
- the same item format (`{k: "text"|"tool"|…}`).

That way the two can merge. Until then, cc-servers' LaTeX tab can frame the viewer with `?embed=1`.
The viewer then takes cc-servers' colours from its `cc-theme` message, the one cc-servers already
sends to the apps it frames.
