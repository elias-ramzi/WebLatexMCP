import { z } from 'zod';

/**
 * Per-project compile defaults (`set_compile_defaults`): the arguments a caller would otherwise
 * resend on every `compile` — backend, engine, timeout, warnings filter. Stored under
 * `<workspace>/.sessions/<id>/compile-defaults.json` (`CompileDefaultsStore`), beside the clone and
 * never inside it, shared by every session on the project, like the rewrite mode.
 *
 * Precedence is per field: an argument the call passes wins, else the stored default, else the
 * server's own default. A stored `compiler` is the user's assertion for that project, exactly as a
 * per-call `compiler` is (CLAUDE.md, "only an unchosen default is ever substituted"): a missing
 * backend named there is an error, never quietly swapped for another.
 */

/** `compile`'s `warningsFilter`, shared with the defaults so the two cannot drift. */
export const warningsFilterSchema = z
  .object({
    file: z
      .array(z.string())
      .optional()
      .describe(
        'Keep only warnings whose file is exactly one of these — project-relative POSIX, ' +
          'matched EXACTLY as warnings[].file reports it (no globs, no prefixes): the way to ' +
          'get the spelling right is to read it off a previous compile result. A warning the ' +
          'log named no file for is dropped when this is set, even though it would otherwise ' +
          'survive — there is nothing to compare it against, and filtering to one file is not ' +
          'what you want mixed with warnings of unknown origin.',
      ),
    rule: z
      .array(z.string())
      .optional()
      .describe(
        'Keep only warnings whose rule is exactly one of these — the values warnings[].rule ' +
          'carries: "Overfull \\hbox", "Underfull \\vbox", "LaTeX", or a package/class name ' +
          'like "hyperref" — including one carrying a dot or a hyphen, e.g. "pdftex.def" or ' +
          '"tikz-cd". Matched exactly, never a prefix.',
      ),
    excludeRule: z
      .array(z.string())
      .optional()
      .describe(
        'Drop warnings whose rule is exactly one of these. A warning with no rule is never ' +
          'excluded by this — only rule and file ever drop a rule-less/file-less warning.',
      ),
  })
  .optional()
  .describe(
    'Trim warnings[] to the ones you actually want, on a document whose warning-heavy log ' +
      'otherwise dominates the result. Applies to logTail too, in lockstep with warnings[] — ' +
      'an Overfull \\hbox line otherwise ships twice, once structured and once as raw text — ' +
      'except when rawLog: true, where logTail stays whole (see rawLog). Never filters errors, ' +
      'only warnings: a document that fails to compile is not made to look cleaner by a filter ' +
      'meant for box-warning noise. warningsOmitted reports how many warnings this removed. An ' +
      'EMPTY array constrains nothing rather than matching nothing — {file: []} returns every ' +
      'warning, not none — so a list you built programmatically and that came out empty widens ' +
      'the result instead of narrowing it.',
  );

export const compileDefaultsSchema = z
  .object({
    compiler: z.enum(['latexmk', 'tectonic']).optional(),
    engine: z.enum(['pdflatex', 'xelatex', 'lualatex']).optional(),
    timeoutSec: z.number().int().positive().optional(),
    warningsFilter: warningsFilterSchema,
  })
  .strict();

export type CompileDefaults = z.infer<typeof compileDefaultsSchema>;

/** The fields a stored default can fill, in a fixed order for reporting. */
export const COMPILE_DEFAULT_FIELDS = [
  'compiler',
  'engine',
  'timeoutSec',
  'warningsFilter',
] as const;

/**
 * Fill every field the call left unset from `stored`. Returns the merged arguments and the names
 * of the fields a default supplied, so the result can say what it did not get from the call.
 */
export function applyCompileDefaults<T extends Partial<CompileDefaults>>(
  args: T,
  stored: CompileDefaults | null,
): { args: T; applied: string[] } {
  if (!stored) return { args, applied: [] };
  const merged: T = { ...args };
  const applied: string[] = [];
  for (const field of COMPILE_DEFAULT_FIELDS) {
    if (merged[field] === undefined && stored[field] !== undefined) {
      (merged as Record<string, unknown>)[field] = stored[field];
      applied.push(field);
    }
  }
  return { args: merged, applied };
}
