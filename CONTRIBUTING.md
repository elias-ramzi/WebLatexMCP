# Contributing

Contributions are welcome — this repo **accepts pull requests**. Bug reports, feature ideas, docs fixes,
and code changes are all appreciated.

## Getting started

```bash
npm install
npm run build        # emits dist/index.js
```

See [docs/development.md](docs/development.md) for the build, test, and CI details, and
[CLAUDE.md](CLAUDE.md) for the architecture overview and repository conventions.

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
   network are needed (see [docs/development.md](docs/development.md)).
5. **Update the docs** when you change configuration, tools, or behavior.
6. **Open the PR** against `main` with a clear description of what changed and why. CI runs the gate on
   ubuntu, windows, and macos; please make sure it's green.

## Reporting bugs

Open an issue with steps to reproduce, what you expected, and what happened. Include your OS, Node
version, and any relevant (token-free) error output.
