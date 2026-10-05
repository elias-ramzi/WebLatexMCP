import path from 'node:path';
import { climbsOut, toPosix } from './paths.js';
import { quoteId } from './projectId.js';

/**
 * What is wrong with a LaTeX root file's SPELLING, judged on the string alone — the same answer on
 * every platform, whatever the disk holds.
 *
 * - `absolute`: absolute on POSIX or on win32 (`/p/main.tex`, `C:\p\main.tex`, `C:/p/main.tex`,
 *   `\\server\share\main.tex`, root-relative `\main.tex`). `relSpelling` is the project-relative
 *   spelling to pass instead, when the path is absolute on the platform that resolves it here and
 *   lies strictly inside `projectDir`.
 * - `drive`: a drive prefix that is not absolute (`C:main.tex`) — drive-relative on win32, so it
 *   names a file against that drive's current directory, which says nothing about the project. It
 *   is refused on EVERY platform: whether a root is accepted must not depend on where the server
 *   runs.
 * - `dotdot`: a `..` segment, with `/` or `\` as the separator (`a/../b.tex`, `..\x.tex`). A
 *   directory merely named like `..foo` is not one.
 *
 * Everything else (`./`, doubled or trailing separators, backslashes, an extensionless name, which
 * latexmk completes to `.tex`) is accepted: it normalises to what the OS resolves. Pure.
 */
export type RootFileSpellingProblem =
  | { kind: 'absolute' | 'drive'; relSpelling?: string }
  | { kind: 'dotdot' };

export function rootFileSpellingProblem(
  rootFile: string,
  opts: { projectDir?: string; platform?: NodeJS.Platform } = {},
): RootFileSpellingProblem | undefined {
  const platform = opts.platform ?? process.platform;
  const raw = toPosix(rootFile).replace(/\\/g, '/');
  const posixAbsolute = path.posix.isAbsolute(raw);
  // A drive prefix, on every platform: absolute (`C:/p`) or drive-relative (`C:main.tex`) on win32.
  const driveQualified = /^[A-Za-z]:/.test(raw);
  if (posixAbsolute || driveQualified || path.win32.isAbsolute(rootFile)) {
    // Suggest a relative spelling only for a path absolute on the platform that resolves it here;
    // a drive-relative name resolves against that drive's current directory, which says nothing.
    const inside =
      opts.projectDir !== undefined && platform === process.platform && path.isAbsolute(rootFile)
        ? path.relative(path.resolve(opts.projectDir), path.resolve(rootFile))
        : '';
    const relSpelling =
      inside !== '' && !climbsOut(inside) && !path.isAbsolute(inside) ? toPosix(inside) : undefined;
    const kind = driveQualified && !path.win32.isAbsolute(rootFile) ? 'drive' : 'absolute';
    return relSpelling !== undefined ? { kind, relSpelling } : { kind };
  }
  if (raw.split('/').includes('..')) return { kind: 'dotdot' };
  return undefined;
}

/**
 * Refuse a `rootFile` given to `register_project` whose spelling cannot name a file in the
 * project ({@link rootFileSpellingProblem}). The registered root drives every later `compile`,
 * `render_pages`, `extract_text`, `pdf_geometry` and viewer call that names none, so a bad one is
 * refused before anything is persisted rather than at each of those calls. `projectDir` (a local
 * project's directory) lets an absolute root inside it be answered with its relative spelling.
 *
 * Applies to a registration only: a root loaded from `WEB_LATEX_MCP_PROJECTS` or `registry.json`
 * is never judged here, since refusing it would strand an existing configuration — those are
 * refused at call time instead. Throws; returns nothing.
 */
export function assertRegistrableRootFile(
  rootFile: string,
  opts: { projectDir?: string } = {},
): void {
  const problem = rootFileSpellingProblem(rootFile, opts);
  if (problem === undefined) return;
  const what =
    problem.kind === 'dotdot'
      ? 'has a ".." segment'
      : problem.kind === 'drive'
        ? 'is spelled with a drive prefix, which Windows reads as an absolute or drive-relative ' +
          'path (so it is refused on every platform)'
        : 'is an absolute path';
  const suggestion =
    problem.kind !== 'dotdot' && problem.relSpelling !== undefined
      ? ` Register it as rootFile: ${quoteId(problem.relSpelling)}.`
      : '';
  throw new Error(
    `rootFile ${quoteId(rootFile)} ${what}. rootFile must be a path relative to the project ` +
      'root, without ".." (e.g. "main.tex" or "sub/main.tex"): every compile, render_pages, ' +
      'extract_text, pdf_geometry and viewer call that names no rootFile uses it.' +
      suggestion +
      ' Nothing was registered.',
  );
}
