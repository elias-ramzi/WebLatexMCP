# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This log starts with the changes made after 0.2.0; for anything earlier, see the git history.

## [Unreleased]

### Changed

- `format-latex-project` gains a third cosmetic pass: every `figure`/`table` environment moves into its
  own `figures/<name>.tex` or `tables/<name>.tex` file, `\input`ed from exactly where the float stood.
  Files are named after the float's label, `\includegraphics` paths are left byte-identical, and new
  floats are authored the same way from the start.
