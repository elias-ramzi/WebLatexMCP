import { describe, it, expect } from 'vitest';
import {
  MAX_REPORTED_PATH_CHECKS,
  MAX_SNIPPET_LINE_CHARS,
  sliceSnippet,
  unopenablePaths,
  withoutUnopenableLocation,
} from '../../src/lib/sourceSnippet.js';

/**
 * The policy shared by `compile` and `list_comments` for paths the *document* named: which of them
 * may be handed back, and what a snippet is allowed to say.
 */

/** A stand-in for FileService: only `outside` leaves the project through a link. */
function linkChecker(outside: string[]) {
  const seen: string[] = [];
  return {
    seen,
    leavesProjectThroughLink: async (_dir: string, rel: string) => {
      seen.push(rel);
      return outside.includes(rel);
    },
  };
}

describe('paths the document named', () => {
  it('separates a path that escapes from one it never got to check', async () => {
    // Past the cap nothing is resolved, so nothing is known: withholding those locations is the
    // safe default, but calling them symlink escapes accuses the document of something the server
    // never looked for — and the caller goes hunting for a link that does not exist.
    const files = linkChecker(['notes.tex']);
    const diagnostics = [
      { file: 'notes.tex' },
      // Fills the cap exactly, so `main.tex` is the first path left unresolved.
      ...Array.from({ length: MAX_REPORTED_PATH_CHECKS - 1 }, (_, i) => ({ file: `aux-${i}.log` })),
      { file: 'main.tex' },
    ];

    const withheld = await unopenablePaths(files, '/project', diagnostics);

    expect(files.seen.length).toBe(MAX_REPORTED_PATH_CHECKS);
    expect(withheld.escaped).toBe(1);
    expect(withheld.unchecked).toBe(1);
    expect(withheld.all.has('notes.tex')).toBe(true);
    expect(withheld.all.has('main.tex')).toBe(true); // withheld, but not accused of anything
  });

  it('takes the snippet away with the location it belongs to', async () => {
    // A snippet is five lines numbered from `snippetStartLine`, and the caller renders it against
    // `line`. Keeping it after the location is withheld hands back source with nowhere to put it —
    // and, for a path that really did escape, source the caller was not meant to receive.
    const stripped = withoutUnopenableLocation(
      {
        severity: 'error' as const,
        file: 'notes.tex',
        line: 2,
        message: 'Undefined control sequence',
        snippet: 'a\nb\nc',
        snippetStartLine: 1,
      },
      new Set(['notes.tex']),
    );
    expect(stripped.file).toBeUndefined();
    expect(stripped.line).toBeUndefined();
    expect(stripped.snippet).toBeUndefined();
    expect(stripped.snippetStartLine).toBeUndefined();
    expect(stripped.message).toBe('Undefined control sequence');
  });

  it('leaves a diagnostic it is not withholding exactly as it was', async () => {
    const diagnostic = { file: 'main.tex', line: 3, snippet: 'a\nb', snippetStartLine: 2 };
    expect(withoutUnopenableLocation(diagnostic, new Set(['notes.tex']))).toBe(diagnostic);
  });
});

describe('snippet line truncation', () => {
  it('never cuts a character in half', () => {
    // An emoji is two UTF-16 code units, so a cut at exactly the cap can land between them and
    // emit a lone surrogate — which is not text: it survives into structuredContent, and JSON
    // encoders either throw on it or silently replace it.
    const line = `${'x'.repeat(MAX_SNIPPET_LINE_CHARS - 1)}😀${'y'.repeat(20)}`;
    const snippet = sliceSnippet([line], 1)!.snippet;

    expect(snippet.isWellFormed()).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    // Backing off the half character loses it rather than mangling it.
    expect(snippet).toBe(`${'x'.repeat(MAX_SNIPPET_LINE_CHARS - 1)}…`);
  });

  it('keeps a character that fits whole', () => {
    const line = `${'x'.repeat(MAX_SNIPPET_LINE_CHARS - 2)}😀${'y'.repeat(20)}`;
    const snippet = sliceSnippet([line], 1)!.snippet;
    expect(snippet.isWellFormed()).toBe(true);
    expect(snippet).toBe(`${'x'.repeat(MAX_SNIPPET_LINE_CHARS - 2)}😀…`);
  });
});
