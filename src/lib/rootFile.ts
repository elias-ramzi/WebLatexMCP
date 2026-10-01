import { stat } from 'node:fs/promises';
import type { FileService } from '../services/fileService.js';
import { resolveInside } from './paths.js';
import { quoteId } from './projectId.js';
import { rootFileSpellingProblem } from './rootFileSpelling.js';

/**
 * Where a root came from: named on this call, registered with the project (`rootFile` in
 * `register_project` / `WEB_LATEX_MCP_PROJECTS`), or guessed by {@link detectRootFile}.
 */
export type RootSource = 'argument' | 'registered' | 'detected';

export interface ResolvedRoot {
  rootFile: string;
  source: RootSource;
}

/**
 * The root a tool should use: the caller's `rootFile`, else the project's registered one, else
 * {@link detectRootFile}. One function for every caller — `compile`, the PDF tools and the viewer
 * — so a project registered with `rootFile: "root.tex"` is built, read and shown as that root
 * everywhere; the registered value used to be stored and then read by nothing, so a nested
 * template `main.tex` won every auto-detection.
 *
 * A registered root is an assertion, like an explicit one: it is used as given, never checked
 * against the tree and silently replaced by a guess.
 */
export async function resolveRootFile(
  files: FileService,
  projectDir: string,
  registered: string | undefined,
  explicit?: string,
): Promise<ResolvedRoot> {
  if (explicit !== undefined) return { rootFile: explicit, source: 'argument' };
  if (registered !== undefined) return { rootFile: registered, source: 'registered' };
  return { rootFile: await detectRootFile(files, projectDir), source: 'detected' };
}

/**
 * Which root a message is about, for a root the caller did not name: ` for root "paper.tex" (the
 * project's registered rootFile)` or `… (auto-detected)`, so a "no PDF" refusal says which build
 * was looked for. Empty for a root named on the call — the caller already knows it.
 */
export function describeRootSource(resolved: ResolvedRoot): string {
  switch (resolved.source) {
    case 'argument':
      return '';
    case 'registered':
      return ` for root ${quoteId(resolved.rootFile)} (the project's registered rootFile)`;
    case 'detected':
      return ` for root ${quoteId(resolved.rootFile)} (auto-detected)`;
  }
}

/**
 * Refuse a registered root that is not a file in the project — before anything is built or a PDF
 * looked for. {@link resolveRootFile} uses a registered root as given, so a stale or mistyped one
 * (`"rootFile": "main.tex"` pasted from an install doc) otherwise failed with nothing to act on:
 * `compile` reported `FAILED gone.tex … 0 error(s)` with the cause only in its log tail, and the
 * PDF tools said "No compiled PDF found … Run compile first" right after another root compiled.
 * The refusal names the root, says it came from the registration, and gives the ways out.
 *
 * Only for `source: 'registered'`: an explicit root keeps its behaviour, and a detected one was
 * found on disk. Read through FileService under the project's link policy (the default
 * `strictLinks`, as for a caller-named read — the user registered this name), with no baseline:
 * the caller asked for no file.
 *
 * Which file is judged mirrors latexmk's `find_basename`: `if (-f "$given_name.tex")` builds
 * `<root>.tex`, else the name as given. It looks for `<root>.tex` FIRST, always — whatever the
 * name ends in, so `Main.TEX` is looked up as `Main.TEX.tex` before `Main.TEX` — and `-f` follows
 * links and is simply false for anything it cannot stat. So `<root>.tex` is judged first: a
 * readable file is accepted; absent or not a regular file falls through to `<root>`; outside the
 * project or unreadable is refused by that name only when a stat following links says it IS a
 * regular file ({@link isRegularFileInside}) — then it is the file latexmk would build, and a link
 * out there beside a usable `<root>` would otherwise be accepted and then compiled. Where `-f` is
 * false (a dangling link out, a link loop, a parent directory that cannot be searched, a name too
 * long once `.tex` is added), latexmk builds `<root>`, so that is judged instead. A `<root>.tex`
 * that leaves the project lexically (an absolute or climbing root) is never stat-ed — nothing
 * outside the sandbox is looked at — and falls through, so the root is refused under the name it
 * was registered with. Then `<root>` itself: a file is accepted, anything else refused.
 * The reason given is from a fixed set ({@link rootProblem}) — never FileService's own message,
 * which carries the path unescaped.
 *
 * Before any lookup, an absolute or drive-prefixed root is refused for its spelling
 * ({@link rootFileSpellingProblem}): FileService refuses every absolute path, and reading that as
 * "outside the project" was false for one that lies inside it — a `WEB_LATEX_MCP_PROJECTS` entry
 * with `"rootFile": "/home/u/paper/main.tex"`, which no registration refuses. The refusal says the
 * root is absolute and, when it lies inside the project, gives the relative spelling to register.
 * Nothing is looked at for it, inside the project or out. A `..` segment is not refused here: one
 * that stays inside (`sub/../main.tex`) is looked up as before, and one that climbs out is refused
 * as outside the project by the lookup.
 *
 * This answers for the file latexmk would use; tectonic never appends `.tex`, and the two can
 * disagree both ways. An extensionless or `paper.v2`-style registered root accepted here because
 * `paper.tex` / `paper.v2.tex` exists can still fail inside the engine under tectonic; and a
 * `paper.tex` that is a regular file reached through a link out, or unreadable, beside a usable
 * extensionless `paper` is refused here, though tectonic would build `paper`.
 */
export async function assertRegisteredRootExists(
  files: FileService,
  projectDir: string,
  id: string,
  resolved: ResolvedRoot,
): Promise<void> {
  if (resolved.source !== 'registered') return;
  const root = resolved.rootFile;
  const spelling = rootFileSpellingProblem(root, { projectDir });
  if (spelling !== undefined && spelling.kind !== 'dotdot') {
    const what =
      spelling.kind === 'drive'
        ? 'is spelled with a drive prefix, which Windows reads as an absolute or drive-relative path'
        : 'is an absolute path';
    const suggestion =
      spelling.relSpelling !== undefined
        ? ` It lies in the project: register it as rootFile: ${quoteId(spelling.relSpelling)}.`
        : '';
    throw registeredRootErrorFor(
      id,
      root,
      `root file ${quoteId(root)} ${what}, and a rootFile must be a path relative to the ` +
        `project root.${suggestion}`,
    );
  }
  const withTex = `${root}.tex`;
  const first = await judgeRoot(files, projectDir, withTex);
  if (first === undefined) return;
  if (
    (first === 'outside' || first === 'unreadable') &&
    (await isRegularFileInside(projectDir, withTex))
  ) {
    throw registeredRootError(id, root, withTex, first);
  }
  const asGiven = await judgeRoot(files, projectDir, root);
  if (asGiven === undefined) return;
  throw registeredRootError(id, root, root, asGiven);
}

/** `undefined` when `candidate` reads as a file, else why not ({@link rootProblem}). */
async function judgeRoot(
  files: FileService,
  projectDir: string,
  candidate: string,
): Promise<RootProblem | undefined> {
  try {
    // No recordBaseline: this only asks whether the root is there.
    await files.read(projectDir, { path: candidate });
    return undefined;
  } catch (err) {
    return rootProblem(err);
  }
}

/**
 * latexmk's `-f` for a candidate FileService would not read: whether a stat FOLLOWING links says
 * it is a regular file. False for anything that cannot be stat-ed (a dangling link, a loop, a
 * parent that cannot be searched, a name too long), as `-f` is. A candidate that leaves the
 * project lexically (absolute, or climbing with `..`) is false without any syscall: only a path
 * inside the project is stat-ed, and following an in-project link reveals no more than whether its
 * target is a regular file — which only decides refuse versus fall through.
 */
async function isRegularFileInside(projectDir: string, candidate: string): Promise<boolean> {
  let abs: string;
  try {
    abs = resolveInside(projectDir, candidate);
  } catch {
    return false;
  }
  try {
    return (await stat(abs)).isFile();
  } catch {
    return false;
  }
}

function registeredRootError(
  id: string,
  root: string,
  judged: string,
  problem: RootProblem,
): Error {
  const which =
    judged === root
      ? ''
      : ` (latexmk looks for ${quoteId(judged)} before ${quoteId(root)}, and builds it ` +
        'whenever it is a file)';
  return registeredRootErrorFor(
    id,
    root,
    `root file ${quoteId(judged)} ${ROOT_PROBLEM_TEXT[problem]}${which}.`,
  );
}

/**
 * The refusal of registered root `root` for `reason` — a sentence built only from quoteId'd names
 * and fixed phrases — followed by where the root came from and the ways out.
 */
function registeredRootErrorFor(id: string, root: string, reason: string): Error {
  return new Error(
    `In project ${quoteId(id)}, ${reason} ` +
      `${quoteId(root)} is the rootFile the project was registered with (register_project or ` +
      'WEB_LATEX_MCP_PROJECTS), used because this call named none. Pass rootFile to use another ' +
      'root on this call; to fix it for good, register the project again with the right ' +
      'rootFile, or without one to auto-detect the root, repeating any branch, username, ' +
      'tokenEnv or followSymlinks it was registered with (for a local project registered with ' +
      'path naming a .tex, name its directory instead, or that .tex is taken as the rootFile ' +
      'again) — for a project configured in WEB_LATEX_MCP_PROJECTS, change its rootFile there.',
  );
}

/**
 * Prefixes of the errors FileService's sandbox raises for a path it will not touch:
 * `resolveInside` (`src/lib/paths.ts`) for an absolute path (`Path must be relative …`) or a
 * climbing one, and `guardLinks` for a link out of the project (`Path escapes … through a
 * symlink`). They are plain `Error`s, so the prefix is the only handle on them; a unit test pins
 * the climbing and the linked registered root, so a rewording fails there rather than turning the
 * refusal into "cannot be read". An absolute root is refused for its spelling before any read
 * ({@link assertRegisteredRootExists}), so the first prefix is a backstop no test reaches.
 */
const OUTSIDE_PROJECT_PREFIXES = [
  'Path must be relative to the project root',
  'Path escapes the project root',
];

/**
 * Why a root candidate could not be read. `absent` and `notFile` are what latexmk falls through;
 * `outside` and `unreadable` it falls through too unless the candidate is a regular file
 * ({@link isRegularFileInside}).
 */
type RootProblem = 'absent' | 'notFile' | 'outside' | 'unreadable';

/**
 * Each {@link RootProblem} as a fixed, path-free phrase: FileService's message quotes the path raw,
 * so a registered name holding a bidi override or a newline would reach the refusal unescaped.
 */
const ROOT_PROBLEM_TEXT: Record<RootProblem, string> = {
  absent: 'does not exist',
  notFile: 'is not a file',
  outside: 'is outside the project or reached through a link out of it',
  unreadable: 'cannot be read',
};

/** Classify a FileService read failure. Unknown failures are `unreadable`, never a missing file. */
function rootProblem(err: unknown): RootProblem {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') return 'absent';
  const message = err instanceof Error ? err.message : '';
  if (message.startsWith('Not a file:')) return 'notFile';
  if (OUTSIDE_PROJECT_PREFIXES.some((p) => message.startsWith(p))) return 'outside';
  return 'unreadable';
}

/** How deep a project-relative POSIX path sits: `main.tex` is 0, `tpl/main.tex` is 1. */
function depth(rel: string): number {
  return rel.split('/').length - 1;
}

function isMain(rel: string): boolean {
  return rel === 'main.tex' || rel.endsWith('/main.tex');
}

/**
 * Detect the LaTeX root file. A top-level `main.tex` wins outright. Otherwise the shallowest
 * `.tex` containing `\documentclass` (a `main.tex` first among files at one depth), else the
 * shallowest `main.tex`, else the first `.tex`. Throws when there are none.
 *
 * Depth comes before the name: a vendored template's `tpl/main.tex` used to beat a top-level
 * `root.tex` that holds the real `\documentclass`, and was then compiled and shown in its place.
 */
export async function detectRootFile(files: FileService, projectDir: string): Promise<string> {
  const tex = await files.list(projectDir, { filter: 'tex' });
  const first = tex[0];
  if (!first) {
    throw new Error('No .tex files found in project; specify rootFile explicitly.');
  }

  const topMain = tex.find((f) => f.path === 'main.tex');
  if (topMain) return topMain.path;

  // Stable: files at one depth keep their listing order, apart from `main.tex` going first.
  const ranked = tex
    .map((f, i) => ({ path: f.path, i }))
    .sort(
      (a, b) =>
        depth(a.path) - depth(b.path) ||
        Number(isMain(b.path)) - Number(isMain(a.path)) ||
        a.i - b.i,
    );

  for (const f of ranked) {
    // No baseline: this sniffs every .tex in the project to find the root, and the caller asked for
    // none of them. Recording here would tell the out-of-band-edit guard the server has seen the
    // current bytes of files the user may be hand-editing — and `compile` and the viewer's PDF
    // poller both come through here, so it would keep re-arming all session.
    const { content } = await files.read(projectDir, { path: f.path });
    if (content.includes('\\documentclass')) return f.path;
  }

  return ranked.find((f) => isMain(f.path))?.path ?? first.path;
}
