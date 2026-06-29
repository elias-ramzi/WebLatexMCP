# Development

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

See [`CLAUDE.md`](../CLAUDE.md) for the architecture overview and repository conventions.
