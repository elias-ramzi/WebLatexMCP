# Slides

A [reveal.js](https://revealjs.com) deck giving a high-level overview of WebLatexMCP.

- `index.html` — the slides (reveal.js 6, loaded from jsDelivr; fonts from Google Fonts).
- `theme.css` — brand colours and layout, layered on reveal's `white` theme.
- `img/` — screenshots used by the slides.
- `build-pdf.mjs` — exports the deck to a PDF (see below).

## Present

Open `index.html` in a browser, or serve the folder (some browsers restrict `file://` pages):

```bash
npx --yes serve slides
```

Press **S** for speaker notes, **F** for full screen, **O** for the overview.

## Export to PDF

```bash
npm run slides:pdf                  # → slides/WebLatexMCP.pdf (git-ignored)
npm run slides:pdf -- out/deck.pdf  # or a path of your choice
```

`build-pdf.mjs` prints the deck with a headless Chrome, Chromium or Edge — the first one it finds
on `PATH` or in the usual install locations, including a Windows browser from WSL. Set `CHROME_PATH`
to choose one. Each slide is one page, with its step-by-step reveals shown together.

The deck needs a network connection for reveal.js and the fonts.
