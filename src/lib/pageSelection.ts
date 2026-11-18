import { z } from 'zod';

/**
 * The `pages` input shared by `render_pages`, `extract_text` and `pdf_geometry`: one positive
 * 1-based page number, or a non-empty array of them. A caller asking for one page naturally
 * sends `{"pages": 2}`, which an array-only schema refused with "expected array, received
 * number".
 *
 * A `z.union`, deliberately not a `z.preprocess` that wraps the number: the advertised JSON
 * Schema is what a client builds its call from, and a preprocess advertises only the array form
 * (the shorthand would work while nothing said it may be sent). The union advertises both forms
 * as `anyOf`, and {@link normalizePages} turns the parsed value into the array the services take.
 *
 * The empty array keeps its own refusal: omitting `pages` means every page, and `[]` would
 * otherwise read as "nothing" to one caller and "all" to another.
 */
export const EMPTY_PAGES_MESSAGE =
  'Omit pages for every page — an empty array selects zero pages, not "all".';

export function pagesInputSchema() {
  return z.union([
    z.number().int().positive(),
    z.array(z.number().int().positive()).min(1, EMPTY_PAGES_MESSAGE),
  ]);
}

/** The parsed `pages` input as the array the render service takes; `undefined` stays omitted. */
export function normalizePages(pages: number | number[] | undefined): number[] | undefined {
  return typeof pages === 'number' ? [pages] : pages;
}
