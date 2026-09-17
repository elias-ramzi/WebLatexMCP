# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This log starts with the changes made after 0.2.0; for anything earlier, see the git history.

## [Unreleased]

### Added

- **A `pdf_geometry` tool: measure the compiled page in points, instead of eyeballing a PNG** (#73).
  `render_pages` answers "does this look wrong"; it cannot answer "by how many points does this
  table's text overlap the figure frame above it". Reading a rasterized page is not measurement, and
  the reporter's case — twelve table text runs sitting inside a figure's frame — is exactly the kind
  a human sees instantly and an agent cannot compute from pixels. `pdf_geometry` is read-only over
  the **last build** (it never compiles) and reports boxes in PostScript points with the origin at
  the **top-left**, matching `render_pages`' `clip` convention so the two compose: one to look, one
  to measure. Three kinds: `text` (pdf.js text items merged into per-line boxes by shared baseline
  and horizontal adjacency — the `text` on each box is a truncated _label_ for it, not the
  document's content), `images`, and an opt-in `floats` index of `label -> printed page` parsed from
  the build-dir `.aux`.

  **What `images` is, and what it deliberately is not.** It reports image and form XObject
  _placement rectangles_ — what an `\includegraphics` figure actually occupies — recovered by
  walking the page's operator list with our own CTM stack. General **vector path geometry is out of
  scope**: pdf.js exposes `\fbox` rules and TikZ strokes only as raw path-construction operators in
  untransformed space, and replaying them correctly is a full graphics-state interpreter, so a frame
  drawn purely with rules and no embedded image is not reported **at all**. The tool description
  says so in those words, because the failure mode of a half-built geometry tool is a caller
  measuring a collision that is not there, or missing one that is — and that is worse than not
  having the tool. Text-only would have been half the work and would **not** have caught the case
  the report was filed about, which is why `images` is in and `drawings` is out.

  Three details the CTM walk depends on, each of which was wrong or unguarded in the first cut and
  each of which fails _silently_ — a plausible rectangle in the wrong place, which is worse here
  than an error. **A form XObject carrying a `/Group` (transparency) gets `null` where its `/BBox`
  should be**: pdf.js builds the op as `[matrix, !group && bbox || null]` and moves the real BBox
  onto the `beginGroup` op emitted just before it. Ignoring `beginGroup` therefore fell back to the
  unit square and reported a **2.0 × 2.0 pt box for a 113.4 × 56.7 pt figure** — a ~56× area error
  at the figure's bottom-left corner, indistinguishable from a good measurement. That is not an
  exotic case: pdfTeX copies an included PDF page's `/Group` onto the Form XObject, so Inkscape
  exports, matplotlib output with any alpha and TikZ/pgfplots figures using `opacity` all carry
  one — and it lands precisely on the flagship question ("does this text collide with that figure
  frame"), producing the exact failure this tool must never produce. The walk now carries a pending
  group bbox forward, composed with the CTM as it stood at `beginGroup` (which is what pdf.js's own
  `beginGroup` clips against — implemented literally rather than assuming the group matrix and the
  form matrix always coincide), consumed by the paired `paintFormXObjectBegin` and cleared so it can
  never leak onto a later form. Where a form still cannot be bounded, the box is flagged
  **`approximate: true`** rather than passed off as measured — a fallback a caller must not compute
  a collision from should say so. Second: an `OPS.restore` on an empty stack must **not** throw — a
  truncated content stream is a real thing a document-controlled operator list produces, and failing
  the page over one bad operator would discard the images already found. Third:
  `paintFormXObjectBegin`/`End` push and pop a CTM of their own even though no paired
  `save`/`restore` appears around them in the list, because pdf.js saves internally when it executes
  that op — removing either half broke no test until one was added that paints an image _after_ the
  form's `End` and checks it sits at the outer CTM. `OPS.paintJpegXObject` does not exist in the
  installed pdf.js and is not referenced; a test now imports the real `OPS` and asserts every op
  name the walk uses is a number, because the walk is driven by a hand-rolled fake everywhere else
  and a renamed op would otherwise yield `images: []` on every page with a fully green gate off-TeX.

  **Coordinates come from the page's own viewport transform, not a hand-rolled y-flip.** The first
  cut took the page box from `getViewport({scale:1})` — which is rotation- and box-aware — and then
  flipped y manually, which rebases nothing: a non-zero MediaBox origin shifted every box, and a
  `/Rotate 90` page transposed the axes and could report an `x1` past `pageWidthPt`. `/Rotate 90` is
  what `pdflscape` writes, and a landscape page is where a wide table lives, so this was wrong
  exactly where the tool is most needed — and it made the promise that `pdf_geometry` composes with
  `render_pages`' `clip` false on those pages, since `clip` _is_ viewport-relative. Every box now
  maps through `viewport.transform`, taking the bounds of all four transformed corners.

  That fixed `images`, and review found it had done **nothing for `text`**, while two documents
  asserted the opposite. `lscape`/`pdflscape` rotate the page _content_ 90° as well as setting
  `/Rotate`, so every text item on such a page carries a rotated matrix — and `itemBox` added the
  advance along `+x` and the em along `+y` regardless, so a 254 pt horizontal line came back as a
  10 pt-wide, 254 pt-tall vertical sliver. Mapping an already-transposed box through the viewport
  cannot repair it. The box is now built from the item's own text matrix — the advance along its
  text direction, the em along its up direction — which reduces to exactly the previous numbers for
  unrotated text and is correct for a sideways table cell, a rotated axis label and a `pdflscape`
  page alike. The smoke test that was meant to prove this asserted only that boxes land _inside_
  the page box, which a 90°-wrong box also satisfies; it now asserts the landscape heading is wider
  than it is tall, and that assertion was watched failing (`expected 14.35 to be greater than
127.72`) before the fix. What is still **not** modelled, and the schema now says so: a sheared
  text matrix; line _merging_, which keys on the baseline `y` alone, so a rotated line of several
  items comes back as several correct boxes rather than one merged line; and a text box spans
  baseline to the **em height**, not the ascent — it overshoots the ink above and excludes
  descenders below, so a descender touching a figure reads as clearance.

  `mergeTextLines` also merged in one direction only: the adjacency test bounded the gap above but
  not below, so an item anywhere to the _left_ of the running line joined it — two TikZ nodes 285 pt
  apart, emitted right-then-left, became one 346 pt box spanning blank paper, in reverse reading
  order. An item may now overlap the running line by at most its own em (accents are painted back
  over the preceding glyph); anything further left starts a new line.

  The geometry math (`src/lib/pdfGeometry.ts`) and the `.aux` parser (`src/lib/auxFloats.ts`) are
  pure and hold no pdf.js import, so both are unit-testable without a PDF; the service work reuses
  `PdfRenderer`'s existing `openDocument`, which is what turns a missing `@napi-rs/canvas` into a
  message naming that package rather than a "DOMMatrix is not defined" or a claim that the PDF is
  broken. pdf.js in Node cannot open a document at all without that backend, so `geometry` needs it
  exactly as `pageCount` does — and loading pdf.js **after** `openDocument` rather than before is
  load-bearing for that, which a test pins. The `.aux` is a build artifact written by the document:
  it is read with a brace-balanced scanner (a naive `\{([^}]*)\}` regex mis-parses hyperref's
  five-group `\newlabel`), a malformed or half-written entry is skipped rather than thrown on, and
  **no path or string it names is ever opened, resolved or stat'd** — the same rule the compile log
  is held to. The first cut bounded the parser's _results_ and not its _work_: the loop guard only
  advanced on a successful parse, and a failing marker's `readBraceGroup` scanned to end-of-string,
  so an unbalanced `.aux` was quadratic — 520 KB took 27 s, and a real `latexmk` run was made to
  produce one. That matters beyond slowness: the parse is synchronous inside `runExclusive`, so it
  blocks the whole stdio server, and past 60 s `reclaimIfStale` lets a peer delete this session's
  live lock. The scan is now bounded on two independent axes — a per-group scan budget and an
  iteration counter that does not depend on how many entries parse — so the worst case is constant
  per marker and linear in the file. The same scan also never advanced past an entry it had read,
  so a `\newlabel` inside hyperref's caption group was picked up as a second, fabricated
  `label -> page` row; it now advances to the end of the outer group. Everything is capped with an
  accompanying count, so a truncated answer is never a silent one: 4 pages per call (lower than
  `render_pages`' 8 — a page of boxes is far more output than one PNG), 300 text lines and 100
  image rects per page, 200 floats — the last counted against every `\newlabel` actually found,
  exactly, up to the parser's own (much larger) scan bound, with `floatsDropped` counting the
  entries that were found but could not be reported — an over-long field, or an entry whose own
  `\newlabel` group ran past the scan budget — rather than discarding them silently. That budget
  needed a second pass of its own: capping the scan stopped the quadratic blowup but left the
  scanner re-entering the group it had just abandoned, so a figure with a ~4000-character caption
  vanished with every counter reading zero, and the fabricated `\newlabel` inside such a caption
  came back in place of the real entry — strictly worse than the bug the cap was fixing. The
  scanner now advances past a group whose true end it has located, and counts what it drops. `floats` also drops cleveref's `@cref` shadow entries, whose "page" field is `[1][1][]1` and
  not a page at all, and which otherwise doubled every document's float budget; the pure parser
  stays faithful to the file and the filtering sits one layer up. Asking for `floats` alone no
  longer opens the PDF, so a float index — which is text parsing — does not require the native
  canvas backend. The tool takes
  `requireProjectDir`, never `requireGitProject`, so it works on a `mode: 'local'` project like
  `compile` and `render_pages`; it takes `runExclusive` for the same reason `render_pages` does (a
  peer session's `compile` can rewrite the build dir mid-read); and it writes nothing into the project
  directory or the temp build dir — an integration test diffs both across a call, since the project
  directory alone would not have caught a scratch file written into the build dir, which is exactly
  what the code this was copied from does. It is not true that it writes nothing _anywhere_: taking
  the lock creates `<workspace>/.sessions/<id>/` and leaves the directory behind (the lock file
  itself is removed), exactly as `render_pages` does. A second test now pins that narrower, true
  statement from an empty workspace root — the original passed only because its fixture called
  `register_project` first, which had already created the directory.

  Two smaller review fixes: a document-controlled `cm` whose operands overflow no longer emits a
  `NaN` box — which zod rejected _after_ the handler returned, outside the `errorResult` catch,
  losing every other page in the call — and `kinds: ["floats"]` alone no longer requires a PDF to
  _exist_, so a compile that wrote an `.aux` and then died on a missing package still has a
  readable float index.

- **`compile` takes a `warningsFilter`, and it trims both channels or neither** (#73). A warning-heavy
  paper returned ~127 KB of result, and the reason it was that large is that every `Overfull \hbox`
  ships **twice**: once structured in `warnings[]`, and once as raw text in `logTail`, because
  `KEEP_PATTERNS` keeps box lines and `logTail` is returned on every compile. So a filter over
  `warnings[]` alone — the obvious shape, and the one the report asked for — would have cut barely half
  of what it claimed to cut, while reading as though it had worked. `warningsFilter` takes `file`,
  `rule` and `excludeRule` (exact, literal, never globs or prefixes — the house rule that a
  caller-named path handed downstream is literal, for the same reason: a typo must fail
  conspicuously rather than match everything), and `filterLog` gained a `keepWarning` predicate so
  `logTail` drops the same lines `warnings[]` dropped. `warningsOmitted` counts what went, so a
  filtered list is never silently a subset. Three things it deliberately does not do: it never
  filters **errors** — a document that fails to compile is not made to look cleaner by a knob meant
  for box noise; it never filters a **rerun hint** or the `Output written on` summary, even though
  `LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.` matches both a
  warning pattern and a hint pattern, so the always-keep list is checked **first**; and it leaves
  `rawLog: true` alone, because raw means raw — `warnings[]` is still filtered there, and both
  descriptions say so rather than letting a caller discover the asymmetry. With no filter passed,
  `filterLog`'s output is pinned two ways, which prove different things: a differential test
  compares its output against itself under options that must be inert (no filter, an
  accept-everything `keepWarning`, an inert `baseDir`) across thousands of generated logs, proving
  the filter is a true no-op absent a caller opting in — but it is structurally blind to a change
  that perturbs both sides of the comparison identically; a committed sha256 digest of that same
  corpus's output, at every `maxLines` choice, is what actually pins byte-identical output against
  a `KEEP_PATTERNS`/`unwrapLines` regression the self-comparison cannot see. The paren-stack
  bookkeeping `keepWarning` needs is skipped entirely when no filter is given. "Unchanged unless
  used" is the only thing that makes this safe to add to a tool every session calls. And when a
  filter rejects _every_ diagnostic line, the tail says so in one sentence rather than falling back
  to the raw last-15-lines tail it falls back to for a log with no diagnostics at all — that
  fallback would have returned the excluded warnings plus the font and PDF-statistics noise, the
  feature exactly inverted, so the two emptinesses are told apart rather than sharing a branch. A
  fourth thing it deliberately does not do: an **empty filter array constrains nothing** —
  `{file: []}` is the same as an absent `file`, not a filter that matches nothing — so a filter
  list built programmatically that comes out empty _widens_ the result to every warning instead of
  narrowing it to none; the tool schema and the docs both say so.

- **A package name carrying a `.` or a `-` is finally a warning at all** (#73). `PACKAGE_WARNING`'s
  name class was `\w+`, which matches neither, so `Package pdftex.def Warning: ...` — pdfTeX's own
  driver file, one of the commonest warning sources in a real log — matched nothing. Not
  misclassified: **invisible**, missing from `warnings[]` entirely and uncounted by
  `warningsOmitted`, while `KEEP_PATTERNS`' literal `/Warning:/` still kept the raw line in
  `logTail` — precisely the ships-twice asymmetry `warningsFilter` exists to remove, on the warning
  a user is most likely to want filtered. The class is now `[\w.-]+`; the space before `Warning:`
  stays outside it, so a name can never swallow into it. `filterLog`'s no-filter output is
  unaffected, since `KEEP_PATTERNS` matches the literal word and never this regex.

- **Review fixes on `warningsFilter`, closed** (#75). The entry above claims `warningsFilter`
  "never filters errors" and "never filters a rerun hint" — both sentences were **false** when
  written, and true only after these two fixes. **`filterLog` filtered a line `parseLog` calls an
  error**: `parseLog` tests `FILE_LINE_ERROR` first and `continue`s, so
  `./main.tex:12: Package foo Warning: …` is an _error_ to it whatever its message says — but
  `ALWAYS_KEEP_PATTERNS` had `^!` and `Error:` and not `FILE_LINE_ERROR`, so the identical line was
  a filterable _warning_ to `filterLog`, and any `warningsFilter` cut the one line reporting the
  failure out of `logTail`. Fixed by adding `FILE_LINE_ERROR` to the always-keep list, mirroring
  `parseLog`'s own branch order — `warningRuleOf`'s doc already claimed `filterLog` could never
  derive a different answer than `parseLog` for the same line, an invariant this gap silently
  broke. Keep the two classifications one partition; do not let a future always-keep pattern drift
  from `parseLog`'s branch order again. **biblatex's rerun hint was filterable**: biblatex phrases
  it `Please (re)run Biber on the file:` — literal parentheses, which the existing `Please rerun`
  pattern never matched — so on a biblatex paper, the only line saying the bibliography is stale
  survived a no-op filter but not a real one. Fixed by adding a pattern for it, deliberately
  `logTail`-only: the structured `warnings[]` entry (rule `biblatex`) stays filterable, exactly as
  the `Label(s) may have changed` hint's own `warnings[]` entry already was. That asymmetry is
  intentional — do not "fix" it later by protecting the `warnings[]` entry too, since that would
  change `warningsOmitted`. The pattern has to stay narrow, not a bare substring match: the log is
  document-controlled — a `.tex` can emit anything via `\PackageWarning`/`\typeout` — so an
  unanchored `/\(re\)run/` let a document pin an arbitrary line (an `Overfull \hbox` that merely
  happens to contain the literal `(re)run`) past every caller's `warningsFilter`,
  indistinguishable from a real rerun hint. It is narrowed to `Please \(re\)run` instead. That does
  not make forgery impossible, and the entry should not claim it does: a document phrasing its line
  as `Please (re)run …` is by definition indistinguishable from biblatex's own hint, exactly as the
  neighbouring `Please rerun` and `may have changed` patterns already are. What the narrowing buys
  is the removal of the cheap, accidental case, and the residual is bounded to `logTail` verbosity —
  it never reaches `warnings[]`, `warningsOmitted`, an error classification, or a snippet-provenance
  decision. Both fixes are pinned by **hand-written cases only**. The differential corpus and its
  golden digest are deliberately blind to them: the digest never passes a `keepWarning` at all, and
  the self-comparison passes `() => true`, which keeps a line whichever side of the always-keep
  branch it falls on — so neither can observe an `ALWAYS_KEEP_PATTERNS` change. Do not retire a
  hand-written case here as redundant with the corpus; the corpus does not cover it.

- **`status` collapses sessions that exited holding nothing into a count** (#73). A session record
  under `<workspace>/.sessions/<projectId>/` is removed only on a clean shutdown
  (`SessionRegistry.release()` on SIGINT/SIGTERM/beforeExit), so every killed agent process leaves
  one behind forever and `activeSessions` grew without bound with sessions that own nothing and are
  never coming back. They are now reported as `staleSessions: N` instead of listed. The tempting fix
  — wiring up `SessionRegistry.collectGarbage()`, which exists and has never had a caller — is
  **deliberately not done**, and should stay undone from here: `status` is read-only and takes no
  lock, and `live` is _derived_ (a pid invisible across pid namespaces, plus a heartbeat that is
  treated as stale after 30 minutes — `STALE_MS`, not the 30-second `HEARTBEAT_THROTTLE_MS` that
  paces the writes), so an idle-but-alive peer can read as dead. Reaping its record while it races its own
  `record()` would destroy the ownership proof `commit scope: "paths"` and `push` refuse on — the
  exact guarantee the shadow store exists to make. An integration test asserts every session's
  `session.json` — and the `shadow.json` of each session that has one — is still on disk after a
  `status` call: the files, not merely the directory, since `release()` removes only the record and
  leaves the directory standing, so a
  directory-only assertion would let that shape of "cleanup" land quietly — and that a corrupt
  index is still corrupt, since "repairing" it would turn unreadable into "owns nothing".
  What is **not** collapsed matters as much as what is: a dead peer whose shadow index could not be
  **read** stays listed individually with `changes: null`, because `null` from `peerEntries` means
  unreadable and never "owns nothing" — counting it as change-free would assert the one thing this
  codebase refuses to infer. Records still accumulate on disk; only the report is bounded.

- **Crossref and OpenAlex as reference backends, behind a resolver — and a DBLP client that sniffs
  the body instead of trusting the status** (#72). `dblp.org` now sits behind an anti-bot
  proof-of-work wall which it serves with **HTTP 200** and an HTML body, so `res.ok` was true and
  `search_references` died inside `JSON.parse` with `Unexpected token '<'`, naming neither DBLP nor
  the cause; `add_citation` was dead the same way. Worse, `fetchBibtex`'s guard was "the body
  contains an `@`" and the interstitial carries `@licstart` in its JS-license header, so the bot
  page passed the one check that exists to keep a web page out of a `.bib` — the old test passed
  only because its fixture contained no `@`. Every backend now sniffs the payload
  (`assertApiBody`), checks the JSON _shape_ (`assertApiShape` — a 200 carrying an error envelope
  is a failure, not a silent zero-result), wraps transport failures (`fetchOrUnavailable`
  /`readBodyOrUnavailable`, covering a body that stalls after the headers arrive as well as a
  rejected fetch), and requires a real BibTeX entry header at a line start before any text reaches
  a bibliography — cut to the leading run of entries at both ends, so neither a proxy banner
  in front nor a `<script>` behind is appended, with an unbalanced body deliberately returned
  whole rather than truncated (a `@string` macro _preceding_ the first entry is cut with the
  rest of the preamble; one _between_ entries stays inside the span, since the entries after it
  need its macros — neither DBLP nor Crossref emits a leading one). One normalizer now serves both the key parser and
  `DblpService`, closing the last _copy_ of that boundary: the service's own normalizer stripped
  any host, so `fetchBibtex('https://evil.com/rec/conf/x/y')` yielded the DBLP key `conf/x/y` —
  unreachable through the resolver, which validates first, but one edit away from being
  reachable, and the only input on which the two copies disagreed. `ReferenceResolver` (`src/services/referenceResolver.ts`) chooses which service
  answers, on exactly the `CompilerResolver` rule — an unset `WEB_LATEX_MCP_REFERENCE_SOURCE` is a
  default that may be substituted (dblp → crossref → openalex) with the substitution reported in
  `hint`/`fallbackFrom`, never silently; the env var, or a per-call `source:` on
  `search_references`, is an _assertion_ and an unreachable backend is then an error rather than a
  quiet switch to a different bibliography. Only `BackendUnavailableError` substitutes: a search
  that succeeds with **zero hits is an answer** and is returned as-is, since falling through would
  turn "DBLP has never heard of this" into "here is what Crossref found instead". `fetchBibtex`
  routes by the **key**, never by the configured source, and substitutes nothing — a key names one
  record in one backend. Record keys are namespaced (`dblp:conf/cvpr/HeZRS16`,
  `crossref:10.1109/CVPR.2016.90`, `openalex:W2194775991`) and parsed in one pure module,
  `src/lib/referenceKey.ts`, whose validation is a security boundary — bare DBLP keys, bare DOIs
  and service URLs still parse, so every existing caller, doc and skill keeps working. **OpenAlex
  publishes no BibTeX at all**, verified against the live API, so its records are fetched from
  Crossref by DOI and a record with **no** DOI is refused rather than assembled from metadata:
  `OpenAlexService` has no `fetchBibtex`; the resolver's `DoiBackend` records that intent, and a
  runtime assertion in `test/unit/openalex.test.ts` is what actually pins the absence, since
  structural typing would admit a grown method.
  A value that names no backend at all is the third case: it neither throws at startup — which
  killed every tool in the server, `read_file` and `push` included, over a setting that governs
  one — nor falls back, which would answer from a bibliography the user did not name. It is
  reported by `server_info` and refuses the unpinned search alone, while a per-call `source:`
  still works and `fetchBibtex` is untouched. New `WEB_LATEX_MCP_CONTACT_EMAIL` opts into
  Crossref's and OpenAlex's polite pool — read only from
  that variable, never derived from `git config`, validated so it cannot alter a request URL or
  inject a header, and reported by `server_info` only as _whether_ one is set, never the address.
  `search_references` and `add_citation` now report which service answered (`source`, and `via`
  when OpenAlex was bridged through Crossref). The DBLP wall itself is upstream and unfixed: an
  unpinned lookup works today by substituting Crossref, but `source: "dblp"` still fails until
  DBLP exempts its API paths from the challenge.

- **Review fixes on the reference backends** (#74). Three defects found reviewing the entry above,
  each reproduced before it was fixed. **A malformed-but-well-enveloped HTTP 200 aborted the whole
  fallback chain**: `assertApiShape` validates the response _envelope_, and the mapping step then
  dereferenced each element unguarded, so `{"result":{"hits":{"hit":null}}}` from DBLP escaped as a
  raw `TypeError` — which the resolver rethrows by design — and Crossref was never tried, defeating
  the substitution this whole feature exists for. (`asArray` fed it: it returned `[null]` for a
  `null`, never `[]`.) Each mapper now converts an element-level throw to the same
  `BackendUnavailableError` path, structurally, so the guarantee holds for fields nobody has thought
  of yet; `hit: null` is refused explicitly rather than read as zero results, since an empty answer
  would stop the chain just as effectively. **`bibtexEntrySpan` could truncate an entry**, contrary
  to its own documented promise that it never returns fewer bytes than the service's entry: the
  `endsItsLine` guard caught only a stray closing delimiter _mid_-line, so one that happened to end
  its line was believed and the entry was cut in half (`abstract = {Sentence one} extra }`), and a
  paren-delimited entry tracked no braces at all, so a `)` inside a braced value cut it leaving a
  dangling `{` that would break every entry after it in the `.bib`. A closer is now believed only
  when it stands **alone on its line** and **outside the other delimiter pair**; both tests only
  ever fail _open_, and the doc block no longer claims more than the code delivers. **A lone `.`
  path segment silently fetched a different record**: `normalizeDblpKey`/`normalizeDoi` rejected
  `..` but not `.`, and WHATWG normalisation deletes such a segment from the request URL, so
  `dblp:conf/./x` fetched `conf/x` — the caller's identifier rewritten into a different, valid one,
  which is exactly what the URL route already refused and this module calls out as something a
  security boundary may not do. All three routes now judge dot segments the same way, per segment,
  so a dot _inside_ a segment (`10.1109/CVPR.2016.90`) is untouched. Plus docs: `CLAUDE.md` no
  longer credits `OpenAlexService` with a `fetchBibtex` it deliberately does not have (contradicting
  its own invariant 150 lines below), `docs/tools.md` documents the three reference fields
  `server_info` now returns, and the README no longer implies `add_citation` falls back between
  services — it routes by the key and substitutes nothing.

- **The review items deferred on the reference backends, closed** (#74). Five follow-ups from the
  same review, each one a case where the code was defensible but a reader could not tell.
  **A configured source that was not an assertion was ignored outright** rather than merely
  substitutable: `pin()` returns the env pin only when `explicit` is set, and nothing read
  `configured` afterwards, so it was neither a choice nor a default but a third thing. It is now
  tried **first** and still substitutable, which is the `CompilerResolver` rule this design says it
  follows — an unchosen `latexmk` is still the compiler that runs. Nothing observable changes today
  (`parseReferenceSource` never emits that combination), but the field stops being a trap for the
  next config path that sets a source without marking it chosen; the two tests that named this both
  used `dblp`, already first in the default order, so they passed under either behaviour and pinned
  neither. **A malformed `WEB_LATEX_MCP_CONTACT_EMAIL` was byte-identical to an unset one** in
  `server_info` — the polite pool silently off with nothing a tool could reach to explain it, the
  exact silent-failure shape `extraWritingGuideLoaded` exists to prevent and that this release
  already fixed for `referenceSourceInvalid`. A new `contactEmailInvalid` reports it as a
  **boolean and never the value**, deliberately unlike `referenceSourceInvalid`: that one carries
  the user's own typo of a backend id, this one would carry an email address into a model's
  context. **`search_references` promised a fallback that an invalid setting had disabled** — in
  its registered description _and_, two fields away, in the `source` field's own schema text, which
  a model reads while filling the call in. Both are now derived from the same config, so they
  cannot disagree, and both say plainly that an unpinned call is refused in that state.
  **The request timeout had no test at all**: every test injects a `fetch`, so the arm that
  attaches `AbortSignal.timeout` never ran, and deleting it left the suite green while the error
  text kept promising "timed out after 15s". The lint rule that guards the constant could not see
  that either, nor the hand-rolled `setTimeout(() => controller.abort(), …)` a contributor is
  likeliest to paste; both are covered now. And **a 404 naming a record is the backend answering,
  not the backend being down**, so it is a plain `Error` rather than the `BackendUnavailableError`
  whose own doc says it is never a caller error — messages unchanged, and a 404 on a _search_
  stays unavailable, since there it means a wrong path rather than a missing record. Harmless
  while `fetchBibtex` has no fallback; wrong the moment one is added, because a key names one
  record in one backend and there is nothing to substitute to.

- **The `push` conflict payload is bounded, in both channels, by one budget** (#68). A conflict on a
  single ~20k-character section file returned a 67,485-character result — past the client's tool-result
  cap, so it was never delivered to the model at all, and the documented way out (retry `push` with
  `resolutions`) became unreachable at ordinary section-file sizes. The three sides plus `hunks` were
  96.6% of it; the 3% a caller actually needs in order to _act_ — `remoteHead`, `mergeBase`,
  `conflictPaths`, `remoteCommits` — was buried underneath, including the very refs
  `read_file(path, ref)` needs, so the overflow disabled the documented alternative to itself. The text
  channel already elided a side over 12,000 characters, but `structuredContent.conflictFiles` was copied
  verbatim and wholly unbounded, and since the cap was per side per _file_ over an uncapped file loop, a
  ten-file conflict multiplied past any of it. Both channels now render from **one** plan
  (`src/lib/conflictBudget.ts`, a pure planner in the shape of `inlineBudget.ts`), so they cannot drift:
  `CONFLICT_SIDE_CAP` (12,000, the former `INLINE_CAP`, now single-source) caps any one **side** and
  `CONFLICT_CONTENT_BUDGET` (20,000) caps the payload **in total, across every file**. The budget is
  charged against **rendered** size, not raw content: the marker boilerplate around each hunk, each
  file's header and each side's label are named constants (`HUNK_MARKER_OVERHEAD` and friends), pinned
  by tests that fail if the render strings drift away from them — budgeting the content alone left a
  few hundred small hunks rendering ~64,000 characters while the plan called itself bounded. Two hard
  caps sit underneath for the shapes no per-item budget can bound: `CONFLICT_MAX_FILES` (20) limits how
  many files get a detailed block, and `CONFLICT_MAX_SPANS` (20) limits the line spans listed for an
  elided hunk block, since eliding hunks _to save space_ could otherwise emit a bigger payload than
  keeping them. A 250-file conflict used to render ~50,000 characters and report
  `conflictTruncated: false`; it is now ~8,000 and correctly flagged. **The top-level fields are never
  what gets cut**: `conflictPaths` lists every conflicted path however many there are, and
  `remoteHead`, `mergeBase`, `rebasedOnto` and `remoteCommits` always survive — burying those under the
  bulk was the original bug. What gets cut is
  ordered by what the caller can get back: `hunks` are allocated **first and cut last**, because once the
  rebase aborts the marker view is gone from the working tree, while a side is one
  `read_file(path, ref)` away — so an elided side carries the exact ref to fetch it and elided hunks
  carry their count and line spans. Where there is no merge base to fetch from at all (unrelated
  histories), the pointer says so in both channels rather than sending the caller to overlap markers
  that the same budget may just have elided — the two channels used to disagree on exactly that, one
  naming the missing merge base and the other pointing at markers not on screen. The reporter's
  proposal — `conflictDetail: "hunks"` dropping the
  sides by _default_ — was declined: docs/CONCURRENCY.md and CLAUDE.md both promise all three sides so an
  MCP-only client can resolve without a shell, and defaulting them off regresses the ordinary small
  conflict (three 2k sides, one round trip) to fix the rare large one. `conflictDetail: "full"` is the
  opt-in that lifts every cap instead. Because `null` on a side **already** means "absent — added or
  deleted on this side", an elided side is never left as a bare `null`: a per-file `elided` record says
  which parts were dropped and how big they were, and `conflictTruncated` reports it at the top level.
  `GitService` is untouched — it still builds the complete report, which is what `resolvePush`
  re-surfaces when a resolution is missing; the budget applies at the formatting boundary only. Also
  declined: accepting a resolution as a _path_ in the clone, since for a shell-less client the merged
  bytes cross the model once either way, and a merged file in the working tree is a tracked modification
  the rebase then refuses over. One correction to the report, since it changes the severity: Claude
  Desktop identifies as `claude-ai` and has `structuredContent` stripped at the transport
  (`src/lib/outputSchemaCompat.ts`), so it only ever received the already-elided text — the overflow is
  specific to clients that _keep_ structured output.
- **`project_sync` refuses a dirty-tree pull in this server's vocabulary, not git's** (#68). A pull over
  a locally modified tracked file returned git's stderr verbatim — _"Please commit your changes or stash
  them before you merge"_ — which prescribes `stash`, a command this server does not expose, and never
  mentions `commit` or `discard`, which it does. Of the two exits git offered, one does not exist here;
  on a client with no shell it cannot be reached at all. The tracked wording now has the typed
  `LocalChangesOverwriteError` that the untracked wording has had on `push` (`UntrackedOverwriteError`,
  which now carries a pull wording too — see the entry below), carrying
  the parsed paths and saying that nothing changed — `merge --ff-only` aborts cleanly, so HEAD did not
  move and the working tree is exactly as it was — then naming the exits this server actually has and
  stating plainly that git's `stash` advice is not available. Because the error knows exactly which
  paths collided, it prescribes them: `commit` with `scope: "paths"` and those paths, or `discard`
  scoped to those paths — not bare `scope: "all"` and not a bare `discard`, which reverts the whole
  working tree. That mirrors the sibling `UntrackedOverwriteError`, and for the same reason: following
  `scope: "all"` here would sweep a live peer's in-flight edits into this session's commit, while
  `scope: "paths"` fails closed on any path a live peer owns. The tool layer then attributes each
  remaining path to the live peer session whose shadow claims it, through the same `peerAttribution`
  helpers `push`'s refusal uses — but **subtracting this session's own paths first**, exactly as `push`
  does, since `livePeers` excludes self and an unfiltered list would report the caller's own edits as
  belonging to nobody. The closing advice is now the calling tool's own: `push` talks about rebasing and
  pushing again, `project_sync` about a refused pull — but **both compose it from the attribution**
  rather than each carrying a static paragraph, because the files they list fall into two groups needing
  **opposite** advice. A peer-owned file can only be taken with `scope: "all"`, since `scope: "paths"`
  refuses outright any path a live session's shadow lists — so the closing now says that, instead of
  offering `scope: "paths"` as a parenthetical alternative that would have bounced — and it retracts the
  scoped `discard` for that group too, since `discard` has no ownership guard and would destroy the
  owner's uncommitted work. A file **no** live
  session owns is the reverse: `scope: "paths"` naming just those paths is the better route, because it
  cannot sweep in a peer's lines the way `scope: "all"` would. A peer whose change index is unreadable
  is advised as an owner, not as unowned — the advice fails closed exactly as the refusal does. Sharing
  one composer is the point rather than a tidy-up: which route works is decided by `commit`'s peer
  guard, so two tools wording it independently is two chances to drift out of step with that guard —
  which is exactly what had happened, `project_sync` still offering `scope: "paths"` first for files a
  peer may own. Both refusals share one
  indented-path-list parser, differing only in the opening line they key on, and the two regexes are
  written so they can never cross-fire — they lead to different fixes. Deliberately implemented as a
  translation of git's refusal **after** it happens rather than a working-tree pre-check: `merge
--ff-only` succeeds over a dirty tree whenever the incoming commits do not touch the dirty files, and a
  status-based gate would refuse pulls git would happily perform. ff-only stays ff-only, and `--autostash`
  stays rejected for the reason already recorded for `push`: a pop is an automatic merge of somebody's
  uncommitted lines, and a pop conflict leaves markers behind.

- **An untracked file blocking a pull is refused in server terms too** (#68 follow-up). `syncPull`
  translated only git's _tracked_ refusal; its sibling — an incoming commit adding a file that already
  sits untracked in the clone — still came back as git's own _"Please move or remove them before you
  merge"_, naming no tool. `UntrackedOverwriteError` now carries an `operation` (`push`, the unchanged
  default, or `pull`), and `syncPull` throws the pull wording: nothing changed (`merge --ff-only`
  aborts cleanly), the exits are `commit` with `scope: "paths"` **then `push`** — the rebase a push
  performs is what surfaces a proper add/add conflict, where a plain sync after committing would only
  report the histories as diverged — or `discard` with `paths` (which runs `clean -f` over an untracked
  name), and every path list in both wordings is capped at the shared `REFUSAL_PATH_CAP`, with the
  same "first N of M — `status` lists them all" note the tracked message carries. `project_sync`
  attributes its paths to live peers exactly as it does the tracked ones, since a peer's `write_file`
  of a new file puts that file in the peer's shadow.
- **The conflict result's `remoteCommits` is bounded too, and text and structured come from one plan
  object.** The per-file payload was budgeted but `structuredContent.remoteCommits` was passed through
  verbatim, uncapped in commits and in each commit's file list: 60 conflicted files under 12 upstream
  commits of 20 files each rendered 80,440 characters — more than the 67k that motivated the budget —
  with `remoteCommits` 38% of the JSON and `conflictTruncated: true` claiming the job done. On a
  conflict it is now capped at `CONFLICT_MAX_COMMITS` (20) commits of `CONFLICT_MAX_COMMIT_FILES` (5)
  files, the caps the text channel already applied, with `remoteCommitsOmitted` and a per-commit
  `filesOmitted` counting what was cut; the text's "… N more commit(s)" pointer sends the caller to
  `status.behindCommits` — uncapped, and the same list once the rebase has aborted — instead of to a
  `structuredContent` that no longer holds it. `rebasedOver` on a successful push and `status`'s own
  commit lists stay uncapped, so their pointer stays true. `conflictDetail: "full"` lifts this cap
  with the others. `push` now plans the per-file payload once and hands that one object to both
  renderers, which assert the plan and report line up file by file, so "same plan" holds by
  construction rather than by two deterministic calls; and when the mandatory per-file headers alone
  exhaust the budget (very long paths), the `note` names that first instead of blaming the aggregate
  cap.
- **`project_sync` takes the per-project lock.** It cloned and fast-forward-pulled outside
  `runExclusive`, so a peer session's `write_file` or `commit` could interleave with the pull. The lock
  file lives outside the clone (`<workspace>/.sessions/<id>/project.lock`), so a first clone takes it
  too. The cost is the lock's own: a peer waiting on the file lock gives up after 30 s, so a sync that
  fetches for longer than that now costs a concurrent peer one refused write, where before the two
  interleaved silently — the trade the lock exists to make. Both refusals from a pull now route the
  caller forward correctly: after a local commit a plain sync would only report the histories as
  diverged, so the composed closing and the typed refusals say `push`, and reserve "the next sync
  succeeds" for the `discard` route. The peer-refusal logic both `push` and `project_sync` run — the live-peer guard and the
  attribution appended to a refused pull — moved out of the tool layer into `src/lib/peerRefusal.ts`,
  unchanged in behaviour.
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
- **`compile` says whether it actually rebuilt, and how long it waited for the lock** (#60). The
  build dir is stable per project path and shared by every session on a clone, so right after a peer
  compiled, latexmk finds nothing to do and `compile` returns `success: true` in 0.08 s with the peer's
  PDF — indistinguishable from a rebuild from your own edits. The result now carries `rebuilt` (the
  build-dir PDF's mtime or size changed between just before and just after the run — never parsed
  from backend stdout, which is discarded once a `.log` exists and which tectonic does not emit, and
  never from the wall clock), `pdfMtime` (read from the build output before the surfacing copy, whose
  mtime is fresh on every call), `lockWaitSec` (`durationSec` still measures the backend run alone) and
  `lockHeldBy` — the session that held the lock, which `LockTimeoutError` already named but only after
  the 30 s timeout. The lock reports more and acquires exactly as before; `withFileLock` and
  `runExclusive` hand the acquisition to their callback, which every other caller ignores.
  `pdfMtime` rounds the stat's fractional milliseconds rather than truncating them (an mtime set to
  an exact millisecond read back one ms early on CI). `lockWaitSec` covers both layers: a second call in the same process waits on the in-process mutex
  first, and that wait is counted too, with `lockHeldBy` naming this session.

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

- **A `render_pages` tool, and `pageCount` on `compile`** — the model could not see what it compiled.
  `compile` returned a log and a PDF path; `viewer` served a pdf.js page for a _human_. Neither put pixels
  where the model could read them, so every visual question had to be answered outside the server — in the
  session this came from, a 140x100cm poster, by installing PyMuPDF and rasterizing by hand six times, which
  moved the whole compile-look-fix loop into the shell and lost the structured error payload on the way.
  `render_pages` rasterizes the last compiled PDF to PNG and returns the images inlined **and** as written
  paths — inlined up to a 5 MB budget on the base64-encoded payload, after which the tail comes back as paths
  only and says so, rather than as a hole in the middle of the page range; a single page too big to inline is
  told what to do about it. At most 8 pages per call, the rest reported in `skippedPages`. It takes `pages`, a
  `clip` rectangle in page fractions, and two sizing knobs: `maxEdgePx` (default 1600)
  fits the returned image to a token-sane size, while `dpi` sets the resolution directly and wins — the precise
  path being to clip one column and ask for 150 dpi. Both are bounded by a 4000px hard cap, and a request that
  reaches it says so (`clamped`) and reports the resolution actually used. Read-only over the last build: it
  never compiles. It takes `runExclusive` despite being read-only _with respect to the project_, because it
  reads the build-dir PDF a peer session's `compile` can rewrite mid-read and writes its PNGs into that same
  build dir — never inside the project, since a `local` project is edited in place, not littered in place.
  Both need the native canvas backend `@napi-rs/canvas`, now declared as an **optional** dependency and reported
  by `doctor` (`pdf-render`). The page count needs it as much as the rasterizing does — pdf.js reaches for DOM
  geometry globals in Node and it is this backend that supplies them, so without it pdf.js cannot open a PDF at
  all; that failure is reported as the missing backend rather than as a broken document. The check is a
  _warning_ and never a failure, because nothing else the server does — compiling, the viewer, editing, the
  whole git side — needs it. The cheap half is `compile`'s new `pageCount`, read from the PDF rather than the
  log: a layout that spilled onto a second page is neither an error nor a warning in TeX's eyes, so one number
  is the only thing that reports it — and the log's own `Output written on … (N pages` line is hard-wrapped at
  79 columns, which is a second reason not to parse it. A count that cannot be read never fails a compile that produced a
  document.

- **Two new skills — `proofread-document` and `review-writing-guide` — and three Claude Code commands that
  parallelize them.** The typo hunter and the guide reviewer existed only as a `.claude/` command and agent, which
  meant they existed only in Claude Code: Claude Desktop and every other MCP client got no proofreading procedure at
  all, and no writing review — not a degraded one, none, since `.claude/commands` and subagents are a Claude Code
  mechanism and the server advertises only `.claude/skills`. Both are now skills, so they ship as MCP prompts and
  through `list_skills` like the other five, each with a single-agent workflow that stands on its own.
  `proofread-document` reports typos as exact minimal substitutions and applies nothing until asked, with the hard
  rule that a sentence you would have phrased differently is not a typo. `review-writing-guide` reviews against
  [`docs/writing-guide.md`](docs/writing-guide.md) — which already reaches every client as the server's own
  instructions, so the guide stays the authority and the skill only says how to review against it — and writes
  nothing whatsoever, not even a report file: it proposes, and the author disposes. Alongside them,
  `/format-latex`, `/hunt-typo` and `/review-writing` fan the per-file reading out across one subagent per file
  (`formatter` and `corrector` on sonnet, `writing-reviewer` on opus with a `--sonnet` override), which is cheaper
  and parallel. The commands and agents **fetch their rules from the skill through `list_skills` at run time**
  rather than restating them, and stop rather than improvise if that call fails — a paraphrased rule is a wrong
  rule, and two copies of a taxonomy drift the first time one is edited. What stays in each command is only what a
  skill cannot say: which part is serial (splitting one main file has nothing to parallelize), which findings need
  more than one file to see (an acronym defined twice, a float never referenced) and so cannot be delegated to a
  single-file agent, and how the fan-out is batched. Contributor tooling under `.claude/` throughout: no tool, no
  runtime behaviour, and nothing in `src/` changed.

- **A `/review` command** — the review half of `review-round`, driven by hand instead of by a
  workflow script, so it costs a session rather than a fleet and reports before it touches
  anything. It scopes the target itself (a PR number through `gh`, a branch, or the working tree),
  resolving the base as the PR's own base and otherwise `origin/dev` — the integration branch —
  rather than `main`, and groups the touched files by the risk they carry here: the
  `src/services`/`src/lib` core, the `src/tools` + `src/server.ts` surface, the `context.ts` /
  `config.ts` wiring, skills and prompts, tests, docs. Then it runs the one gate this repo has
  (`typecheck` + `lint` + `format:check` + `test`) **itself** before delegating, because a green a
  subagent reports is not evidence, and it reads the skip count rather than the pass line — the
  TeX smokes auto-skip wherever `latexmk` is absent, so a green `npm test` over compile-adjacent
  code is a vacuous pass, which is the failure mode the whole review exists to catch. The review
  goes to the existing `plan-verifier` agent (there is no separate reviewer agent here, and one
  more agent restating the same invariants is one more copy to drift), with the stated intent as
  the spec and the CLAUDE.md guards the diff comes near named outright. Report-only by default:
  the implement/verify loop runs only under `--fix`, capped at three rounds, and a finding that is
  really the author's call — a design disagreement, a scope question — is reported and never
  "fixed". Posting the verdict to the PR and pushing the fixes are two separate steps, each gated
  on an explicit go, which is the deliberate difference from the workflow's unattended commit.
  Adapted from a sibling repo: the shape carried over, every rule was rewritten for this one.
  Contributor tooling under `.claude/`; no tool, no runtime behaviour, nothing in `src/`.

- **A `review-round` workflow and the two agents it drives** — contributor tooling under
  `.claude/`, which changes nothing about the server itself: no tool, no runtime behaviour. The
  workflow performs one review round end to end: by default an adversarial reviewer produces the
  round itself against the current branch's diff (a posted PR review-comment URL can be supplied to
  fix an existing round instead), then a planner batches every finding and cleanup
  item into 1–4 self-contained specs ordered so an earlier batch cannot invalidate a later one, an
  `implementer` agent fixes each batch test-first, a `plan-verifier` agent tries adversarially to
  refute it and sends rework back (up to `max_attempts`), and a final auditor reads the whole diff for
  the cross-batch interactions no per-batch reviewer could see, syncs with the remote, runs the gate,
  and commits only when every batch was approved. Adapted from a sibling repo, so what carried over is
  the shape and what was rewritten is every rule: the agents encode _this_ repo's invariants (thin tool
  layer over services, stdout as the JSON-RPC channel, and the guards — `requireGitProject`,
  `runExclusive`, `confirmBibEdit`, `recordBaseline`, symlink resolution, ff-only pull, a
  shadow-store `conflicted` flag that stays flagged, snippets only for log-vouched locations) as
  things a verifier hunts for having been weakened. The vacuous-pass mode they are built to catch is
  this repo's own: `test/smoke/**` auto-skips wherever `latexmk` is absent, so a green `npm test` is
  never accepted as coverage of compile-adjacent code, and `typecheck` is run for the tests the build
  excludes.
- **An `/implement` command** — orchestrates a request the same way by hand: the session writes the
  spec (files, invariants, tests-first with a case just outside every new guard, and the right test
  tier), delegates each bounded task to the `implementer` agent, verifies the assembled diff with
  `plan-verifier`, and proves the work with the one gate this repo has: the local CI
  (`typecheck` + `lint` + `format:check` + `test`) passing.
- **An `/implement-issue` command** — `/implement` assumes the request is worth building because I
  wrote it; an issue or a saved feedback report is written by someone else, so this one triages before
  it builds. It loads the source verbatim (a `gh issue view` including the **comments**, since a
  maintainer reply often narrows or kills the ask; or a markdown file, each issue block in a saved
  feedback report being its own candidate), delegates the judgment to a single agent whose model is
  picked by `--triage-model` (fable or opus, fable by default, and the run says which one ran). It
  separates the observed problem from
  the proposed solution (the proposal being the half more often wrong) and checks the claim against the
  tree with files and lines named, since the behaviour may already exist, may have been fixed since the
  reporter's version, may be a CLAUDE.md guard working as designed, or may be a docs fix rather than a
  code one. The agent advises; the session forms its own call and says where it disagrees. Then it
  **stops**: a building / discarding / deviating / open-questions report, and no `implementer` is
  launched and no file edited until I approve it — an empty accept list being a valid outcome, stated
  outright so a run cannot manufacture work to justify itself. After approval it is `/implement`'s
  pipeline, with the issue's words treated as evidence rather than as a spec, and a close that drafts
  (never posts) the reply owed to the reporter, discarded parts included.

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

### Changed

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

- **The warning judge moves out of the tool layer, and the two channels can no longer be handed
  different predicates** (#78, finding 1). `compile` composed
  `withoutUnopenableLocation ∘ warningMatches` inline in `src/tools/compile.ts` — the load-bearing
  invariant of the whole `warningsFilter` feature, and the one thing stopping a `file` filter that
  names a symlink-escaping path from emptying `warnings[]` while leaving that very warning sitting
  in `logTail`. It lived exactly where CLAUDE.md says logic must not: in a tool, unreachable from a
  unit test, so the composition was pinned only indirectly — through an integration test driving a
  real MCP client over a stub compiler. It is now `makeWarningJudge(withheld, filter)` in
  `src/lib/warningFilter.ts`, and the unit layer asserts directly what the integration test could
  only imply: a withheld path is judged on the `file` the caller actually sees (`undefined`), not
  the log's original. With it, a case just outside every clause (a fileless warning against a
  `file` filter, a rule-less one against `excludeRule`) and one for the predicate's idempotence —
  a single judge, asked about the structured side's already-stripped candidate and about the tail
  side's paren-stack candidate still carrying the real path, must answer the same, since that
  equality is what "both channels or neither" means.

  The factory returns **`undefined`** when the filter constrains nothing, deliberately, rather than
  an always-true predicate. That is the part to keep: `compile` used to carry a separate
  `filterEmpty` boolean beside the judge, so "skip the machinery — and, in `filterLog`, the
  paren-stack bookkeeping — entirely" was a second derived value that could drift from the
  predicate it was meant to match. Now there is one value and both channels branch on it. Claim no
  more than that: the emptiness decision can no longer disagree with the judge, but `compile` still
  branches on that one value twice, once per channel, so a one-sided edit remains possible and
  remains something to review for — the doc comment on `makeWarningJudge` says so in those words
  rather than advertising a guarantee the shape does not give. No behaviour change:
  `test/integration/compileWarningsFilter.test.ts` is untouched and still green, and that is the
  proof.

- **`SessionRegistry`'s lifecycle methods are covered, and one of the tests found that `touch()`'s
  statement order is load-bearing** (#78, item 2's neighbours). The boot-scoping fix landed with
  `peers()` well covered and the rest of the class barely touched, so this closes the gaps around it:
  `release()` (removes the record **only** — a sibling `shadow.json` and `shadow/<rel>` come back
  byte-identical, and a release for a project with no directory at all resolves rather than
  rejecting, which is what the shutdown loop in `index.ts` leans on), `trackedProjects()` (shutdown
  releases exactly what it returns, and the heartbeat throttle is keyed per project — a shared one
  would starve a project's heartbeat, and a starved heartbeat is the fail-open direction: a live
  session reads dead to its peers), corrupt and absent records, `peers()` sort order, and
  `collectGarbage()`.

  Two of those are worth stating as guarantees rather than as tests. **`collectGarbage()` must never
  reap a directory whose record it could not read**: an unreadable record means UNREADABLE, never
  "owns nothing" — the same fail-closed reading `attributePeers`/`isStalePeer` use for a `null`
  shadow index — and reaping one would delete a shadow index that `commit scope: "paths"` and `push`
  refuse on, turning a visible refusal into vanished evidence. And it **must reap the whole
  directory**, not just the record: narrowing that `rm` fails closed (it leaks a dead session's
  shadow bytes rather than destroying a live peer's proof) but leaks _silently_, since `peers()` goes
  on reporting nothing for the directory.

  The find: inside `touch()`, the synchronous `lastHeartbeat.set` **before the first `await`** is what
  makes the throttle dedupe _concurrent_ callers and not merely sequential ones. `writeAtomic` names
  its temp file `${target}.${process.pid}.tmp` — unique per process, not per call — so two touches
  racing on one project fight over one temp file, the first `rename` consumes it, and the rest reject
  with `ENOENT`. `touch()` is uncaught at three of its four call sites (`status`, `commit`, `push`),
  so that is a hard tool failure out of a registry whose whole contract is that "a missing or stale
  registry only ever costs visibility". The race is reachable: `status` takes no `runExclusive` lock,
  so it can be in flight against a `commit` on the same project in one process. A test now pins the
  ordering. Making `writeAtomic`'s temp name unique per call is the real repair and is deliberately
  **not** done here — it is a source change, and this entry is the record that it is owed.

- **Every path list in the peer refusal is bounded, and the message says where the whole one is**
  (#68). `push` and `project_sync` refuse while a live peer session has in-flight work, and the
  refusal names the disputed files three times over: the header's full list, each live session's
  `owns`, and the files no live session owns. Only the closing paragraph's copy was capped, so a tree
  with hundreds of dirty files rendered three long lists — and the _same_ `unowned` list came back
  capped in one paragraph and uncapped in the one above it, which is incoherent on its face. All four
  now cap at one exported `REFUSAL_PATH_CAP` (20, the house value already used by `capList` in
  `GitService` and by `CONFLICT_MAX_FILES`), single-source for the same reason the closing itself
  became a shared composer: four independently chosen cap values would be the same drift one level
  down. Capping here costs more than capping the conflict payload did, and the entry is worth reading
  for that reason: this refusal is an `Error`, and `errorResult` returns text with **no**
  `structuredContent`, so a dropped path is dropped from the response entirely rather than merely
  from one of two channels. What makes that acceptable is that `status` already carries the complete
  lists on purpose — its `otherChanges` is built exactly as `push` builds the disputed set, and its
  `activeSessions[].changes` is whole even though its own _text_ shows five paths per peer. The
  message names them when, and only when, a cap actually fired; never otherwise, since announcing a
  cap that did not fire is the same false statement about a payload that `conflictBudget`'s `note`
  rule exists to prevent. It names them as a **derivation**, not as two fields to go read, and that
  distinction is the whole point: `status` has no `unowned`-shaped field, and `otherChanges` is the
  _whole_ disputed set — peer-owned files included — so a caller who fed it to `commit scope:
"paths"`, as the closing directs for unowned files, would hit the live-peer guard and lose the
  entire call. The pointer therefore spells out that the unowned set is `otherChanges` minus every
  live session's `changes`, with a null `changes` claiming everything. Naming a field that bounces
  off the guard one tool over is the exact failure the shared `composeClosing` above was written to
  end; it would have been re-introduced here, one layer down, by a pointer that merely sounded
  helpful. For the same reason the line claims the _weaker_ thing — that `status` names every path
  the lists omit, among more besides — rather than that it reports these lists back: that identity
  holds for `push`, whose disputed set is built exactly as `otherChanges` is, but not for
  `project_sync`, which renders the same line over the paths an incoming commit would overwrite,
  tracked or untracked, a strict subset no `status` field reproduces. One message shared by two tools may only
  assert what is true for both, which is the same discipline the shared closing imposed. The unreadable-peer line still lists no paths at
  all — that peer is treated as owning everything precisely because it might own anything, and
  printing a concrete list would read as a claim about which.

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
- **`session-feedback` grades the evidence behind each finding** (#68). The skill already told a
  shell-less session how to fill the environment block, but said nothing about step 2, _Reconstruct the
  session_ — and that is the step where the shell decides whether a finding is _correct_, not merely
  present. The report that prompted this change was written from a compacted conversation, and its
  headline finding came out wrong about **which side of the call failed**: recalled as the `resolutions`
  request being unwieldy, when the defect was the conflict response never being delivered. Those have
  different fixes, and the recalled version would have been filed with no less confidence. Step 2 now
  says to grade every finding's evidence as **observed** (the call and its result are still visible) or
  **recalled** (rebuilt from memory or from a compaction summary), to stamp a recalled finding's issue
  block `_unverified — reconstructed from recollection_`, and to say in the chat summary that the session
  was reconstructed without a re-readable transcript — the same way the environment block already states
  what it could not measure. Compaction is called out alongside the no-shell case rather than folded into
  it, because a compaction summary is the same lossy recollection **even with a shell sitting right
  there**. One deviation from what the report asked for: ranking stays **by impact**, with the evidence
  grade as an annotation rather than a reordering. Dropping or demoting a high-impact finding for being
  recalled loses it outright, which costs more than a flagged claim a maintainer has to double-check.
- **`render_pages` says how to measure below a point.** The same report asked for a vector-geometry tool
  partly on the premise that "at 150 dpi a point is ~2 px" — too coarse to match two table heights. `dpi`
  already accepts up to 1200, bounded by the 4000px cap on the clipped edge, so a narrow clipped band
  resolves at roughly 16.7 px/pt; the tool's description now says so. The tool itself is not built — see
  [#73](https://github.com/elias-ramzi/WebLatexMCP/issues/73) — but the premise it rested on was
  already false.

- **`ASSET_EXT` (moved into `src/lib/assets.ts` for `add_asset`) now also recognizes `.tif` and
  `.ico`, gained along with the move.** Since that set also drives `list_files`'s `assets`
  classification and `read_file`'s binary-file refusal, a `.tif` or `.ico` that previously read as
  text through `read_file` now returns a path note instead, the same as every other asset type.

- **A regression test that passes before its fix is now a finding, not a footnote.** The `implementer`
  agent already had to watch each new test fail on the pre-fix code and report the result, and it did —
  during the review of #52 it said plainly that two of three new tests passed pre-fix, because the `- `
  bullet prefix in front of them already satisfied their regexes. Nothing said what to _do_ with that
  disclosure, so it was read as a status line and passed upward; the vacuous tests were caught two steps
  later by `plan-verifier`. The agent's brief now closes that loop — such a test is rewritten until it
  fails for the right reason, or deleted, and never reported as covered — and `/review` step 3 treats an
  implementer's "passed pre-fix" as a confirmed finding to send back in the same round. A test that
  passes before the fix cannot catch the bug returning, and is also evidence the fix may be aimed at the
  wrong thing, which is the easier signal to skim past. No extra verification round was added: the
  existing one worked, catching both these tests and a TOCTOU race that a fix had itself introduced.

- **The `session-feedback` skill saves its report itself when there is no way to file it.** The report
  was always optional to write, which is right when `gh` can file the findings and wrong when it
  cannot: with `gh` missing or merely logged out, the blocks existed only in the transcript and died
  with the session. The skill now checks `gh auth status` before printing and, on a non-zero exit,
  writes the summary and every issue block to `.claude/session_feedbacks/web-latex-mcp-feedback-<date>.md`
  without asking (appending under a timestamped heading rather than overwriting a report I have not
  filed yet), says why it went there, and names `gh auth login` as the one command that unblocks
  filing. Authenticated, nothing changes: the file stays offered, not written. The same exit code now
  gates the known-issues search, too — an installed-but-logged-out `gh` fails it with an auth error,
  which is not "nothing found", so it counts as skipped and the confirmation checkbox stays unticked.
  The directory ships with its own `.gitignore` (`*`, `!.gitignore`) so a report is never committed,
  and the skill writes those same two lines wherever else it creates the directory.

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

### Fixed

- **A reused pid no longer keeps a dead session `live` forever** (#78). `SessionRegistry` derives
  liveness rather than trusting it — a crashed session cannot retract its record — and a peer counted
  as live if its recorded pid still named a running process **or** its heartbeat was inside the
  30-minute staleness window. The second clause is a bounded grace, and deliberately so: a session
  heartbeats from `status`, `commit` and `push`, and from the mutation recorder on every server-side
  write, so anything actually _doing_ work stays fresh — but a session that is merely idle, waiting
  on its user or reading, is still perfectly real and still deserves protection. That is why the pid
  clause cannot simply be tightened into `pidAlive && age < some outer bound`: it would trade this
  spurious refusal for the far worse failure of sweeping a live peer's uncommitted lines. The first clause was the only unbounded
  route to `live`, and a pid is unique only within one boot. On a workspace that survives a reboot —
  which is the normal case, since `.sessions/` lives beside the clones — a dead session's recorded pid
  can be handed to an unrelated process, and `pidAlive` then answered true indefinitely. The record
  never aged into the `staleSessions` count added alongside it, and `guardPeerWork` refuses while any
  live peer exists **whatever that peer owns** — it is owner-aware only about how it _words_ the
  refusal, not about whether to refuse at all. So a ghost holding nothing blocked every `push` made
  while the tree carried a dirty path this session had not itself recorded, permanently, naming a
  session that did not exist. That last condition sounds like it narrows the blast radius and mostly
  does not: the dead session's own abandoned edits are still sitting in the working tree, owned by
  nobody now, and they are precisely such paths. There was no way out through the tools: `status` would not collapse it,
  `collectGarbage` is deliberately never called from a read-only path, and the only cure was deleting
  a JSON file by hand — which a user would have to read the source to know about. Each record is now
  stamped with the boot it was written in (`bootedAt`, derived in the new `src/lib/bootIdentity.ts`
  from `os.uptime()`), and the pid clause counts only when that stamp matches the current boot, so
  every route to `live` is bounded again unless the process genuinely still exists. Three things worth
  keeping straight. The stamp is **approximate** — second-resolution uptime, and a clock NTP can step
  — so the comparison carries a generous tolerance, biased on purpose toward "same boot": calling two
  boots one merely leaves the old behaviour in place, a spurious refusal, which is the safe way to be
  wrong, while calling one boot two would revoke a live session's pid grant and let its uncommitted
  work read as owned by nobody, which is the direction this codebase does not fall in. `os.uptime()`
  counts suspended time on all three supported platforms, so a sleeping laptop is not a reboot. And a
  record with **no** stamp — written by an older build — earns no pid grant _from the stamp_: the
  stamp is what makes a pid meaningful, and without it reuse cannot be told from the original, which
  is the whole defect. Its one remaining way into the pid clause is the clock-free route described
  below — a `heartbeatAt` at or after this process's own start — together with the bounded 24-hour
  grace described at the end of this entry, which grants a stampless record the pid clause on the pid
  alone once it has gone quiet. A ghost already sitting on disk clears itself when that grace expires
  instead of needing the hand deletion. That second route is doing real
  work here rather than tidying up after the first: a stampless record exists _because its owning
  process runs the old build_ — and that process will never write a `bootedAt` however often it
  heartbeats, since Node does not hot-reload. Denying it the pid clause outright would strand a
  still-running old-build session: idle past the staleness window with uncommitted work, it would read
  dead to a new-build peer, whose `commit scope: "paths"` would then take its lines. So the pid grant
  has a second, independent route, which rescues such a session **for as long as it goes on
  heartbeating after the judging process started** — once it has been quiet longer than that, the
  bounded grace at the end of this entry takes over — and which also repairs a worse problem of the
  same shape.

  A derived stamp is only as good as the clock it is derived from, and this is where the first cut of
  the fix was itself unsafe. `Date.now() - os.uptime() * 1000` drifts whenever the wall clock is
  stepped without uptime advancing, and the drift accumulates over the whole life of a boot rather
  than being sampling noise at write time. On the WSL2 machine this was developed on, the derived
  instant had already moved 4m32s — about 90% of the tolerance — inside a single boot, and a laptop
  sleeping overnight steps it by hours. That is the fail-open direction: a genuinely alive peer
  holding uncommitted edits would lose its stamp match _and_ have a stale heartbeat, both clauses
  dying together, and `commit scope: "paths"` would stop refusing its files. Before the fix,
  `pidAlive` protected it. So the pid clause has a second route that does not depend on the clock at
  all: a record whose `heartbeatAt` is at or after **this process's own start** was necessarily
  written during the current boot, because a reboot would have killed us. That proof is immune to
  drift — a clock step changes future readings, not the two past readings being compared — and it is
  what rescues both the drifted live peer and the old-build session above, in each case only from the
  moment they heartbeat again after we start. It is a supplement, never a replacement: it can only
  vouch for records written since we started, so a peer older than this process still needs its stamp
  — and a peer that clears neither is a residual, stated below.

  Three residuals, stated rather than claimed away, and one that a review turned from a residual
  into a fix. Pid reuse **within** one boot (wraparound) is
  still not detected; telling it apart needs the OS's per-process start time, which has no portable
  source across the three platforms. A **clock step** can still strand a live peer, and what decides
  that is not when either process started relative to the step: `isSameBoot` compares the stamp the
  peer derived at its last heartbeat against the one we derive now, so the quantity that matters is
  the drift accumulated **between that heartbeat and the `peers()` call judging it**. A step landing
  anywhere inside that span pushes the two stamps past the tolerance — including a step that happens
  well after the judging process started, so long as the peer's last heartbeat predates our module
  load, which is precisely when `writtenSinceProcessStart` cannot vouch for it either. A
  still-running **old-build** session was stranded by the same shape with no clock step at all, and
  it was the most reachable of these: its pid is genuinely alive, its record carries no `bootedAt` to
  match (and never will — Node does not hot-reload), and once its last heartbeat was older than both
  the staleness window and our own start, the clock-free route could not speak for it either, so it
  read dead. That is the ordinary upgrade window, because heartbeats come only from `status`,
  `commit`, `push` and the mutation recorder, and an agent session waiting on its user goes quiet for
  exactly that long — and it failed **open**: `guardPeerWork` saw no live peer, so a `push` carrying
  a `message` (`git add -A`) or a `commit scope: "paths"` could take that session's uncommitted
  lines. That one is now bounded away rather than merely listed — narrowed, not eliminated: a record
  with **no** stamp keeps its pid grant on
  the strength of the pid alone for a bounded `LEGACY_PID_GRACE_MS` (24h), long enough to cover a
  session left open overnight. The bound is the point — an unbounded pid clause is the defect this
  whole entry is about — so a genuine legacy ghost whose pid has been reused still clears itself
  within a day instead of needing a hand-deleted file, and a stampless session idle for longer than
  that does still read dead, by design. The grace deliberately does **not** extend to a record whose
  stamp merely drifted: that record has a stamp and the stamp says another boot, so granting it
  anyway would override evidence rather than act in its absence, and would re-grant the boot-reused
  ghost for a day. And in
  **containers** the two routes part company, in whichever direction the runtime chooses. Under a
  plain runtime `/proc/uptime` is the host's and is not namespaced, so two sessions in separate
  containers derive the same stamp while their pids come from different namespaces where low pids
  always exist — `pidAlive` false-positives survive there, fail-closed, the same family as
  wraparound. Under **LXCFS or gVisor**, though, `/proc/uptime` _is_ virtualised per container, and
  that flips the residual over: each container derives a different stamp, so an idle peer in another
  container matches neither route and reads dead — fail-open, the shape the old-build session used to
  have. The legacy grace does not reach that one either: those records carry a stamp, it is simply
  the wrong host's. The registry is a single-machine mechanism; a workspace on a network
  share shared between two machines was never something a pid could speak to.

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
- **Every by-name comparison in `commit`, `push` and `status` that decides what is staged, owned,
  settled or reported now folds case where git does — the peer-ownership check included**
  (#67 "Known, not fixed"). `commit` scope `"paths"`'s peer-ownership check and `push`'s peer
  attribution compared shadow index keys byte-for-byte, so on a `core.ignorecase` clone (git's
  default on macOS/Windows) a live peer's `Notes.txt` entry did not protect a request naming
  `notes.txt` — `git add` staged the peer's lines under this session's name — and a push refusal
  attributed git's `Notes.txt` to nobody. `coversPath`/`peerOwnership`/`attributePeers` take an
  optional fold; the tools pass git's own ASCII fold (`src/lib/caseFold.ts`, the one home of
  `foldCase` and the exact-first `canonicalNames` lookup) exactly when `GitService.isCaseInsensitive`
  says so, and stay byte-exact otherwise. On the same configuration: a case-spelled path through
  `scope: "paths"`/`"all"` with `paths` (deleting a tracked `Notes.txt` and naming `notes.txt`) is
  resolved to the index's spelling before `git add` instead of surfacing git's raw "did not match
  any files"; a new file under a case-differing tracked directory (`sub/new.tex` while HEAD has
  `Sub/`) stages under the tracked directory's spelling instead of creating a second, case-differing
  directory in the tree; and a session that writes both spellings of one file gets one shadow entry (the store folds the
  second key onto the first, since on that filesystem `shadow/notes.txt` _is_ `shadow/Notes.txt`
  and a second entry used to overwrite the first's shadow with HEAD's bytes, so the commit found
  nothing staged); an index that still spells one file two ways is refused by name before
  anything is staged, where the second spelling used to win silently. Each fold has its
  `core.ignorecase=false` twin test proving the comparison stays byte-exact there.
- **`resolvePush` aborts the rebase when the priming step itself fails; `commit` and `discard` never
  surface git's "did not match" for a path that matches nothing** (#67 review deferrals). The
  `pull --rebase` that opens a resolution ran outside the loop's try/catch, so a spawn failure while
  listing the unmerged paths left the clone mid-rebase; it aborts first now. `commit` with `paths`
  refuses, in server words, any path that is neither on disk nor tracked, before `git add` sees it.
  `discard` with `paths` checks out only the tracked subset (resolved to the index's spelling on an
  ignorecase clone) and runs `clean -f` over every requested path, so naming an untracked file
  removes it instead of failing on `checkout`; a path matching nothing is a no-op. A path-limited
  `discard` now settles only the named paths in every session's records instead of clearing every
  session's whole record for the project — before, a path-limited discard of a tracked path wiped every session's records, and one naming
  only an untracked path failed outright. The
  under-a-symlink refusal in `resolvePush` now has a reaching test (a mocked `lstat`), since git
  itself never produces that layout.
- **A deletion under a linked directory is recorded where the file really was** (#67 review). With a
  tracked in-project link `linkdir -> realdir`, `delete_file linkdir/notes.tex` removes the real
  `realdir/notes.tex` — but the session's record was filed under the link's path, a key git rejects
  ("beyond a symbolic link"), so every later session commit failed with that raw fatal, unrelated files
  included. `delete` now attributes the removal to the parent resolved through links plus the literal
  final component (`attributedDeletePath`): a link named `link.tex` still records as `link.tex` (`rm`
  removes the link), a path under a linked directory records as the real file. Like the write-side
  attribution, a resolution failure never fails the delete — one stderr line, and the given name is
  used. `add_citation`'s confirmation diff now goes through the same `changedPath` rule as
  `write_file`/`edit_file`, so a `.bib` that is itself a link shows the target's diff instead of an
  empty one.
- **`commit scope: "paths"` no longer surfaces git's raw "did not match any files" for a stale record**
  (#67 review). The item-2 rescue let a requested path that this session still tracked past the
  "not changed in the working tree" refusal so a stale record could settle — but it also put that
  path into `git add`, which fatals when nothing is left on disk (`write_file` then `delete_file`, or a
  hand `rm`). A path that covers nothing dirty stages nothing by definition, so it is now kept out of
  the `git add` pathspec and settled by the handler as before; when nothing stageable remains the
  call returns `committed: false` with the record under `settled`. The ignore list also survives the
  mixed case: when some requested paths are ignored and the rest already match HEAD, `GitService`'s
  bare nothing-to-commit error is rethrown carrying `ignored`, the result lists them, and the headline
  says which paths were skipped as ignored and which already matched HEAD, instead of claiming the
  tree matched HEAD for a dirty ignored file. `scope: "all"` with `paths` now hands git a POSIX,
  `./`-stripped form, as `scope: "paths"` also now does (a Windows `sub\notes.tex` used to reach
  `--literal-pathspecs add` verbatim), and the `paths` description says what both scopes already
  did: matched literally, no globs. `sha`'s description names the `"unborn"` sentinel.
- **Ignored session entries are reported and settled whatever their flags** (#67 review). A record
  that was both git-ignored and `conflicted`/`unrecorded` (this session wrote an excluded note, a
  peer wrote the same lines) was never settled and never listed under `ignored`; the refusal called
  it conflicted and pointed at `scope: "all"`, which cannot commit an ignored file either. The ignore
  check now runs over every session entry, ignored ones are settled and dropped from
  `conflicted`/`unrecorded` before the refusal is worded. A `scope: "paths"`/`"all"` request naming a
  _directory_ also names, under `ignored`, the session's ignored entries beneath it that `git add`
  skipped and the take settled. The `discard` hint says what `discard` does: it reverts those paths
  for every session, not only this one.
- **A tracked link replaced by a regular file commits as one** (#67 review). `commitContents`'
  refusal to stage content over a mode-120000 entry judged the index right after its reset to HEAD,
  so `delete_file link.tex` then `write_file link.tex` — a typechange `git add` records without
  comment — was refused, and the remedy named the two calls the caller had just made. The refusal now
  fires only when the path is _still_ a symlink on disk (the stale-record case it exists for); a
  regular file there stages as `100644`.
- **`resolvePush` aborts the paused rebase on _any_ exception, not only its deliberate refusals** (#67
  review). A failed `ls-files`/`add` spawn or `writeFile` inside the loop used to propagate with the
  clone left mid-rebase (conflict markers on disk, detached HEAD) — two of those spawns were new in
  #67, the other legs older. The loop body is now one try/catch around `abortRebaseIfInProgress`. The
  symlink refusal's text also names the shell-free way out, `reset_to_remote (confirm: true)`, as the
  conflict report's guidance already did. `GitService.diff` passes `--literal-pathspecs` like `add`,
  `ls-files` and `ls-tree`, since the write tools' confirmation diff now feeds it a path a caller
  named — and so does `discard` with `paths` (`checkout`/`clean`), the most destructive place for
  `a[1].tex` to also mean `a1.tex`. One consequence for old session state: a shadow key filed under
  a linked directory by a pre-fix `delete_file` is now refused by `check-ignore` even on a
  `conflicted` entry; `discard` clears it, and no such key is written any more.
- **A session commit no longer takes files git ignores** (#66, item 1). `scope: "session"` stages
  from the session's shadow with `update-index`, which never consults `.gitignore` or
  `.git/info/exclude` — so a file this server wrote that git would never stage (the `summarize-paper`
  note relies on the exclude to stay local) was committed and pushed by the default scope while
  `scope: "all"` left it alone. `commit` now runs one `git check-ignore` over the paths in scope —
  the session's files, or the named `paths` under `"paths"`/`"all"` (where `git add` would have
  failed with a raw "use -f") — skips the matches, reports them under a new `ignored` field and
  drops them from the session's record; a tracked file that matches a pattern is not ignored (as
  under `git add`) and still commits. "Tracked" is judged where the staging step will look: against
  HEAD for the session scope and `scope: "paths"`, which reset the index to HEAD first — so a hand
  `git rm --cached` no longer gets the file reported ignored (and the session's edit dropped) while
  the reset put it straight back — and against the live index for `scope: "all"` with `paths`,
  whose `git add` runs over the index as it stands. On a case-insensitive repository
  (`core.ignorecase`, which git sets on macOS and Windows clones) the HEAD lookup folds case, so a
  file tracked as `Notes.txt` and edited as `notes.txt` is tracked, not ignored — under either
  basis. The same ASCII fold (git's own; exact spelling wins where a tree holds both) now applies
  wherever this server looks a path up by name: the session's shadow base is read from HEAD's
  spelling, so such an edit no longer seeds an empty base and swallows a peer's uncommitted lines
  whole, and the session commit stages under HEAD's spelling, since `update-index --cacheinfo`
  does none of the case-alias lookup `git add` does — such an edit used to land as a second,
  case-differing tree entry, and a deletion removed nothing. A request whose every path is
  ignored is refused by name, not with "no changes". Pathspecs handed to `git add`, `ls-files`, `ls-tree` and `diff` are now
  literal, never globs: naming `a[1].tex` used to stage a peer's dirty `a1.tex` past the ownership
  check.
- **`status` (and every tool that starts from it) works on a clone of an empty remote.** The branch
  name came from `rev-parse --abbrev-ref HEAD`, which cannot name an unborn branch, so a repository
  created without a first commit failed every `status`/`commit` with git's raw "ambiguous argument
  'HEAD'"; it now asks `symbolic-ref` first (falling back to `rev-parse` on a detached HEAD). A
  `commit` that settles a session record on such a clone says "no commits yet" rather than printing
  the `sha: "unborn"` sentinel as if it were a commit id.
- **A wedged `unrecorded`/`conflicted` entry whose file already matches HEAD can be settled without an
  empty commit** (#66, item 2). After a `push` with `message` had committed the working tree, or a hand
  revert, the remedy every message named — `scope: "all"` — refused with "Nothing to commit", `scope:
"paths"` refused the path as unchanged, and only `discard` or `allowEmpty` (a junk empty commit,
  later pushed) worked. Now a `scope: "all"`/`"paths"` request that covers a tracked entry and finds
  nothing to stage settles those entries and returns `committed: false` with them under the new
  `settled` field (also populated after a landed commit); a request covering nothing the session tracks
  still refuses as before. The refusal texts name the exact `discard` call and this route.
- **A push `resolution` can no longer write through a symlink, and a non-ASCII conflicted path can be
  resolved** (#66, items 3 and 10). `resolvePush` applied each resolution with a raw `writeFile` by the
  path git reported: when a collaborator's commit turned `notes.tex` into a link pointing outside the
  clone, the resolution's content landed in the outside file, `git add` staged the link unchanged, and
  the tool reported nothing-to-push; a link to `refs.bib` reached the bibliography past the
  literal-name `confirmBibEdit` gate. A path that is a symlink on either side of the conflict (the
  paused rebase's working tree, or the ours/theirs index stage at mode 120000) is now refused by
  name, the rebase aborted and the clone left where it was before the rebase started. A link only in
  the _base_ stage — one both sides already replaced with a regular file — is an ordinary content
  conflict and is not refused, since nothing a resolution could land on is a link any more. A path
  beneath a symlinked directory (`sub/x.tex` under a link `sub`) is refused the same way: git never
  checks a conflicted file out beneath a link itself, but one placed by hand while the rebase is
  paused would otherwise redirect the write. The index-side check (and `commitContents`' mode
  lookup) passes the path as a literal pathspec, not a glob, so `a[1].tex` is never judged by
  `a1.tex`'s entry. Separately, the unmerged-path listing lacked `core.quotePath=false`, so a
  conflict on `é.tex` came back as `"\303\251.tex"`, with an empty per-file report and a resolution
  for `é.tex` rejected as "not supplied"; it now matches every other path-returning call. (The
  issue's item 10 — a literal newline in a path mis-splitting `--numstat` — turned out not to be a
  defect: git C-quotes control characters whatever `core.quotePath` says, so the row count stays
  right; the quoting bug that _was_ real is this one.)
- **A write through an in-project symlink is attributed to the link's target** (#66, item 4). A
  confirmed `write_file`/`edit_file`/`add_asset` through a tracked `link.tex -> main.tex` changed
  `main.tex` on disk but recorded the change under `link.tex`, whose HEAD content is the target string:
  the session's commit then refused with a bogus "same lines of link.tex" collision while the real
  edit to `main.tex` was owned by nobody; through a dangling tracked link, the commit landed a
  mode-120000 entry whose blob was the new text — a symlink pointing at the paragraph. The mutation
  recorder is now told where the bytes landed (the target's project-relative name, when the link stays
  inside the project); `delete_file` stays attributed to the link itself, which is what it removes; the
  revision-tracker baseline key is unchanged, and the confirmation diff `write_file`/`edit_file`
  return now shows the target's change rather than an unchanged link. `commitContents` additionally
  refuses to stage content over a mode-120000 index entry, so no stale record can produce a
  link-with-text again.
- **`refresh` no longer re-merges and re-hashes a permanently conflicted entry on every call** (#66,
  item 6). A conflicted entry's shadow and base are frozen by design, so after a collision every
  `status`/`commit`/`push`/`project_sync` re-read HEAD, re-ran the three-way merge and spawned
  `git hash-object` twice per entry — three conflicted 2 MiB assets meant six spawns and ~12 MiB of pipe
  per `status`, forever. The entry now remembers the HEAD commit it was judged against
  (`conflictHead`) and is skipped while HEAD is still that commit; a HEAD move re-evaluates it in full,
  the flag is never cleared by the memo, and entries written before the field existed are evaluated
  once and then memoised.
- **An imported `.svg`/`.eps` (or a CRLF `.tex`) no longer stays `conflicted` forever on a clone with
  `* text=auto`** (#63). A session commit stages through `git hash-object --path`, which applies the
  path's gitattributes clean filter, so HEAD held the LF-normalised blob while the session's shadow held
  the CRLF bytes it wrote; the next refresh saw HEAD and shadow differ, a binary shadow has no merge, and
  the path was flagged `conflicted` — sticky by design — for a file nobody else touched, and every later
  `add_asset` or `commit` on it was refused. Equality between HEAD, a shadow and the working tree is
  now judged through the same clean filter (`GitService.cleanBlobId`, the blob id the bytes _would_
  get), so "our change is what landed" is recognised across a normalisation, the second import to the
  same path is accepted, and a CRLF `.tex` commits without a phantom every-line conflict. A genuine
  collision still conflicts, a binary shadow is still never merged, and the flag still sticks.
- **A shadow record that fails no longer leaves a live session's edit owned by nobody.** The write was
  (and is) never failed for it, but the file then had no index entry, so a peer's `commit scope: "paths"`
  could take the session's in-flight lines and the session's own commit silently omitted them. The path
  is now marked `conflicted` + `unrecorded` in the session's index (and `commit` returns the
  `unrecorded` subset of `conflicted` in its structured output): peers refuse it as owned, the
  session's `commit` excludes it and says why, and it stays that way until taken with `scope: "all"` or
  discarded. Taking it now actually settles it: a `scope: "all"`/`"paths"` commit drops this session's
  entries under the paths it was given (`ShadowStore.settle`), so a conflicted or unrecorded entry no
  longer lingers and keeps the default scope refusing after the tree was taken deliberately — and
  `refresh` leaves an unrecorded entry alone, so a later commit by a peer cannot quietly make it
  committable again with a shadow that is missing the session's write. A
  heartbeat (`touch`) failure alone marks nothing — only a failed shadow record does. What remains is
  an index that cannot be written at all (documented in CONCURRENCY.md).
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
