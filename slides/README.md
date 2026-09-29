# Slides

A [reveal.js](https://revealjs.com) deck giving a high-level overview of WebLatexMCP.

- `index.html` — the slides (reveal.js 6, loaded from jsDelivr; fonts from Google Fonts).
- `theme.css` — brand colours and layout, layered on reveal's `white` theme.
- `img/` — screenshots used by the slides.
- `WebLatexMCP.pdf` — the deck as a PDF, for reading without a browser or a network.
- `build-pdf.mjs` — rebuilds that PDF (see below).

## Present

Open `index.html` in a browser, or serve the folder (some browsers restrict `file://` pages):

```bash
npx --yes serve slides
```

Press **S** for speaker notes, **F** for full screen, **O** for the overview.

## Export to PDF

```bash
npm run slides:pdf                  # → slides/WebLatexMCP.pdf
npm run slides:pdf -- out/deck.pdf  # or a path of your choice
```

`build-pdf.mjs` prints the deck with a headless Chrome, Chromium or Edge — the first one it finds
on `PATH` or in the usual install locations, including a Windows browser from WSL. Set `CHROME_PATH`
to choose one. Each slide is one page, with its step-by-step reveals shown together.

A pull request that changes the deck gets the PDF rebuilt for it: the `Slides PDF` workflow
(`.github/workflows/slides-pdf.yml`) builds it and commits it to the PR's branch. That push uses
the `SLIDES_PDF_TOKEN` repository secret, a fine-grained personal access token with **Contents:
read and write** on this repository — a push with the workflow's own token would start no CI, and
`dev` refuses a head commit without its checks. Without the secret (or on a fork's PR), the run
attaches the PDF as the `WebLatexMCP-slides` artifact and warns instead; download it and commit it.

The deck needs a network connection for reveal.js and the fonts.
