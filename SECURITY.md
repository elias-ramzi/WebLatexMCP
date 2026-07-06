# Security Policy

`latex-git-mcp` runs locally over stdio and handles git credentials for the remotes you
configure (Overleaf, GitHub, GitLab, or any git host). This document explains how it treats
secrets and how to report a vulnerability.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Instead, use GitHub's private reporting: go to the repository's
[**Security → Report a vulnerability**](https://github.com/elias-ramzi/overleaf_mcp/security/advisories/new)
page, which opens a private advisory visible only to the maintainers.

Include, where possible:

- affected version / commit,
- your OS and Node version,
- steps to reproduce,
- the impact you observed, and
- any **token-free** logs (see the redaction note below before pasting output).

You can expect an initial acknowledgement within a few days. Please give us a reasonable
window to ship a fix before any public disclosure.

## How the server handles secrets

- **Tokens stay in memory.** Git credentials are resolved per remote host and injected into
  the remote URL in-memory for each call. They are **never written to `.git/config`** — `clone`
  resets `origin` to the tokenless URL.
- **Output is scrubbed.** Every tool error is passed through a redactor that removes known
  secret values and strips `user:token@host` credentials from URLs before anything is returned
  to the client or written to stderr.
- **stdout is reserved** for the JSON-RPC channel; the server logs only to stderr.
- **No token prompts.** `GIT_TERMINAL_PROMPT=0` is set so git fails fast rather than blocking on
  a credential prompt.

Despite the redactor, please **review any logs you share** and remove tokens or private project
URLs before posting them in a public issue.

## Your responsibilities

- Keep your real configuration out of version control. `.env` and `.mcp.json` are gitignored;
  copy from `.env.example` and keep your tokens local.
- Prefer scoped, least-privilege tokens for each remote, and rotate them if you suspect exposure.

## Supported versions

This project is pre-1.0. Security fixes are applied to the latest release on `main`.
