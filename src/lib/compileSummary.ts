import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * The short compile report `edit_file`/`write_file` attach when called with `compile: true`.
 *
 * The point of compiling in the same call is to save the round trip, not to ship `compile`'s whole
 * payload twice per edit — that one carries snippets, a log tail and up to 20000 characters of
 * diagnostics. So this keeps what decides the next step: did it build, how many errors and
 * warnings, the first few errors by location, and the comments it resolved. Everything else is
 * one `compile` call away, and the text says so whenever something was left out.
 */
export const SUMMARY_MAX_ERRORS = 5;
export const SUMMARY_MESSAGE_CHARS = 200;

export const compileSummarySchema = z
  .object({
    success: z.boolean(),
    compiler: z.string().optional().describe('The backend that ran.'),
    rootFile: z.string().optional(),
    pageCount: z.number().optional(),
    errorCount: z.number(),
    warningCount: z.number(),
    errors: z
      .array(
        z.object({
          file: z.string().optional(),
          line: z.number().optional(),
          message: z.string(),
        }),
      )
      .describe(
        `The first ${SUMMARY_MAX_ERRORS} errors, each message cut at ${SUMMARY_MESSAGE_CHARS} ` +
          'characters. Call compile for snippets, warnings and the log tail.',
      ),
    resolvedComments: z.number().optional(),
    defaultsApplied: z.array(z.string()).optional(),
    hint: z.string().optional(),
    failure: z
      .string()
      .optional()
      .describe('Set when the compile could not run at all (no backend, a refused root, …).'),
  })
  .describe(
    'A short report of the compile this call ran after writing (compile: true). The write itself ' +
      'has landed whatever this says.',
  );

export type CompileSummary = z.infer<typeof compileSummarySchema>;

/** The two inputs `edit_file` and `write_file` share for compiling in the same call. */
export const compileAfterWriteInput = {
  compile: z
    .boolean()
    .optional()
    .describe(
      'Compile the project after writing, in this same call, and return a short report under ' +
        '`compile` (success, counts, the first errors) — instead of a separate compile call. ' +
        "Uses the project's registered root and its stored compile defaults " +
        '(set_compile_defaults); call compile directly for any other argument. The write lands ' +
        'whatever the build does.',
    ),
  resolveComments: z
    .array(z.string())
    .min(1)
    .optional()
    .describe(
      'Viewer comment ids (from list_comments) to mark resolved if that build succeeds. Needs ' +
        'compile: true.',
    ),
};

/** `resolveComments` without `compile` is refused before anything is written. */
export function assertCompileRequested(
  compile: boolean | undefined,
  resolveComments: string[] | undefined,
): void {
  if (resolveComments !== undefined && compile !== true) {
    throw new Error(
      'resolveComments needs compile: true — comments are resolved only by a build that ' +
        'succeeds. Add compile: true, or call resolve_comments.',
    );
  }
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

interface CompileDiagnostic {
  file?: string;
  line?: number;
  message: string;
}

/** Reduce `runCompile`'s result to the summary, and render its text lines. */
export function summarizeCompile(result: CallToolResult): {
  summary: CompileSummary;
  text: string;
} {
  const first = result.content[0];
  const rawText = first && first.type === 'text' ? first.text : '';
  if (result.isError || !result.structuredContent) {
    const failure = clip(rawText.trim() || 'compile failed to run', 2000);
    return {
      summary: { success: false, errorCount: 0, warningCount: 0, errors: [], failure },
      text: `compile did not run: ${failure}`,
    };
  }
  const sc = result.structuredContent as {
    success: boolean;
    compiler?: string;
    rootFile?: string;
    pageCount?: number;
    errors?: CompileDiagnostic[];
    warnings?: unknown[];
    errorsOmittedByCap?: number;
    warningsOmittedByCap?: number;
    resolvedComments?: number;
    defaultsApplied?: string[];
    hint?: string;
  };
  const allErrors = sc.errors ?? [];
  const errorCount = allErrors.length + (sc.errorsOmittedByCap ?? 0);
  const warningCount = (sc.warnings?.length ?? 0) + (sc.warningsOmittedByCap ?? 0);
  const errors = allErrors.slice(0, SUMMARY_MAX_ERRORS).map((e) => ({
    ...(e.file !== undefined ? { file: e.file } : {}),
    ...(e.line !== undefined ? { line: e.line } : {}),
    message: clip(e.message, SUMMARY_MESSAGE_CHARS),
  }));
  const summary: CompileSummary = {
    success: sc.success,
    ...(sc.compiler !== undefined ? { compiler: sc.compiler } : {}),
    ...(sc.rootFile !== undefined ? { rootFile: sc.rootFile } : {}),
    ...(sc.pageCount !== undefined ? { pageCount: sc.pageCount } : {}),
    errorCount,
    warningCount,
    errors,
    ...(sc.resolvedComments !== undefined ? { resolvedComments: sc.resolvedComments } : {}),
    ...(sc.defaultsApplied !== undefined ? { defaultsApplied: sc.defaultsApplied } : {}),
    ...(sc.hint ? { hint: clip(sc.hint, 1000) } : {}),
  };
  // The compile tool's own headline is its first line: built, backend, pages, counts.
  const lines = [rawText.split('\n')[0] ?? ''];
  for (const e of errors) {
    const where = e.file ? `${e.file}${e.line !== undefined ? `:${e.line}` : ''}: ` : '';
    lines.push(`  ${where}${e.message}`);
  }
  if (errorCount > errors.length) lines.push(`  … ${errorCount - errors.length} more error(s)`);
  if (sc.resolvedComments !== undefined) {
    lines.push(`resolved ${sc.resolvedComments} comment(s)`);
  }
  if (errorCount > 0 || warningCount > 0) {
    lines.push('call compile for snippets, warnings and the log tail');
  }
  return { summary, text: lines.filter(Boolean).join('\n') };
}
