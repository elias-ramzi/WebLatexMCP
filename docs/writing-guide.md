# Writing Academic Articles in LaTeX

A style and conventions guide for drafting research papers in this repository.
These are the rules Claude should follow when writing or editing `.tex` files
through the WebLatexMCP server, and that human contributors should follow too.

---

## Tense

Use the present tense throughout the paper.

## Writing style

The reading must flow. If the reader has to stop and re-read a sentence, it is
not clear enough — prefer the simpler phrasing.

Avoid overusing "we" and "our". These words are impactful when reserved for key
contributions ("our contributions are...") and diluting when applied to
everything ("our parameters are..." → "the parameters are..."). Reserve the
first person for what is genuinely yours; let the rest of the paper speak
plainly.

## Sections

Introduce each section with a short header sentence that signposts its
subsections. For example:

> In \autoref{sec:exp:details}, we present the experimental details, and compare
> against state-of-the-art models in \autoref{sec:exp:sota}.

## Figures and tables

- Every figure and table is referred to in the text. An unreferenced float is a
  red flag.
- Position figures and tables next to where they are discussed.
- Prefer the **top** of the page for placement (`[t]`), occasionally the bottom;
  avoid floats drifting far from their discussion.
- Captions start with a short title in **bold**, then the explanation.
- The explanation is descriptive: it says what the figure or table shows — the
  axes, the conditions, what each curve, column, or panel is. Do not comment on
  the figure in the caption. Interpretation, comparison, and the conclusions
  drawn from it belong in the body text, not the caption.
- Use descriptive labels: `\label{tab:sota_results}`, `\label{fig:overview}`.
- The caption test: a reader who only reads the title and then looks at the
  figures, tables, and their captions should still understand them. Write
  captions to pass this test.
- For table design, follow the conventions in Markus Püschel's guide:
  <https://people.inf.ethz.ch/markusp/teaching/guides/guide-tables.pdf>
  (in short: `booktabs` rules, no vertical lines, aligned numbers).

## Equations

- Introduce every notation you use.
- Drop any notation you introduce but never use.
- Equations are part of the sentence: punctuate them. End with a period if the
  sentence ends there, a comma if it continues.
- Textual subscripts and superscripts use `\text` or `\textit`, otherwise the
  letters are typeset as a product and become hard to read. Write
  `L_\textit{image}`, not `L_{image}`.

```latex
The image loss is defined as
\begin{equation}
  L_\textit{image} = \frac{1}{n} \sum_i \| x_i - \hat{x}_i \|_2^2,
\end{equation}
where $\hat{x}_i$ is the reconstruction.
```

## Bibliography

- **Never hand-write or invent references.** Do not fabricate BibTeX entries or
  `\cite` keys for works you cannot verify. The only sanctioned way to add a
  reference is the `add_citation` tool, which fetches the BibTeX from DBLP
  server-side — use it when the author asks for a citation. If a passage seems to
  need a citation and you cannot find the work on DBLP, flag it for the author
  rather than guessing — a hallucinated reference is worse than a missing one.
- **`.bib` files are protected.** Direct `write_file` / `edit_file` /
  `delete_file` on a `.bib` file is refused; add references through
  `add_citation`. Any other change to a `.bib` (removing or fixing an entry)
  needs the author's explicit approval and the `confirmBibEdit: true` flag.
- Harmonize the reference style consistently across the whole file:
  - Strip noise: conference location and date, editors, URL/DOI, volume number,
    page ranges, etc.
  - Use venue acronyms instead of full names (optional, but be consistent — all
    or none).
- BibTeX key format: `firstauthorYEARpaperacronym`, e.g. `chambon2024pointbev`.
  If the paper has no acronym, use the first word of the title.

## Citations

- **Never cite in the abstract.** Indexing engines strip bibliographies; bracketed
  references become bare numbers with no meaning. As a rare exception, if a work is
  central to the abstract's argument, use plain text only: "(Dosovitskiy et al., 2020)".
- **Cite on first mention in the main text.** The first time a method, baseline, or
  architecture is named, add `\cite{}`.
- **Re-anchor at major section boundaries.** Papers are not read linearly — readers
  jump straight to the Method or Experiments. Re-cite a method at its first appearance
  in each new major section: Related Work, Method, and Experiments/Implementation Details.

  ```latex
  % Method section
  The architecture uses a standard ResNet-50 \cite{he2016resnet} backbone.

  % Experiments section
  The model is optimized with AdamW \cite{loshchilov2017adamw} at a learning rate
  of $10^{-4}$.
  ```

- **Do not re-cite within the same section.** Once a method is established, use its
  name alone for the rest of the section. Never bracket the same method twice in the
  same paragraph:

  ```latex
  % ✗
  Unlike NeRF \cite{mildenhall2020nerf}, our method is faster.
  Furthermore, NeRF \cite{mildenhall2020nerf} requires static scenes.

  % ✓
  Unlike NeRF \cite{mildenhall2020nerf}, our method is faster.
  Furthermore, NeRF requires static scenes.
  ```

## Acronyms and abbreviations

- Define an acronym at its **first appearance**: full term first, acronym in
  parentheses, as in "bird's-eye view (BEV)". Every occurrence after that uses
  the acronym alone.
- Define it **once**. Re-introducing "bird's-eye view (BEV)" in a later section
  tells the reader they missed something — check the whole paper for duplicate
  definitions.
- The abstract is read on its own: if the acronym appears there, define it in
  the abstract and again at its first appearance in the body, then never after.
- Only introduce an acronym worth reusing. A term that appears once or twice
  stays spelled out — an acronym the reader has to look back for costs more than
  the words it saves.

## English usage

- "i.e.," and "e.g.," — dot, dot, comma. Not italicized.
- "ground truth" as a noun (no hyphen); "ground-truth" as an adjective, as in
  "the ground-truth annotation".
- Hyphens and dashes:
  - **Hyphen** (`-`): compound words ("well-known"), prefixes ("re-evaluate"),
    word breaks.
  - **En dash** (`--`): ranges ("2010--2015") and connections
    ("Paris--London flight").
  - **Em dash** (`---`): parenthetical punctuation — like this — in place of
    parentheses or commas for emphasis. Use sparingly: it has become a tell of
    LLM-generated text, so do not overuse it.

## LaTeX commands

- Use `\autoref{}` for cross-references, not `\ref{}` or `\cref{}`.
- For quotation marks, the opening quote uses backticks: `` `single' `` and
  ` ``double'' `.

---

## Working with Claude through the MCP server

This repository lets Claude read, edit, compile, and commit `.tex` files
directly. To get clean, reviewable results:

- Write **one sentence per line** in the source. LaTeX flows them into normal
  paragraphs, but it keeps `git diff`s small and lets Claude edit surgically
  instead of rewriting whole blocks.
- Ask for **targeted changes** ("tighten the second paragraph of the intro",
  "fix the punctuation on the loss equations") rather than "rewrite this
  section" — the diffs stay reviewable.
- Have Claude **compile after editing** and report errors; LaTeX failures are
  usually localized and the log points to the offending line.
- **Review the diff before pushing.** Treat edits like a collaborator's pull
  request: read `git diff`, then commit and push deliberately.
- **When rewriting prose, replace the text directly.** The server preserves the
  original automatically when the project is configured for it (`edit_file`'s
  rewrite-preservation mode), commenting it out above the replacement on its
  own. Never hand-type `%`-commented copies of the old text yourself — that
  duplicates what the server already does and is not provably the original.

---

_Contributions to this guide are welcome. Keep examples minimal and compilable._
