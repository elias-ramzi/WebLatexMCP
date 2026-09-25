# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This log starts with the changes made after 0.2.0; for anything earlier, see the git history.

## [Unreleased]

### Added

- **A `.plugin-scanner.toml` for the HOL AI Plugin Scanner**, which the awesome-ai-plugins catalog
  runs before listing the server (#198). It excludes `test/`, where the token-shaped strings the
  credential and redaction tests need were reported as hardcoded secrets; `src/` is still scanned
  in full. The score goes from 69 to 88, past the catalog's threshold of 80.
- **A SkillSpector job in CI.** NVIDIA's SkillSpector scans every bundled skill with its static
  rules (`--no-llm`, so no model and no key) on each pull request, and any finding fails the build.
  The README carries a badge for it.

### Changed

- **`arxiv-clean-project` no longer runs `rm -rf`.** The scratch copy of the clone is made without
  `.git` (a `tar --exclude`) instead of copied whole and pruned. A submission folder or zip left by
  an earlier run is replaced only after the user agrees, and is moved into the scratchpad, not
  deleted, since it may carry hand edits.
- **`session-feedback`'s environment facts are a list, not a wide table**, and the offline fallback
  report is described as always written, with its path named in the reply. The bug-report form's
  install option `npx web-latex-mcp` now reads `npx (the npm package, run on demand)`, and the
  skill's example report matches it. Together these clear the seven SkillSpector findings the two
  skills had (three high).
- **CI moves to `actions/setup-node@v7`.** v5 wrote an `always-auth` line into the `.npmrc` it
  generates, which npm 11 flags as an unknown config that "will stop working in the next major
  version" — a warning on every npm step of the publish job, and a likely publish failure once the
  runner's npm is 12. v7 drops the input, and stops exporting a placeholder `NODE_AUTH_TOKEN`, which
  suits trusted publishing. Every workflow moves, not just `publish.yml`, so the pull request's own CI
  exercises v7 before a tag depends on it.
- **Every GitHub Action is pinned to a commit SHA**, with the release it names kept as a trailing
  comment (`@<sha> # v5.1.0`). A tag can be moved to other code after the fact, and `publish.yml`
  runs with the npm publishing credentials. A new `.github/dependabot.yml` keeps the pins current:
  one grouped weekly PR into `dev` (main accepts `dev` only), labelled `no-changelog`. Together these
  clear the plugin scanner's remaining findings (#198), taking the score from 88 to 100.
- **Skills that write a `.git/info/exclude` line now say so.** `arxiv-clean-project` asks before
  adding its export to the exclude file of a repository that is not the project, `verify-citations`
  names the exclude line when it asks to write into a local project, and `session-feedback`'s
  description and closing rule no longer claim it writes nothing. `arxiv-clean-project` also lists
  every shell command it runs, and adds only `mkdir` and `grep` to its pre-approved `allowed-tools`:
  `tar`, `cp`, `mv` and `git` can overwrite or move files anywhere, so the client still asks for
  each. These are the findings of a SkillSpector scan with its LLM pass (the CI job runs without it).
- **`format-latex-project`, `format-bibliography` and `arxiv-clean-project` no longer fall back to a
  bare `discard`** when a compile they broke cannot be repaired. That reset the whole tree, including
  edits the user had made before the skill ran, which none of them checks for. They now ask, then
  `discard` only the paths the run changed.

### Fixed

- **`verify-citations` could write a git-exclude line into the wrong repository.** For a local
  project, its snippet ran `printf … >> "$(git -C "$DIR" rev-parse --git-dir)/info/exclude"` even
  when the check before it had found no repository, which appended to `/info/exclude`; and at a
  repository's top level `--git-dir` prints a bare `.git`, which resolved against the shell's own
  directory, some other repository. It now asks git for the absolute path
  (`--path-format=absolute --git-path info/exclude`, which also works in a worktree) and writes
  nothing outside a repository.

### Fixed

- **Tools are callable from clients that validate schemas as JSON Schema 2020-12.** The MCP SDK
  converts every tool's zod schema with no target, which falls back to draft-07 and stamps
  `"$schema": "http://json-schema.org/draft-07/schema#"` on each advertised `inputSchema` and
  `outputSchema`. The Claude desktop app's Code tab validates with a 2020-12-only Ajv, so it refused
  every tool (`… has an invalid outputSchema: JSON Schema declares an unsupported dialect`) before any
  call reached the server. The server now drops that root `$schema` from every tool it lists, for
  every client and in every `WEB_LATEX_MCP_NO_OUTPUT_SCHEMA` mode. MCP reads a schema without
  `$schema` as 2020-12. The schema bodies mean the same thing in both dialects, so the SDK's own
  draft-07 `Client` still accepts them. A test round-trips `listTools()` and compiles every
  advertised schema with strict 2020-12 and draft-07 validators, so a future zod construct that is
  specific to one draft fails in CI instead of in a client.

## [0.7.1] - 2026-09-25

### Changed

- **npm releases publish through trusted publishing (OIDC), with no stored token.** The v0.7.0
  publish was refused with `E404`, most likely an expired `NPM_TOKEN`; `publish.yml` now
  authenticates as this repository's workflow, runs on Node 24 (npm >= 11.5.1 is required), and
  no longer reads `NPM_TOKEN`.

## [0.7.0] - 2026-09-24

### Added

- **A `pdf_geometry` tool: measure the compiled page in points, instead of eyeballing a PNG**
  (#73, #80, #119, #132, #133, #139, #140). `render_pages` answers "does this look wrong"; it
  cannot answer "by how many points does this table's text overlap the figure frame above it", and
  reading a rasterized page is not measurement. `pdf_geometry` is read-only over the **last build**
  (it never compiles) and reports boxes in PostScript points with the origin at the **top-left**,
  matching `render_pages`' `clip` convention so the two compose: one to look, one to measure. Three
  kinds: `text` (pdf.js text items merged into per-line boxes — the `text` on each box is a
  truncated _label_ for it, not the document's content), `images`, and an opt-in `floats` index of
  `label -> printed page` parsed from the build-dir `.aux`. One standard governs all of it: **a
  rectangle nobody can vouch for is worse than an admitted gap**, since the failure mode of a
  half-built geometry tool is a caller measuring a collision that is not there, or missing one that
  is. Every refusal, flag and count below follows from that, and the gaps that remain are named in
  the schema and the tool description — which is not a claim that none remain.

  **What `images` is, and what it deliberately is not.** It reports image and form XObject
  _placement rectangles_ — what an `\includegraphics` figure actually occupies — recovered by
  walking the page's operator list with our own CTM stack. General **vector path geometry is out of
  scope**: pdf.js exposes `\fbox` rules and TikZ strokes only as raw path-construction operators in
  untransformed space, and replaying them correctly is a full graphics-state interpreter, so a frame
  drawn purely with rules and no embedded image is not reported **at all**. Text-only would have
  been half the work and would **not** have caught the case the tool was asked for, which is why
  `images` is in and `drawings` is out.

  Four things the CTM walk depends on, each failing _silently_ if lost — a plausible rectangle in
  the wrong place. A form XObject carrying a `/Group` (transparency) gets `null` where its `/BBox`
  should be, pdf.js having moved the real BBox onto the `beginGroup` op emitted just before it, so
  ignoring it falls back to the unit square and reports a box orders of magnitude too small — on
  every Inkscape export, alpha-bearing matplotlib figure and `opacity` TikZ picture, since pdfTeX
  copies an included PDF page's `/Group` onto the Form XObject. The walk carries that pending bbox
  forward, composed with the CTM as it stood at `beginGroup` (what pdf.js's own `beginGroup` clips
  against — implemented literally rather than assuming the group matrix and the form matrix
  coincide), consumes it at the paired `paintFormXObjectBegin` and clears it so it can never leak
  onto a later form; where a form still cannot be bounded the box is flagged **`approximate: true`**
  rather than passed off as measured. An `OPS.restore` on an empty stack must **not** throw: a
  truncated content stream is a real thing a document-controlled operator list produces, and failing
  the page over one bad operator would discard the images already found.
  `paintFormXObjectBegin`/`End` push and pop a CTM of their own although no `save`/`restore` pair
  surrounds them, because pdf.js saves internally when it executes that op. And a test imports the
  real `OPS` and asserts every op name the walk uses is a number — the walk is driven by a
  hand-rolled fake everywhere else, so a renamed op would otherwise yield `images: []` on every page
  with a fully green gate off-TeX.

  `paintInlineImageXObject` and `paintSolidColorImageMask` are measured too (both paint the unit
  square under the current CTM, verified against the installed pdf.js rather than assumed). pdf.js's
  four **batched** paint operators (`paintImageXObjectRepeat`, `paintInlineImageXObjectGroup`,
  `paintImageMaskXObjectGroup`, `paintImageMaskXObjectRepeat`) have no branch, because
  `page.getOperatorList()` sets the OPLIST rendering intent, which selects `NullOptimizer`, and only
  `QueueOptimizer` emits them — pinned by tests that reproduce the optimizer's own quad pattern
  through the real `getOperatorList()`, assert the batching preconditions are genuinely present and
  none of the four opcodes appears, and drive the page through the walk pinning every placement to a
  box. Keep them: a future batching would otherwise drop rectangles silently, a page of figures
  returning a fraction of them with every counter at zero.

  Two provenance rules on top. An image painted inside an **annotation appearance stream**
  (`pdfcomment`, form fields, `pdfpages` links — not plain `hyperref`, which emits no appearance
  ops) cannot be measured against the page's CTM, since pdf.js's `beginAnnotation` rebases the
  graphics state on a `baseTransform` the operator list does not carry and consecutive annotations
  accumulate the drift; those images are **skipped and counted**, per page, in
  `annotationImagesSkipped`. A `cm` operand overflowing to a non-finite value is refused — a `NaN`
  is not a measurement — and the last known-good transform carried forward, with every box measured
  after such a refusal carrying **`unreliableCtm: true`** so it cannot pass as a plain one. Both
  `annotationImagesSkipped` and `unreliableCtm` are published in the tool's `outputSchema`, pinned
  against the schema `tools/list` actually serves, since that is the only thing a caller can read
  to learn a field exists.
  **Coordinates come from the page's own viewport transform, not a hand-rolled y-flip**: every box
  maps through `viewport.transform`, taking the bounds of all four transformed corners, so a
  non-zero MediaBox origin and a `/Rotate 90` page (what `pdflscape` writes, and where a wide table
  lives) are both right — and `pdf_geometry` still composes with `render_pages`' `clip` there, since
  `clip` _is_ viewport-relative.

  **A text box is built in the item's own frame.** `itemFrame` takes the text matrix's two column
  directions scaled by the two lengths pdf.js measured along them — the exact parallelogram of a
  slanted matrix, not an orthogonal approximation — so a sideways table cell, a rotated axis label,
  a `pdflscape` page and a sheared run are all correct, and unrotated text reduces to the obvious
  numbers. The box stops at the font's **declared ascent** where there is one:
  `TextContent.styles[item.fontName]` carries `{ fontFamily, ascent, descent, vertical }`, the
  ascent a fraction of the em, and a test reads a real ascent out of a real PDF so the unit cannot
  drift unnoticed. **It is spent only where a font declares a usable one, and that is a guard rather
  than a refinement**: a baseline-to-em box over-covers the ink, which for a collision question is a
  false positive, while a box built from a guessed ascent under-covers — the false negative this
  tool exists to avoid. So a missing, zero, negative, non-finite or above-one ascent keeps the
  full-em box — byte-identical under rotation and shear too, pinned by a differential test against
  the un-cut box math — and pdf.js's own `0.8` text-layer default is never used; the non-finite
  case is reachable rather than theoretical (`ascent: NaN` for `Symbol` and `ZapfDingbats`, none at all on
  an `ErrorFont`). Descenders stay outside the box, so a descender touching a figure reads as
  clearance — spending the declared descent would grow every box downward and is left for its own
  change. A **vertical writing mode** (`WMode 1`, CJK) item is reported the other way round by
  pdf.js — `width` is the em across the column, `height` the advance down it — so its box runs down
  the column and is centred across the baseline, the PDF's own default vertical origin
  (`v = (w0/2, DW2[0])`).

  **Items merge into one line box against the running line's axes, never each item's own.** The
  candidate's origin projects onto the line's position axis (the perpendicular to its advance axis,
  oriented the way its cross axis points) and its em corners onto the line's advance axis, so the
  line coordinate is the candidate's perpendicular **distance from that line's baseline**, in
  points, with no `|origin|` term and no shear term in it. Projecting each item onto its own cross
  axis reads the two ends of a comparison off different rulers — a frame difference of _d_ displaces
  it by about `|origin| * sin(d)`, so far out on a page a fraction of a degree of per-item drift
  splits a line, and under shear `up · dir` is non-zero, so one step along the advance axis moves it
  by `advance * (dir · up)` and a naturally-placed slanted run comes back one box per item. Against
  the line's axes, `DIRECTION_TOLERANCE_COS` (1°) is the governing bound on frame disagreement
  everywhere on the page. **Axis-aligned horizontal text is bit-identical, not merely close**: for
  `b = c = 0`, `itemAxes` returns `dir = (1,0)` and `up = (0,1)` exactly, the position axis reduces
  to `(0,1)` bit for bit, and each projection is the identical floating-point expression — pinned by
  a swept differential test against an independent reimplementation, at and either side of every
  tolerance boundary. The one thing it loosens: a frame so flattened that `up` is within ~5° of
  `dir` has almost no perpendicular separation left between consecutive lines and two could merge,
  which takes a text matrix with essentially no height; every angle short of it separates.

  Each item is read in the frame its writing mode actually uses — for a vertical item the **column**
  takes the place of the baseline and the **run down it** (the negated up axis, a vertical run advancing backward along `up`) the
  place of the advance, so a CJK column is one box, while horizontal items are untouched, the
  swapped pair being the same pair. Two items in different writing modes are never one line, and
  since a 270°-rotated horizontal item and an upright vertical one share their advance and cross
  axes, the writing mode is compared on top of the raw frame axes rather than inferred from them.
  Adjacency is bounded **below as well as above**: an item may overlap the running line backward by
  at most its own em (accents are painted back over the preceding glyph) and anything further starts
  a new line — unbounded below, two nodes hundreds of points apart emitted right-then-left become
  one box spanning blank paper in reverse reading order. That allowance is the em (`width` for a
  vertical item), never `height`, which for a vertical item is the whole run's advance and would let
  an item several glyphs back up the column join; and a vertical item's grouping extent is its own
  (`±em/2` across, a full advance back down), since measured the horizontal way an item's
  along-extent sits a whole advance behind its glyphs and a column ending in a short glyph splits.
  **Grouping is computed from the full-em corners in every case** — including an item whose box was
  cut to an ascent or rebuilt for vertical mode — because under a sheared matrix the up axis leans
  along the reading direction, so a shorter box would move the along-axis reach and silently regroup
  lines; a test pins one line either way. What still does not merge: two neighbouring columns (their
  cross coordinates differ by a column width), and a horizontal line sharing a coordinate with a
  vertical one. A generated property asserts what matters for a collision question — a merged line's
  box **covers every item merged into it**, across rotated, sheared, horizontal and vertical runs —
  with a per-mode merge count asserted alongside so it cannot pass vacuously on a rule that never
  merges.

  **The `floats` index is parsed from a document-controlled file, so it never believes a
  fabrication.** `render_pages` and `extract_text` both read this index for label→page lookup, so a
  fabricated label whose key collides with a requested one would resolve to a page the tool then
  renders **with confidence**, off bytes the document itself controls — the failure shape the rest
  of the server refuses by construction. The `.aux` is read with a brace-balanced scanner (a naive
  `\{([^}]*)\}` regex mis-parses hyperref's five-group `\newlabel`), a malformed or half-written
  entry is skipped rather than thrown on, and **no path or string it names is ever opened, resolved
  or stat'd** — the same rule the compile log is held to. Work is bounded on two independent axes, a
  per-group scan budget and an iteration counter that does not depend on how many entries parse, so
  the worst case is constant per marker and linear in the file: the parse is synchronous inside
  `runExclusive`, so an unbalanced `.aux` going quadratic blocks the whole stdio server, and past
  60 s `reclaimIfStale` lets a peer delete this session's live lock. `MAX_GROUP_SCAN` (4096) caps a
  group read and `GROUP_SKIP_SCAN` (16384) is a larger budget used only to _locate_ an over-budget
  group's true end; the scanner advances past a group whose end it has located, and where it has
  not, that group's brace walk is **carried forward instead of dropped** — each later marker is
  resolved by continuing the walk to the marker's index, which either finds the close first
  (ordinary text after the group, parsed as usual) or does not (the marker is inside the group, and
  is refused) — so a real entry after such a group is still reported and a `\newlabel`-shaped string
  buried past the budget is not. The continuation cursor only moves forward, so every character is
  walked at most once across all continuations: one extra linear pass at worst on top of the
  `indexOf` pass, group reads still bounded by `PARSE_BOUND * (MAX_GROUP_SCAN + GROUP_SKIP_SCAN)`.
  Re-walking the group per marker instead walks straight back into the quadratic blowup these
  budgets exist to prevent, and a growth-ratio test pins the open-span path against it. A group that
  closes **nowhere** in the file **fails closed**: a brace walk reaching end-of-file without the
  depth touching 0 _proves_ the group is open at every position after it, and the walk is already
  paid for, so every later marker is a counted refusal rather than a float. The cost is narrow — on
  an `.aux` cut off mid-write by a killed `latexmk` the unclosed group is the last thing in the
  file, so there is nothing after it to refuse and every entry before it is still reported; what is
  given up is recall on a file where a group opens, never closes, and legitimate entries follow it
  anyway. `searchFrom` is never advanced on any of these branches, so the "never advance on a guess"
  rule holds throughout. The index also drops cleveref's `@cref` shadow entries, whose "page" field
  is `[1][1][]1` and not a page at all and which otherwise doubled every document's float budget —
  the pure parser stays faithful to the file and the filtering sits one layer up.

  **Five counts, kept apart, none folded into another**, because each names a different cause and
  reporting one as another names a cause that did not fire. `floatsOmitted` is the entry cap (200,
  counted against every `\newlabel` actually found, exactly, up to the parser's own much larger scan
  bound). `floatsOmittedBySize` is the rendered-size bound: `src/lib/floatsBudget.ts` charges each
  entry its real `JSON.stringify` cost (a backslash-dense `\label` key roughly doubles in width once
  encoded) against a 20000-character budget — `CONFLICT_CONTENT_BUDGET`'s number, deliberately,
  since this is the same defect fixed for push conflicts — and cuts the tail, never reordering or
  cherry-picking by size, with the `note` naming whichever bound fired and never the other.
  `floatsDropped` means "there was a real entry here and you are not getting it" — an over-long
  field, or an entry whose own `\newlabel` group ran past the scan budget. `floatsRefused` means the
  opposite, that nothing is missing at all: text inside another entry's argument, declined rather
  than believed. And `floatsIndeterminate` is a `\newlabel` whose own key group never closes, added
  to **neither** neighbour: with no key text there is nothing to test for a cleveref shadow record,
  so calling it dropped could report a record excluded by design as a lost float, while calling it
  refused is a claim about the bytes that nothing supports. It says only that a marker existed and
  nothing can be said about it. Length is not the line — a key `{` that never closes is counted
  whether the scan ran out of budget or out of file — but a `\newlabel` followed by no `{` at all is
  not, since nothing was opened and there is no evidence an invocation was ever there. The rest is
  capped with an accompanying count too, so a truncated answer is never a silent one: 4 pages per
  call (lower than `render_pages`' 8 — a page of boxes is far more output than one PNG), 300 text
  lines and 100 image rects per page.

  The geometry math (`src/lib/pdfGeometry.ts`) and the `.aux` parser (`src/lib/auxFloats.ts`) are
  pure and hold no pdf.js import, so both are unit-testable without a PDF; the service work reuses
  `PdfRenderer`'s `openDocument`, which turns a missing `@napi-rs/canvas` into a message naming that
  package rather than a "DOMMatrix is not defined" or a claim that the PDF is broken — pdf.js cannot
  even be _imported_ in Node without that backend (`pdf.mjs` evaluates `new DOMMatrix()` at module
  scope), so loading it **after** `openDocument` rather than before is load-bearing, and a test pins
  it. Asking for `floats` alone opens no PDF and needs no canvas backend — a float index is text
  parsing — and does not need a PDF to _exist_, so a compile that wrote an `.aux` and then died on a
  missing package still has a readable float index. The tool takes `requireProjectDir`, never
  `requireGitProject`, so it works on a `mode: 'local'` project like `compile` and `render_pages`;
  it takes `runExclusive` for the same reason `render_pages` does (a peer session's `compile` can
  rewrite the build dir mid-read); and it writes nothing into the project directory or the temp
  build dir — an integration test diffs both across a call, since the project directory alone would
  not catch a scratch file written into the build dir. It is not true that it writes nothing
  _anywhere_: taking the lock creates `<workspace>/.sessions/<id>/` and leaves the directory behind
  (the lock file itself is removed), exactly as `render_pages` does, pinned from an empty workspace
  root.

- **`render_pages`, and `pageCount` on `compile`: the model can see what it compiled** (#105, #112,
  #73). `compile` returned a log and a PDF path; `viewer` served a pdf.js page for a _human_. Neither
  put pixels where the model could read them, so every visual question had to be answered outside the
  server — in the session this came from, a 140x100cm poster, by installing PyMuPDF and rasterizing by
  hand six times, which moved the whole compile-look-fix loop into the shell and lost the structured
  error payload on the way. `render_pages` rasterizes the last compiled PDF to PNG and returns the
  images inlined **and** as written paths — inlined up to a 5 MB budget on the base64-encoded payload,
  after which the tail comes back as paths only and says so, rather than as a hole in the middle of the
  page range; a single page too big to inline is told what to do about it. At most 8 pages per call,
  the rest reported in `skippedPages`. It takes `pages` or `labels`, a `clip` rectangle in page
  fractions, and two sizing knobs: `maxEdgePx` (default 1600) fits the returned image to a token-sane
  size, while `dpi` sets the resolution directly and wins — the precise path being to clip one column
  and ask for 150 dpi, or up to 1200 for a narrow clipped band, where the 4000px hard cap still leaves
  roughly 16.7 px/pt: fine enough to measure below a point, and to tell two table heights apart. A
  request that reaches the cap says so (`clamped`) and reports the resolution actually used. Read-only
  over the last build: it never compiles.

  **`labels` renders the page a float actually landed on.** After moving a float its page is exactly
  what is unknown — the question is never "page 8", it is "the page the table I just restructured
  landed on" — and answering it meant grepping the server's own hash-named build directory from a
  shell, a private path nothing in the tool surface points at and a client with no shell cannot reach.
  Labels resolve through the same `readAuxFloats` `pdf_geometry` uses — no second `.aux` parser — and
  the result echoes the `label -> page` mapping it used, in `structuredContent`, in the text channel
  and in `note`, so a caller can see what was actually rendered. `labels` and `pages` together are
  rejected rather than one silently winning, following `diff`'s `ref` + `staged` precedent. Lookups
  use their own bound rather than `readAuxFloats`' 200-entry _reporting_ cap: a real manuscript clears
  200 `\newlabel`s easily, and reusing a report cap for a search answers "no such label" for a label
  plainly in the file — a wrong answer, not a truncated one.

  **The printed page is not the page index, so the PDF is asked rather than guessed.** The `.aux`
  records what a label _printed_, never how many pages preceded it. A PDF carries a `/PageLabels`
  number tree mapping page index to printed label exactly, whatever the scheme, and pdf.js exposes it
  as `getPageLabels()`, so resolution is a lookup — printed page from the `.aux`, page index from that
  array — with nothing inferred. `PdfRenderService.pageLabels()` reads it; `src/lib/labelPages.ts`
  stays pure over plain data and receives the array as a parameter, which is what keeps every refusal
  unit-testable without pdf.js or a TeX install.

  **`getPageLabels()` returning `null` is the common case, not an error** — a plain `article` has no
  such tree — so the printed-page-as-index fallback stays, correct precisely when nothing renumbered,
  with two heuristic refusals live on it: a printed page that is not a decimal integer is refused, and
  so is an _arabic_ label in a document where any label prints as a roman numeral, because those are
  precisely the ones whose number would render the wrong page while looking perfectly reasonable. An
  empty or all-blank tree counts as "no tree" for the same reason: believing a degenerate one would
  refuse every label in the document, replacing a working heuristic with a wrong certainty.
  (Changed before release: without `/PageLabels` the printed page is now only a candidate, accepted
  when that PDF page's own folio reads it and a neighbouring page's folio reads the adjacent
  number; a document whose arabic numbering restarts, or whose last page reads as a decimal other
  than the page count, is refused; and a beamer deck's tree, which numbers frames rather than slides,
  is never looked up in — overlays and `pgfpages` layouts make it prove nothing.)

  **Two refusals keep the lookup from becoming a new way to be wrong.** A printed page the tree prints
  on **no** page is a stale `.aux` (`printedPageAbsent`), not an unknown label — the `\newlabel` is
  right there, and calling it missing sends the caller hunting for a typo instead of recompiling. A
  printed page the tree maps to **several** pages (`ambiguousPrintedPage`) is legitimate — a restarted
  `\pagenumbering`, an unnumbered front page — so both candidates are named and nothing is rendered;
  taking the first match would re-create the wrong-page failure by another route. Every refusal names
  the way round (`pdf_geometry kinds: ["floats"]` plus explicit `pages`).

  **It takes `runExclusive` despite being read-only _with respect to the project_**, because it reads
  the build-dir PDF a peer session's `compile` can rewrite mid-read, and writes its PNGs into that same
  build dir — never inside the project, since a `local` project is edited in place, not littered in
  place. So it can wait on, or time out against, a peer holding the lock, and it creates
  `<workspace>/.sessions/<id>/`: "writes nothing" is never true of it without that caveat, and its
  description says so.

  **The native canvas backend is optional, and its absence is a warning.** `@napi-rs/canvas` is
  declared as an **optional** dependency and reported by `doctor` (`pdf-render`). The page count needs
  it as much as the rasterizing does: pdfjs-dist 6.1.200 evaluates `new DOMMatrix()` at module scope
  and this backend is what supplies that global in Node, so without it the `import` itself throws and
  pdf.js cannot open a PDF at all — reported as the missing backend rather than as a broken document.
  The dependency is incidental rather than intrinsic, and `isNativeCanvasMissing`'s comment says which
  of the two it is: given stub globals the same build reads `/PageLabels` and extracts text with no
  canvas. The check is a _warning_ and never a failure, because nothing else the server does —
  compiling, the viewer, editing, the whole git side — needs it. (Changed before release: the
  server installs that stub `DOMMatrix` itself when the backend is absent, so only rasterizing
  needs it, and the backend's absence no longer stops a PDF from being read.)

  **The cheap half is `compile`'s new `pageCount`**, read from the PDF rather than the log: a layout
  that spilled onto a second page is neither an error nor a warning in TeX's eyes, so one number is the
  only thing that reports it — and the log's own `Output written on … (N pages` line is hard-wrapped
  at 79 columns, which is a second reason not to parse it. A count that cannot be read never fails a
  compile that produced a document.

- **`extract_text`: read the compiled page's text layer** (#105, finding 5). `render_pages` returns
  pixels, so verifying _typeset text_ meant reading an image — and some questions are a few pixels
  wide. The case that filed this one: an `\xspace`-defined macro next to a `\textsubscript{}` risks a
  spurious space, and with no text extraction the check became comparing the PDF's byte size across
  compiles, which is a coincidence that would not survive a reflow. `extract_text` returns the
  requested pages' text layer, line by line, and takes `labels` exactly as `render_pages` does — so
  "read the page my table landed on" is one call. It is also the way to read a compiled page at all on
  a client that cannot display images.

  **One text extractor, not two.** It reuses `mergeTextLines` and the walk `pdf_geometry`'s `text` kind
  already runs, with the boxes dropped and that kind's 160-character per-line label cap lifted —
  `pdf_geometry kinds: ["text"]` already carries each merged line's string, and what was missing was a
  cheap whole-page _reading_ answer rather than geometry to wade through. That gap is real:
  `pdf_geometry` caps at 4 pages and 300 lines, truncates each line to a box label, takes no `labels`,
  and costs several times the tokens for the same words. Its row in `docs/tools.md` says outright that
  its `text` carries the line's string, and points here for reading it.

  **Budgets that say what they cut.** 4 pages per call (the rest in `skippedPages`), 20000 characters
  per page. The per-page cut is a **suffix** — the first line that does not fit ends the page — so what
  comes back is a contiguous prefix in drawing order rather than a budget-packed sample of scattered
  lines, and `linesOmitted`/`charsOmitted` count it. Lines are never re-sorted: the order is the order
  the PDF draws them, which is reading order for ordinary LaTeX output and is not claimed to be in
  general.

  **It takes the per-project lock**, the third deliberate exception to "a read-only tool does not lock"
  after `render_pages` and `pdf_geometry`, and for the same single reason: what it reads is the temp
  build dir, which a peer session's `compile` rewrites in place. Its description says so, including
  that it can wait on or time out against a peer and that it creates `<workspace>/.sessions/<id>/` — so
  "writes nothing" is never stated without the caveat.

- **Crossref and OpenAlex as reference backends, behind a resolver — and a DBLP client that sniffs the
  body instead of trusting the status** (#72, #74). `dblp.org` now sits behind an anti-bot
  proof-of-work wall which it serves with **HTTP 200** and an HTML body, so `res.ok` was true and
  `search_references` died inside `JSON.parse` with `Unexpected token '<'`, naming neither DBLP nor the
  cause; `add_citation` was dead the same way, and `fetchBibtex`'s guard was "the body contains an
  `@`", which the interstitial's `@licstart` JS-license header walks straight through. Every backend
  now sniffs the payload (`assertApiBody`), checks the JSON _shape_ (`assertApiShape` — a 200 carrying
  an error envelope is a failure, not a silent zero-result), and wraps transport failures
  (`fetchOrUnavailable`/`readBodyOrUnavailable`, covering a body that stalls after the headers arrive
  as well as a rejected fetch, since the timeout signal governs streaming too). Requests carry
  `AbortSignal.timeout`, and that arm is exercised by a test that does **not** inject a `fetch` —
  every other test does, so the real arm never ran and deleting it left the suite green while the
  error text kept promising "timed out after 15s"; the lint rule guarding the constant could not see
  that, nor the hand-rolled `setTimeout(() => controller.abort(), …)` a contributor is likeliest to
  paste, and both are covered. Mapping is guarded to the same standard: an element-level throw becomes
  the same `BackendUnavailableError` path **structurally**, so the guarantee holds for fields nobody
  has thought of yet, and a `null` hit list is refused explicitly rather than read as zero results —
  a malformed-but-well-enveloped 200 like `{"result":{"hits":{"hit":null}}}` otherwise escaped as a
  raw `TypeError`, which the resolver rethrows by design, and aborted the very fallback chain this
  feature exists for.

  **Selection is an assertion, never an inference.** `ReferenceResolver`
  (`src/services/referenceResolver.ts`) chooses which service answers, on exactly the
  `CompilerResolver` rule: an unset `WEB_LATEX_MCP_REFERENCE_SOURCE` is a _default_ that may be
  substituted (dblp → crossref → openalex) with the substitution reported in `hint`/`fallbackFrom`,
  never silently; the env var, or a per-call `source:` on `search_references`, is an _assertion_, and
  an unreachable backend is then an error rather than a quiet switch to a different bibliography. A
  configured source that is not marked chosen is tried **first** and stays substitutable — an unchosen
  `latexmk` is still the compiler that runs — rather than being ignored outright as neither a choice
  nor a default. Only `BackendUnavailableError` substitutes: a search that succeeds with **zero hits
  is an answer** and is returned as-is, since falling through would turn "DBLP has never heard of
  this" into "here is what Crossref found instead". And a **404 naming a record is the backend
  answering, not the backend being down**, so it is a plain `Error` rather than the
  `BackendUnavailableError` whose own doc says it is never a caller error — harmless while
  `fetchBibtex` has no fallback, wrong the moment one is added; a 404 on a _search_ stays unavailable,
  since there it means a wrong path rather than a missing record.

  **A value that names no backend at all is the third case.** It neither throws at startup — which
  killed every tool in the server, `read_file` and `push` included, over a setting that governs one —
  nor falls back, which would answer from a bibliography the user did not name. It is remembered,
  logged to stderr, reported by `server_info` as `referenceSourceInvalid`, and refuses the **unpinned
  search alone**, while a per-call `source:` still works and `fetchBibtex` is untouched.
  `search_references`' registered description and the `source` field's own schema text — which a model
  reads while filling the call in — are derived from that same config, so they cannot disagree, and
  both say plainly that an unpinned call is refused in that state.

  **`fetchBibtex` routes by the key, never by the configured source**, and substitutes nothing: a key
  names one record in one backend. Record keys are namespaced (`dblp:conf/cvpr/HeZRS16`,
  `crossref:10.1109/CVPR.2016.90`, `openalex:W2194775991`) and parsed in one pure module,
  `src/lib/referenceKey.ts`, whose validation is a **security boundary** — bare DBLP keys, bare DOIs
  and service URLs still parse, so every existing caller, doc and skill keeps working, and one
  normalizer now serves both the key parser and `DblpService`, closing the last _copy_ of that
  boundary (the service's own stripped any host, so `fetchBibtex('https://evil.com/rec/conf/x/y')`
  yielded the DBLP key `conf/x/y`). All three routes judge dot segments the same way, **per segment**:
  `normalizeDblpKey`/`normalizeDoi` rejected `..` but not a lone `.`, and WHATWG normalisation deletes
  such a segment from the request URL, so `dblp:conf/./x` fetched `conf/x` — the caller's identifier
  rewritten into a different, valid one, which is the one thing a security boundary may not do. A dot
  _inside_ a segment (`10.1109/CVPR.2016.90`) is untouched.

  **OpenAlex publishes no BibTeX at all**, verified against the live API, so its records are fetched
  from Crossref by DOI and a record with **no** DOI is refused rather than assembled from metadata:
  `OpenAlexService` has no `fetchBibtex`; the resolver's `DoiBackend` records that intent, and a
  runtime assertion in `test/unit/openalex.test.ts` is what actually pins the absence, since
  structural typing would admit a grown method.

  **Entry text is cut to its own bytes, and an unbalanced body fails open.** A real BibTeX entry header
  at a line start is required before any text reaches a bibliography, and `bibtexEntrySpan` cuts to the
  leading run of entries at both ends, so neither a proxy banner in front nor a `<script>` behind is
  appended — while a body whose braces never balance is returned **whole** rather than truncated, since
  a truncated entry is worse than an untidy one. A closing delimiter is believed only when it stands
  **alone on its line** and **outside the other delimiter pair**: the old guard caught only a stray
  closer _mid_-line, so one that happened to end its line cut an entry in half
  (`abstract = {Sentence one} extra }`), and a paren-delimited entry tracked no braces at all, so a
  `)` inside a braced value left a dangling `{` that would break every entry after it in the `.bib`.
  A whole entry on **one line** — Crossref's `/transform` shape, whose closer can never stand alone
  — is believed closed when the closer ends the line its header opened and no unmatched closer of
  the entry's pair follows anywhere after it; trailing junk that itself carries one
  (`<script>}</script>`) cannot be told from an entry continuing below, and comes back whole.
  Every test only ever fails open. A `@string` macro _preceding_ the first entry is cut with the rest of
  the preamble; one _between_ entries stays inside the span, since the entries after it need its
  macros (neither DBLP nor Crossref emits a leading one).

  **`WEB_LATEX_MCP_CONTACT_EMAIL` opts into Crossref's and OpenAlex's polite pool** — read only from
  that variable, **never derived from `git config user.email`**, validated so it cannot alter a request
  URL or inject a header, and reported by `server_info` only as _whether_ one is set, never the
  address. A malformed value is reported separately as `contactEmailInvalid`, a **boolean and never the
  value** — deliberately unlike `referenceSourceInvalid`, which carries the user's own typo of a
  backend id, where this one would carry an email address into a model's context; without it the polite
  pool was silently off with nothing a tool could reach to explain it. `search_references` and
  `add_citation` report which service answered (`source`, and `via` when OpenAlex was bridged through
  Crossref), and `docs/tools.md` documents the three reference fields `server_info` returns.

  The DBLP wall itself is upstream and unfixed: an unpinned lookup works today by substituting
  Crossref, but `source: "dblp"` still fails until DBLP exempts its API paths from the challenge.

- **`compile` trims what it reports, and says what it actually did** (#73, #75, #78, #60).

  **`warningsFilter`.** A warning-heavy paper returns ~127 KB of result, and every `Overfull \hbox`
  in it ships **twice**: once structured in `warnings[]`, once as raw text in `logTail`, because
  `KEEP_PATTERNS` keeps box lines and `logTail` comes back on every compile. So the filter trims
  **both channels or neither** — `warningsFilter` takes `file`, `rule` and `excludeRule`, and
  `filterLog` takes a `keepWarning` predicate so `logTail` drops exactly the lines `warnings[]`
  dropped. A filter over `warnings[]` alone — the obvious shape — would cut barely half of what it
  claimed to cut while reading as though it had worked. `warningsOmitted` counts what went, so a
  filtered list is never silently a subset. Matching is **exact and literal**, never globs, prefixes
  or case folding: the house rule for any caller-named string handed downstream, and for the same
  reason — a typo must fail conspicuously rather than match everything. An **empty array constrains
  nothing**: `{file: []}` is the same as an absent `file`, not a filter that matches nothing, so a
  programmatically built list that comes out empty _widens_ the result to every warning instead of
  narrowing it to none; the tool schema and the docs both say so.

  Three things it deliberately does not do. It never filters **errors**: `ALWAYS_KEEP_PATTERNS` is
  checked **before** `isWarningLine`/`warningRuleOf`, because a line can be both, and it holds
  `FILE_LINE_ERROR`, mirroring `parseLog`'s own branch order — `parseLog` tests `FILE_LINE_ERROR`
  first and `continue`s, so `./main.tex:12: Package foo Warning: …` is an _error_ to it whatever its
  message says, and a `filterLog` that called the identical line a filterable warning would cut the
  one line reporting the failure out of `logTail` under any filter at all. Keep the two
  classifications one partition; do not let a future always-keep pattern drift from `parseLog`'s
  branch order. It never filters a **rerun hint** or the `Output written on` summary:
  `LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.` matches both a
  warning pattern and a hint pattern, and the always-keep check being first is what makes the hint
  win; biblatex's `Please (re)run Biber on the file:` — literal parentheses, which the `Please
rerun` pattern never matches — is kept too, since on a biblatex paper it is the only line saying
  the bibliography is stale. That pattern stays narrow (`Please \(re\)run`), never a bare substring
  match: the log is document-controlled — a `.tex` can emit anything through `\PackageWarning` or
  `\typeout` — and an unanchored `/\(re\)run/` lets a document pin an arbitrary line (an `Overfull
\hbox` that merely contains the literal `(re)run`) past every caller's `warningsFilter`. It does
  not claim to make forgery impossible: a document phrasing its line as `Please (re)run …` is by
  definition indistinguishable from biblatex's own hint, exactly as the neighbouring `Please rerun`
  and `may have changed` patterns already are. What the narrowing buys is the removal of the cheap
  accidental case, and the residual is bounded to `logTail` verbosity — it never reaches
  `warnings[]`, `warningsOmitted`, an error classification, or a snippet-provenance decision. This
  protection is `logTail`-only on purpose: the structured entry for a rerun hint (rule `biblatex`,
  and the `Label(s) may have changed` one alike) stays filterable, so `excludeRule: ['LaTeX']` still
  drops it from `warnings[]` and counts it in `warningsOmitted`. Do not "fix" that asymmetry later
  by protecting the `warnings[]` entry too; it changes what `warningsOmitted` means, not just its
  number. And it leaves `rawLog: true` alone, because raw means raw — `warnings[]` is still filtered
  there, and both descriptions say so rather than letting a caller discover the asymmetry.

  When a filter rejects _every_ diagnostic line, the tail says so in one sentence. The raw
  last-15-lines fallback — what a log with no diagnostics at all gets — must **never** fire there:
  it is unfiltered and un-de-noised, so it would hand back the very warnings `keepWarning` rejected
  plus the font and PDF-statistics noise `filterLog` exists to strip, the feature exactly inverted
  and silently. `matchedBeforeFilter` is what tells "nothing diagnostic" apart from "the filter
  rejected everything", and the two emptinesses stay on separate branches.

  **One judge, both channels.** The composition of `withoutUnopenableLocation` with the filter is
  `makeWarningJudge(withheld, filter)` in `src/lib/warningFilter.ts`, not inline in
  `src/tools/compile.ts` — it is the load-bearing invariant of the whole feature and the one thing
  stopping a `file` filter that names a symlink-escaping path from emptying `warnings[]` while
  leaving that very warning sitting in `logTail`, and in a tool it was unreachable from a unit test.
  The judge strips the withheld location from its own candidate **first**, so a withheld path is
  judged on the `file` the caller actually sees (`undefined`), not the log's original — `logTail`'s
  side derives `file` from the paren stack, which knows nothing about a withheld path. The unit
  layer pins that directly, along with the cases just outside every clause (a fileless warning
  against a `file` filter, a rule-less one against `excludeRule`) and the predicate's **idempotence**:
  one judge, asked about the structured side's already-stripped candidate and about the tail side's
  paren-stack candidate still carrying the real path, must answer the same, since that equality is
  what "both channels or neither" means. The factory returns **`undefined`** when the filter
  constrains nothing, deliberately, rather than an always-true predicate: "skip the machinery — and,
  in `filterLog`, the paren-stack bookkeeping — entirely" is then the same value as the judge rather
  than a second derived boolean beside it that can drift. Claim no more than that: `compile` still
  branches on that one value twice, once per channel, so a one-sided edit remains possible and
  remains something to review for, and `makeWarningJudge`'s doc comment says so in those words
  rather than advertising a guarantee the shape does not give.

  **Unchanged unless used.** With no filter passed, `filterLog`'s output is byte-identical and the
  paren-stack bookkeeping does not run at all — the only thing that makes this safe to add to a tool
  every session calls. Two tests pin it, and they prove different things: a differential test
  compares `filterLog`'s output against itself under options that must be inert (no filter, an
  accept-everything `keepWarning`, an inert `baseDir`) across thousands of generated logs, proving
  a filter accepting everything is a true no-op — but it is structurally blind to a change that
  perturbs both sides identically; a committed sha256 digest of that corpus's output, at every
  `maxLines` choice, is what pins byte-identical output against a `KEEP_PATTERNS`/`unwrapLines`
  regression the self-comparison cannot see. Neither can observe an `ALWAYS_KEEP_PATTERNS` change at
  all — the digest never passes a `keepWarning`, and the self-comparison passes `() => true`, which
  keeps a line whichever side of the always-keep branch it falls on — so the always-keep cases are
  pinned by hand-written tests. Do not retire one of those as redundant with the corpus; the corpus
  does not cover it.

  **`rebuilt`, `pdfMtime`, `lockWaitSec`, `lockHeldBy`** (#60). The build dir is stable per project
  path and shared by every session on a clone, so right after a peer compiled, latexmk finds nothing
  to do and `compile` returns `success: true` in 0.08 s with the peer's PDF — indistinguishable from
  a rebuild off your own edits. `rebuilt` says which it was: the build-dir PDF's mtime or size
  changed between just before and just after the run, never parsed from backend stdout (discarded
  once a `.log` exists, and tectonic emits none) and never from the wall clock. `pdfMtime` is read
  from the build output before the surfacing copy, whose mtime is fresh on every call, and rounds
  the stat's fractional milliseconds rather than truncating them (an mtime set to an exact
  millisecond read back one ms early on CI). `lockWaitSec` covers both layers — a second call in the
  same process waits on the in-process mutex first, and that wait is counted, with `lockHeldBy`
  naming this session — while `durationSec` still measures the backend run alone. `lockHeldBy`
  otherwise names the session that held the lock, which `LockTimeoutError` already named but only
  after the 30 s timeout. The lock reports more and acquires exactly as before: `withFileLock` and
  `runExclusive` hand the acquisition to their callback, which every other caller ignores.

- **`compile` preflights its backend, and substitutes only a default nobody chose** (#48). On a
  machine with tectonic and no latexmk, `compile` died with a raw `spawn latexmk ENOENT` naming
  neither `WEB_LATEX_MCP_COMPILER` nor the backend on `PATH` that would have worked: both backends
  implemented `isAvailable()` and nothing called it. `CompilerResolver` now picks the backend that
  will actually run, and what licenses a substitution is whether the backend was **chosen**, not
  whether it is available — an unset `WEB_LATEX_MCP_COMPILER` leaves `latexmk` a _default_, so a
  missing one is replaced by whatever is installed and the swap is reported in the result's `hint`;
  set (to anything, `latexmk` included), or named per call through the new **`compiler`** input, it
  is an assertion and a missing backend is an error naming what _is_ installed, both routes out, and
  — when the offer is tectonic — that it yields no source snippets at all. Same shape as
  `followSymlinks`: an assertion, never an inference. The result's new **`compiler`** field is the
  backend that ran. `isAvailable` treats only ENOENT as absent and rethrows anything else (EACCES,
  EAGAIN), so fork pressure cannot silently switch a healthy machine's engine, and a positive answer
  is memoized. `doctor` grades the backend-dependent checks (`engines`, `package-manager`) against
  the **effective** backend, and only when it is installed: a tectonic-only machine was reported
  broken because it has no system engine and no `tlmgr`, which tectonic needs neither of.

- **Every by-name comparison in `commit`, `push` and `status` that decides what is staged, owned,
  settled or reported folds case exactly where git does** (#67, #70, #93, #106).
  `src/lib/caseFold.ts` is the one home of git's ASCII fold (`foldCase`) and the exact-first
  `canonicalNames` lookup. `coversPath`, `peerOwnership`, `attributePeers`, `uncoveredPaths` and
  `ShadowStore.settle` take an optional fold; `commit` (in every scope — the ownership check, the
  rescue, the session-scope `paths` filter and the settle), `push` (peer attribution, and the split of
  dirty paths into mine and theirs) and `status` (its session/other split) pass it exactly when
  `GitService.isCaseInsensitive(dir)` says so, and stay byte-exact otherwise. The source of truth is
  **`core.ignorecase` in the clone's config, never the filesystem**: a repository copied onto a
  case-insensitive disk without that setting keeps every comparison byte-exact, as git itself would.
  The fold is **ASCII-only**, matching git — U+212A KELVIN SIGN stays unfolded — and the **exact
  spelling wins** when both exist. The lib functions stay pure: the fold is a parameter, the decision
  is the caller's, and one handler resolves it once per call and threads it into every branch, so the
  ownership check, the rescue, the path filter and the settle cannot be handed two separately-derived
  answers — they agree by construction rather than by a memo. That is a structural rule, not a
  performance one: `isCaseInsensitive` is promise-memoised per directory, so a second ask is a `Map`
  lookup and the `git config core.ignorecase` spawn happens once either way.

  On a `core.ignorecase` clone (git's default on macOS and Windows) this is what changes: a live
  peer's `Notes.txt` entry protects a request naming `notes.txt`, where `git add` used to stage the
  peer's lines under this session's name, and a `push` refusal used to attribute git's `Notes.txt` to
  nobody. A case-spelled path through `scope: "paths"` or `scope: "all"` with `paths` — deleting a
  tracked `Notes.txt` and naming `notes.txt` — is resolved to the index's spelling before `git add`,
  because a literal pathspec never folds, instead of surfacing git's raw "did not match any files".
  `canonicalNames.resolve` also folds the longest tracked **directory** prefix, exact-first at every
  depth (`sub/new.tex` while HEAD tracks `Sub/` stages under `Sub/`), so a new file never opens a
  second, case-differing directory in the tree. A session that writes both spellings of one file gets
  one shadow entry — the store folds the second key onto the first, since on that filesystem
  `shadow/notes.txt` _is_ `shadow/Notes.txt`, and a second entry used to overwrite the first's shadow
  with HEAD's bytes so the commit found nothing staged. And an index that still spells one file two
  ways is refused by name before anything is staged, where the second `update-index --cacheinfo` used
  to win silently.

  Each fold has its `core.ignorecase=false` twin proving the comparison stays byte-exact there, and
  every test forces `core.ignorecase` explicitly rather than inheriting it from the host filesystem —
  it is false by default on the Linux box the gate runs on, so an unforced assertion passes against
  unfixed code. The integration coverage asserts a true `committed` plus real git state (HEAD moved,
  `git show HEAD:<path>` holding the edited bytes under HEAD's spelling, working tree clean) rather
  than merely "no error", because without the fold the call is **not** an error: the request falls
  into the rescue branch, whose own `coversPath` does fold, and a rescued path is deliberately kept
  out of `stageable` — so the vacuous version of the test sees a reassuring `committed: false` while
  the edit sits uncommitted in the working tree. One gap stays open and is named in the file header
  rather than left for the next reader to assume away: `ignoredUnderRequestedDirs` and `mergeIgnored`
  are exercised folded but only widen the `ignored` report, so nothing fails if their fold is
  dropped (#70).

- **`shelve` / `unshelve` / `list_shelves`: set uncommitted work aside without publishing or
  destroying it** (#86). `push` refuses to rebase over an uncommitted tracked file, and every
  exit it offered either **published** that file (`commit`, or a `message` on `push`) or
  **destroyed** it (`discard`). The ordinary case — push section A while section B is
  mid-sentence — had no safe way out. `shelve` is that exit, and `push`'s refusal now names it,
  between the two publishing routes and the destructive one.

  **Deliberately not `git stash`.** A stash is a ref inside the shared clone: invisible to every
  tool here and to every peer session, which is how an unreclaimed `stash@{0}` sat for five days
  in a real session. A shelf lives under `<workspace>/.sessions/<project>/shelves/`, outside the
  clone, and is labelled and listable. It is also **project-scoped, not session-scoped** — any
  session on the project can list and reclaim one, because a shelf only its author can see
  reproduces the problem it replaces.

  Two orderings carry the safety and are not implementation details. **The shelf is fully on disk
  before the working tree is touched**, so a crash leaves the work duplicated rather than gone —
  and because a restore whose bytes are already on disk is treated as a no-op rather than a
  conflict, reclaiming it afterwards is not wedged. And **the manifest is written last**, so a
  half-written shelf is invisible rather than corrupt: `list_shelves` skips it and `unshelve`
  does not know it.

  `unshelve` **refuses rather than overwrites.** If anything is at a shelved path that the shelve
  did not leave there, or HEAD's content for it is no longer what the shelved edit was made
  against, nothing is written, the tree is left exactly as it was, and **the shelf is left
  intact** — which is what
  makes eliding a large side safe here in a way it is not for a push conflict: every byte stays
  recoverable by resolving the collision and calling again. The report gives `base`/`ours`/
  `theirs` per file rather than writing markers into anyone's files, and `conflictPaths` is never
  capped. A HEAD that advanced without touching the shelved files is **not** a conflict: the
  check is per file, against the shelf's stored base, not against the recorded `headSha`.

  Both operations refuse when a live peer session owns one of the paths — and when they cannot
  read that peer's change index to tell. **An unreadable index means unreadable, never "owns
  nothing"**, the same fail-closed reading `commit scope: "paths"` uses; getting it backwards is
  the one defect that would silently take a peer's in-flight lines. A `.bib` stays behind
  `confirmBibEdit`, judged on the link-resolved name, and a path that is a symbolic link on any
  side (HEAD's mode, the index's, `lstat`, or a linked ancestor) is refused outright, because
  restoring content through a link puts the bytes wherever it points. A path that could not be
  judged at all counts as a link, on purpose.

  The decision for one file is a pure function over bytes (`planUnshelveFile`), not an inline
  question to `git status`, and that is not a refactor: asking git alone missed a path git
  declines to report. An untracked shelved path later covered by a `.gitignore` was invisible to
  `status`, so a file the user wrote there afterwards was silently overwritten and the shelf then
  deleted, making the loss unrecoverable. A path that was untracked when shelved is now checked
  for **presence** — the shelve removed it, so anything there is someone's work — which needs no
  filter reasoning; a tracked path still goes through `git status`, because only git applies the
  path's clean filter (the #63 defect) and `.gitignore` never hides a tracked file. The dirty
  check folds case like every other by-name comparison here; it did not, which made it fail open
  on exactly the platforms where `core.ignorecase` is git's default.

  A **staged** path is refused outright: `discard`'s path-limited branch restores from the index
  rather than HEAD and cannot remove a staged new file, so shelving one reported success while
  leaving the work in the tree — the push stayed blocked and the shelf could never be reclaimed.

  The conflict payload is bounded by all three of #68's caps, including the **aggregate** one an
  earlier draft omitted: a per-side cap alone lets 20 files × 3 sides × 12000 characters through
  with nothing individually oversized, `truncated: false`, and a result an order of magnitude past
  the size that originally failed to deliver. `list_shelves` is bounded too, since nothing reaps a
  shelf.

  `shelve` settles the shelved paths across every session and deliberately does **not** record:
  the tree now equals HEAD there, so there is nothing for anyone to own. `unshelve` settles and
  then records into the calling session, exactly as `revert` does, since the restored bytes are
  content no session currently owns.

  Every key the three tools emit is declared in the `outputSchema` they advertise, the manifest's
  own `version` included. That is a correctness requirement rather than tidiness: `zod`'s JSON
  Schema conversion marks every advertised object `additionalProperties: false`, and the MCP
  SDK's `Client` compiles an ajv validator per `outputSchema` during `listTools()` and checks
  every later result against it, so a single undeclared key makes a tool answer
  `-32602 … must NOT have additional properties` and return nothing at all. The fix direction is
  always to **declare** the field, never to stop emitting it — dropping a field callers may read
  is the breaking direction (#146, found by the #145 output-contract sweep).

- **A `review-round` workflow and the agents it drives** — contributor tooling under `.claude/`, which
  changes nothing about the server itself: no tool, no runtime behaviour, nothing in `src/`. The workflow
  performs one review round end to end: by default an adversarial reviewer produces the round against the
  current branch's diff (a posted PR review-comment URL can be supplied to fix an existing round instead),
  then a planner batches every finding and cleanup item into 1–4 self-contained specs ordered so an earlier
  batch cannot invalidate a later one, an `implementer` agent fixes each batch test-first, a `plan-verifier`
  agent tries adversarially to refute it and sends rework back (up to `max_attempts`), a `Tail audit` reads
  the whole accumulated diff once more, and a sign-off auditor syncs with the remote, runs the gate, and
  commits only when every batch was approved. Adapted from a sibling repo, so what carried over is the shape
  and what was rewritten is every rule: the agents encode _this_ repo's invariants (thin tool layer over
  services, stdout as the JSON-RPC channel, and the guards — `requireGitProject`, `runExclusive`,
  `confirmBibEdit`, `recordBaseline`, symlink resolution, ff-only pull, a shadow-store `conflicted` flag that
  stays flagged, snippets only for log-vouched locations) as things a verifier hunts for having been
  weakened, and the vacuous-pass mode they are built to catch is this repo's own: `test/smoke/**` auto-skips
  wherever `latexmk` is absent, so a green `npm test` is never accepted as coverage of compile-adjacent code,
  and `typecheck` is run for the tests the build excludes. **No irreversible act of the round sits in its
  cheapest phase** (#81): the sign-off is what reads the whole multi-batch diff for the cross-batch
  interactions no per-batch verifier can see, runs the gate, and then commits and pushes unattended, so it
  has its own model knob — `signoff_model:`, defaulting to **opus**, while `fable: false` / `fable_model:`
  govern the `Plan` phase alone, an altitude argument about a planner saying nothing about an auditor whose
  job is adversarial reading plus git surgery. A default is flipped back by a future edit that means no harm,
  so the part that matters is a **hard floor**: while `commit: true` the sign-off may not run below the tier
  of the agent that verified what it is committing. It refuses synchronously, before a single agent spawns,
  like every other input refusal in that file, and fails closed at each end — the comparison is by rank
  against a `MODEL_TIER` map rather than by equality (a tier between the two ends is refused, which an
  equality check lets through), an unrankable `signoff_model` is refused on its own terms before the floor
  compares anything, and the script refuses to run at all, whatever `commit` says, if the single
  `VERIFIER_MODEL` constant that the floor and the verifying `agent()` call both read is missing from the
  map, since an unranked end leaves the guard present and no longer guarding. `{commit: false}` is the way to
  run an advisory round on a cheaper auditor, one `MAY_COMMIT` expression decides both the sign-off's git
  authority and how its commit step renders (the sentence granting that authority must not survive on the
  rounds that must not use it), and a completed round records which model actually held the commit. The
  `Tail audit` is the same principle one layer in (#82): one verify-only `plan-verifier` pass between the
  last batch verifier and the sign-off, **with no knob of its own**, taking the verifier's model directly —
  a cheaper tail auditor that finds nothing, feeding a sign-off merely told "nothing blocking", buys the same
  unattended push the floor refuses to sell, and reusing the constant makes that unenforceable by
  construction rather than enforced by a second check someone can forget. It is unconditional, because here
  no batch ever ships unverified: it exists for what a per-batch verifier structurally cannot see —
  cross-batch staleness (batches run sequentially in a shared tree, so an early approval describes code a
  later batch may since have moved), rework approved in a single reading, and independence from the agent
  that commits. It terminates by construction: no implementer runs after it and nothing loops back. Its
  verdict is read fail-closed in every shape a free-text answer can arrive in — nothing at all, a non-object,
  or either required field absent or mis-typed, since an answer that broke the schema in one required field
  is not evidence about the other — and a blocking verdict folds into `MAY_COMMIT` and withholds the commit
  rather than opening a fourth fix round: the fixes stay in the tree for a human exactly as an unapproved
  batch already leaves them, and it would be incoherent for the round's one independent pass to find a defect
  and then commit it unattended. One residual is stated rather than glossed: the sign-off may still fix a
  trivial gate failure — a prettier reflow, a lint autofix — in a claimed path after the tail audit has run
  and then commit it, so the phase narrows the unreviewed surface without reducing it to zero. The
  do-not-commit reason is a list, not a one-reason ternary, so a round both
  unapproved and tail-blocked does not report only the batches. Both the tail auditor and the sign-off are
  told which paths were **already dirty** before the round began, because this checkout is shared with peer
  agent sessions and a peer's half-written file must neither block a finished round nor land in its record.
  What a batch claims is named by **file**: each done-list entry carries the files that batch reported
  changing (and says `(no files reported)` when an implementer returned nothing, which is not the same claim
  as "touched nothing"), and the implementer is told to read those files as they are now rather than as its
  spec describes them. The sign-off re-measures `git status --porcelain` — with `-uall`, or a wholly new
  directory collapses to one `?? dir/` line and a claimed path inside it never appears, and with
  `core.quotePath=false`, the rule CLAUDE.md already applies to every path-returning git call in the server —
  immediately before its by-path `git add`, is handed the deduplicated claimed paths by the script rather
  than by its own memory of the round, and stops if any of them has gone quiet since the batch reported it,
  whatever status letter it would have carried. That is a **stop, not a fix**, and the prompt says so in those
  words: the unit of ownership is a path and `git add <path>` takes the whole file, so a peer that edited a
  different region of a claimed path still has its lines committed with the round's (#81, finding 3, open).
  The honest fix is to commit through the server's own `ShadowStore`/`commitContents` machinery at line
  granularity, which is a much larger design question; what is here turns the silent version into a stop and
  nothing more.

- **Three hand-driven commands — `/review`, `/implement` and `/implement-issue`** — the same pipelines driven
  by a session instead of a workflow script, so they cost a session rather than a fleet and report before
  they touch anything. `/review` scopes the target itself (a PR number through `gh`, a branch, or the working
  tree), resolving the base as the PR's own base and otherwise `origin/dev` — the integration branch —
  rather than `main`, and groups the touched files by the risk they carry here: the `src/services`/`src/lib`
  core, the `src/tools` + `src/server.ts` surface, the `context.ts` / `config.ts` wiring, skills and prompts,
  tests, docs. It runs the one gate this repo has (`typecheck` + `lint` + `format:check` + `test`) **itself**
  before delegating, because a green a subagent reports is not evidence, and it reads the skip count rather
  than the pass line — the TeX smokes auto-skip wherever `latexmk` is absent, so a green `npm test` over
  compile-adjacent code is a vacuous pass, which is the failure mode the whole review exists to catch. The
  review goes to the existing `plan-verifier` agent (there is no separate reviewer agent here, and one more
  agent restating the same invariants is one more copy to drift), with the stated intent as the spec and the
  CLAUDE.md guards the diff comes near named outright. Report-only by default: the implement/verify loop runs
  only under `--fix`, and a finding that is really the author's call — a design disagreement, a scope
  question — is reported and never "fixed". Posting the verdict to the PR and pushing the fixes are two
  separate steps, each gated on an explicit go, which is the deliberate difference from the workflow's
  unattended commit. The loop's three-round cap is a **wall-clock bound, not a convergence claim** (#82), and
  a verdict of "3 rounds, clean" whose last round's fixes no reviewer ever attacked is exactly the overclaim
  the command must not make: so a run that ends with fixes no verification has seen closes with one
  verify-only pass over the accumulated diff — triggered by _"fixes exist that no verification has seen"_ and
  not by the counter, skipped on a run that exits because a verification came back clean and nothing changed
  after it — and the step 5 verdict carries a **required** line, with the same standing the command gives
  "skips distinguished from passes", naming which findings were fixed after the final verification round and
  are therefore unreviewed; an absent line and a `"none"` line must not look the same. The cap itself is
  unchanged and no fourth fix round exists. **A regression test that passes before its fix
  is a finding, not a footnote.** The `implementer` agent watches each new test fail on the pre-fix code and
  reports the result; such a test is rewritten until it fails for the right reason, or deleted, and never
  reported as covered, and `/review` step 3 treats an implementer's "passed pre-fix" as a confirmed finding
  to send back in the same round. A test that passes before the fix cannot catch the bug returning, and is
  also evidence the fix may be aimed at the wrong thing, which is the easier signal to skim past. `/implement`
  orchestrates a request the same way by hand: the session writes the spec (files, invariants, tests-first
  with a case just outside every new guard, and the right test tier), delegates each bounded task to the
  `implementer` agent, verifies the assembled diff with `plan-verifier`, and proves the work with the local
  gate passing. `/implement-issue` triages before it builds, because `/implement` assumes the request is
  worth building — the maintainer wrote it — while an issue or a saved feedback report is written by someone
  else. It loads the source verbatim (a `gh issue view` including the **comments**, since a maintainer reply
  often narrows or kills the ask; or a markdown file, each issue block in a saved feedback report being its
  own candidate) and delegates the judgment to a single agent whose model `--triage-model` picks (fable or
  opus, fable by default, and the run says which one ran). That agent separates the observed problem from the
  proposed solution — the proposal being the half more often wrong — and checks the claim against the tree
  with files and lines named, since the behaviour may already exist, may have been fixed since the reporter's
  version, may be a CLAUDE.md guard working as designed, or may be a docs fix rather than a code one; the
  agent advises, the session forms its own call and says where it disagrees. Then it **stops**: a building /
  discarding / deviating / open-questions report, with no `implementer` launched and no file edited until the
  maintainer approves it, an empty accept list being a valid outcome stated outright so a run cannot
  manufacture work to justify itself. After approval it is `/implement`'s pipeline, with the issue's words
  treated as evidence rather than as a spec, and a close that drafts (never posts) the reply owed to the
  reporter, discarded parts included.

- **Two new skills — `proofread-document` and `review-writing-guide` — and three Claude Code commands that
  parallelize them.** `.claude/commands` and subagents are a Claude Code mechanism and the server advertises
  only `.claude/skills`, so a typo hunter and a guide reviewer that live only as a command and an agent reach
  Claude Desktop and every other MCP client not in degraded form but not at all. Both are skills, shipping as
  MCP prompts and through `list_skills` like the other six, each with a single-agent workflow that stands on
  its own. `proofread-document` reports typos as exact minimal substitutions and applies nothing until asked,
  with the hard rule that a sentence you would have phrased differently is not a typo. `review-writing-guide`
  reviews against [`docs/writing-guide.md`](docs/writing-guide.md) — which already reaches every client as
  the server's own instructions, so the guide stays the authority and the skill only says how to review
  against it — and writes nothing whatsoever, not even a report file: it proposes, and the author disposes.
  Alongside them, `/format-latex`, `/hunt-typo` and `/review-writing` fan the per-file reading out across one
  subagent per file (`formatter` and `corrector` on sonnet, `writing-reviewer` on opus with a `--sonnet`
  override), which is cheaper and parallel. The commands and agents **fetch their rules from the skill
  through `list_skills` at run time** rather than restating them, and stop rather than improvise if that call
  fails — a paraphrased rule is a wrong rule, and two copies of a taxonomy drift the first time one is
  edited. What stays in each command is only what a skill cannot say: which part is serial (splitting one
  main file has nothing to parallelize), which findings need more than one file to see (an acronym defined
  twice, a float never referenced) and so cannot be delegated to a single-file agent, and how the fan-out is
  batched. Contributor tooling under `.claude/` throughout: no tool, no runtime behaviour, and nothing in
  `src/` changed.

- **CI says something about `.claude/workflows/*.js` beyond "the whitespace is tidy"** (#81). `prettier
--check` was the only automated statement about 626 lines of JavaScript that review, **commit and push this
  repo unattended** — `eslint.config.js` ignored `.claude/**` wholesale, `tsc --noEmit` never saw those files
  and nothing imported them — and that gap shipped a `const` declared inside a retry loop and read after it,
  and backticks that closed a template literal early. A flat-config block scoped to
  `.claude/workflows/**/*.js` declares the Workflow globals (`args`, `agent`, `parallel`, `pipeline`,
  `phase`, `log`, `workflow`, `budget`) readonly, allows the top-level `return` that is legal in a body
  the host wraps in an async function, and turns `no-undef` on, which catches both defect shapes.
  Un-ignoring `.claude/**` instead is **not** the same change and is worse: measured on this config, forced over the file that way eslint reports
  32 problems, every one of them `no-undef` on those very globals, burying the findings the block exists for.
  The ignore is `.claude/*` rather than `.claude/**`, and that distinction is load-bearing rather than
  cosmetic: in flat config a directory ignored with `/**` is skipped whole and nothing inside it can be
  unignored afterwards, so the obvious spelling lints nothing at all while reading as though it works — every
  other child of `.claude/`, a nested worktree included, is still skipped before eslint descends into it.
  (`allowReturnOutsideFunction` is defence in depth against a future parser swap rather than load-bearing
  today, because `tseslint.configs.recommended` carries no `files:` restriction and so claims `.js` too,
  making `typescript-eslint/parser` the effective parser here — and it accepts a top-level `return` silently;
  the comment beside it says so, so that nobody deletes it as dead config.) Two test tiers hold the rest.
  `test/unit/workflowScripts.test.ts` is **generic over the directory** — a second workflow script added later
  is checked for free. A Workflow script cannot be imported (its top-level `return` is a SyntaxError in an ES
  module), so the tier wraps each body in an async function and injects stubbed globals exactly as the host
  does, which is what lets the guards be executed rather than merely read: per script it asserts `meta` is
  well-formed and cross-checks the `meta.phases` titles against the `phase()` / `opts.phase` strings the body
  actually uses, **in both directions** — a phase declared and never used, and one used and never declared,
  are both failures — and then 48 scenarios pin `review-round.js`'s guards by running them: every input
  refusal firing before a single agent spawns, `max_attempts: 0` as the legitimate plan-only value just
  outside that refusal, the preflight's fail-closed normalization of `refs/heads/dev` and `  dev  ` into the
  protected-branch refusal, the detached-HEAD refusal proven scoped to a committing round, a peer's
  pre-existing dirty paths reaching the sign-off as must-not-commit, the `done` string that is the only
  channel telling one batch what earlier ones landed, and the sign-off's by-path commit instruction. An
  `eslint.config.js reach` tier asserts through the real `ESLint` API that each workflow script is **not**
  ignored, that the other children of `.claude/` and a nested `.claude/worktrees/` checkout still are, and
  that a workflow script resolves to a config carrying all eight Workflow globals as `readonly`,
  `allowReturnOutsideFunction`, and `no-undef` on — nothing else in the repo could catch a drift there, since
  the script tier reads the files off disk itself and never invokes eslint, so a config that silently lints
  one file fewer would leave it green. Both tiers are tested against deliberately broken sources and
  mutation-checked: each guard's removal is caught by exactly the one scenario that claims to pin it, and the
  reach tier is checked against the natural-looking `['.claude/**', '!.claude/workflows']` that unignores
  nothing, the wholesale ignore, and a single dropped global. Discovery asserts the script list is non-empty,
  because a tier that would pass over broken input states nothing. And the house rules injected into every
  agent of every round name what lint actually reaches (`.claude/workflows/`, with the Workflow globals
  declared, plus that test tier) and what it still does not (every other child — `skills/`, `agents/`,
  `commands/` — where prettier remains the only check): a stale rule in a prompt is worse than a missing one,
  since it instructs an agent, with the authority of its own system context, to disregard the one automated
  signal that now covers the diff it is reading, and it is invisible to a reader of that diff because the
  prose lives in a template literal nothing executes.

- **`search_files`: grep the project instead of reading every candidate** (#105, finding 1).
  Locating a phrase, a `\label`, or every site of a citation key meant `list_files` and then
  `read_file` over each result — the whole file into context to find one line. `search_files`
  returns the matching lines with their path, 1-based line number and an optional context window.

  **Literal by default.** `\Cref{tab:sota}` searches for exactly that, backslashes and braces
  included, which is the common case in LaTeX and the one a regex-by-default tool gets wrong
  silently.

  **A refused regex, not a bounded one.** `regex: true` opts into a pattern, and some shapes are
  rejected with an explanation rather than executed. This is not conservatism: `RegExp.exec` cannot
  be interrupted on the thread running it, so a deadline checked there cannot cut a match short —
  by the time the budget is checked the match has already finished, or the process has not come
  back. (Changed before release: the regex scan now runs on a worker thread that is terminated at
  the deadline, and that is what bounds a search; the refusals are the first line of defence in
  front of it.) The analyzer turns on **character overlap** between a repeat and what follows
  it, not on which metacharacters were written: `[^x]*a[^x]*a[^x]*b` contains no `.` at all and
  takes **12 minutes** on a single line, while `\w+\s+\w+` — two chained quantifiers — is linear
  and a LaTeX search needs it. A rule phrased over syntax would have missed the first and
  wrongly refused the second. A refusal says what it objects to and suggests a rewrite — anchoring
  a repeat to something it cannot match (`[^}]*\}` rather than `.*\}`), dropping a leading `.*`,
  lowering a count — or `regex: false`.

  **`excludeComments`** skips hits that begin inside a LaTeX `%` comment, by backslash parity, so
  `50\%` is live text and `\\%` is a comment. It applies only where `%` _is_ a comment
  (`.tex`/`.sty`/`.cls`/`.bbl`/`.ltx`/`.latex`); a searched file without that syntax has every hit
  reported, and `note` says how many such files there were rather than filtering nothing quietly.

  **Nothing is silently absent.** Assets are never searched whatever `filter` says and come back
  under `skipped`, so "not searched" cannot read as "no match". Output is budgeted by **rendered**
  size — each match charged its real `JSON.stringify` cost plus its lines in the text channel —
  with a match-count cap and an aggregate budget, and the `note` names whichever one actually
  fired.

- **`edit_file` takes line ranges, and `replaceAll` can skip LaTeX comments** (#105, findings 3
  and 4). Two changes to the same machinery, both about edits a manuscript actually needs.

  **Line ranges.** `read_file` takes `startLine`/`endLine`; `edit_file` had no counterpart, so a
  change defined by _where_ it is rather than _what it says_ had no cheap expression — commenting
  out two tables of 328 and 361 lines meant one `oldString` holding all 689 and a `newString`
  holding all 689 again. An edit may now be `{startLine, endLine, newString}` instead, 1-based and
  inclusive exactly as `read_file` is.

  Line numbers refer to the file **as it was before the call**. Every range is resolved up front
  and kept in step as earlier edits shift the text, so a range means the same thing wherever it
  sits in the `edits` array; two edits that would touch the same bytes are **refused**, because
  the only other outcome is a range quietly sliding onto text nobody named. Out of range refuses
  rather than clamping, for the same asymmetry: a clamped read shows you fewer lines, which you
  can see, while a clamped write rewrites a region you did not ask for, which you cannot.

  One deliberate divergence from `read_file`, now visible because both scans live in
  `src/lib/lines.ts`: a whole-file _read_ hands back the trailing newline, and a whole-file range
  _edit_ must not consume it, or it strips the file's final newline as a side effect. A
  differential test asserts the two agree everywhere else.

  **`excludeComments`.** `replaceAll` was textual with no notion of `%`, which made it unusable on
  a manuscript that keeps its history in comments — the very convention this server's
  rewrite-preservation mode encourages. Measured in one real file: 192 occurrences of a method
  name, **10 live**; `replaceAll: true` would have silently rewritten the other 182, which are the
  audit trail for the numbers in its tables. The flag skips matches inside comments, escape-aware
  by backslash parity (`%` is a comment, `\%` is not, and `\\%` **is** — the naive "previous
  character is a backslash" rule gets that last one backwards), and re-judges each occurrence
  against the current text, since a replacement can introduce a `%` that comments its own line.

  Silence is refused throughout: an edit whose every match is commented is an error rather than a
  success that changed nothing, and the flag is refused outright on a file whose comment character
  is not `%` — filtering a `.md` against `%` would find no comments and rewrite every match the
  caller asked to protect. Each flagged edit reports `replaced` and `skippedInComments`, in
  `structuredContent` and in the text, or an MCP-only client would read "applied 1 edit(s)" for a
  rename that deliberately left 182 alone.

  Note for existing callers: an edit object is now validated strictly, so a typo'd key is refused
  where it used to be ignored.

- **`commit scope: "paths"` — commit exactly the files you name, and nothing else** (#61). A session
  whose work reached the clone without going through `edit_file` / `write_file` — a script's output,
  the client's own file tools — owns nothing in its shadow, so `scope: "session"` had nothing to commit
  and the only route was `scope: "all"`, fenced by a caller-maintained `paths` list that widened
  silently to the whole tree the moment the list was empty. The new scope requires a non-empty `paths`,
  stages only those (a directory covers what is under it, a path leaving the clone is refused before git
  sees it) — the index is reset to HEAD first, as a session commit does, so nothing a hand `git add` or
  an interrupted commit left staged rides along — reports `leftUncommitted` like a session commit does,
  and **refuses a path a live session's
  shadow lists** rather than taking that session's in-flight lines — `scope: "all"` remains the
  deliberate way to do that, unchanged. A live peer whose shadow index cannot be read is treated as
  owning everything, so the refusal fails closed. The alternative the report also floated — letting a
  session "claim" external changes into its shadow — was declined: a claim has no `before` of its own,
  so it would adopt whatever a peer had also written into the file, which is the exact leak the
  change-not-result shadow design exists to prevent. Review fixes before merge: the ownership check
  iterates the live peers rather than the indexes it managed to read, so a peer missing from the
  read set is unreadable (refused), never "owns nothing"; and both commit paths tolerate a clone with
  no commits yet (an empty remote), where `read-tree --reset HEAD` used to fail.

- **The `push` refusal for a peer's uncommitted work now says who is mid-edit** (#61). It named the
  live sessions and the files, but not which session owned which file or whether that session was
  between keystrokes or merely still open — so "wait" and "take over" looked the same, and telling
  them apart meant `stat`-ing mtimes in a shell. Each shadow index entry now records `touchedAt`, the
  last write that session made through the server (set only when an edit is recorded, never when the
  shadow is carried onto a new HEAD, which is why file mtimes were never a usable signal), and the
  refusal attributes each foreign file to the live session whose shadow lists it, with that session's
  last write age and heartbeat age, and lists apart the files no live session owns. The refusal's
  _trigger_ is unchanged — any live peer plus any foreign dirt still refuses; making it owner-aware is
  #60's question and is left there, because dropping the guard without also fixing `safePush`'s
  `git add -A` fallback would turn "no longer blocked" into "swept into the commit".
  `status.activeSessions` carries the same per-session `changes` (`null` when that session's index is
  unreadable) and `lastWriteAt`, so the check is one read-only call.

- **`push` no longer refuses on untracked files nobody owns** (#60). `guardPeerWork` already let
  unowned dirt through when no live peer session existed (or the dirt was this session's own), but `safePush`/`resolvePush` then
  re-gated on simple-git's `isClean()`, which counts untracked files — so three hand-built `main.pdf`/
  `main.bbl`/`main.blg` beside the root file, or an exited peer's new figure, refused every push with a
  generic "uncommitted changes" message that named neither the files nor a session, contradicting what
  docs/CONCURRENCY.md promised. A rebase's checkout tolerates untracked files in place; it balks only at
  uncommitted changes to files git already tracks. So the gate now distinguishes the two: untracked
  files ride through a push untouched, and only modified tracked files refuse — **by name**, saying why
  (git cannot rebase over them) and offering the three exits (`commit`, a `message` on `push` — which
  commits the whole working tree, peers' work included — or `discard`). `--autostash` was deliberately
  not used: a stash pop is an automatic merge of somebody's uncommitted lines onto a new base, and a
  pop conflict leaves markers in the working tree. The one case git itself refuses — an incoming commit
  adding a path that already exists untracked locally — is no longer a raw "could not detach HEAD": it
  is `UntrackedOverwriteError`, naming the colliding file(s), with the clone left at its pre-push state
  — and prescribing `commit scope: "paths"` with exactly those paths, not `scope: "all"`, so following
  the message does not sweep a peer's in-flight work into the commit.

- **`push` retries a lost fast-forward race, then reports `status: "remote-moved"`** (#60). With a
  collaborator typing in the Overleaf editor the git bridge lands a commit every few seconds, and a push
  that lost the race between its last fetch and its `git push` returned git's raw stderr
  (`[rejected] (fetch first)`), neither retried nor explained. `safePush` and `resolvePush` now go through one
  helper that, on a plain non-fast-forward rejection — and only that: auth, network and hook refusals
  (`[remote rejected]`) rethrow at once — re-runs the same fetch → `pull --rebase` → push round up to 3
  times. A conflict on a retry round is reported exactly as before, never retried with stale content;
  the success result's `rebasedOver` includes the commits picked up by every round. Losing the race
  three times returns `status: "remote-moved"` with `remoteHead` and the commits that landed, nothing
  pushed, no rebase in progress, and the local commits still ahead. A `resolutions` push that passed
  `expectedRemoteHead` does not retry at all — the caller asked to be refused if the remote moved again,
  so it gets `remote-moved` on the first lost race. Branch-mode landing does not loop either (its
  rebase-then-ff shape is different): it converts the same rejection into `remote-moved`, and because
  local `<base>` is already fast-forwarded onto the feature branch by then, its summary prescribes the
  recovery that actually works — a direct-mode push, which pull-rebases `<base>` and pushes. The `beforePush` hook on `GitService`'s constructor exists only so a test can move the
  remote in that gap. A retry round re-reads how far ahead the clone is before pushing: when the
  rebase dropped our commit because a collaborator landed the identical change, the result is
  `nothing-to-push` (with what was rebased over), never a `pushed` that names their commit as ours.

- **Every reported commit lists the files it touched** (#60). `rebasedOver`, `behindCommits`,
  `aheadCommits`, the conflict payload's `remoteCommits` and `reset_to_remote`'s `discardedCommits`
  carried only hash + subject, and an Overleaf commit's subject is always "Update on Overleaf." — so
  "what did he change since my last sync" meant ~15 `git show --stat` shell detours per session. Each
  entry now carries `files` (path, added, removed) from one `git log --numstat`; the result text shows
  up to 5 files per commit and 20 commits, the rest in `structuredContent`. For the content, `diff`
  with `ref: "<hash>~1..<hash>"` already answers a single commit and the docs now say so where the
  commits are reported; the reporter's "diff compares the working tree to a ref" was the single-ref
  form — the two-dot range compares two commits. A separate `log` tool was declined: the range form
  plus the per-commit file list covers the case that recurred. The per-commit paths are plain: the
  log is read with rename detection off and `core.quotePath=false`, so a rename lists its old and new
  path and a non-ASCII name is not C-quoted.

- **A project registered from the chat can be the default** (#60). `register_project` gains
  `default: true`, persisted as `"default": true` on the entry in `registry.json` and applied
  immediately in this process, so later calls may omit `project`. `WEB_LATEX_MCP_DEFAULT_PROJECT`, when
  set, always wins — an explicit env value is an assertion, like `compilerExplicit`, and a persisted
  default is only what fills in when it is unset. Making the sole registered project the default by
  inference was declined for the same reason, and because a peer registering a second project would
  flip a working call into an error mid-session. The no-default error now lists the known ids and both
  ways to set one, and the env-check error no longer claims the id must be in `WEB_LATEX_MCP_PROJECTS`
  (it was already checked against env plus registry; only the message said otherwise, which is what
  misled the reporter). Making an already-registered project the default takes `project` and
  `default: true` alone — no `gitUrl`/`path` — and re-persists the entry as `registry.json` holds it (not this process's snapshot of it), so
  `rootFile`/`branch`/`tokenEnv` survive; the registry-default read in `loadConfig` is injectable like
  the registry read, so unit tests never see a developer's real `registry.json`.

- **`add_asset`: a figure on your laptop can finally reach the project.** `write_file` takes a
  `content: string` and wrote it as UTF-8, so there was no way to add a PNG that was not already in
  the project — and the corruption ran deeper than the tool layer: `ShadowStore` stored every shadow
  as UTF-8 and `GitService.hashObject` piped a string into `git hash-object`, so even bytes that
  reached disk were destroyed by the default `scope: "session"` commit. (`scope: "all"`/`"paths"`
  stage through `git add` and were always binary-safe, which is why this only bit the default path.)
  The write path is now byte-exact end to end: `FileService.readBytes`/`writeBytes`, a `binary` flag
  on each shadow entry, and `Buffer` support through `commitContents`. A binary shadow is **never**
  three-way merged — there is no such thing as a merged PNG — so a peer changing the same bytes is
  reported as a conflict and, as everywhere else, a conflicted entry stays flagged.
  `add_asset` takes either `sourcePath` (an absolute path on the machine running the server, `~`
  expanded) or `contentBase64` (for clients with no filesystem access, capped lower since those bytes
  cross the model's context). Both the destination AND the resolved (realpath'd) source must be an
  asset type: that two-sided allowlist is the security gate on the one read that leaves every project
  sandbox — the destination side alone does not constrain what `sourcePath` may name, so it is checked
  too, on the path a symlink actually resolves to rather than the name it was given, before any file is
  opened. The result reports the resolved source path and a sha256 of what landed; it deliberately
  carries no diff (an added binary tool needing to echo the copied bytes back would be its own way to
  leak a file that slipped the allowlist). Every filesystem outcome on the source collapses to
  found / not-found / unresolvable with no errno text: a raw `ENOTDIR` on `/etc/passwd/x.png` used to
  say that `/etc/passwd` exists and is a file.

- **Rewrite-preservation mode** — a habit Overleaf users already have, that the model had no way to
  match: when `edit_file` rewrites a sentence or paragraph in a `.tex`/`.sty`/`.cls`/`.bbl`/`.latex`/`.ltx`
  file, it can now comment the original out (`% ` on every line) above the replacement instead of
  discarding it, so a rewrite reads in the diff the way a human's would — the old wording still there,
  commented, for a co-author to see. This has to be enforced server-side rather than asked of the model
  as a writing-guide rule: a preserved block is only trustworthy if it is provably the bytes that were
  there, the same reason BibTeX entry text comes from DBLP rather than from the model retyping it. Three
  modes — `off` (default — preservation is opt-in, since it writes bytes the caller did not ask for),
  `prose`, `always` — with `prose` preserving only edits that look like an actual rewrite (at least 8
  tokens, whitespace-separated, so a `\cite{…}` counts as one; mostly non-markup, not a near-identical
  replacement), so a typo fix or a swapped `\cite` key is left alone. Turn preservation
  on with `set_rewrite_mode` (per project) or `WEB_LATEX_MCP_REWRITE_MODE` (server-wide). The mode is
  sticky per project (`set_rewrite_mode`, persisted outside the clone) and
  defaults from `WEB_LATEX_MCP_REWRITE_MODE`; a per-call `preserveOriginal` on `edit_file` always wins
  over both, in either direction. Never applies to `write_file` (no single old paragraph to comment out
  above — the whole prior file isn't the same thing) or to a `.bib` (already gated by `confirmBibEdit`).
  Preservation only fires on a **line-aligned** match — `oldString` starting at the beginning of a line
  and ending at the end of one — and never on a `replaceAll` edit, since neither leaves a single safe
  place to put a `%`-comment; either case applies the edit unchanged instead. The preserved block carries
  no sentinel marker on purpose — it should look exactly like a paragraph a human commented out by hand,
  and `arxiv-clean-project` already strips comments before submission. `list_projects` reports the
  effective mode per project and `server_info` the server-wide default, both with an `envConfigured`
  flag distinguishing a mode someone actually set from the built-in `off`, so it is never a hidden
  setting. Preservation leaves the old text as a `% `-commented block, so a later call can match inside
  it — within one call that is refused; across calls a match that lands only inside the comment is applied to the dead comment and reported as success, so it is the caller's context to get right (only a single line of the original still occurs verbatim, as `% <that line>`). In the
  same call, an edit that matches only inside a block an earlier edit preserved is refused rather than
  applied — it would otherwise rewrite dead commented-out text and report success for a change no reader
  would ever see.

- **`WEB_LATEX_MCP_WRITING_GUIDE_EXTRA`, and an `add_writing_convention` tool to write to it.** The
  existing `WEB_LATEX_MCP_WRITING_GUIDE` only _replaces_ the bundled `docs/writing-guide.md` — fine for
  swapping in a house style wholesale, but it meant a single per-paper preference ("always write lidar,
  never LiDAR") forced copying the whole base guide just to add one line, and any later upstream change
  to that base guide had to be hand-merged back in. The new var names an _additional_ guide (a plain path
  or a `file:///...` URL, so Claude Desktop users can paste a file link) that is composed in **after** the
  base guide, under a "Project-specific conventions" heading, and takes precedence where the two
  contradict — the base guide stays the default and the project layers its exceptions on top. Setting
  both is legal: your replacement base plus your extra on top.
  `add_writing_convention` takes a single `rule` string and appends it as a bullet to that configured
  file, creating it on first use, behind the same cross-process file lock every mutating tool uses. It
  takes no path — the destination is always the one file the server was configured with, never one the
  model names — and it is strictly append-only: it cannot rewrite or drop a line a human already wrote
  there. The rule takes effect starting with the **next** session, not the current one, because MCP
  `instructions` are fixed at connect time; no live-refresh machinery was built for this, since a rule
  that changed what "the current session already agreed to" mid-conversation is a stranger source of
  confusion than a one-session delay. `server_info` now reports the configured path and whether the file
  actually loaded, because a typo'd path would otherwise mean the conventions are silently ignored
  forever with no way to notice. `add_writing_convention` now also requires `confirmGuideEdit: true`,
  refusing otherwise with an actionable error — mirroring the `.bib` guard's shape, but for the opposite
  reason: the appended rule originates from the model, not a trusted source, and it is the one write in
  the server that lands outside every project sandbox and into every future session's instructions, so
  the gate stands in for the user's explicit acknowledgement. When no guide is configured at all, the
  unconfigured error wins outright — there is nothing to confirm writing to a destination that doesn't
  exist, so no confirmation round trip precedes it. `server_info` also now reports
  `writingGuideExtraRuleCount`, a live count of the top-level bullets currently in that file (including
  any the user wrote by hand) — read fresh on every call, so unlike the loaded instructions and the
  `guide://latex/writing-guide` resource (both fixed at startup) it reflects a rule appended earlier in
  the same session; absent when no guide is configured or the file can't be read. Deliberately a count,
  not the rule text, to keep `server_info` cheap and bounded — open the reported path for the text.

- **A CI check that a PR into `dev` moved the `[Unreleased]` section of this file.** The log is not a
  list of commit subjects — its entries carry the reasoning that is nowhere else: why a guard exists,
  what the alternative was, what a fallback silently changes. A forgotten entry loses that and it is
  never reconstructed later, so the rule is checked rather than trusted. It is a workflow and not a
  test, because it is a fact about a PR rather than about the code: `on: pull_request` hands over the
  base ref, while `npm test` runs on `push` and locally, where there is no base branch and mid-work
  there is legitimately no entry yet — a check that is red all afternoon teaches people to ignore red.
  Narrow on purpose. PRs into `dev` only: a `dev -> main` release PR _is_ the changelog, and the
  auto-merged `main -> dev` back-merge carries no entry by construction, so requiring one there means
  a bot PR that has to be babysat every release. A `no-changelog` label opts out, because the
  alternative for a PR with genuinely nothing to log is a junk entry written to satisfy a bot, which
  costs the log more than the missing rule does. And what is compared is the `[Unreleased]` section
  itself, base-vs-head, not whether the file appears in the diff — the mistake actually made is
  appending to the last released section out of habit, which touching the file does not catch.

- **A guide for running the server from an iPad, an iPhone, or a browser**
  ([`docs/install/claude-code-web.md`](docs/install/claude-code-web.md)). The recurring question is
  whether the Claude mobile and web apps can use this server, and the honest answer has two halves.
  They cannot add it as a **custom connector**: those reach only remote servers over HTTPS, and this
  one is a stdio process that needs a filesystem, a git credential and a TeX install — hosting it to
  close that gap means a public URL in front of something that writes your working tree and pushes to
  your remotes, which is the same trade this repo already declines for Le Chat. But **Claude Code on
  the web** runs it unmodified: a cloud session clones the repo, loads its `.mcp.json`, and is
  steerable from the Claude app on a phone. So the guide documents that path end to end — which repo
  to start from when the paper lives on Overleaf and has no GitHub remote, a setup script that
  installs TeX inside the ~5-minute budget the environment cache needs (measured in an Anthropic cloud
  VM: ~34 s for a minimal `latexmk` + `texlive-latex-recommended` base, ~2.5 min and 2.3 GB with
  `texlive-latex-extra`/`-science`/`-fonts-extra` and `biber`, against a 30 GB disk — so the answer to
  a missing package is `compile`'s `missingPackages` and one more line in the script, never
  `texlive-full`), the two hosts that need adding to the network allowlist (`git.overleaf.com`,
  `dblp.org`; npm and the Ubuntu archives are already on the Trusted list), and why the token goes in
  the environment rather than the committed `.mcp.json`. It is also explicit about what does **not**
  survive the move: `viewer` and `credential_portal` bind loopback inside a VM nobody can route to, so
  the PDF is read through `render_pages` (whose canvas backend has a prebuilt linux-x64 binary and
  works there) and the token through an environment variable; the clone dies with the sandbox, so
  unpushed work is lost; and two cloud sessions are two VMs, so the lock file and session shadows —
  which coordinate processes sharing a filesystem — do not apply, and the sessions meet at the git
  remote like two people would. Verified rather than asserted: this repo's TeX smoke suite, real
  `latexmk` compiles and `render_pages` rasterization included, passes unmodified in that VM.

- **A `revert` tool: walk a commit back without a shell** (#85). `discard` resets the working tree to
  HEAD; nothing could reach past it, so undoing a change that had already been committed meant
  leaving the server entirely. On a manuscript that is a normal round of review — prose gets written,
  pushed, read in the Overleaf editor and rejected — and it is the one git operation that must not be
  improvised, because a shell-less client's alternatives (re-editing the file from the model's memory
  of it, or `discard` after a reset) either drift from the real prior state or destroy work.
  `revert` takes one or more shas, requires `confirm: true`, and reverts **into the working tree
  without committing** (`git revert --no-commit`, then unstaged), leaving the caller to review with
  `diff` and land it with `commit` — the same two-step separation `commit`/`push` already enforces,
  and it keeps the revert's message in the caller's hands.

  The field that makes it a tool rather than a shortcut is **`matchesRef`**: given an `expectRef`
  (normally the commit before the one being reverted), it answers whether the reverted files now
  equal it — turning "I ran a revert" into "the revert is exact", which `diff` cannot do because it
  returns a unified diff for a human to read rather than an assertion a caller can branch on. It is
  compared over the **reverted paths only**, deliberately: a peer session's unrelated dirty file must
  not make an exact revert report false. A `false` comes back with the mismatching per-file counts,
  so it is actionable rather than a bare boolean.

  Refusals happen before anything is written, in a fixed precedence: a **merge commit** (named, since
  `revert` takes no mainline parameter), a **symlinked path** on either side or under a linked
  directory (a revert writing through a link would write outside the project — refused, never
  followed), a **`.bib`** in the reverted set without `confirmBibEdit`, a **dirty touched path**,
  which is what keeps the revert off another session's in-flight lines and makes the abort exact,
  and **anything staged anywhere in the clone**. That last one is not fastidiousness: a conflicting
  revert can only be undone with `git revert --abort`, which is a `reset --merge` to the stored head
  and resets the _whole_ index — verified against real git, a peer session's `git add`ed file on a
  path the revert never touches comes back at HEAD with its staged work destroyed. Refusing up front
  is what makes the abort provably safe rather than usually safe, and it has to be up front, because
  once the conflict is known the loss is already unavoidable. A
  **conflicting revert aborts** and leaves nothing behind — no markers, no partly-applied commits,
  and an unrelated dirty file untouched — returning the conflicted paths plus the two refs to read
  each side from with `read_file`.

- **`WEB_LATEX_MCP_SESSION_PROBE`: opt-in stderr instrumentation for the session-identity spike**
  (#18, "Step 0 — spike first"). #18 opens with a blocking empirical question — when a user opens
  several Claude Desktop chats against one configured server, does Desktop give one MCP connection
  per chat, one connection whose requests carry a conversation id in `_meta`, or one connection
  with nothing distinguishing? — and nobody could answer it, because the server logged none of
  what it takes to tell those apart. Set the variable to `1` and the server reports, to stderr:
  every `initialized` firing with a **monotonic counter** (so "one connection or N?" is read off
  the highest `#n` rather than counted), the `clientInfo` and pid of each, and the `_meta` of
  **every** tool call with the tool's name. That is the whole feature: it measures identity, it
  establishes none — the refactor #18 describes is deliberately not started here.

  **One wiring point, not thirty.** Every tool registers through `server.registerTool`, so the
  probe wraps that one method in `createServer` before any tool registers; a tool added later is
  covered with no edit. It reads `extra._meta`, which the SDK assigns straight from the request's
  `params._meta`, so what the spike measures is exactly what a per-request identity would consume.

  **`_meta` is client-controlled data of unknown shape**, and is treated as such: the rendered
  JSON is scrubbed of known secrets **before** it is truncated (truncating first could cut a token
  in half and leave the prefix readable in a log the user pastes into an issue), capped at 2000
  characters with the overflow counted, and every failure mode of `JSON.stringify` — circular
  references, `BigInt`, a throwing getter, a value with no JSON form — becomes a marker string.
  A probe that crashes a tool call is worse than no probe, so every entry point swallows its own
  failures and reports them through the same sink.

  **Off by default and inert, not merely harmless.** Unset, nothing is installed at all:
  `registerTool` is still the prototype's own method, so there is no wrapper in the hot path to
  measure or fail. Tests pin that identity, pin that a probed tool call's result is _equal_ to the
  unprobed one (error results included), and pin that the default sink is `console.error` —
  stdout is the JSON-RPC channel.

### Changed

- **`commit` with no `scope` no longer widens to the whole working tree** while a live peer shares
  the clone.
- **`search_files` refuses regular expressions whose estimated backtracking is too high**, names the
  construct and suggests a rewrite; `regex: false` always works.
- **`labels` lookups are checked against the page and refused rather than guessed** when the page
  cannot be confirmed: no `/PageLabels` and no confirming folio, restarted numbering, a beamer deck
  without a slide number in its footline, or any build that loaded `pgfpages`/`pgfmorepages`
  (remaining gaps: #194).
- **Inputs are validated**: project ids, `WEB_LATEX_MCP_SESSION`, `WEB_LATEX_MCP_CONTACT_EMAIL` and
  `push`'s `expectedRemoteHead`; `edit_file` and `add_citation` refuse a file that is not valid
  UTF-8.
- **git 2.25 or later is required** (`doctor` checks it).

- **README cut to a landing page, for the release** (248 → 124 lines). It had grown into a second,
  staler copy of `docs/` — the failure mode of which is not length but divergence, since the copy is
  the one nobody updates. Every detail below moved rather than went away.

  **The headline and the intro are now one unit rather than two copies of each other.** The old
  headline ("Read, edit, compile, and commit LaTeX in any git-hosted project") and the paragraph
  under it said nearly the same sentence twice, and the paragraph spent its remaining half on
  transport and platform trivia the badges already carry. The headline now says what the
  server does in one line — "Edit, compile, and sync your Overleaf projects with Claude" — and the
  intro is a single paragraph describing what that looks like from your side (Claude rewriting a
  paragraph, compiling, checking a citation in Crossref or OpenAlex, looking at the typeset page,
  with nothing reaching Overleaf until you say so), with no implementation detail. `stdio`, TeX Live
  and the supported client list moved to the install guides and the badges.

  **"Highlights" is what a reader decides on**, so it carries only what distinguishes the server. The
  surgical-edit, parallel-session and page-rendering bullets are gone — all three are documented in
  the tool reference and [CONCURRENCY.md](docs/CONCURRENCY.md), and none reads as a reason to install
  anything. The compile bullet leads with the two supported backends (`latexmk`, which is what
  Overleaf runs, or `tectonic`) instead of the snippet caveats, and the viewer bullet drops SyncTeX,
  which names a mechanism rather than an outcome. "What you can do" is gone outright:
  [tools.md](docs/tools.md) is the tool reference, and a per-tool paragraph in the README was a
  second one.

  **"Install" is now the two one-liners and nothing else** — for Claude Code, one chat line pointing
  Claude at the repo, and the `.mcpb` drag for Claude Desktop — plus one chat line for the token and
  the project. The npm-package route, the per-OS guides, the TeX/compiler explanation, the credential
  portal in full, the env vars and the iPad/browser route all moved into
  [docs/install/README.md](docs/install/README.md), which was already the hub for exactly this and now
  leads with what the README leaves out. That page grew; the front page shrank by more.

  The skills list drops `/session-feedback`: it is a contribution channel, not a way to work on a
  paper. It is named in the beta warning instead, where someone hitting a rough edge is actually
  reading, and in "Contributing", which now says so in one sentence instead of thirteen lines.
  "Documentation" is a bare list of links — every description there restated what the linked page says
  on its first screen.

  One thing to know rather than discover: with "What you can do" gone, **`render_pages`,
  `pdf_geometry` and `extract_text` are no longer named in the README** — the intro says Claude looks
  at the typeset page, but no tool is named. All three are fully documented in
  [tools.md](docs/tools.md), so nothing is undocumented; this is a deliberate trade for a landing page
  that fits on one screen, and the place to undo it if it turns out to cost installs is one
  Highlights bullet, not a restored section.

- **`diff` and the write-confirmation diffs are budgeted, cut at hunk boundaries** (#153, #68).
  `diff` was the largest unbudgeted payload in the server and one of the most-called tools: the
  patch went back **twice** — verbatim in the result text and again in `structuredContent.diff` —
  over a `GitService.diff` that caps nothing, with `files[]` uncapped beside it. A regenerated
  `.bbl`, a re-exported `.svg` or `ref: "HEAD~20"` is one call away from the ~67k-character result
  a client rejected outright in #68, delivering nothing at all; unlike a conflict report there is
  no anomaly to notice first, because a diff is _expected_ to be large. A real 600-line rewrite
  measured 96,163 characters before this change and 19,922 after.

  The new planner is `src/lib/diffBudget.ts`, the fifth member of the family `conflictBudget.ts`
  started: a budget, a plan, a `note`, and a tool layer that only maps the plan onto response
  shapes. Three things decide its shape. **The cut is at hunk boundaries** — unlike a droppable
  field or a page tail, a patch is a sequence of hunks whose `@@` headers give the lines under
  them meaning, so a mid-hunk cut yields text that looks like a diff and is not one; every file
  that lost hunks keeps its `diff --git`/`---`/`+++` headers and carries a `... N of M hunk(s)
omitted` marker in place. **The budget is charged on the rendered size of BOTH channels** — the
  patch ships twice, so counting it once is wrong by 2x — which means a 12k patch that looks
  comfortably inside a 20000-character budget is in fact 24k on the wire and is cut; the charge is
  `JSON.stringify`-exact, so backslash-dense LaTeX is charged what it really costs. And the cut
  stops at the **file** boundary rather than running to the end of the patch: a regenerated `.bbl`
  is exactly the kind of first file that blows a budget, and letting it blank every later file's
  hunks would throw away the section the reviewer opened `diff` for.

  `diff` keeps the house figure (`DIFF_CONTENT_BUDGET` = 20000, as `CONFLICT_CONTENT_BUDGET` /
  `FLOATS_CONTENT_BUDGET` / `SEARCH_CONTENT_BUDGET`) and the house list cap (`DIFF_MAX_FILES` = 20
  on `files[]`, as `capList`), and reports `truncated`, `diffChars` (the full patch's true size),
  `hunksOmitted`, `patchFilesOmitted`, `filesOmitted` and a `note` that names only the bound that
  actually fired. `detail: "full"` is the escape hatch, exactly as `conflictDetail: "full"` is.

  **The confirmation diff gets a much smaller budget on purpose** (`CHANGE_DIFF_BUDGET` = 2000, the
  house figure for a diagnostic share of a result). `diff` returns the patch the caller asked for;
  `write_file`/`edit_file`/`add_citation` return one nobody asked for — a courtesy echo on a call
  whose answer is "written" — and a `write_file` over a large file shipped that whole file straight
  back as one `+` hunk, twice. The headline and the summary already carry the fact that matters,
  and the whole patch is one `diff` call away, which is the escape hatch here rather than a new
  flag on three write tools. Those three tools now also report `diffTruncated`; `diff: ''` keeps
  meaning what it always did — there is no diff at all (a local project, or nothing changed) — and
  never "it was cut", since a cut patch still carries its headers. `changeDiff` still returns `''`
  for a local project, and every git call keeps `--literal-pathspecs`.

  Both channels are rendered from **one** plan object, so they cannot disagree about what was cut
  (`push.ts`'s rule, and `searchFiles.ts`'s). The accounting is proved rather than asserted: the
  render templates live beside the cost functions and the cost functions call them (stronger than
  a pinned constant, which `conflictBudget.ts` needs only because its templates live elsewhere),
  the pieces rendered outside the planner are named constants pinned by a test that stringifies a
  real result, a unit test bounds the rendered payload across seven adversarial patch shapes
  (one enormous hunk, 3000 tiny ones, 400 files, 14-deep paths, backslash- and
  control-character-dense content, binary-only), and an integration test measures the size of the
  real MCP result — text plus JSON — off a live client against a real clone.

- **`status` collapses a dead, change-free peer session into a count instead of listing it**
  (#73, #78). A session record under `<workspace>/.sessions/<projectId>/` is removed only on a clean
  shutdown (`SessionRegistry.release()` on SIGINT/SIGTERM/beforeExit), so every killed agent process
  leaves one behind forever and `activeSessions` grew without bound with peers that hold nothing and
  are never coming back. `isStalePeer`/`splitStalePeers` (`src/lib/peerSummary.ts`) fold such a peer
  into `staleSessions: N`, but only under all three of: it is `!live`, its shadow index read back as
  a readable **empty** array, and its heartbeat is at least `RECENT_HEARTBEAT_GRACE_MS` (2 hours)
  old.

  Each clause is easy to get backwards. **`null` from `ShadowStore.peerEntries` means the index was
  UNREADABLE, never "owns nothing"** — the same fail-closed reading `attributePeers` uses — so a dead
  peer whose index cannot be read stays listed individually with `changes: null`; counting it
  change-free would assert the one thing this codebase refuses to infer. A live peer is never
  collapsed either, whatever it currently holds. And `[]` is the _other_ ambiguous value:
  `peerEntries` deliberately maps ENOENT and a successfully-read empty index to the same `[]`, since
  every ownership guard only ever asks whether a peer _owns_ a path and an absent claim is never
  permission for something a guard would otherwise refuse — so `[]` means "nothing is recorded", not
  "nothing was changed". It also covers the session whose write reached the working tree while its
  own index write failed (a full or unwritable `.sessions/`) before the path could be marked
  `unrecorded`: its lines are in the tree with nothing naming them, and collapsing it deletes the
  only named suspect for exactly the paths a human is staring at in `otherChanges`. That is what the
  heartbeat clause is for, and the wording matches it in `docs/tools.md`, in `status`'s output schema
  **and in the text `status` actually prints** — the channel a human reads — all of which say the
  index records no changes rather than that the session made none.

  The window is a **usefulness** window, not an evidence one: elapsed time is not evidence about a
  write that either failed or did not at the time it ran, it only bounds how long someone is still
  looking at those dirty lines. So the residual is documented rather than sized away — an agent
  killed overnight is already collapsed by morning, and matching the harm exactly would need a
  state-based condition (do not collapse while the tree holds dirty paths no live session owns),
  a larger change deliberately not made. Two sizing rules hold the clause up and are both easy to
  lose. It must **exceed `STALE_MS`**, because `!live` already implies a heartbeat at least that old,
  so any grace at or below `SessionRegistry`'s 30 minutes could never keep a single peer listed while
  reading exactly like a working guard; `STALE_MS` is exported and the unit test compares against it
  rather than a hand-copied literal, so raising either constant past the other fails the test instead
  of silently emptying the exemption. (`HEARTBEAT_THROTTLE_MS`, 30 seconds, is a different thing
  entirely: it paces how often a _live_ session rewrites its heartbeat.) And a **non-finite** age — an
  unparseable `heartbeatAt` — is never collapsed, the opposite sign from `bootIdentity.ts`'s "a
  non-finite age earns nothing", because the grant flips: there, granting calls a peer live; here,
  collapsing asserts it holds nothing. `isStalePeer` stays **one conjunction**, with `entries !== null`
  ahead of the later clauses, precisely so this cannot drift: every clause only narrows, so the
  collapse can only ever take fewer peers, and is structurally incapable of weakening the `null` guard
  in front of it.

  **Nothing is reaped from disk, and `SessionRegistry.collectGarbage()` — which exists and has never
  had a caller — must stay uncalled from here.** `status` is read-only and takes no lock, and `live`
  is _derived_, not authoritative: a pid can be invisible across a pid namespace, and a record only
  reads stale once its heartbeat is older than `STALE_MS`, so an idle-but-alive peer reads as dead
  well inside its own session. Reaping its record while it races its own `record()` would destroy the
  ownership proof `commit scope: "paths"` and `push` refuse on — the exact guarantee the shadow store
  exists to make. An integration test asserts each session's `session.json`, and the `shadow.json` of
  every session that has one, survives a `status` call — the **files**, not merely the directory,
  since `release()` removes only the record and leaves the directory standing, so a directory-only
  assertion would let that shape of "cleanup" land quietly — and that a corrupt index is still
  corrupt, since "repairing" one turns unreadable into "owns nothing". Records still accumulate on
  disk; only the _report_ is bounded, to the last two hours' worth of dead, empty sessions rather than
  every one the workspace has ever seen. One accepted cost: a session killed between its working-tree
  write and `record()` leaves dirty lines with no shadow entry and now collapses into a bare count
  instead of surfacing as a named suspect for them. The lines stay in `otherChanges` and no guard
  changes — `commit`/`push` consult `livePeers()` — so this is diagnostic loss only.

- **`session-feedback` grades the evidence behind every finding, and saves its report itself when there is no
  way to file it** (#68). Step 2, _Reconstruct the session_, is where the shell decides whether a finding is
  _correct_ rather than merely present: the report that prompted this was written from a compacted
  conversation and its headline finding came out wrong about **which side of the call failed** — recalled as
  the `resolutions` request being unwieldy, when the defect was the conflict response never being delivered.
  Those have different fixes, and the recalled version would have been filed with no less confidence. Every
  finding's evidence is graded **observed** (the call and its result are still visible) or **recalled**
  (rebuilt from memory or from a compaction summary), a recalled finding's issue block is stamped
  `_unverified — reconstructed from recollection_`, and the chat summary says the session was reconstructed
  without a re-readable transcript — the same way the environment block already states what it could not
  measure. Compaction is called out alongside the no-shell case rather than folded into it, because a
  compaction summary is the same lossy recollection **even with a shell sitting right there**. Ranking stays
  **by impact**, with the evidence grade as an annotation rather than a reordering: dropping or demoting a
  high-impact finding for being recalled loses it outright, which costs more than a flagged claim a
  maintainer has to double-check. Filing is treated the same way. The report is optional to write when `gh`
  can file the findings and must not be when it cannot, so the skill checks `gh auth status` before printing
  and, on a non-zero exit, writes the summary and every issue block to
  `.claude/session_feedbacks/web-latex-mcp-feedback-<date>.md` without asking (appending under a timestamped
  heading rather than overwriting a report not yet filed), says why it went there, and names `gh auth login`
  as the one command that unblocks filing; authenticated, nothing changes and the file stays offered, not
  written. The same exit code gates the known-issues search — an installed-but-logged-out `gh` fails it with
  an auth error, which is not "nothing found", so it counts as skipped and the confirmation checkbox stays
  unticked. The directory ships with its own `.gitignore` (`*`, `!.gitignore`) so a report is never
  committed, and the skill writes those same two lines wherever else it creates the directory.

- **One home for LaTeX's comment rule.** `edit_file`'s `excludeComments` and `search_files`'
  each grew their own backslash-parity scan — one counting the run, one skipping the character
  after each backslash. They agreed on every case tested, but two implementations of "what is a
  comment" are how the code that _writes_ commented-out prose and the code that _reads_ it
  eventually disagree. Both now delegate to `commentStartInRange` in `src/lib/latexComments.ts`;
  a mutation of that one rule fails tests on both sides.

- **The conflict-budget cap test stops taking 25 `edit_file` round trips to set itself up.** It was
  the slowest test in the suite (~4.6s locally, 4x its siblings in the same file) and had timed out
  three times on `windows-latest` against the 30s budget, blocking three unrelated PRs in one
  afternoon. The seam it asserts is `push`'s conflict payload — that `conflictFiles` is capped at
  `CONFLICT_MAX_FILES` while `conflictPaths` stays complete — and how the local commit came to
  exist is not part of that claim, so the setup now writes the working tree directly and commits
  with `scope: "all"`. Each round trip it dropped took the project lock (in-process mutex + lock
  file), recorded a shadow entry and rendered a confirmation diff. Same commit, same conflict, same
  assertions: ~1.5s. What did **not** change is `TOTAL_FILES = 25`, which must stay above
  `CONFLICT_MAX_FILES` or the cap assertion goes vacuous — raising the cap to 50 still fails the
  test, which is the property that makes it worth keeping.

- **The per-test timeout is now per-platform: 90s on Windows, 30s everywhere else.** Trimming the
  one expensive test above was necessary and is not sufficient, and the run that proved it was the
  one validating that trim: on the very commit that made `pushConflictBudget` 3x cheaper, the
  `windows-latest` job failed on two _different_ tests in `safePush.test.ts`, both at exactly
  30 000 ms — while a concurrent job over the identical tree passed. Same content, same platform,
  opposite outcomes is the signature of a budget, not of a hang.

  The numbers say the budget was mis-set rather than the tests being expensive. Those two cost
  1.6s and 1.4s locally, in a file whose slowest test is 2.3s; nothing in it is remotely near 30s.
  Windows runs this suite at roughly 10x Linux (~50s of test time on ubuntu, ~460s on
  `windows-latest`) because every assertion shells out to real `git`, and 10x is the _median_ — a
  20x tail is what a 1.6s test hitting a 30s wall means. A single global number chosen for the
  slowest platform will keep being crossed by whichever git-heavy test the tail happens to land
  on, which is why this flake has already moved once.

  So Windows gets ~40x headroom over the slowest integration test's local cost, and every other
  platform stays at 30s — deliberately, so a test that genuinely hangs still surfaces in 30s in
  the jobs that finish first, rather than the whole suite trading diagnosis time for tail
  tolerance. This buys headroom against a platform factor; it is not licence to make a fixture
  expensive, and the comment in `vitest.config.ts` says so.

- **The settle policy leaves the `commit` tool handler for `src/lib/commitSettle.ts`** (#70). Which
  shadow records a deliberate `scope: "all"`/`"paths"` take drops — everything vs. the named paths,
  the `hasChanges` guard, the rethrow when a request covered nothing this session tracks — was
  decided twice inside the handler, once in the `NothingToCommitError` rescue and once after a
  commit landed, and so could only be exercised through an MCP round trip against a real clone. It
  is now `settleTakenPaths` and `settleNothingToCommit` over a structural `SettleStore` port, unit
  tested against a temp-dir `ShadowStore`. Pure refactor: every existing integration test passes
  untouched, and `settlePaths` keeps its name and its export from `src/tools/commit.ts`.

  What the move is careful **not** to change is the part that reads like a bug and is the whole
  point: **a take settles by requested-path coverage, never by what git actually staged** (#66,
  finding 5). A `scope: "paths"` commit naming a directory drops every entry under it, including one
  git skipped because it is ignored or because its content already equals HEAD — which is exactly
  what un-wedges an already-reconciled entry, and is why `settle` is handed the requested paths and
  never `res.files`. The two halves of the #66 item-2 rescue survive together (nothing to stage for a
  request covering a tracked entry settles it and returns `committed: false`; a request covering
  nothing this session tracks still refuses), `fold` stays a parameter the caller decides from
  `GitService.isCaseInsensitive` rather than anything the new module infers, and nothing here clears
  a `conflicted`/`unrecorded` flag — the entry goes because the session took the tree deliberately.

- **`status.otherChanges` and `push`'s peer guard see index-only changes.** Both built their dirty set
  from `unstaged + untracked`, so a path modified only in the index — a hand `git add`, or an
  interrupted `commitContents` — was invisible to `otherChanges`/`sessionChanges`, and `push` let it
  through to `GitService`'s own uncommitted-changes refusal, unattributed. That is exactly the group
  git's _first_ "local changes would be overwritten" block reports, which made the refusal's "`status`
  names every path omitted here" pointer false for it. Both sets now include `staged` (deduplicated),
  the way `commit scope: "paths"` already did, so the pointer's superset claim holds and `push`'s
  disputed set is once again built exactly as `otherChanges` is.

- **Re-registering a project says which stored fields it dropped.** `register_project` with `gitUrl`
  or `path` on an id already known (in the registry, or held in-process from the env or `project_sync`)
  replaces the stored entry from the arguments given — that
  is unchanged and documented — but a `rootFile`, `branch`, `username`, `tokenEnv` or `followSymlinks`
  set earlier and not repeated vanished without a word. The result text now lists them with their old
  values so they can be re-registered on purpose. Internal clean-ups from the same review:
  `execCapture` is defined in terms of `execCaptureBytes` (one spawn body, and a multi-byte character
  split across two output chunks now decodes correctly), and `FileService.readBytes` refuses a file over
  the 2 MiB read cap instead of loading it whole.

- **`ASSET_EXT` (moved into `src/lib/assets.ts` for `add_asset`) now also recognizes `.tif` and
  `.ico`, gained along with the move.** Since that set also drives `list_files`'s `assets`
  classification and `read_file`'s binary-file refusal, a `.tif` or `.ico` that previously read as
  text through `read_file` now returns a path note instead, the same as every other asset type.

- **The win32 delete-pending retry in `withFileLock` is covered through the real code, not a mirror of it.**
  `tryAcquire` (`src/lib/fileLock.ts`) re-attempts once on a win32 `EPERM`/`EACCES` where the lock file
  is absent, because the previous holder's delete can complete between the failed `open()` and the
  existence check. That retry was covered only by a test-local `decide()` helper that re-implemented the
  decision in isolation — honestly labelled as a mirror, but a copy: deleting the retry from the source
  left the suite green, on a code path shared by every mutating tool. `tryAcquire` now takes an internal
  `LockAttemptDeps` seam (an injectable opener and platform string, defaulting per call to
  `open(p, 'wx')` and `process.platform`), so the tests drive the real function on any platform and
  assert both the outcome and how many times the opener was called — one call for the immediate
  rethrow, two for the race. The platform is threaded from one object into both `attemptOpen`'s
  contention classification and the retry guard, so the two cannot disagree; a test pins the case just
  outside the guard (a win32 `EPERM` with the lock file _present_, which is contention and must not
  retry) and fails if they are split apart again. No behaviour change: `withFileLock`'s signature and
  call site are unchanged, `isLockContentionError` is untouched, and `existsSync` stays uninjected.

- **`FileService.list` filters inside the walk and stats only what survives** (#174). It used to
  `stat` every file in the project and apply the filter afterwards, so `detectRootFile` — which runs
  on every `compile` — paid one syscall per figure to find a handful of `.tex` files. A symlink is
  still `stat`ed before it is classified, since that is what decides file-vs-descend and a directory
  link's name says nothing about its contents: the filter changes what is collected, never what is
  walked. Output is unchanged for every filter, pinned by expectations captured from the old
  implementation.

### Fixed

- **The Claude Desktop extension can read PDFs**: pdf.js ships in the bundle; only `render_pages`
  needs the native canvas, and says so.
- **`search_files` cannot stall the server**: regex searches run on a worker thread that is
  terminated at the deadline.
- **Parallel sessions**: a commit or push no longer takes a live peer's lines, conflicted entries
  stay flagged, `status` writes no shadow state and takes no git index lock, and the cross-process
  lock no longer admits two holders.
- **Git**: the access token never reaches `.git/config` or a command line, and a git URL carrying
  credentials is never stored; `discard` restores from HEAD; `revert` refuses when an untracked or
  ignored file is in the way; a missing remote branch is reported instead of "in sync"; a user's git
  configuration no longer breaks `diff`.
- **Files and edits**: `list_files`/`search_files` no longer follow a symlinked `subdir` out of the
  project; line-range deletions remove the lines; rewrite preservation never hides live text;
  `add_asset` reads through one handle; files named after `Object.prototype` members are tracked;
  shelving never loses work; non-UTF-8 bytes survive `revert` and `unshelve`.
- **PDF tools**: `render_pages`, `extract_text`, `pdf_geometry` and the `viewer` read the root's own
  build PDF; labels in `\include`d chapters are found; clipped renders no longer overwrite each
  other.
- **Bounded payloads**: `pdf_geometry` boxes, `extract_text`, `compile`'s `logTail`, `commit`'s file
  lists and `check_citations`' lists are budgeted.
- **References**: `add_citation` fetches outside the project lock; trailing junk after a Crossref
  entry is cut; DBLP keys are never rewritten; `list_references` claims the edit baseline only for a
  file it returned whole.
- **Messages**: values from the environment, a document or the caller are quoted and escaped;
  `server_info` returns an error result instead of throwing.

- **`push`'s review payload is budgeted too, not just its conflict payload** (#160, #153, #68). Branch
  mode returned `diff` (the whole review branch vs its base) and `diffFiles` uncapped, while the
  conflict branch of the same tool has been budgeted since #68 — so the one result most likely to
  carry a large patch was the one with no bound on it. `planPushReviewDiff` (`src/lib/diffBudget.ts`,
  additive) now fits it into the house `DIFF_CONTENT_BUDGET` (20000) across at most `DIFF_MAX_FILES`
  (20) files, cutting whole hunks from the end with a marker in place, and reports `diffChars`,
  `diffTruncated`, `diffHunksOmitted`, `diffPatchFilesOmitted`, `diffFilesOmitted` and `diffNote`
  (all newly declared in the `outputSchema`, since an undeclared key makes the whole call fail
  `-32602`). The patch is charged **once**, not twice as `diff`'s is: this result puts only the
  summary in the text channel, so a new `structuredOnlyCost` charges the single rendering — the note
  still reaches both channels, so a client that drops `structuredContent` is told what was cut and
  is routed to `diff` with `ref: "<base>...<branch>"`. The conflict branch's budget is untouched.
- **`list_files` is bounded, in both channels, and cuts by what an entry is for** (#164, #68). The
  listing had no cap, no counter and no budget, and it rendered every entry twice — once as a JSON
  object in `structuredContent.files`, once as a text line. A `figures/` tree with one PDF per seed
  per ablation, a vendored conference style bundle, or a `mode: 'local'` project registered on a
  directory the server does not control, all reach thousands of entries; at ~60 characters of path
  in two channels, 5000 of them is ~600k, which the client rejects **undelivered** — no listing and
  no reason, on the tool an agent calls first to orient itself in a project it has never seen. The
  new `src/lib/fileListBudget.ts` (a pure planner, the shape of `searchBudget.ts` /
  `citationsBudget.ts` / `diffBudget.ts`) bounds it at **40000 characters charged across both
  channels** — deliberately one house 20000-char share _per channel_, because unlike every other
  budget in the family the listing is not one field of a result, it **is** the result, and because
  the house `capList` figure of 20 is the wrong instrument here: the item is the answer and each
  item is tiny, so a listing tool that returns 20 of 5000 files is not a listing tool. What survives
  a cut is decided by `type`, in the order **tex > bib > doc > other > asset**, not by walk order —
  the walk sorts by path, so `assets/` beat `main.tex` on the letter `a` and a figures tree starved
  the sources the caller was almost certainly after; `other` outranks `asset` on recoverability,
  since `filter: "assets"` brings assets back whole while no `filter` value isolates `.sty`/`.cls`.
  Selection is by priority, presentation stays in path order. Whatever is cut is counted
  (`totalFiles`, `omittedByCap`, `omittedBySize`, `omittedByType`, all declared in the
  `outputSchema` — an undeclared counter is a `-32602` and no result at all, #137/#146) and named in
  `note`, which points at the remedy that here actually exists: `subdir` and `filter` narrow the
  walk itself, so the omitted entries come back whole. **A cut can never produce `files: []`** — the
  first entry is kept whatever it costs — so an empty array keeps meaning only "nothing matched". A
  new optional `maxResults` narrows by count (it can only narrow; the character budget is fixed),
  and an uncut listing is unchanged on the wire: the same one line per entry, the same
  `No matching files.`, no note.
- **`list_comments` is budgeted, and its payload no longer ships twice unbounded** (#163, #68,
  #153). The tool had no cap of any kind — no `maxResults`, no character budget, no counter — and
  it rendered every comment **twice**: once into `structuredContent.comments`, once field for field
  into the result text. `quote` is the PDF text the user selected (a selection can be a page),
  `snippet` is five lines of project source, and `note` is uncapped user text — so 200 comments on
  a paper under review, which is the ordinary case rather than the bad one, reached the ~67k
  payload a client rejected **undelivered** in #68. A new pure planner, `src/lib/commentsBudget.ts`,
  fixes it in the house shape (a budget, a plan, a `budgetNote`, a thin tool layer), with the render
  templates living beside the cost function that **calls** them so the charge and the text cannot
  drift, and the text channel rendered from the already-cut payload rather than from the full one.
  The priority order is **within** a comment rather than between comments, because every comment is
  equally something the user asked about: identity and location survive first, then `note` (clipped,
  never dropped — it is the one field with no copy anywhere else a tool can reach), then `quote`
  (still selectable in the viewer), then `snippet` (one `read_file` at the comment's own
  `file`:`line`). So the recoverable fields are cut across **every** comment before a single comment
  is dropped — dropping the 150th comment makes the user's 150th note invisible and puts it beyond
  `resolve_comments`, which takes `ids` that come only from here. New `structuredContent` keys, all
  declared in the `outputSchema` (an undeclared one makes the whole call fail `-32602` and return
  nothing — #137, #146): `commentsOmitted`, `quotesOmitted`, `snippetsOmitted`, `truncated`,
  `budgetNote`, and per comment `noteOmittedChars`/`quoteOmittedChars`/`snippetOmittedChars`, whose
  presence is what tells a budget cut apart from the innocent reasons a field is absent (the user
  selected no text; no synctex location; a withheld path). The unopenable-path guard is untouched
  and runs first: the budget only ever removes fields, so a `file`/`line`/`snippet` withheld because
  the document named a path leaving the project can never come back through it.
- **`compile`'s `errors[]` and `warnings[]` are budgeted, warnings cut before errors** (#162,
  #68, #153). `logTail` beside them had been bounded at 80 lines all along, while both arrays went
  into `structuredContent` uncapped — and the tool's own comment said why that hurts ("a normal
  build has hundreds of [warnings]"), having bounded the per-warning cost and left the count open.
  A thesis-length document with a wide table emits an `Overfull \hbox` per line: a 1200-warning
  log now measured at **201,966 characters** of rendered payload, three times the ~67k a client
  rejected undelivered in #68, on a **successful** compile of an ordinary document — and `compile`
  is the most-called tool in the server, so this fired on the loop the agent was already in. The
  new `src/lib/diagnosticsBudget.ts` is a pure planner in the family shape (a budget, a plan, a
  `note`, a thin tool layer): 20000 characters charged across BOTH channels, allocated in
  `ALLOCATION_ORDER` — **errors first, so warnings are cut first**, the thing that breaks the build
  cut last — with the text channel rendered from the already-cut payload so it cannot re-render the
  full set behind the budget's back. The two channels are charged apart rather than averaged,
  because they differ: the first ten errors ship **twice** (rendered into the result text with
  their snippets, and again as JSON), warnings ship once, and `renderErrorLine` is the same call
  the cost function charges and the tool ships. Cuts are counted in **new** fields,
  `errorsOmittedByCap`/`warningsOmittedByCap`, never folded into `warningsOmitted` — that one
  counts what the caller's own `warningsFilter` removed at their request, a different claim its
  schema text makes at length, and the two are never added. `omittedSnippetLocations` keeps its
  meaning and its schema text now says so: it is counted where snippets are attached, before the
  cap, so it answers "what could the log be vouched for" rather than "what fit", and an error the
  cap drops is counted in `errorsOmittedByCap` instead. Nothing about snippet provenance changed,
  an error carrying a snippet is kept past the count cap (so context the server already read is
  never thrown away), at least one error is always returned, and `logTail`'s own 80-line bound is
  untouched — it is the fallback evidence for the warnings this cut removes.
- **`list_references`' third document-controlled region — `title`, `authors[]`, `venue` and the
  identifiers — is budgeted, in both channels it ships in** (#165, after #137 and #147). The parse
  shortens nothing, so a 4000-character `title={…}` came back as a 4000-character `title`, a
  200-author collaboration as 200 strings per entry, and a `prose` bibliography's heuristic title
  as however much text sat between the delimiters it found — with no `.bib` anywhere in that path.
  `src/lib/referenceTypedBudget.ts` is the third planner of the family and takes a third allocation
  of the one house figure (`REFERENCE_TYPED_BUDGET` **is** `REFERENCE_FIELDS_BUDGET`, imported), so
  the worst case for all three regions is ~60000 rendered characters **across both channels** — it
  is charged on the JSON _and_ on the text `list_references` renders from it, which is why a third
  allocation still lands under the ~67k a client rejected undelivered in #68. It cuts by declared
  priority across the whole result rather than entry by entry, so every entry keeps its title
  before any entry keeps its URL; a prose-shaped value is truncated to a marked prefix, an
  identifier is dropped whole (half a DOI is not a short DOI), and `key`/`label` are never
  truncated at all — an absurd one is dropped, since a cut cite key is one that does not exist.
  `authors[]` gets `capList`'s cap of 20 with the rest reported as `authorsOmitted` ("first 20 of
  214"), which is deliberately not `truncatedAuthors` (the document's own `and others`). New
  counters `entries[].typedOmitted`, `entries[].authorsOmitted` and `typedNote` are **declared in
  the `outputSchema`** — the omission that made this tool uncallable from v0.6.0 — and the text
  channel is rendered from the already-cut payload by the renderer the cost function itself calls.
  The same change lowers **`maxResults`' default from 200 to 50**, the one lever that reaches what
  no content budget can refuse: at 200 an ordinary bibliography rendered ~120000 characters across
  both channels even with all three regions budgeted — still far past the size a client rejects —
  and arrived stripped of the authors, venue and DOI a reader is there for, because the per-entry
  scaffold (`path`, `line`, `format`, `year`, cite key) is irreducible and crowds the content
  budgets out. At 50 the same `.bib` comes back whole and fits.

- **The last native absolute path `FileService` emitted, and one spelling per result in `status`,
  `commit` and `revert`** (#148, #138, #141, #80 §4). Two remainders #141 deliberately left behind.

  `FileService.readBytes`' over-cap refusal ends "Open it directly at `<abs>`" — the one thing the
  message is _for_, since it hands the caller a path instead of the bytes — and that path was
  native, the same defect shape as the binary/large-file `note` #141 fixed four hundred lines up in
  the same file. It is now `toPosix`'d **on the interpolation, never on `abs`**, exactly as that
  note is: `abs` stays the `resolveInside` string that `readFile` and `this.revisions.record` key
  on, and re-spelling it would file a baseline under a key no write looks up. The branch was left
  untested in #141 for fear of a 25 MiB fixture; it needs none — `truncate` makes a sparse file
  whose `stat` size is over the cap while it allocates no blocks, and the pre-read `stat` guard
  never opens it, which is what the four cap tests beside it already do. **No injectable cap was
  added**: the seam would have been production surface around a security-shaped number that
  `src/lib/assets.ts` argues against in as many words, bought for nothing. The message surfaces in
  no tool result — `revert`'s shadow-attribution loop catches every throw and logs it — so the test
  is a unit one, and it fails against the old code.

  `status`, `commit` and `revert` each mapped _some_ of their returned path lists through `toPosix`
  and not others (`status`'s `sessionChanges` yes, its `staged`/`unstaged`/`untracked`/
  `externalChanges`/`conflictedChanges`/`activeSessions[].changes` no; `commit`'s `leftUncommitted`
  yes, its `files`/`conflicted`/`unrecorded`/`ignored`/`settled` no; `revert`'s `mismatchedFiles`
  yes, its `files`/`conflictPaths` no), so one result could carry two spellings of the same kind of
  data and the next reader could not tell which were converted by rule and which by accident. Every
  such list is now converted once, at the reporting boundary, and the text channel is rendered from
  that same value so the two cannot disagree. **No behaviour changes on any platform** — git's own
  output is `/`-separated and a shadow key is normalised when it is recorded — which is the point:
  this is the convention made uniform, not a Windows bug. What stays native is asserted rather than
  assumed: `status` still hands `ctx.files.externalModifications` the raw git spellings it resolves
  against the filesystem, `revert` still hands `settleAll`/`readAtRefBytes`/`readBytes`
  `pre.touchedPaths` untouched, and `commit` converts strictly below every `git add` pathspec and
  `check-ignore` probe. `src/tools/doctor.ts`'s `workspaceRoot` remains deliberately unconverted.

  On coverage: a git-sourced list cannot be made to fail such a test, because a relative path from
  git is `/`-separated everywhere and a filename literally holding a backslash comes back C-quoted
  (`"out\\dir/notes.tex"`) rather than as a separator — so those conversions are no-ops by
  construction and no assertion about them is written. The two lists that _can_ carry one are the
  shadow-store-sourced ones, `status`'s `activeSessions[].changes` (read out of a file another
  server process wrote) and `commit`'s `settled`; both are pinned under the stubbed-separator
  harness and both fail against the old code.

- **`check_citations` bounds its report, advisory findings first and build-breaking ones last**
  (#154). The tool built four finding lists and returned every one of them whole through
  `structuredContent`, then rendered every one of them again into the text channel: no cap, no
  `maxResults`, no budget, no counter. The case that bit was the _ordinary_ one rather than a
  hostile one — a group `.bib` carried in the project with 300 entries and a paper citing 80 of
  them is ~220 `uncitedEntries`, each with a document-controlled BibTeX `title`, in both channels,
  as the **default** result for a perfectly normal paper. The `bibliographyProject` path already
  forced `uncitedEntries` empty for exactly that reason; the same reasoning applies when the shared
  `.bib` lives _in_ the project, and there nothing applied it.

  `src/lib/citationsBudget.ts` is the new planner — a pure function over plain data, the shape
  `conflictBudget.ts`/`floatsBudget.ts`/`searchBudget.ts` already use, so the tool layer only maps
  a plan onto response shapes. Three decisions carry it. **Per-list caps with an explicit
  priority, never one global budget spent in declaration order**: `ALLOCATION_ORDER` writes the
  order down, and read as a cut priority it is `uncitedEntries` first (advisory — "dead weight, not
  an error" in the schema's own words — and the only list carrying free text), then
  `incompleteEntries`, then `duplicateKeys`, with `undefinedCitations` cut **last** because those
  break the build and are the cheapest list to carry. A shared budget walked in build order would
  have spent it on the advisory list and cut the important one — the ordering mistake
  `conflictBudget.ts` avoids by allocating `hunks` before the sides. The order is strict: once a
  list is cut by size the ones behind it get nothing, rather than a few cheap advisory rows
  slipping in behind a truncated higher-priority list. **Nest-aware counting**: capping the outer
  list alone leaves one missing key cited 400 times carrying 400 `{path,line}` objects, so
  `uses`/`occurrences`/`missing` are cut first, at 20 each, with their own `usesOmitted` /
  `occurrencesOmitted` / `missingOmitted` — and the outer entry is then charged the cost of what it
  will really send. **The budget is charged against rendered size**, each entry at its own
  `JSON.stringify(entry).length`: a BibTeX title is LaTeX and LaTeX is backslash-dense, so raw
  `.length` under-counts by roughly half.

  Figures are the house ones — 20 per list (`capList`, `CONFLICT_MAX_FILES`) and 20000 characters
  across the four (`CONFLICT_CONTENT_BUDGET`, `FLOATS_CONTENT_BUDGET`, `SEARCH_CONTENT_BUDGET`) —
  with a new `maxResults` (1..1000) raising the per-list cap the way `list_references`' does,
  though a cap is needed regardless because the _default_ has to be safe. Nothing is cut silently:
  `undefinedCitationsOmitted` / `uncitedEntriesOmitted` / `duplicateKeysOmitted` /
  `incompleteEntriesOmitted` are always present, `shown + omitted` always equals what was found,
  and `note` names which list and which bound fired. One counter per list rather than two: unlike
  the withheld-snippet counters, which distinguish two different _claims_, both bounds here make
  the identical claim ("this finding exists and is not shown"), so which one fired is a fact about
  what to do next and belongs in `note`. The cut is a tail of a key-sorted list, never a
  cherry-picked subset, and the first `undefinedCitations` entry is kept even if it alone exceeds
  the budget — a report listing nothing tells a caller nothing, and that exception is cheap
  precisely because that list carries no document-controlled free text. **The text channel is
  rendered from the already-cut payload**, so the two channels cannot disagree, and a section whose
  entries were all cut still prints its heading with `showing 0 of N` rather than vanishing into
  "no uncited entries". Every new key — the four counters, the three nested ones, and `note` — is
  declared in `outputSchema`, and an integration test calls `listTools()` before the tool so the
  SDK's per-schema ajv validator is armed and an undeclared key would fail the call outright
  (#137, #146). The `bibliographyProject` rules are untouched: two sandboxes, read-only, no lock,
  and `uncitedEntries` still empty by design rather than by a cap that happened to fire. Along the
  way the renderer's hand-copied view of the payload — which had already drifted, omitting the
  `incompleteEntries[].type` the handler emits and `outputSchema` declares — now extends the
  planner's own type, so it cannot drift again.

- **`logTail` carries the line that says _what_ failed, and a package name holding a `.` or a `-` is
  a warning at all** (#78, #73). Two gaps in the log de-noiser, both of which left `logTail` — the
  channel a text-only client reads — describing a compile the structured fields got right.

  latexmk is passed `-file-line-error`, so a real error prints as `./main.tex:5: Undefined control
sequence.`: no leading `! `, no inline `Error:`. `FILE_LINE_ERROR` is therefore in `KEEP_PATTERNS`,
  or the de-noiser keeps the `l.5 \bad` echo beneath the error and drops the sentence naming the
  failure, handing a client a position with nothing to attribute it to while
  `structuredContent.errors` is right all along (`parseLog` tests the same regex first and treats
  such a line as an error whatever its message says). Because that regex also sits in
  `ALWAYS_KEEP_PATTERNS`, the line is filter-exempt for free and the two partitions stay aligned —
  the standing rule that a `KEEP_PATTERNS` entry which is neither always-kept nor a warning line is
  a bug in waiting. This moves unfiltered `logTail` output, so `GOLDEN_DIGEST` in
  `test/unit/filterLogWarnings.test.ts` was **deliberately regenerated** and the delta verified line
  by line rather than rebaselined on faith: across the 18000 generated outputs the only new content
  is the `-file-line-error` line itself (sometimes glued to the preceding 79-column fragment by
  `unwrapLines`), plus shifted omission counts where the cap elides one more line; no kind of line
  disappears; and three short logs that used to fall through to the raw tail because nothing matched
  now de-noise to their single error line, which is the fallback correctly ceasing to fire for a log
  that does have a diagnostic in it. That digest's failure message and doc comment were **tightened**
  while regenerating it: a `KEEP_PATTERNS` edit moves the digest whether it adds a kept line or
  silently drops one, and the digest is the only thing that tells those apart, so "I meant to change
  that list" is explicitly called insufficient — the constant may be updated only once the old and
  new output have been diffed and every added and removed line can be named. A `.sty`-path case sits
  alongside the `.tex` ones, because every other `-file-line-error` literal in the tests names a
  `.tex` and a narrower `\.tex`-only rewrite of the entry passed all of them with the digest
  unmoved, while silently losing the message line for every error raised inside a package.

  `PACKAGE_WARNING`'s name class is `[\w.-]+`, so `Package pdftex.def Warning: …` — pdfTeX's own
  driver file, one of the commonest warning sources in a real log — is a warning. Under `\w+` it was
  not misclassified but **invisible**: missing from `warnings[]` entirely, uncounted by
  `warningsOmitted`, while `KEEP_PATTERNS`' literal `/Warning:/` still kept the raw line in
  `logTail` — precisely the ships-twice asymmetry `warningsFilter` exists to remove, on the warning
  a user is most likely to want filtered. The space before `Warning:` stays outside the class, so a
  name can never swallow into it, and `filterLog`'s no-filter output is unaffected, since
  `KEEP_PATTERNS` matches the literal word and never this regex.

- **The `push` conflict payload is bounded, in both channels, by one budget** (#68). The three sides
  plus `hunks` are ~96% of a conflict result, so a conflict on a single ~20k-character section file
  rendered 67,485 characters — past a client's tool-result cap, which drops the whole result rather
  than trimming it, taking with it the 3% a caller needs in order to _act_ (`remoteHead`,
  `mergeBase`, `conflictPaths`, `remoteCommits`, including the very refs `read_file(path, ref)`
  needs) and so disabling the documented alternative to itself. Both channels now render from **one**
  plan (`src/lib/conflictBudget.ts`, a pure planner in the shape of `inlineBudget.ts`), so they
  cannot drift: `CONFLICT_SIDE_CAP` (12,000, the former `INLINE_CAP`, now single-source) caps any one
  **side**, and `CONFLICT_CONTENT_BUDGET` (20,000) caps the payload **in total, across every file** —
  the old per-side-per-file cap over an uncapped file loop multiplied past any of it.

  The budget is charged against **rendered** size, not raw content: the `<<<<<<<`/`=======`/`>>>>>>>`
  marker boilerplate around each hunk, the JSON punctuation around every hunk and array element, each
  file's `━━━━━ path ━━━━━` header, each side's label, and what an _elision_ itself costs (cutting is
  not free) are named constants — `HUNK_MARKER_OVERHEAD`, `HUNK_JSON_OVERHEAD`,
  `HUNK_LINE_ELEMENT_OVERHEAD`, `FILE_HEADER_OVERHEAD`, `SIDE_LABEL_OVERHEAD`, `SIDE_ELISION_OVERHEAD`,
  `HUNK_ELISION_TEXT_OVERHEAD` — pinned by tests that render a known input and check the constant
  still accounts for it, so `conflictText.ts`'s templates cannot drift out from under them. Budgeting
  the content alone left a few hundred small hunks rendering ~64,000 characters while the plan called
  itself bounded. Two hard caps sit underneath for the shapes no per-item budget can bound:
  `CONFLICT_MAX_FILES` (20, `capList`'s house value) limits how many files get a detailed block at
  all, and `CONFLICT_MAX_SPANS` (20) limits the line spans listed for an elided hunk block, since
  eliding hunks _to save space_ could otherwise emit a bigger payload than keeping them.

  **The top-level fields are never what gets cut.** `conflictPaths` is never capped and never elided
  — it lists every conflicted path however many there are, and it is the one thing a caller needs in
  order to act — and `remoteHead`, `mergeBase`, `rebasedOnto` and `remoteCommits` always survive;
  burying those under the bulk was the original bug. What does get cut is ordered by what the caller
  can get back: `hunks` are allocated **first and cut last**, because once the rebase aborts the
  marker view is gone from the working tree, while a side is one `read_file(path, ref)` away — so an
  elided side carries the exact ref to fetch it and elided hunks carry their count and line spans.
  Where there is no merge base to fetch from at all (unrelated histories), the pointer says so in
  both channels rather than sending the caller to overlap markers the same budget may just have
  elided. Because `null` on a side **already** means "absent — added or deleted on this side", an
  elided part comes back `null` **with** a matching per-file `elided` record (its true size and how
  to fetch it), and `conflictTruncated` reports it at the top level: `null` with no `elided` entry
  keeps its old meaning, and that distinction must never blur. The `note` names only whichever cap
  actually fired — per side, aggregate, or file count — never one that did not; and when the
  mandatory per-file headers alone exhaust the budget (very long paths), it says so first instead of
  blaming the aggregate cap.

  `remoteCommits` is bounded on a conflict too, at `CONFLICT_MAX_COMMITS` (20) commits of
  `CONFLICT_MAX_COMMIT_FILES` (5) files — the caps the text channel already applied — with
  `remoteCommitsOmitted` and a per-commit `filesOmitted` counting what was cut; passed through
  verbatim it was 38% of the JSON, 60 conflicted files under 12 upstream commits of 20 files rendering
  80,440 characters with `conflictTruncated: true` claiming the job done. The text's "… N more
  commit(s)" pointer sends the caller to `status.behindCommits` — uncapped, and the same list once
  the rebase has aborted — rather than to a `structuredContent` that no longer holds it, while
  `rebasedOver` on a successful push and `status`'s own commit lists stay uncapped, so
  `renderCommitLines`' default "(see structuredContent)" pointer stays true for them.

  `push` plans the per-file payload **once** and hands that one object to both renderers, which
  assert that plan and report line up file by file, so "same plan" holds by construction rather than
  by two deterministic calls agreeing. `conflictDetail: "full"` is the opt-in escape hatch that lifts
  every cap, and `conflictDetail: "auto"` (the default) is the budgeted one. Dropping the sides by
  _default_ was declined: docs/CONCURRENCY.md and CLAUDE.md both promise all three sides so an
  MCP-only client can resolve without a shell, and defaulting them off regresses the ordinary small
  conflict (three 2k sides, one round trip) to fix the rare large one. Accepting a resolution as a
  _path_ in the clone was declined too — for a shell-less client the merged bytes cross the model
  either way, and a merged file in the working tree is a tracked modification the rebase then refuses
  over. `GitService` is untouched: it still builds the complete report, which is what `resolvePush`
  re-surfaces when a resolution is missing, and the budget applies at the formatting boundary only.

- **A pull this server refuses is refused in this server's vocabulary, and every path list in a peer
  refusal is bounded** (#68, and its follow-ups). git's own refusals prescribe `stash`, a command
  this server does not expose, and never mention `commit` or `discard`, which it does — on a client
  with no shell, one of the two exits git offers cannot be reached at all.

  **Both pull refusals are typed.** A locally modified _tracked_ file throws
  `LocalChangesOverwriteError`, the sibling of the `UntrackedOverwriteError` `push` already had; an
  incoming commit adding a file that already sits _untracked_ in the clone throws that same
  `UntrackedOverwriteError`, which carries an `operation` (`push`, the default, or `pull`) and words
  itself accordingly. Both carry the parsed paths and state that nothing changed — `merge --ff-only`
  aborts cleanly, so HEAD did not move and the working tree is exactly as it was — then name the
  exits this server actually has, and say plainly that git's `stash` advice is not available.
  Because each error knows which paths collided, it prescribes them: `commit` with `scope: "paths"`
  and those paths, or `discard` scoped to those paths — never a bare `scope: "all"`, which would
  sweep a live peer's in-flight edits into this session's commit, and never a bare `discard`, which
  reverts the whole working tree — and `discard` with `paths` is what removes an untracked name,
  since it runs `clean -f` over it. Both pull wordings say `commit` with `scope: "paths"` **then
  `push`**: the rebase a push performs is what surfaces a proper add/add conflict, where a plain
  sync after committing would only report the histories as diverged, so "the next sync succeeds" is
  reserved for the `discard` route. Every path list in both wordings caps at the shared
  `REFUSAL_PATH_CAP`, carrying the same "first N of M — `status` lists them all" note. Both refusals
  share one indented-path-list parser, differing only in the opening line they key on, with the two regexes written so they can never cross-fire —
  they lead to different fixes. This is deliberately a translation of git's refusal **after** it
  happens, not a working-tree pre-check: `merge --ff-only` succeeds over a dirty tree whenever the
  incoming commits do not touch the dirty files, and a status-based gate would refuse pulls git would
  happily perform. ff-only stays ff-only, and `--autostash` stays rejected for the reason already
  recorded for `push`: a pop is an automatic merge of somebody's uncommitted lines, and a pop
  conflict leaves markers behind.

  **The closing advice is composed from the attribution, by one composer shared with `push`**
  (`src/lib/peerRefusal.ts`, where the live-peer guard and the attribution appended to a refused pull
  now live instead of in the tool layer). Each remaining path is attributed to the live peer session
  whose shadow claims it — untracked paths included, since a peer's `write_file` of a new file puts
  that file in the peer's shadow, and **subtracting this session's own paths first**, since
  `livePeers` excludes self and an unfiltered list would report the caller's own edits as belonging
  to nobody. The files
  then fall into two groups needing **opposite** advice: a peer-owned file can only be taken with
  `scope: "all"`, because `scope: "paths"` refuses outright any path a live session's shadow lists —
  and the scoped `discard` is retracted for that group, since `discard` has no ownership guard and
  would destroy the owner's uncommitted work — while a file **no** live session owns is the reverse,
  where `scope: "paths"` naming just those paths is the better route precisely because it cannot
  sweep in a peer's lines. A peer whose change index is unreadable is advised as an owner, failing
  closed exactly as the refusal does. Sharing one composer is the point rather than a tidy-up: which
  route works is decided by `commit`'s peer guard, so two tools wording it independently is two
  chances to drift out of step with that guard. Only the closing line differs — `push` talks about
  rebasing and pushing again, `project_sync` about a refused pull.

  **All four path lists cap at one exported `REFUSAL_PATH_CAP`** (20, the house value `capList` and
  `CONFLICT_MAX_FILES` already use): the header's full list, each live session's `owns`, the files no
  live session owns, and the closing paragraph's copy — four independently chosen cap values would be
  the same drift one level down, and the same `unowned` list coming back capped in one paragraph and
  uncapped in the one above it is incoherent on its face. Capping costs more here than in the
  conflict payload, and that is worth reading twice: this refusal is an `Error`, and `errorResult`
  returns text with **no** `structuredContent`, so a dropped path is dropped from the response
  entirely rather than merely from one of two channels. What makes it acceptable is that `status`
  already carries the complete lists on purpose — its `otherChanges` is built exactly as `push`
  builds the disputed set, and its `activeSessions[].changes` is whole even though its own text shows
  five paths per peer. The message names a cap when, and only when, one actually fired; announcing a
  cap that did not fire is the same false statement about a payload that `conflictBudget`'s `note`
  rule exists to prevent. And it names `status` as a **derivation**, not as two fields to go read:
  `status` has no `unowned`-shaped field, and `otherChanges` is the _whole_ disputed set, peer-owned
  files included, so a caller who fed it to `commit scope: "paths"` as the closing directs for
  unowned files would hit the live-peer guard and lose the entire call. The pointer therefore spells
  out that the unowned set is `otherChanges` minus every live session's `changes`, with a null
  `changes` claiming everything. Naming a field that bounces off the guard one tool over is the exact
  failure the shared composer was written to end, and a pointer that merely sounded helpful would
  have re-introduced it one layer down. For the same reason the line claims the _weaker_ thing — that
  `status` names every path the lists omit, among more besides — rather than that it reports these
  lists back: that identity holds for `push`, whose disputed set is built exactly as `otherChanges`
  is, but not for `project_sync`, which renders the same line over the paths an incoming commit would
  overwrite, tracked or untracked, a strict subset no `status` field reproduces. One message shared
  by two tools may only assert what is true for both. The unreadable-peer line lists no paths at all:
  that peer is treated as owning everything precisely because it might own anything, and printing a
  concrete list would read as a claim about which.

  **`project_sync` runs inside `runExclusive`.** It cloned and fast-forward-pulled outside the lock,
  so a peer session's `write_file` or `commit` could interleave with the pull; the lock file lives
  outside the clone (`<workspace>/.sessions/<id>/project.lock`), so a first clone takes it too. The
  cost is the lock's own: a peer waiting on the file lock gives up after 30 s, so a sync that fetches
  for longer than that costs a concurrent peer one refused write, where before the two interleaved
  silently — the trade the lock exists to make.

- **A reused pid no longer keeps a dead session `live` forever, permanently blocking `push`** (#78).
  `SessionRegistry` derives liveness rather than trusting it — a crashed session cannot retract its
  record — and counted a peer live if its recorded pid still named a running process **or** its
  heartbeat was inside the 30-minute staleness window. A pid is unique only within one boot, and
  `.sessions/` lives beside the clones and so survives a reboot, after which a dead session's recorded
  pid could be handed to an unrelated process and `pidAlive` answered true indefinitely. The record
  never aged into `staleSessions`, and `guardPeerWork` refuses while any live peer exists **whatever
  that peer owns** — it is owner-aware only about how it _words_ the refusal — so a ghost holding
  nothing blocked every `push` made while the tree carried a dirty path this session had not itself
  recorded, naming a session that did not exist; the dead session's own abandoned edits are still
  sitting in the tree owned by nobody, and they are precisely such paths. There was no way out through
  the tools, and the only cure was hand-deleting a JSON file a user would have to read the source to
  know about. Each record is now stamped with the boot it was written in (`bootedAt`, derived in
  `src/lib/bootIdentity.ts` from `os.uptime()`), and the pid clause counts only when that stamp matches
  the current boot, so every route to `live` is bounded again unless the process genuinely still exists.
  The heartbeat clause stays a deliberate grace rather than being tightened into `pidAlive && age <
bound`: a session heartbeats from `status`, `commit`, `push` and the mutation recorder, so anything
  actually doing work stays fresh, but a session merely idle — waiting on its user, or reading — is
  still real and still deserves protection, and tightening would trade a spurious refusal for the far
  worse failure of sweeping a live peer's uncommitted lines.

  The stamp is **approximate** — second-resolution uptime, and a clock NTP can step — so the comparison
  carries a generous tolerance biased on purpose toward "same boot": calling two boots one merely leaves
  a spurious refusal in place, while calling one boot two would revoke a live session's pid grant and
  let its uncommitted work read as owned by nobody, the direction this codebase does not fall in.
  `os.uptime()` counts suspended time on all three supported platforms, so a sleeping laptop is not a
  reboot. Because `Date.now() - os.uptime() * 1000` drifts whenever the wall clock is stepped without
  uptime advancing — 4m32s inside a single boot on the WSL2 machine this was built on, about 90% of the
  tolerance, and hours for a laptop asleep overnight — the pid clause has a second route that does not
  depend on the clock at all: a record whose `heartbeatAt` is at or after **this process's own start**
  was necessarily written during the current boot, because a reboot would have killed us. That proof is
  immune to drift (a step changes future readings, not two past ones being compared), but it can only
  vouch for records written since we started, so it supplements the stamp and never replaces it. A
  record with **no** stamp — written by an older build, and one that will never grow one, since Node
  does not hot-reload — earns no pid grant from the stamp, and would otherwise strand a still-running
  old-build session: idle past the staleness window with uncommitted work, it reads dead to a new-build
  peer whose `commit scope: "paths"` then takes its lines, which fails **open**. Such a record therefore
  keeps its pid grant on the strength of the pid alone for a bounded `LEGACY_PID_GRACE_MS` (24h), long
  enough to cover a session left open overnight; the bound is the point, since an unbounded pid clause
  is the defect itself, so a legacy ghost whose pid has been reused clears itself within a day instead
  of needing that hand-deleted file. The grace deliberately does **not** extend to a record whose stamp
  merely drifted: that record has a stamp and the stamp says another boot, so granting it anyway would
  override evidence rather than act in its absence — and would re-grant the boot-reused ghost for a day.

  Three residuals are stated rather than claimed away. Pid reuse **within** one boot (wraparound) is
  still not detected; telling it apart needs the OS's per-process start time, which has no portable
  source across the three platforms. A **clock step** can still strand a live peer, and what decides
  that is the drift accumulated between the peer's last heartbeat and the `peers()` call judging it —
  including a step landing well after the judging process started, so long as that heartbeat predates
  our module load, which is exactly when the clock-free route cannot speak for it either. And in
  **containers** the two routes part company in whichever direction the runtime chooses: under a plain
  runtime `/proc/uptime` is the host's and is not namespaced, so two sessions in separate containers
  derive the same stamp while their pids come from different namespaces where low pids always exist
  (`pidAlive` false-positives, fail-closed, the wraparound family); under **LXCFS or gVisor**
  `/proc/uptime` _is_ virtualised per container, so an idle peer in another container matches neither
  route and reads dead — fail-open, and the legacy grace does not reach it, since those records carry a
  stamp, just the wrong host's. The registry is a single-machine mechanism: a workspace on a network
  share between two machines was never something a pid could speak to.

  Two lifecycle guarantees around it are worth stating as guarantees rather than as tests.
  **`collectGarbage()` must never reap a directory whose record it could not read** — unreadable means
  UNREADABLE, never "owns nothing", the same fail-closed reading `attributePeers`/`isStalePeer` use for
  a `null` shadow index — because reaping one deletes a shadow index that `commit scope: "paths"` and
  `push` refuse on, turning a visible refusal into vanished evidence; and it **must reap the whole
  directory**, not just the record, since narrowing that `rm` fails closed (it leaks a dead session's
  shadow bytes rather than destroying a live peer's proof) but leaks _silently_, `peers()` going on
  reporting nothing for the directory. `release()` removes the record only — a sibling `shadow.json`
  and `shadow/<rel>` come back byte-identical — and resolves rather than rejecting for a project with
  no directory at all, which is what the shutdown loop in `index.ts` leans on; the heartbeat throttle
  is keyed **per project**, since a shared one would starve a project's heartbeat and a starved
  heartbeat is the fail-open direction, a live session reading dead to its peers. Inside `touch()`, the
  synchronous `lastHeartbeat.set` **before the first `await`** is load-bearing and pinned by a test: it
  is what makes the throttle dedupe _concurrent_ callers and not merely sequential ones, because
  `writeAtomic` names its temp file `${target}.${process.pid}.tmp` — unique per process, not per call —
  so two touches racing on one project fight over one temp file, the first `rename` consumes it, and the
  rest reject with `ENOENT`. `touch()` is uncaught at three of its four call sites (`status`, `commit`,
  `push`), so that is a hard tool failure out of a registry whose whole contract is that a missing or
  stale registry only ever costs visibility, and it is reachable: `status` takes no `runExclusive` lock,
  so it can be in flight against a `commit` on the same project in one process. A per-call temp name is
  the real repair and is still owed.

- **A pathspec handed to git is literal, never a glob — and a long list of them is chunked, so a
  large operation no longer blows Windows' command line** (#66, #67, #94, #110). Every `git add`,
  `ls-files`, `ls-tree`, `diff` (patch and numstat) and `discard`'s `checkout`/`clean` call that
  takes a path a caller or a shadow named runs with `--literal-pathspecs`, the global option,
  _before_ the subcommand; so do the conflict side's index-stage mode lookup and `commitContents`'
  own, so `a[1].tex` is never judged by `a1.tex`'s index entry. `check-ignore --stdin` reads paths
  rather than pathspecs and needs none. `GitService.diff` needed the flag because the write tools'
  confirmation diff feeds it a path a caller named. Without it `a[1].tex` is a glob that also
  matches `a1.tex`, and under `scope: "paths"` that staged a peer's dirty `a1.tex` past an
  ownership check which had compared literal names — the one thing a session commit must never do —
  while in `discard` it is the most destructive place for two names to mean one file. Callers see the
  same rule in the `paths` description — matched literally, no globs — so a `sections/*.tex` is
  refused in server words rather than expanded. A new git call site that takes a path must carry the
  flag too.

  Handing git one list of those pathspecs is what broke on Windows: `revert`'s preflight (`ls-tree`,
  the link probes, the dirty scan), its scoped unstage and its numstat comparisons; `commit`'s
  `ls-files`/`add`; `discard`'s `ls-files`/`checkout`/`clean`; and `ignoredPaths` → `trackedAtHead`'s
  `ls-tree HEAD` each built one argument vector, and past Windows' ~32 KB `CreateProcessW` limit the
  spawn simply fails. `trackedAtHead` is the reachable one — it runs on **every** commit and asks
  about everything the session has touched, so a session that has edited thousands of files crossed
  the limit routinely, not only on an unusually large operation. All of them now go through
  `chunkPathspecs`, every chunk keeping `--literal-pathspecs` and `-c core.quotePath=false`. Chunking
  is by **accumulated argument length, never by a fixed count**: `sections/a.tex` and a 200-character
  nested figure path cost the command line wildly different amounts, so a count is not a bound on
  argv at all. `MAX_PATHSPEC_ARGV_CHARS` is 8000 — a quarter of the real limit, because the
  accounting cannot see the fixed part of the line, the environment block that shares `ARG_MAX` on
  POSIX, or Windows' own argument quoting, which is applied _after_ this count and can nearly double
  the rendered length — with the derivation in the doc comment and the headroom inequality asserted
  by a test, so the number cannot drift loose from its reasoning.

  Combining the chunks is exact, and the reasoning is written at each site: the chunks partition the
  list, so a listing's union is a concatenation and a chunk printing **nothing** means none of _its
  own_ paths matched, never "nothing matched overall". The link probe and `trackedAtHead` stay
  fail-closed — a throwing chunk propagates rather than reading as "no links here" or shrinking the
  tracked set, which would report a tracked file as ignored and silently drop the session's edit to
  it. Rename and copy record pairs are emitted together by whichever chunk matched either side, so a
  pairing never straddles a boundary. **The partial-failure mode batching introduces is answered per
  tool, never borrowed**: `revert`'s unstage loop sits inside the wrapper that already reports the
  revert landed and warns against retrying; a failed `git add` chunk in `commit` is staging only —
  nothing was committed, no file on disk changed, and the only content that can be left staged is
  what the call itself named, since every other scope resets the index to HEAD before staging — so
  `commit` says exactly that and says a retry is safe; `discard`'s `checkout`/`clean` destroy
  working-tree content, so a failed chunk means an earlier chunk's files are already gone, and its
  message takes the `landedOrExplain` shape without the revert's ban on retrying, because retrying is
  how a discard is finished, it just destroys the rest. The regression tests put a recording `git`
  shim on `PATH` and assert the argv each invocation actually receives, since on Linux a 40 KB argv
  is perfectly legal and a behavioural test alone passes against the unbatched code on the platform
  this gate runs on; each behavioural body also runs at one-chunk and several-chunk sizes against
  ground truth from a single unscoped git call.

- **A session commit no longer takes files git ignores** (#66 item 1, #67 review). `scope: "session"`
  stages from the session's shadow with `update-index`, which never consults `.gitignore` or
  `.git/info/exclude` — so a file this server wrote that git would never stage (the `summarize-paper`
  note relies on the exclude to stay local) was committed and pushed by the default scope while
  `scope: "all"` left it alone. `commit` now runs one `git check-ignore` over the paths in scope — the
  session's files, or the named `paths` under `"paths"`/`"all"`, where `git add` would have failed with
  a raw "use -f" — skips the matches, reports them under a new `ignored` field and settles them out of
  the session's record; a tracked file that matches a pattern is not ignored (as under `git add`) and
  still commits. "Tracked" is judged where the staging step will look: against HEAD for the session
  scope and `scope: "paths"`, which reset the index to HEAD first — so a hand `git rm --cached` no
  longer gets the file reported ignored (and the session's edit dropped) while the reset puts it
  straight back — and against the live index for `scope: "all"` with `paths`, whose `git add` runs over
  the index as it stands. On a `core.ignorecase` repository (git's default on macOS and Windows clones)
  the HEAD lookup folds case under either basis, so a file tracked as `Notes.txt` and edited as
  `notes.txt` is tracked, not ignored; the same ASCII fold (git's own; exact spelling wins where a tree
  holds both) governs the shadow base, read from HEAD's spelling — such an edit no longer seeds an
  empty base and swallows a peer's uncommitted lines whole — and the staging itself, since
  `update-index --cacheinfo` does none of the case-alias lookup `git add` does, so the edit no longer
  lands as a second, case-differing tree entry with the deletion removing nothing. The check runs over
  **every** session entry whatever its flags: a record that is both ignored and
  `conflicted`/`unrecorded` (this session wrote an excluded note, a peer wrote the same lines) is
  settled and dropped from `conflicted`/`unrecorded` before the refusal is worded, instead of being
  called conflicted and pointed at `scope: "all"`, which cannot commit an ignored file either. A
  request naming a _directory_ lists, under `ignored`, the session's ignored entries beneath it that
  `git add` skipped and the take settled; a request whose every path is ignored is refused by name, not
  with "no changes"; and when some requested paths are ignored and the rest already match HEAD, the
  headline says which were skipped as ignored and which already matched HEAD, instead of claiming the
  tree matched HEAD for a dirty ignored file. The `discard` hint says what `discard` does: it reverts
  those paths for every session, not only this one.

  **A shadow key beyond a symlink fails in server words, not git's** (#70, accepted trade-off).
  `check-ignore` dies on a path that runs through a symbolic link — a record a pre-fix `delete_file`
  filed under a linked directory's own name rather than the real directory's (below): exit 128,
  `fatal: pathspec '<path>' is beyond a symbolic link`, verbatim out of every `commit`, naming no route
  out of a state that failed the whole call, the files that were fine included. That one failure is
  recognised and re-thrown as `PathBeyondSymlinkError`, which names the offending path and the way out
  (`discard` with `paths` naming just it — verified: `discard`'s own `ls-files`/`clean -f` accept such a
  pathspec as a no-op, so the route really is open). It stays a **throw, never an empty set**: answering
  "nothing is ignored" would let the commit stage a file git means to exclude, and git dies at the
  _first_ offending path, so the partial stdout it had already written is a plausible-looking wrong
  answer, not a usable one. The branch is narrow on purpose — exit 128 _and_ git's exact wording, with
  the path named by reconstructing git's own quoted form per requested path rather than captured out of
  the message, which a path containing a quote or a newline defeats — so a corrupt repository, a missing
  git or a translated git still report exactly what happened, and what `ignoredPaths` returns on
  success, its `tracked: 'head' | 'index'` split and its case folding are untouched, with a differential
  test pinning the success answers. Such a key is refused even on a `conflicted` entry, `discard` clears
  it, and no such key is written any more.

- **A wedged `unrecorded`/`conflicted` entry whose file already matches HEAD can be settled without an
  empty commit** (#66 item 2, #67 review). After a `push` with `message` had committed the working tree,
  or a hand revert, the remedy every message named — `scope: "all"` — refused with "Nothing to commit",
  `scope: "paths"` refused the path as unchanged, and only `discard` or `allowEmpty` (a junk empty
  commit, later pushed) worked. A `scope: "all"`/`"paths"` request that covers a tracked entry and finds
  nothing to stage now settles those entries and returns `committed: false` with them under the new
  `settled` field (also populated after a landed commit); a request covering nothing the session tracks
  still refuses as before, and the refusal texts name the exact `discard` call and this route. A path
  that covers nothing dirty stages nothing by definition, so it is kept out of the `git add` pathspec
  and settled by the handler instead — otherwise the rescue fed `git add` a path with nothing left on
  disk (`write_file` then `delete_file`, or a hand `rm`) and git's raw "did not match any files"
  surfaced. More broadly, `commit` with `paths` refuses in server words any path that is neither on disk
  nor tracked before `git add` sees it, and `scope: "all"` with `paths` hands git a POSIX, `./`-stripped
  form as `scope: "paths"` does (a Windows `sub\notes.tex` used to reach `--literal-pathspecs add`
  verbatim).

- **A shadow record that fails no longer leaves a live session's edit owned by nobody.** A commit is
  meant to contain one session's lines and nobody else's, and that rests on every write being recorded
  as someone's: the write was (and is) never failed for a recorder failure, but the file then had no
  index entry, so a peer's `commit scope: "paths"` could take the session's in-flight lines and the
  session's own commit silently omitted them. The path is now marked `conflicted` + `unrecorded` in the
  session's index (and `commit` returns the `unrecorded` subset of `conflicted` in its structured
  output): peers refuse it as owned, the session's `commit` excludes it and says why, and it stays that
  way until taken with `scope: "all"` or discarded — `refresh` never advances an unrecorded entry, so a
  later commit by a peer cannot quietly make it committable again with a shadow that is missing the
  session's write. Taking it actually settles it: a `scope: "all"`/`"paths"` commit drops this session's
  entries under the paths it was given (`ShadowStore.settle`), so a conflicted or unrecorded entry no
  longer lingers and keeps the default scope refusing after the tree was taken deliberately. A heartbeat
  (`touch`) failure alone marks nothing — only a failed shadow record does. What remains is an index
  that cannot be written at all (documented in CONCURRENCY.md).

- **A write through an in-project symlink is attributed to the link's target, and a delete under a
  linked directory to the file it really removed** (#66 item 4, #67 review). A confirmed
  `write_file`/`edit_file`/`add_asset` through a tracked `link.tex -> main.tex` changed `main.tex` on
  disk but recorded the change under `link.tex`, whose HEAD content is the target string: the session's
  commit then refused with a bogus "same lines of link.tex" collision while the real edit to `main.tex`
  was owned by nobody, and through a dangling tracked link the commit landed a mode-120000 entry whose
  blob was the new text — a symlink pointing at the paragraph. The mutation recorder is now told where
  the bytes landed (the target's project-relative name, when the link stays inside the project), and the
  confirmation diff `write_file`/`edit_file` return shows the target's change rather than an unchanged
  link — as does `add_citation`'s, through the same `changedPath` rule, so a `.bib` that is itself a
  link no longer shows an empty diff. A deletion is attributed to the parent resolved through links plus
  the literal final component (`attributedDeletePath`): a link named `link.tex` still records as
  `link.tex`, since `rm` removes the link, but `delete_file linkdir/notes.tex` through a tracked
  `linkdir -> realdir` removes the real `realdir/notes.tex` and now records it there — filed under the
  link's path it was a key git rejects ("beyond a symbolic link"), and every later session commit failed
  with that raw fatal, unrelated files included. A resolution failure never fails the write or the
  delete — one stderr line, and the given name is used — and the revision-tracker baseline key is
  unchanged either way. `commitContents` additionally refuses to stage content over a mode-120000 index
  entry **unless `lstat` shows a regular file or ENOENT** — still a link, or unstattable, is refused,
  fail closed — so no stale record can produce a link-with-text blob again, while `delete_file link.tex`
  followed by `write_file link.tex`, the typechange `git add` records without comment, stages as
  `100644` instead of being refused by a remedy naming the two calls the caller had just made (the index
  is reset to HEAD before staging, so its mode says what HEAD has, not what the session did).

- **A push `resolution` can no longer write through a symlink, and a non-ASCII conflicted path can be
  resolved** (#66 items 3 and 10, #67 review). `resolvePush` applied each resolution with a raw
  `writeFile` by the path git reported: when a collaborator's commit turned `notes.tex` into a link
  pointing outside the clone, the resolution's content landed in the outside file, `git add` staged the
  link unchanged, and the tool reported nothing-to-push; a link to `refs.bib` reached the bibliography
  past the literal-name `confirmBibEdit` gate. A path that is a symlink on **either** side of the
  conflict — the paused rebase's working tree, or the ours/theirs index stage at mode 120000 — is now
  refused by name, the rebase aborted and the clone left where it was before the rebase started. The
  check has to live in `GitService` inside the paused rebase, because the link that matters is
  upstream's and is materialised only there: a pre-check against our HEAD cannot see it. A link only in
  the _base_ stage — one both sides already replaced with a regular file — is an ordinary content
  conflict and is not refused, since nothing a resolution could land on is a link any more. A path
  beneath a symlinked directory (`sub/x.tex` under a link `sub`) is refused the same way: git never
  checks a conflicted file out beneath a link itself, but one placed by hand while the rebase is paused
  would otherwise redirect the write — a layout git cannot produce, so the refusal is reached by a
  mocked `lstat` rather than left untested. The refusal's text names the shell-free way out,
  `reset_to_remote (confirm: true)`, as the conflict report's guidance already did. Every exception
  raised inside the paused rebase now aborts it, not only the deliberate refusals: a failed
  `ls-files`/`add` spawn or `writeFile` used to propagate with the clone left mid-rebase (conflict
  markers on disk, detached HEAD), and the priming `pull --rebase` that opens a resolution ran outside
  the loop's try/catch, so a spawn failure while listing the unmerged paths left the clone mid-rebase
  too. Separately, the unmerged-path listing lacked `core.quotePath=false`, so a conflict on `é.tex`
  came back as `"\303\251.tex"`, with an empty per-file report and a resolution for `é.tex` rejected as
  "not supplied"; it now matches every other path-returning call. (The issue's item 10 — a literal
  newline in a path mis-splitting `--numstat` — turned out not to be a defect: git C-quotes control
  characters whatever `core.quotePath` says, so the row count stays right; the quoting bug that _was_
  real is this one.)

- **A path-limited `discard` settles only the paths it was given, and removes an untracked one instead
  of failing** (#67 review). It cleared every session's whole record for the project, so a peer's record
  for a file the discard never touched was dropped — and an unowned path is exactly what lets a later
  `commit scope: "paths"` take that peer's lines. It now settles the named paths in every session's
  records (`ShadowStore.settleAll`); `clearAll` stays for the whole-tree discard, where there is nothing
  left for anyone to own. It also checks out only the tracked subset (resolved to the index's spelling
  on an ignorecase clone) and runs `clean -f` over every requested path, so naming an untracked file
  removes it instead of failing on `checkout` — before, a path-limited discard naming only an untracked
  path failed outright — and a path matching nothing is a no-op.

- **`refresh` no longer re-merges and re-hashes a permanently conflicted entry on every call** (#66
  item 6). A conflicted entry's shadow and base are frozen by design — its base is stale, so a later
  edit must never clear the flag — yet after a collision every `status`/`commit`/`push`/`project_sync`
  re-read HEAD, re-ran the three-way merge and spawned `git hash-object` twice per entry: three
  conflicted 2 MiB assets meant six spawns and ~12 MiB of pipe per `status`, forever. The entry now
  remembers the HEAD commit it was judged against (`conflictHead`) and is skipped while HEAD is still
  that commit; a HEAD move re-evaluates it in full, the flag is never cleared by the memo, and entries
  written before the field existed are evaluated once and then memoised.

- **An imported `.svg`/`.eps` (or a CRLF `.tex`) no longer stays `conflicted` forever on a clone with
  `* text=auto`** (#63). A session commit stages through `git hash-object --path`, which applies the
  path's gitattributes clean filter, so HEAD held the LF-normalised blob while the session's shadow held
  the CRLF bytes it wrote; the next refresh saw HEAD and shadow differ, a binary shadow has no merge,
  and the path was flagged `conflicted` — sticky by design — for a file nobody else touched, and every
  later `add_asset` or `commit` on it was refused. Equality between HEAD, a shadow and the working tree
  is now judged through that same clean filter (`GitService.cleanBlobId`, the blob id the bytes _would_
  get), so "our change is what landed" is recognised across a normalisation, the second import to the
  same path is accepted, and a CRLF `.tex` commits without a phantom every-line conflict. A genuine
  collision still conflicts, a binary shadow is still never three-way merged — there is no such thing as
  a merged PNG — and the flag still sticks.

- **`status` (and every tool that starts from it) works on a clone of an empty remote.** The branch name
  came from `rev-parse --abbrev-ref HEAD`, which cannot name an unborn branch, so a repository created
  without a first commit failed every `status`/`commit` with git's raw "ambiguous argument 'HEAD'"; it
  now asks `symbolic-ref` first, falling back to `rev-parse` on a detached HEAD. A `commit` that settles
  a session record on such a clone says "no commits yet" rather than printing the `sha: "unborn"`
  sentinel as if it were a commit id, and `sha`'s description names that sentinel.

- **Every absolute path a tool returns is POSIX, on every OS — which is what the docs have always
  said** (#80 §4, #98, #99, #138). `docs/tools.md` opens with "File paths are always POSIX
  (`/`-separated), on every OS" and CLAUDE.md repeats it, and on Windows a single result object
  used to contradict itself: a `toPosix`'d `note` sitting beside a backslashed `pdfPath`, with the
  result **text** and `structuredContent` disagreeing about the spelling of the same file. The
  sharpest case contradicted itself inside one expression — `registerProject.ts` read
  `path: local ? toPosix(dir) : dir`, so the same field of the same tool came back POSIX for a
  local project and native for a git one: a ternary nobody decided, not a rule. Every emitter is
  now converted: `compile`'s `logPath`, `pdfPath`, `render_pages`' `outDir` and per-page
  `pngPath`, `pdf_geometry`, `extract_text`, `register_project`, `project_sync`, `list_projects`,
  `doctor`'s three path-bearing details, `add_asset`'s `source` and `read_file`'s
  binary/large-file `note`.

  **One boundary helper, not a `toPosix` sprinkled at each emission site.** `toPosixOut`
  (`src/lib/paths.ts`) is applied once where each result is assembled and feeds the payload
  **and** the text, so a result cannot spell one path two ways: `render_pages`' page lines map
  over the converted `pagesOut` rather than the native `rendered`, `compile`'s
  `… N more error(s) — see structuredContent or <logPath>` names the spelling `structuredContent`
  does, and `add_asset`'s headline and `source` come from a single converted value.

  **Placement is the load-bearing part, and the trap is next door.** The conversion sits _below_
  everything that touches the filesystem, and the value that keeps the host's own spelling is
  never the one re-spelled: `ctx.pdfRenderer.pageCount()` and `toFileUrl()` in `compile`,
  `render()` in `render_pages`, `geometry()` in `pdf_geometry`, `ctx.git.clone` and
  `ctx.files.resetBaselines` in `register_project`, the persisted `ProjectConfig.path` read back
  into `fs` calls in every later session, `DoctorService`'s `canWrite` probes, and — in
  `FileService` — the `resolveInside` string itself, which is a path's one identity for `readFile`
  and for the revision tracker's baseline key. Re-spelling that last one would file a baseline
  under a key no write ever looks up, which is how the symlink guard once went quiet on macOS
  (`/var` → `/private/var`) and on Windows 8.3 short paths. `add_asset` converts `origin` only
  after every syscall it was for — `realpath`, `stat`, the allowlist check on the resolved target,
  the read — has already happened. `toFileUrl` is the exception worth stating precisely, because
  the obvious rationale for it is wrong: `pathToFileURL` resolves through `path.win32.resolve` and
  accepts either spelling, so `C:\a\b` and `C:/a/b` produce the identical valid URL (measured, UNC
  included) and the viewer link would not have broken. It is kept above the line because it takes
  a filesystem path rather than a string chosen for a reader, and a test pins that it still gets
  one. Refusal text follows the same convention — every path the **server** resolved is POSIX in
  the message, with one deliberate exception in `assetImport.ts`: the not-absolute refusal quotes
  the caller's own `sourcePath` and its tilde expansion, and re-spelling half of a quotation would
  read as though the server had rewritten the input.

  **Not everything that looks path-ish is one.** `doctor`'s `compiler`, `git` and `distribution`
  details hold `--version` banner output and `package-manager`'s `repository` is a URL; converting
  either would have been a regression. `errors[].file` needs nothing — `logParser` already rebases
  it with `path.posix.join` — and `logTail` is the log verbatim, whatever TeX wrote into it.
  `ProjectManager.listProjects()` is untouched, since `ProjectStatus.path` is native by contract
  and the conversion belongs in its one production consumer.

  **The tests cannot be allowed to pass vacuously, and by default they would.** On Linux and macOS
  `path.sep` is already `/`, so the conversion is the identity and an assertion not driven through
  a stub passes against unfixed code. `toPosixOut` takes the separator as an injectable seam, and
  the integration suite builds its project under a directory whose **name** contains a literal
  backslash — legal on POSIX — with `path.sep` stubbed for the duration of the tool call, so the
  server's own conversion genuinely runs and every assertion fails against the unfixed code on any
  host. The tests also assert the **consumers** still receive the host's own spelling —
  `canWrite`'s recorded arguments, the persisted registry JSON read back off disk, `compile`'s
  `pageCount`, and that `render_pages`' PNGs really are where the result says they are — so
  converting one line too early fails loudly rather than silently returning `undefined` or writing
  into a second directory. (`path.sep` is a writable, configurable data property and
  `path.join`/`resolve`/`relative`/`basename` do not read it; `internal/fs/rimraf` _does_ capture
  it at module load, so the suite warms that module with the real separator before stubbing
  anything — otherwise a lazily-loaded rimraf holding a backslash breaks recursive `fs.rm` for
  every test sharing the worker.) A path-spelling change is invisible to a green Linux gate and
  bites only on the Windows leg, which is the whole reason for the seam.

- **`discard`: both halves of a call fold case, and a path git reached nothing for is not
  reported as discarded** (#127, #70). The two halves of one `discard` disagreed. Tracked paths
  were resolved onto the index's own spelling, but the `clean -f` loop ran over the caller's raw
  spelling, because an untracked file has no index entry to resolve against — so on a
  `core.ignorecase` clone `discard(['scratch.txt'])` restored a modified `Notes.txt` while
  leaving an untracked `Scratch.txt` sitting on disk. One call folded or did not fold depending
  on something the caller cannot see. Untracked paths are now resolved against the working
  tree's own untracked listing (`ls-files --others --exclude-standard`) through the same
  exact-spelling-first `canonicalNames` machinery, on an ignorecase clone only —
  `core.ignorecase` in the clone's config stays the source of truth, never the filesystem, and a
  case-sensitive clone is byte-exact unchanged.

  **It has to be resolved server-side, and that is measured rather than assumed.** Pathspec
  folding is a separate opt-in knob (`:(icase)`, `--icase-pathspecs`, `GIT_ICASE_PATHSPECS`)
  that `--literal-pathspecs` is mutually exclusive with, and `clean` enumerates untracked
  entries from the directory and compares byte-exactly, so `core.ignorecase` does not decide it.
  Measured on ext4 with `core.ignorecase` forced true, and again on a genuinely
  case-insensitive, case-preserving filesystem (NTFS via WSL2 DrvFs, where git auto-detects the
  setting): the file survived both times, and only the disk's own spelling removed it. So the
  fold cannot be bought with a pathspec flag — every path-taking call keeps
  `--literal-pathspecs`, because reintroducing globbing in the most destructive call in the
  server is not a trade worth making.

  **And the reporting half, which held whichever way the fold went.** `git clean -f` matching
  nothing exits 0, so `discarded: true` came back for a file that is still there. `discard` now
  returns **`missed`** — the requested paths git matched nothing for, in the caller's own
  spelling, named in the text channel too — and `discarded: false` when the call reached nothing
  at all. `discarded` answers "did this reach the paths it was given", not "were bytes
  destroyed": a partial miss stays `discarded: true` with the rest under `missed`, because a
  bare boolean cannot say "one of the two" and a bare list would leave `discarded: true` on a
  call that did nothing. A tracked path already at HEAD is reached, and still reports discarded.

  A `missed` path is still settled in every session's records, deliberately — a path git can
  match nothing for is exactly the wedged shadow entry that the ignore filter's refusal sends
  the caller to `discard` to clear, so narrowing the settle to reached paths would close that
  escape hatch. That makes `discarded: false` with records settled a visible asymmetry rather
  than an invisible one.

  `test/integration/discardCaseFold.test.ts` pins every case, in both regimes: the fold on an
  ignorecase clone, the byte-exact twin under `core.ignorecase=false` whatever the filesystem
  underneath thinks, and `missed`/`discarded` throughout — with `missed` asserted off a
  `listTools()` round trip rather than off `structuredContent`, since an undeclared key is one
  the SDK client rejects the whole result over (#130). **Nothing in the file skips**: the one
  case a case-insensitive filesystem cannot express — two files differing only in case —
  branches on what the disk actually did, never on `process.platform`, because a skipped test
  prints no note under this reporter and would collapse to "1 skipped" on exactly the two CI
  legs the behaviour was in doubt on.

- **`list_references` declares `entries[].fields`, and budgets it** (#137, surfaced by the #130
  audit in #135). Each entry's raw BibTeX field map — lowercased names, `@string` macros
  expanded — was sent to clients and declared nowhere, and that was never merely a documentation
  gap: **the tool has been uncallable from an SDK client since v0.6.0.** The server does transmit
  the undeclared key — `McpServer` validates the result against the advertised schema, reads only
  whether the parse succeeded, throws the parsed data away, and a zod object _strips_ rather than
  _stricts_ — but zod's JSON Schema conversion marks every object node `additionalProperties:
false`, and the SDK's own `Client` compiles an ajv validator per advertised schema during
  `listTools()` and checks every later result against it. So the call did not return a slightly
  too wide payload; it returned nothing, raising `-32602 … data/entries/0 must NOT have
additional properties`. The suite missed it because a test client that never lists tools caches
  no validator.

  Declared rather than dropped, because removing a field callers may already read is the breaking
  direction — and declaring it turns an accident into a promise, which is why it arrives with a
  budget. `fields` is an open-ended `Record<string, string>` in which **both the keys and the
  values are document-controlled**, so an undeclared accident was also an unbounded one: 200
  entries x arbitrary fields is the shape of the ~67k-character conflict payload a client rejected
  in #68. `src/lib/referenceFieldsBudget.ts` cuts a tail, counts it and never reorders: at most 20
  fields per entry, one 20000-char budget (the house figure, charged on **rendered** JSON size
  since LaTeX is backslash-dense and escaping roughly doubles it) across every map in a result,
  and a field whose name or value is over-long is **dropped whole, never truncated** — `bibtex` is
  the one format whose fields are exact, and a shortened value in an exact field is a wrong answer
  rather than a short one. Everything cut is counted in the entry's `fieldsOmitted` and named in
  the result's `fieldsNote` (and in the result text, which never prints the map itself), and is
  still present verbatim in that entry's `raw`. An entry whose map was cut entirely sends no
  `fields` key at all plus a `fieldsOmitted` count — "this entry has fields and none fit", which
  an empty map would misreport as "this entry has no fields".

- **`list_references` budgets `entries[].raw` as well, the larger of its two document-controlled
  payloads** (#147, found by the lane that fixed #137 and deliberately left out of it). #137
  bounded the field map and left the entry text beside it open: only `maxResults` bounded the
  entry _count_, nothing bounded any single `raw` or their sum, so the tool budgeted the smaller
  payload and pointed callers at the unbounded one as the remedy for every cut. A `.bib` is
  document-controlled text — one entry carrying a pasted abstract, a base64 `file` field or a long
  `annote` is ordinary rather than hostile, and 200 of them is the default page — and thirty
  ordinary Zotero-sized entries already put ~55k characters of `raw` on the wire, the shape of the
  ~67k conflict payload a client rejected undelivered in #68.

  `src/lib/referenceRawBudget.ts` bounds it the way the siblings do, with one difference that is
  the whole design: **a cut `raw` is marked and counted, never dropped whole and never silently
  sliced.** Dropping an over-long _field_ whole was right because `raw` still had it; `raw` is the
  only copy of itself, so the same move one level up would delete the evidence rather than
  shorten it. A cut entry therefore keeps a verbatim **prefix** (a BibTeX entry's head is its
  type, key and first fields — what identifies it), ends in a `… [+N characters omitted]` marker
  so the text itself admits it is a prefix, and carries `rawOmitted`. The schema no longer calls
  `raw` authoritative unconditionally: it says so except where `rawOmitted` fires. At most 2000
  characters of any one entry are returned (the `fields` value gate, reused, so one pathological
  entry cannot blind the twenty behind it), and one 20000-char budget — `REFERENCE_FIELDS_BUDGET`
  itself, imported rather than restated, because two numbers for one class of defect only invite
  the question of which is right — covers every `raw` in a result, charged on **rendered** JSON
  size and cut as a sticky tail so the kept part is a describable prefix. `raw` gets its own
  allocation of that figure rather than sharing the `fields` pool: they answer different questions
  (verbatim authority vs. parsed convenience) and a single pool would make whichever was planned
  second go dark on every real bibliography, where halving both leaves each useful. A marker-only
  entry is still charged although the budget is gone — a `raw` of `''` would claim the entry as
  written is empty — which is the one bounded overspend, and it is written down rather than
  discovered. Everything cut is named in the result's `rawNote` and in the result text, so a
  caller reading only prose is told too, and the text channel renders from the budgeted payload,
  never the parser's.

- **`list_skills` reports an unregistered project instead of asserting it, and the lock-taking
  read-only tools are named consistently** (#105, #112). Two loose ends from the same wave.
  `list_skills` renders the same instruction text as the skill prompts but was still calling
  `buildSkillMessage` without a verdict, so a `project` naming nothing came back as
  ``Apply it to the project `ghost` ``. The positional mis-binding behind finding 6 cannot happen
  on this route — a tool receives named arguments, not a positionally-bound first word — but the
  claim is just as false, so it now takes the same `isRegisteredProject` lookup the prompts do.
  And with `extract_text` joining them, `render_pages` and `pdf_geometry` are no longer "the two
  deliberate exceptions" that take the per-project lock while reading the temp build dir:
  CLAUDE.md and the comment in `search_files` said two, and `doctor`'s missing-canvas hint named
  only `render_pages` — it now names every tool the missing backend disables, and says that
  `pdf_geometry`'s `floats` index still works because it reads the `.aux` rather than the PDF. A
  test asserts the hint names each of them, so the next tool to join the set cannot go unlisted the
  way these two did. The same hint also said pdf.js "cannot even open a PDF" without the backend;
  measured, it cannot be **imported** — `pdf.mjs` evaluates `new DOMMatrix()` at module scope and
  reaches for `@napi-rs/canvas` to install that global, so the failure is one step earlier than
  described. (Changed before release: the server now supplies that global itself when the backend
  is absent, so only `render_pages` needs it.)

- **A skill prompt no longer reads free text as a project id** (#105, finding 6). Every bundled
  skill was registered as a prompt with the same one-argument schema (`project`), so a client that
  binds a prompt's free-text invocation positionally put the first whitespace-delimited word there:
  `/session-feedback please describe why you used so many bash calls` rendered
  ``Apply it to the project `please` ``, for a skill whose own body says no project id is needed.
  Harmless only because no project is named `please` — the first word matching a **real** registered
  project would have reviewed the wrong project with no error anywhere.

  **A skill now declares whether it takes a project at all.** `SKILL.md` frontmatter carries
  `project: none | optional | required`, and the prompt's argument list is built per skill, so a
  procedure that acts on no project advertises no argument and there is nothing to mis-bind.
  `session-feedback` is `none`; the other seven bundled skills are `optional` — each acts on a
  project but can ask which. The key is a narrowing declaration: a `SKILL.md` without it, including
  one from a user's own `WEB_LATEX_MCP_SKILLS_DIR`, keeps exactly today's behaviour (`optional`),
  and an unrecognised value logs to stderr and falls back to that same default rather than dropping
  a skill that works.

  **And a project id that does not resolve is reported, never asserted.** For the skills that do
  take one, the server hands `registerSkillPrompts` a narrow `isRegisteredProject` lookup; an
  unregistered id renders a prompt that says so and asks which project to use, instead of a
  confident instruction to act on a project that does not exist. A lookup that _fails_ is worded
  apart from one that answers no — "could not be checked" rather than "no such project" — and never
  throws out of prompt rendering.

- **`FileService.readBytes` gets its own binary cap, instead of borrowing the text one** (#66, item
  7). The binary reader refused anything over `MAX_READ_BYTES` (2 MiB) — the cap that exists for
  **text**, where it governs `read` and the snippet readers over it — while `add_asset` imports
  figures up to `MAX_ASSET_BYTES` (25 MiB). Reading back a 3 MiB PNG **this server itself wrote**
  was therefore a hard throw. That stopped being hypothetical when `revert` landed (#85): it reads
  every touched path back in order to attribute the reverted lines to this session, and its own
  comment said the 2 MiB throw was what "a revert that restores a figure hits routinely". The throw
  is caught there, so the cost was silent rather than loud — the path was flagged `conflicted` +
  `unrecorded`, a state only a deliberate take or a discard ends.

  `MAX_BINARY_READ_BYTES` (`src/lib/assets.ts`, beside `MAX_ASSET_BYTES` and derived from it) is
  now that cap, so "anything `add_asset` was allowed to import can be read back again" holds by
  construction rather than by two numbers being kept in step by hand. It is a **constant, not a
  `maxBytes` option** on `readBytes`, deliberately: a per-call option would make every future caller
  choose a security-shaped number, where one constant sitting next to the cap it has to stay at or
  above does not.

  Two properties are deliberate, and both are pinned by tests rather than left to a comment. The
  check stays a **pre-read `stat`**, never a post-read `buf.length`: the point of a size cap on a
  binary reader is that the oversized file is never pulled into memory at all, so the refusal has to
  happen before `readFile` — a posix-only case proves the ordering by chmod-ing an over-cap file to
  `0o000` and asserting the refusal is still the cap's and not `EACCES`. And the message **names
  which cap fired**, quoting the binary cap as the limit that was hit and the smaller text cap only
  as the separate limit it is not, so a caller can tell a binary-cap refusal from a text-cap one.
  Both sides of the new boundary are covered — exactly `MAX_BINARY_READ_BYTES` reads back, one byte
  over refuses — using sparse files, so the unit cases pay no multi-MiB write for either.

  `revert`'s own integration case moved with the cap, and had to: it provoked the fail-closed branch
  with a 3 MiB file, which is precisely what this change makes legal, so it would have gone on
  passing while testing nothing. Its provocation is now one byte over the binary cap, and a second
  case pins the other side — a 3 MiB revert is attributed normally, with neither flag set. The cap
  is the only route to that branch: the cheaper-looking one, a tracked link out of the project, is
  refused by `revertPreflight` before the attribution loop runs, which was probed rather than
  assumed. The fixture is shaped to touch the oversized blob once (committed in the clone and
  deleted by the reverted commit, not seeded into the remote), which keeps the case at ~1.8s against
  the ~1.5s it cost before — `vitest.config.ts` is explicit that its per-platform timeout buys tail
  headroom and is "not a licence to make a fixture expensive".

  One consequence worth naming rather than discovering later: the old throw was incidentally capping
  what a binary shadow entry could hold. Reverting a 25 MiB asset now writes both sides of it into
  `<workspace>/.sessions/<id>/` and holds them in memory while recording. That is the right trade —
  a path stuck `conflicted` + `unrecorded` forever is far worse than the disk — and it weakens no
  guard, since binary entries are still never three-way merged and the `before` side came from the
  already-uncapped `readAtRefBytes`.

- **`.gitignore` now excludes a `node_modules` symlink, not only a `node_modules` directory.** The
  pattern was `node_modules/`, and a trailing slash matches directories only. Sharing one install
  across git worktrees by symlinking `node_modules` into each is the obvious way to avoid an
  `npm ci` per worktree, and git saw that link as an ordinary untracked file: a `git add -A` in such
  a worktree committed it as a mode-120000 blob whose content is an absolute path on one machine.
  This was found by it happening during this change.

- **Clicking the PDF dismisses the viewer's comment panel** (#71). The panel _overlays_ the page
  (`position: absolute` over `#viewerContainer`) rather than sitting beside it, so clicking through to
  the document reads as the way out of it — but the only thing that closed it was the 💬 toolbar
  toggle, and clicking the PDF did nothing at all. That is a papercut in a full browser window and a
  real one in an embedded pane: in VS Code's Simple Browser the viewer is narrow, the panel covers most
  of it, and the toggle is a reach back up to a 22px toolbar. A `pointerdown` listener on `document`
  now closes the panel unless the click landed in chrome the user clicks _while working with_ it —
  `#bar`, `#panel`, `#fab`, `#pop`, the `PANEL_KEEP` list. The toolbar has to be on that list and is
  not merely conservative: without it the toggle would open the panel and the same gesture would
  immediately close it, so `ctoggle` would appear dead. **`pointerdown`, not `click`**, so a drag that
  selects PDF text dismisses on press rather than on release; that ordering is safe only because the
  panel overlays the viewer instead of being laid out beside it — closing it mid-drag reflows nothing
  under the cursor, and the selection (and the `selectionchange` handler that positions the 💬 Comment
  button) survives. The highlight layer is already `pointer-events: none`, so a click on a commented
  region falls through to the page div and dismisses like any other. Escape closes the panel too,
  unless one of three things claims the key first: the note popup's own Escape already handled it
  (`e.defaultPrevented`, rather than re-reading `pop.style.display` **first** — `popcancel` has
  already set it to `none` by the time the event bubbles, so one keypress would otherwise cancel the
  popup _and_ close the panel), a note is mid-edit inside the panel (`editingId`), or the note popup
  is open, in which case the keypress cancels the popup and returns without touching the panel (the
  branch below). Closing over an open edit does not throw the typed text away, as this entry first
  claimed: `setPanel(false)` only removes a class (`.wlm-panel.open { display: block }`), so the
  edit `<textarea>` and its value survive, and `refreshComments` — the only thing that rebuilds
  `panellist` — early-returns while `editingId` is set, so reopening shows the same half-typed note.
  What closing actually does is move the edit box out from under the user and, the cost that matters,
  strand `editingId` set forever: every later `refreshComments()` then early-returns, so the 3s poll,
  the post-save refresh, delete and undo all stop updating silently — a user adds a comment, sees
  `flash('comment added')`, and neither the `#ccount` badge nor the panel list ever changes again.
  **That same guard now sits on the `pointerdown` path**, which fires far more often than Escape and
  shipped without it: an incidental click into the document no longer dismisses the panel mid-edit. The
  deliberate route out is untouched — pressing the 💬 toggle while editing still closes the panel, as
  it always did — and it still strands `editingId`, so the freeze described above stays reachable on
  purpose. Closing that last route is deliberately left as a separate call: the toggle is an explicit
  request, and honouring it without losing the pending text means deciding what happens to that text
  (cancel it, save it, or keep it for the next open), which is a behaviour change to design rather
  than a guard to add. **Escape now cancels an open note popup before it touches the panel, as long
  as no inline note edit is live**: the popup's Escape is bound to the `popnote` textarea, and the
  quote element (`.wlm-pop .q`) is `overflow: auto`, so clicking the quoted text to scroll it drops
  focus to `<body>` and left the key unhandled — the panel behind closed while the popup the user
  was dismissing stayed on screen, inverting the "Esc to cancel" the placeholder advertises.
  `e.defaultPrevented` still comes first, and `pop.style.display` is still read only after it, so
  the in-textarea case stays absorbed by the guard above rather than by a display check `popcancel`
  has already invalidated. The qualifier is the matching gap to the 💬-toggle one above, and is
  reported here as a known, deliberate limitation rather than fixed: `editingId` short-circuits the
  whole keydown handler on its first guard line, so with an inline edit live _and_ the popup open,
  Escape cancels neither — the popup stays up and the panel stays open. Reordering the popup branch
  ahead of that guard is not obviously right (it would make Escape act on a popup while the user's
  focus is in an edit box elsewhere), so it is left to the same separate call as the toggle case.
  And **only a primary-button press dismisses** (`e.button !== 0`): `pointerdown` fires for every
  button, so right-clicking the PDF to reach the browser context menu, or middle-clicking for
  autoscroll, was closing the panel behind the menu it had just opened. Touch and pen both report
  button 0, so this costs no touch gesture.
  The accepted cost: selecting PDF text while the panel is open now closes it, so adding a comment from
  an open panel ends with the panel shut. That is the gesture's whole point — dismiss on a click into
  the document — and the count in the toolbar still updates, so it is one click to bring it back. The
  test asserts the handler is wired, that its body actually calls `setPanel(false)` and carries both of
  the guards above, and that every id in `PANEL_KEEP` still exists in the served **markup** — the script
  half is sliced off before the search, so no future string literal in the client script can let the
  list corroborate itself. The viewer's client script is a template literal that no linter resolves, so
  **renaming an element** — `#pop` to anything else — while `PANEL_KEEP` keeps the now-stale selector
  would silently turn "click the note popup" into "close the panel under me", which the existing
  parse-only check cannot catch. The list is also pinned **exactly** rather than checked with
  `arrayContaining`, so **removing** an entry from `PANEL_KEEP` fails too: the looser assertion let
  `#pop` be deleted from the list outright and still passed, which is the other half of the same
  regression. The Escape handler, which had no coverage at all, is pinned the same way — both its
  guards, and the popup-cancel branch sitting ahead of the panel branch. Every guard is matched on
  its own line and ahead of the statement it guards, over a comment-stripped handler body, so none
  of a rationale comment naming a guard that was deleted, a trailing `// if (editingId) return;`
  decoy the line-leading strip cannot reach, or a guard moved below `setPanel(false)` reads as
  present. (The strip stays line-leading on purpose: widening it to `//[^\n]*$` would eat
  `'http://'`-shaped string literals, and pinning the guard's own line is both cheaper and more
  precise.) And the Escape slice now checks its anchor rather than trusting it: `lastIndexOf` over
  the listener registration never returns -1, so spelling this one `document.` instead of `window.`
  — behaviour-identical, and the natural consistency edit beside the `document.`-bound pointerdown
  handler — silently re-anchored the slice on the zoom shortcuts several kB earlier, where an
  unrelated `getElementById('popcancel')` and `setPanel(false)` satisfied both popup assertions;
  with that rename in place the popup-cancel branch could be deleted outright and the test stayed
  green. The slice now asserts that nothing else registers a listener between its anchor and the
  Escape guard, and that each call it probes appears exactly once inside it.

- **A peer's `register_project { default: true }` now reaches every env-unset session the same way.**
  It retargeted a session that had no default at startup at once, but never one that had started with
  a persisted default, because the in-process value shadowed the registry's. The registry's current
  default is now the live answer for every session that did not assert one through
  `WEB_LATEX_MCP_DEFAULT_PROJECT`; the env assertion still wins outright.

- **The `.bib` guard and the `add_asset` destination gate look through symlinks.** An in-project link
  `figures/x.png -> refs.bib` stays inside the sandbox, so it passed the escape check, and every
  name-based gate judged only `figures/x.png`: `write_file` and `edit_file` changed the bibliography
  with no `confirmBibEdit`, and `add_asset` overwrote it with a PNG. Each now also judges the name the
  path resolves to (`FileService.linkTarget`, inside the project lock) and refuses with a message
  naming the far end. `delete_file` is deliberately not gated on the target: deleting a link removes
  the link, never the bibliography behind it. The escape check itself is unchanged and still runs
  first.

- **`diff` returns literal paths in `files[].path`.** A non-ASCII path came back C-quoted
  (`"r\303\251sum\303\251.tex"`) and a rename as `{a => b}.tex`, neither of which `read_file`
  accepts. Every `--numstat` the server runs (`diff`, `commit`, the branch-review landing) now shares
  one helper with `core.quotePath=false` and `--no-renames`, the same fix `logCommits` received; the
  patch text alongside still renders a rename as a rename.

- **A missing parent directory now names the flag that creates it.** Writing
  `sections/new/intro.tex` without `createDirs: true` failed with a raw
  `ENOENT: no such file or directory, open '/abs/...'` that mentioned neither the missing directory
  nor the flag, which read as "the server cannot create folders". It now names the parent and points
  at `createDirs`. A different `ENOENT` still propagates unchanged. (`createDirs` keeps its `false`
  default on `write_file`; `add_asset`, having no existing callers to surprise, defaults it to true.)

- **A non-UTF-8 `.tex` is no longer reported as edited-outside-the-server forever.** Comparing raw
  bytes (above) fixed binaries but broke the other direction: `read`/`readText` record a baseline from
  the _lossily decoded_ string, so a latin-1 `.tex` — common enough in LaTeX — could never match its
  own baseline again. A path now counts as externally modified only when it fails to match **both** as
  bytes and as the decoded string, which is right for binary and latin-1 alike.

- **Deleting or replacing a figure you just imported no longer claims someone edited it.** The
  byte-vs-string baseline mismatch above also reached the three _refusal_ sites: `write_file`,
  `edit_file` and `delete_file` compared a `Buffer` baseline against a UTF-8 rehash of the server's
  own write, so `add_asset figures/plot.png` followed by `delete_file figures/plot.png` was refused
  with "changed on disk … it was likely edited directly" — advice the caller could not act on, since
  `read_file` will not return a binary. All four refusal sites and `status` now share one comparison,
  so the two halves of the guard cannot disagree again.

- **A text edit to an `.svg`/`.eps` an `add_asset` had touched could silently become an unfixable
  conflict.** A shadow entry is sticky-binary once bytes land in it, and `write_file`/`edit_file` hand
  the shadow store a UTF-8-decoded `before`, which can never equal the true bytes — so the entry was
  flagged conflicted and, correctly, never unflagged, leaving the file uncommittable for the session.
  The comparison now also accepts a string `before` that the shadow decodes to; a genuine
  Buffer-vs-Buffer mismatch still conflicts, because that one is real.

- **Binary files no longer show up as permanently edited-outside-the-server.**
  `FileService.externalModifications` read every file as UTF-8, so a figure's bytes never matched
  their own recorded baseline and `status` reported it under `externalChanges` forever.

- **`list_references` claims the out-of-band-edit baseline only for a bibliography it returned
  whole** (#171, #147, #165, #170). It recorded one for every file it opened, which RESETS the
  guard rather than arming it — so on an ordinary `.bib` cut by a budget or paged by `maxResults`
  (default 50 since #170) the caller's next write clobbered a hand edit it had never been shown,
  with no `ExternalChangeError`. The claim is now made per file, after the plans are known, and
  only when every entry that file contributed shipped with nothing cut out of it.

- **A `push`/`project_sync` peer refusal no longer promises that `status` lists the paths it
  omitted uncapped** (#185). #175 budgeted `otherChanges` and capped `activeSessions`, falsifying
  the one line a stuck caller reads; it now names `truncated`, `pathsOmitted.otherChanges`,
  `activeSessionsOmitted` and each session's `changesOmitted` as the way to tell a complete answer
  from a cut one, and a test ties the claim to `status`'s actual budget and advertised schema.

- **`read_file` with a line range no longer claims the out-of-band-edit baseline over the whole
  file** (#181). A five-line read of a 2000-line document recorded all 2000 lines, so the next
  `write_file` replaced a hand edit outside the range with no `ExternalChangeError`. `FileService.read`
  now refuses the claim for any `startLine`/`endLine` read, so no caller can get it wrong.

- **`list_references` records the bytes it showed the caller, instead of reading every
  fully-shipped bibliography a second time** (#182). `FileService.recordBaseline` is the new seam
  for bytes already in hand; the second read cost a hand edit landing between the two reads, which
  was absorbed as the baseline and so never tripped the guard.

### Tests

- **The integration suite's fixture helper stopped paying for git processes nothing asserts on**
  (CI wall clock). The unit of cost in `test/integration/` is the git subprocess — which is
  precisely what `windows-latest` runs ~10x slower than linux, and why `vitest.config.ts` scopes its
  timeout by platform. The suite issued **11,793 git spawns**, and ~30% of them were fixture
  construction rather than behaviour under test: `git config` alone was 1,827 spawns, 1,442 of them
  `config --local` writing `user.name`/`user.email`/`core.autocrlf` three processes at a time, in a
  repository whose own `src/` never shells out to `git config` to set anything — `GitService`
  already passes `-c core.autocrlf=false`. The helper was the outlier, not the pattern, so it now
  passes the same identity as `-c` switches through simple-git's `config` option.

  The larger half is that the seeds repeat. `createFakeRemote` costs 6 spawns and ~0.4s on linux,
  the suite calls it 350 times, and there are only **109 distinct `(files, branch)` pairs** once
  keyed per test file — so each distinct seed is now built once and handed out as a filesystem copy
  of the finished bare repo, turning ~69% of fixture builds into a recursive copy with no git
  process at all. The cache is scoped to the module registry, which under vitest's default
  isolation means per test **file**: every caller still gets its own independent copy under its own
  temp dir with its own `cleanup`, so nothing is shared between tests but bytes that were about to
  be recomputed identically, and a template is never opened by a git process after it is built, so
  no lock can be held when the copy is taken. Net on the integration suite: **11,793 git spawns ->
  9,138** (-22.5%), and **133.7s -> 104.5s** (-21.8%) measured as wall clock at `--maxWorkers=3`, a
  stand-in for a 4-core runner, over two alternating rounds each. The two figures agreeing is the
  point: the time came off because the spawns did. Expect a larger proportional saving on windows,
  where a spawn is ~10x costlier and the removed work was almost purely spawns. The test count is
  unchanged at 3,246 — this buys time by not repeating work, never by covering less.

- **CI splits into a `static` job and a per-platform sharded `test` matrix** (CI wall clock). Two
  changes, one rename. `lint`, `format:check`, `typecheck` and `build` are eslint/prettier/tsc over
  the same source on every leg — they cannot fail on one OS and pass on another — so they were ~35s
  per leg of pure duplication and now run once, on ubuntu, as `Lint, typecheck, build`. The build
  is not a prerequisite for the tests either: vitest runs from `src/`, and no test imports `dist/`.
  The tests themselves now run under `vitest --shard`, and the shard counts are
  deliberately uneven because two measurements say they should be.

  **Sharding stops paying at three.** `--shard` splits by the sha1 of each file's path and slices by
  file COUNT, not duration, so balance is a lottery over 185 files whose times differ by two orders
  of magnitude. Against the real per-file durations the max-shard time goes 242s at 2 shards (1.01x
  of an even split), 174s at 3 (1.08x), 163s at 4 (1.36x), 142s at 6 (1.77x): past three, an extra
  runner buys almost nothing, because `safePush.test.ts` alone is ~46s and sets a floor on whichever
  shard it lands in. **And the runners are not priced alike** — linux 1x, windows 2x, macos 10x — so
  each platform is sharded only until it stops being the critical path and no further: windows takes
  three (it is ~10x linux on git spawns, which is what these tests mostly do), macos takes two, which
  puts it under windows' shard time, and ubuntu takes none because unsharded it already finishes
  inside it. A third macos shard would raise the bill on the 10x runner to shorten a leg nobody is
  waiting on. Verified to partition rather than sample: the three windows shards run 62 + 62 + 61 of
  185 files and 1044 + 1325 + 877 of 3,246 tests.

  **Every job name here is a required context on `dev`**, matched by exact string, so this rename had
  to land together with a protection update — a job renamed on its own detaches its context, and
  protection then waits forever for a name nothing will ever report. The header comment says so and
  carries the `gh api` invocation. `back-merge.yml` is unaffected for a reason worth stating: it
  needs `main`'s push run to have already put `dev`'s required checks on `main`'s HEAD, and `main`
  receives this workflow in the same release PR that makes the new names current, so the names on
  `main`'s HEAD and the names `dev` requires move together.

- **The advertised `outputSchema` is now tested, whole-payload, for every tool the suite can
  reach** (#128, #130, #135, #137, #145). The MCP SDK does not protect the output contract, in a
  way that is worth stating exactly because both halves matter. On the **server** side,
  `McpServer` validates a result against the tool's schema and then discards the parse result —
  only `parseResult.success` is read, `parseResult.data` never is — and a zod object _strips_
  rather than rejects, so a key present in `structuredContent` and absent from the schema is
  neither removed nor refused, and reaches the wire while `tools/list`, the only place a client
  can learn a field exists, never mentions it. On the **client** side it is worse than
  undocumented: zod's JSON Schema conversion marks **every** object in **all 38** advertised
  schemas `additionalProperties: false`, and the SDK's own `Client` compiles an ajv validator per
  schema during `listTools()` and checks every later result against it. So for any client that
  lists tools at startup — every real one — an undeclared key does not widen the payload, it
  fails the call outright with `-32602` and returns no result. A missing **required** field, by
  contrast, does fail the server-side parse and surfaces as an `McpError`.

  A test asserting only on `structuredContent` therefore pins the handler and says nothing about
  the declared contract — which is how a `floatsRefused` test passed with the field deleted from
  the schema. `test/helpers/outputSchema.ts` is the one place that answers the real question, off
  a live `listTools()` round trip: `advertisedOutputSchema`, a `declaredField` pointer walk
  (`pages[].images[].unreliableCtm`), `expectDeclaredField`/`expectUndeclaredField` with optional
  `required` and `description` clauses, and — for the defect a pointer cannot find —
  `undeclaredKeys`/`expectNoUndeclaredKeys`, which walk the **payload into the schema**. That
  direction is the point: a pointer assertion can only answer a question somebody already thought
  to ask, and the key that breaks a tool is by definition one nobody thought of.

  Three properties of the walk are load-bearing. It judges the **wire form**
  (`JSON.parse(JSON.stringify(...))`), because an explicitly-`undefined` key is a real own
  property that survives `InMemoryTransport` and does not survive JSON — reporting one
  manufactures a finding that cannot exist over stdio, which is exactly `compile`'s
  `warnings[].snippet`. A key declared by **any** branch of a union counts, and where the schema
  says nothing about a value's interior its children are not walked, so the check reports keys the
  schema _contradicts_, never keys it is silent about. And `knownUndeclared` compares the **whole**
  set rather than tolerating a subset, so fixing a pinned hole fails the test and forces the entry
  out — a tolerating allow-list would go stale silently, which is the same defect in the test layer
  that this whole audit found in the SDK.

  `test/integration/outputContract.test.ts` makes it a test CI re-runs rather than a script
  somebody ran once. Re-instrumenting the suite showed **six** of the 38 registered tools had no
  output-contract coverage at all — `credential_portal`, `list_comments`, `resolve_comments`,
  `set_credential`, `viewer` (never called) and `reset_to_remote` (called once, into an error) —
  and all six are now driven end to end through a real client, alongside the local-project
  read/write tools, the PDF readers and the git-backed set, each asserted to emit nothing
  undeclared. Two real holes came out of it, both fixed in this release: `list_references`'
  `entries[].fields` and the `version` the three shelve tools spread out of `ShelfManifest`.
  Coverage is a floor, not a ceiling — the audit sees a tool only if the suite calls it and the
  call returns `structuredContent`, so `auditCall` asserts `isError === false` before it looks at
  the payload, since a call that quietly started erroring is otherwise a test that cannot fail.

  **And now all 38, the four bibliography tools included.** `list_references`,
  `check_citations`, `search_references` and `add_citation` were the gap the first pass left —
  `list_references` only because #137's fix (#142) was still in flight, the other two because
  neither can answer without a bibliography backend. They now drive the **real**
  `DblpService`/`CrossrefService`/`OpenAlexService` over a canned `fetch` (production mapping
  code, canned bytes, no network) rather than the hand-written fake backends
  `referenceBackends.test.ts` uses for the resolver's _decision_: a hand-built `ReferenceHit`
  carries exactly the keys the test author typed, and the key that breaks a tool is the one
  nobody typed. None of the four emits an undeclared key today — which is a finding only because
  the check was shown to bite: injecting one into each handler fails each audit with the pointer
  named, `results[].…` through the array included. The fixtures exist to keep anything from being
  judged empty: a `.bib` carrying one of every `check_citations` finding, all three bibliography
  shapes for `list_references`, a pinned search and a substituted one (the only call that emits
  `fallbackFrom`/`hint`), and `add_citation` against a git-backed project so its `diff` is a real
  diff — over the write, the already-present no-op, and the OpenAlex→Crossref DOI bridge, which
  is the one branch that emits `via`. `list_references` also gets the primed-client pair the
  shelve trio has, since #137 made it uncallable rather than merely wide: a client that calls
  `listTools()` first now gets `entries[].fields` back instead of `-32602`. Finally, "all 38" is
  asserted rather than asserted-in-a-comment: a test matches this file's own `auditCall` sites
  against `tools/list`, so a 39th registered tool that nobody audits fails CI — judged against
  the file's source, so it holds under a `-t` filter too.

- **Both timing tests in `errorSnippets` measure scaling, not a wall clock** (#129; no `src/` file
  changes). `test/unit/errorSnippets.test.ts`'s _"does not go quadratic on a document that fails
  with thousands of errors"_ closed with `expect(ms).toBeLessThan(1000)`. That failed on
  `windows-latest` at 2398ms on a PR carrying no `src/` change at all — and the same commit had
  passed Windows minutes earlier in the `push` run of the identical tree, which is what tells a
  slow runner from a regression. An absolute budget is a Linux-shaped number asserted on a shared
  machine roughly an order of magnitude slower and variable run to run.

  Its deterministic assertions are unchanged and still carry the guarantee — the work is bounded
  by `MAX_SNIPPET_LOCATIONS` and not by the 20,000 diagnostics. What replaces the budget is the
  claim the test's _name_ makes: the same call is timed at 2,000 and at 20,000 diagnostics, and
  the ratio must stay under 30. A ratio of two measurements taken on one machine, in one process,
  milliseconds apart is machine-independent by construction — a uniformly slower runner scales
  both halves and cancels out, and a higher fixed per-call cost (Windows fs) inflates both by the
  same constant, which moves the ratio TOWARD 1 rather than away.

  Three details decide whether a test of this shape is worth having, and all three are easy to get
  wrong. The threshold is **not** the 10 the input scale suggests: an implementation linear in the
  diagnostic count takes 10x as long on 10x the input by definition, so the input scale is the
  linear _prediction_, not a bound above it, and asserting it would red on the first sample — a
  naive single-shot ratio measured 13.4x on correct code. The small size is **batched**, because a
  ~1.5ms baseline measures timer granularity, GC luck and JIT warmup rather than complexity — and
  a non-vacuity assertion fails the test outright if that window ever shrinks into the noise
  floor, rather than letting it pass for the wrong reason. And the two sizes are timed **back to
  back inside each round**, then reduced by the **median** of the per-round ratios: timing every
  small call and then every large one lets a load change land entirely in one phase, which is a
  ratio of two different machines, and the per-round ratio turns out to be bimodal under GC, so
  reducing by the fastest round picks the low mode on both sides and discards half the separation
  (4.8-6.8 against 36.0-42.7, where the median gives 7.6-10.2 against 99.3-107.8).

  The same treatment goes to _"checks a location once, not once per diagnostic sitting on it"_,
  which had the same defect on a **tighter** budget (500ms) over fs- and regex-bound work on a
  ~500KB line — the next red leg, left alone. Its guarantee is a stronger scaling claim, so the
  hypotheses sit further apart: checking the location once makes the cost independent of how many
  diagnostics sit on it (~1x), while re-checking per diagnostic makes it proportional (~100x at
  100x the diagnostics). One project, one location, two diagnostic counts, so the file read and
  the single normalization are identical fixed costs on both sides and the ratio isolates the only
  thing that varies. The threshold is 10 — again deliberately not the ~1x the guarantee predicts.

  Proven against controls rather than asserted. With the `order.some(...)` dedup spliced back in
  where the `Map` is, the anti-quadratic assertion fails 5 runs out of 5 at 98.7-102.2 against its
  limit of 30, while the real implementation measures 7.6-10.2 over six runs and passed 8 out of 8. With the per-diagnostic loop spliced back in, the co-location assertion fails 4 runs out of 4
  at 83.5-90.5 against its limit of 10, while the real implementation measures 0.90-1.20 over six
  runs. That second control also supplied the evidence for preferring the median over the minimum:
  one of its rounds came back at **0.19** against its four siblings' 71-116, a stall in that
  round's baseline window that a minimum would have selected — passing the regression through.

- **`auxFloats`' three linearity tests measure scan steps, not wall clock** (#173). A growth ratio
  over `Date.now()` is machine-speed independent but not load independent, and one read 3.21x on
  genuinely linear code inside a full suite; they now count the characters the scan looks at
  (`measureAuxScanWork`), which is deterministic and let the threshold tighten from 3.0 to 2.5.

- **`status` bounds its path lists, in both channels** (#175, #68). Every list — `staged`,
  `unstaged`, `untracked`, `externalChanges`, `sessionChanges`, `otherChanges`, `conflictedChanges`
  and each peer's `activeSessions[].changes` — shipped uncapped as JSON and again `join(', ')`ed
  into the result text, so an untracked `figures/` tree put the most-called tool in the server past
  a client's cap, undelivered. `planStatusPayload` (`src/lib/statusBudget.ts`) now fits them into
  the house 20000-character budget charged across both channels, cutting by a declared priority
  (`conflictedChanges` and `externalChanges` before the informational `untracked`) with every cut
  counted in `pathsOmitted`/`truncated`, and caps `activeSessions` at 20 sessions. `aheadCommits`
  and `behindCommits` stay **complete** — a conflict payload caps its own `remoteCommits` and points
  here for the full list — and only their text rendering is bounded.

- **Which `status` fields other code depends on being complete is now enumerated, and consumed by
  the tests on both sides** (#187, #185, #175). Two modules cut a list of their own and tell the
  caller `status` holds the whole of it: `conflictBudget.ts`'s `CONFLICT_MAX_COMMITS` survived
  #175 because that spec named it, and `peerAttribution.ts`'s refusal did not — it promised an
  uncapped `status` for a release (#185). The difference was whether a human remembered the second
  pointer existed. `STATUS_COMPLETENESS_PROMISES` (`src/lib/statusBudget.ts`) now records each
  promised field with **which code depends on it and where that promise is written**, so a reader
  can check whether the dependency still exists instead of treating the exemption as sacred, and
  `STATUS_UNPROMISED_POINTERS` records the deliberate opposite — `otherChanges` is pointed at and
  budgeted anyway, since exempting the list most likely to be enormous to keep a sentence true is
  the trade #185 rejected. Both halves are enforced by the type system, symmetrically: a promise's
  field subtracts `ALLOCATION_ORDER`, so **budgeting a promised field stops compiling**, and an
  unpromised pointer's field IS `ALLOCATION_ORDER`, so un-budgeting a warned one stops compiling
  too. Tests consume it from both ends — the cap in `conflictBudget` asserts its own delegation is
  registered, each dependent's promise is asserted to still be in that dependent's source, and a
  real `status` call over a real clone returns every promised field whole while its path lists are
  cut. What it does not do is notice a **new** pointer nobody registered; it makes registering one
  line, and makes a registered promise fail at the budget rather than in prose.

## [0.6.0] - 2026-08-21

### Added

- **`compile` returns the source around each error** — a LaTeX message is frequently uninterpretable
  on its own (`Undefined control sequence` names no macro; `Missing $ inserted` points at the line
  where TeX _noticed_, not where you erred), so each error now carries the 5 source lines around it
  (`snippet`, numbered from `snippetStartLine`), rendered into the result **text** as well as
  `structuredContent` so a client that strips structured output still sees it. Errors only —
  warnings never carry one — at most 10 distinct locations per compile, attached once per location,
  and never a guess. Earning one takes more than a plausible line: the log has to name the file
  **and** line on one diagnostic line (`-file-line-error`), so a location pieced together from the
  parenthesis stack is counted rather than illustrated — which means **tectonic**, whose logs carry
  no `file:line` at all, gets no snippets by design. A line past the end of its file, a file the
  document merely _named_ in its log, and a location TeX's own echo of the source contradicts all
  get none either. `omittedSnippetLocations` says how many locations went without, so a gap is
  reported rather than silent. `list_comments` snippets now have the same shape (`snippetStartLine`
  included).
- **`session-feedback` skill** — a bundled skill to run at the _end_ of a session, which reviews the tool
  calls that actually ran and reports on the **server itself**: what broke, what cost too many calls,
  what capability was missing, what the docs got wrong. Findings are classified
  (`bug`/`friction`/`gap`/`docs`/`skill`), rated blocked/slowed/cosmetic, given a frequency, and checked
  against existing issues (best-effort, via `gh`) so a known problem is marked rather than re-filed. The
  output is **one ready-to-file issue body per finding**, laid out field for field against the repo's
  issue forms — with a _measured_ environment block (server version and whether it is the latest, OS +
  arch + WSL, Node, MCP client, model, install method, TeX toolchain, workspace and project kind): the
  skill runs the commands rather than recalling values, and writes `<unknown — please fill in>` for
  anything it could not measure or was not told. It mutates nothing, scrubs credentials and manuscript
  content before printing, and files an issue only when explicitly asked. Documented in
  [CONTRIBUTING.md](CONTRIBUTING.md#feedback-from-a-session) as the fastest way to contribute.
- **Issue forms ask what actually predicts a bug** — the bug report form gained **MCP client** (which app
  was connected), **Model** (tool-use behavior differs between them), **How was it installed?** (npx,
  global npm, `.mcpb` bundle, plugin, clone — it decides which dependencies shipped), and **TeX
  toolchain** fields, the OS field now asks for architecture and WSL, and the remote dropdown covers a
  local in-place project. `session-feedback` fills the same fields in the same order.
- **`list_references`** — read a project's own references, structured: cite key, entry type, title,
  authors (with `truncatedAuthors` for an `and others` / "et al." list), year, venue, DOI/arXiv, the file
  and line each entry sits on, and its `raw` text. Reads three shapes of bibliography and says which one
  each entry came from: a BibTeX `.bib` (resolving `@string` venue macros), a LaTeX `thebibliography` of
  `\bibitem`s, and **a reference list written as prose in a markdown or plain-text document**. `filter`
  searches across key/title/authors/venue. Read-only and git-free, so it works on a local project.
- **`check_citations`** — cross-check what a document cites against what its bibliography defines, in one
  call: `undefinedCitations` (cited with no entry — these render as `[?]`), `uncitedEntries`,
  `duplicateKeys`, and `incompleteEntries` (missing a field the BibTeX entry type requires). Reads the
  `\cite` family in `.tex` (multi-key and optional-argument forms, skipping commented-out ones) and
  pandoc `[@key]` / `@key` in markdown. Structural only; correctness is still the DBLP pass.
- **`check_citations` spans two projects** — `bibliographyProject` checks a draft against a shared
  bibliography that lives in _another_ registered project, in one call instead of two `list_references`
  calls and a comparison by hand. `documents` resolve inside `project` and `bibliography` inside
  `bibliographyProject`, each sandboxed to its own; the parameter is a **project id**, never a
  `"project:path"` string, so another project is reachable only by naming one you registered. Reading
  only — writing into another project's `.bib` stays a separate, permissioned `add_citation` there.
  Findings are limited to the keys the draft actually cites, since a shared bibliography is supposed to
  hold entries this draft does not use: `uncitedEntries` comes back empty and `duplicateKeys` /
  `incompleteEntries` cover cited entries only (`entryCount` still reports the full size). The answer you
  came for — `undefinedCitations`, the keys the shared `.bib` does not define — is unaffected.
  `list_references` needs no equivalent: it already reads whichever project `project` names.
- **`list_files` filter `docs`** — prose documents (`.md`, `.markdown`, `.txt`, `.rst`, `.org`) are now a
  first-class file `type` (`doc`) rather than `other`, so a markdown draft is findable.
- **`add_citation` returns `line`** — the file and line the entry landed on, so a caller can confirm the
  insertion without re-reading the `.bib`.
- **`register_project` accepts a file, not only a directory.** People point at the document — "verify the
  citations in `~/proposals/eurohpc.md`" — so naming a file now registers the folder holding it instead of
  failing. A `.tex` named this way also becomes the LaTeX `rootFile`; a markdown or plain-text document
  does not, since it is not a LaTeX root. An explicit `rootFile` still wins, and the result says which
  directory was registered — the project is the whole folder, and every file in it is readable.
- **`diff` accepts a `ref`** — so a session that already committed a few times is still reviewable as a
  whole, without dropping to a shell. Takes a commit-ish (`"HEAD~3"`, a sha, `"origin/master"` for what
  the branch has that the remote does not) or a two-dot range (`"a..b"`); `path` still narrows it to one
  file. Every endpoint is resolved before it reaches git, so an unknown ref is reported by name rather
  than surfacing a raw git error, and `ref` alongside `staged` is rejected instead of one silently
  winning. Note it is **not** session-scoped: `commit` takes only your own edits but history is shared,
  so on a clone with several sessions a ref diff spans everyone's commits — it answers "what changed",
  not "what did I change" ([tools.md](docs/tools.md#reviewing-a-whole-session)).

### Changed

- **README trimmed.** "Highlights" merges the multi-project and no-remote bullets into one, and the
  surgical-edit and reviewable-push bullets into another; the references bullet now leads with what the
  citation checks do rather than which formats they parse. "What you can do" is five one-line entries
  instead of a paragraph each — the parameters, guards, and edge cases it restated all live in
  [tools.md](docs/tools.md), which it now points at.
- **`verify-citations` works on a document that is neither a `.bib` nor on a remote.** The skill now
  branches on the project's `mode`: it skips `project_sync` and the git-exclude step for a local project
  instead of failing on them, registers an unregistered folder in place, and drives `list_references` /
  `check_citations` rather than hand-parsing with regex. It states per format how far the parsed fields
  can be trusted (`prose` entries are heuristic — query DBLP from `raw`), never annotates a markdown
  draft (no comment syntax stays invisible there), and asks before writing the audit report into a local
  project's directory, which belongs to the user.
- **`search_references` description** — says outright that it queries DBLP over the network and does not
  read the project's `.bib`, and points at `list_references` for searching the references already there.
  It was not clear which side of the boundary the tool sat on.

### Fixed

- **A read the server makes for itself no longer disarms the out-of-band-edit guard.** Detecting the
  root file (`compile`, and the viewer's PDF poller, on a timer) and building `list_comments` snippets
  recorded a revision baseline as though the caller had read those files, so a `write_file` after a
  hand edit could overwrite it with no `ExternalChangeError`. `FileService.read`/`readText` now record
  only when asked to, which only `read_file` and `list_references` do — the two that hand back a whole
  file the caller could base a write on.
- **A symlink can no longer take a read or a write out of a project.** `resolveInside` compares
  strings, so a `notes.tex` symlinked outside it — git stores one as mode 120000, so a collaborator
  can commit it — was read, written, edited and deleted at the far end. Every path resolves links
  first now, including for a file that does not exist yet: a write follows a dangling link and
  creates the file wherever it points. A link's target is resolved in turn, component by component:
  a dangling `notes.tex` pointing at `sub/pwned`, with `sub` itself linked outside, lands outside
  however innocent the literal target looks. That holds for **every** project, cloned or local:
  whether you or the server ran `git clone` says nothing about who put a link in the tree, and a
  directory you registered in place is usually a working tree a co-author can push a symlink into.
  The one layout that needs links — a shared `refs.bib` or `figs/` linked into each paper — is a
  per-project opt-in you set yourself, **`followSymlinks: true`** on a local project
  (`register_project`, `WEB_LATEX_MCP_PROJECTS`, or the workspace registry). Where it is on,
  `list_files` and every tool that scans on its own now see the linked files too, so the shared
  `.bib` is findable instead of readable only by name.
- **A path the _document_ chose is not handed back as one to open.** `compile` refused to read a
  symlinked path for a snippet and then reported it as a `file` you can pass straight to `read_file` —
  so the guard covered the read the server makes rather than the path it offers, and the caller took
  the next hop. A diagnostic (error or warning) whose file leaves the project through a symlink now
  keeps its message and loses its `file`/`line` — and its snippet, which is rendered against that
  line — and the result text says how many were hidden; `list_comments` does the same for a synctex
  record, which the document controls just as much. Resolving those paths is capped, and a location
  past the cap is withheld too but reported as **unchecked**, not as an escape: nobody looked at it,
  so blaming a symlink would send you after a link that is not there.
- **`read_file` no longer counts a phantom last line.** A file ending in a newline reported one line
  more than it has, and a range ending on it returned a blank line; CRLF and CR-only files are now split
  correctly instead of leaving `\r` on every line (or, for CR-only, returning the whole file as line 1).
- **A ranged `read_file` hands back the bytes that are on disk.** Line endings were normalized to `\n`
  on the way out, so pasting a range from a CRLF file into `edit_file`'s `oldString` failed to match;
  the `ref` path also called a whole-file read truncated and dropped the trailing newline, which
  `push` resolutions write straight back into the repository.
- **`rawLog` and the log tail no longer carry `\r`** on a Windows log — the last path that still split
  on `\n` alone.
- **Compile logs written on Windows parse at all.** pdfTeX writes its `.log` in text mode, so every line
  arrives with a trailing `\r` — which the diagnostic patterns do not cross and `extname` keeps. Left
  unhandled it emptied the parser, and CI's TeX job is Linux-only, so nothing caught it.
- **`compile` resolves a root file in a subdirectory.** latexmk's `-cd` makes the log's paths relative
  to the root file's directory, so a document at `paper/main.tex` reported its errors in `main.tex`;
  they are now rebased onto the project root.
- **The collapsed "TikZ externalization failed for N figures" error no longer claims a location** — it
  inherited the first figure's file and line, pointing at source where nothing is wrong.
- **A diagnostic printed without a source position no longer borrows the next one's.** The `l.<n>` scan
  ran past whatever followed, so a `! Package hyperref Error` above an unrelated
  `! Undefined control sequence` was reported at that error's line — including when latexmk printed the
  two on adjacent lines, which is the usual shape.
- **Source context survives an accented document.** pdfTeX elides a long context line at a byte offset,
  so it can cut a UTF-8 character in half; the resulting replacement character made the check that
  guards against a stale location reject a file that was perfectly correct. Measured on real French
  prose, that silently withheld the source for one error location in eight.
- **A warning's `file` is rebased like an error's**, so it too is a path `read_file` can open when the
  root file lives in a subdirectory.

## [0.5.0] - 2026-08-20

### Added

- **Local (in-place) projects.** `register_project` accepts a `path` instead of a `gitUrl` and uses that
  directory where it lies — no clone, no second copy of the document. Registering the surrounding repo
  just to reach one `.tex` previously left two copies to drift apart. Git tools (`status`, `diff`,
  `commit`, `push`, `discard`, `project_sync`, `reset_to_remote`, and `read_file` with a `ref`) refuse a
  local project with an explanation rather than operating on the user's own repository. Compiled PDFs are
  surfaced into the workspace, never beside the source. Also configurable via `WEB_LATEX_MCP_PROJECTS`
  as `{ "mode": "local", "path": … }`.
- **`doctor`** — report the local toolchain a compile depends on: configured compiler, installed engines,
  TeX distribution and whether it is past end of life, the package manager and the repository it would
  install from (flagging a frozen `historic`/`tlnet-final` archive), writable install paths, `git`, and
  the workspace. Local and read-only; `checkRepository: true` also tests the repository over the network.
- **`missingPackages` on the compile result** — packages the local TeX installation lacks are named
  directly (e.g. `["fontawesome"]`) instead of leaving the caller to parse ``File `x.sty' not found``
  out of the log, with a `hint` carrying the install command. Only `.sty`/`.cls` names are reported: a
  missing image is a problem with the document, not with the machine.
- **`list_skills`** — the bundled skills as a tool, so the model can discover and follow one on its own.
  They were previously reachable only as MCP prompts, which a user has to invoke.
- `server_info` and `register_project` now report the `.git/info/exclude` pattern the server added for
  the clone directory, so a caller knows it is already handled and does not add a redundant `.gitignore`
  entry — and that the exclude is local to that checkout.
- Writing guide gains a **Citations** section on where `\cite{}` goes in the prose: never in the
  abstract, on first mention in the main text, re-anchored at each major section boundary (readers jump
  straight to the Method or Experiments), and never twice for the same work within a section.

### Fixed

- **The `.mcpb` Desktop Extension could not start.** `.mcpbignore` excluded `src/` unanchored, which
  matches a directory of that name at any depth — including `node_modules/debug/src/`, where that
  package's `main` points. The packed bundle was therefore missing the entry point of a transitive
  runtime dependency (via `simple-git`) and died on startup with
  `Cannot find package …/debug/src/index.js`. This affected the published 0.4.0 bundle. Our own
  directories are now anchored (`/src/`, `/test/`, …), and the bundle workflow starts the packed
  server before attaching it to a release, so a bundle that cannot boot never ships again.
- `manifest.json` had fallen a release behind the other version manifests, so a locally built
  Desktop Extension (`npm run bundle`, which does not sync it the way the release workflow does) was
  labelled with the previous version. A unit test now asserts `package.json`, `plugin.json`,
  `marketplace.json`, `manifest.json` and the lockfile all agree, so the gate fails instead.
- The per-project build directory is keyed by the project's full path rather than its basename, so two
  projects whose directories share a name no longer share a build directory (and surface each other's
  PDF).
- `list_projects` no longer points at `OVERLEAF_MCP_PROJECTS`, an environment variable that no longer
  exists; an empty workspace now explains how to register a project.
- Relative paths in `WEB_LATEX_MCP_PROJECTS` resolve against the server's launch directory rather than
  the process working directory.

## [0.4.0] - 2026-07-28

### Added

- **`set_credential`** — store a git token in the OS keychain straight from chat, so a project can be
  authenticated without editing environment variables or shell config. The token is written to the
  platform keychain and never persisted in `.git/config`.
- **`credential_portal`** — enter a git token via a one-off loopback web page instead of typing it into
  the chat, so the secret never travels through the conversation transcript.
- **Persistent project registry.** Projects registered at runtime (via chat) now survive a server
  restart instead of living only in memory, so a client does not have to re-register them each session.
- **One-click Claude Desktop Extension.** The server ships as a `.mcpb` bundle for one-click install in
  Claude Desktop, trimmed from ~50 MB to ~17 MB (6.2 MB packed).

### Changed

- Compilation adopts `latexmk -cd`, running the build from the main file's own directory so projects
  that rely on relative paths compile correctly.
- The credential portal page, the `credential_portal` result, the Desktop install form, and the docs now
  link to <https://www.overleaf.com/user/settings>, where an Overleaf Git authentication token is
  created — no hunting through Overleaf's settings to find it.

## [0.3.0] - 2026-07-24

### Added

- Keyboard shortcuts in the PDF viewer's comment popup: `Shift+Enter` saves the note (triggers the Save
  button) and `Escape` cancels, so the select-to-comment flow no longer needs the mouse. Plain `Enter`
  still inserts a newline; the textarea placeholder advertises both.
- **Parallel sessions on one clone.** Several agent sessions — a session per section, say — can work on
  the same project at once, each committing only its own edits. Each session keeps a shadow of every
  file it touched, holding `HEAD` plus only that session's changes, and `commit` stages that content
  directly instead of running `git add`, so a peer's half-written paragraph in the same file stays
  uncommitted in the working tree. Name a session with `WEB_LATEX_MCP_SESSION`; state lives in
  `<workspace>/.sessions/`, outside the clones. Same file, different paragraphs merges silently; the
  same _lines_ is surfaced and excluded from commits rather than resolved. See
  [Parallel sessions on one clone](docs/CONCURRENCY.md#parallel-sessions-on-one-clone). Requires one
  server process per session (Claude Code); Claude Desktop shares a single session across chats.
- Mutating operations now also take a lock file, so two server processes over the same clone can no
  longer rewrite its git index at once. Abandoned locks are reclaimed once the owning process is gone.
- `status` reports `sessionChanges` / `otherChanges` (who owns each uncommitted file), `activeSessions`,
  and `conflictedChanges`; `commit` reports `scope`, `session`, `leftUncommitted`, and `conflicted`.
  Rendered into the result text too, so clients without structured output still see them.

### Changed

- `commit` commits only the current session's edits by default, once that session has changes to track;
  pass `scope: "all"` for the previous whole-clone behaviour. Sessions that make every edit through the
  tools — the single-session case — are unaffected.
- `push` refuses while another live session has uncommitted work, naming who to wait for: a push has to
  rebase, and a rebase needs a clean tree. Changes nobody owns (edited outside the server, or left by an
  exited session) do not block it.

- `format-latex-project` gains a third cosmetic pass: every `figure`/`table` environment moves into its
  own `figures/<name>.tex` or `tables/<name>.tex` file, `\input`ed from exactly where the float stood.
  Files are named after the float's label, `\includegraphics` paths are left byte-identical, and new
  floats are authored the same way from the start.
- `arxiv-clean-project` skill now gates `--use_external_tikz` on detection: it is offered only when the
  project already externalizes TikZ (`\tikzexternalize` plus one PDF per figure in the prefix folder),
  since `arxiv_latex_cleaner` only substitutes the PDFs and never generates them. Otherwise the skill
  explains what setting externalization up would require (a live source edit and arXiv's TeX Live
  release) and proceeds without the flag.
- Writing guide clarifies two conventions: figure/table caption explanations are descriptive (axes,
  conditions, curves — interpretation stays in the body text), and acronyms are defined once at first
  appearance, only for terms that recur, with the abstract as the standalone exception.
