import { stat } from 'node:fs/promises';
import type { AppContext } from '../context.js';
import type { AnyEditOp, ApplyEditsResult, EditPlan } from '../services/fileService.js';
import { bibEditBlockedMessage, isBibFile } from './bib.js';
import { changedPath } from './changeDiff.js';
import { quoteId } from './projectId.js';
import { resolveInside } from './paths.js';
import {
  createPreserveTransform,
  matchIsCommented,
  resolveRewriteMode,
  supportsLineComments,
  DEFAULT_REWRITE_MODE,
} from './rewriteMode.js';
import type { RewriteMode, ResolvedRewriteMode } from './rewriteMode.js';

/**
 * `edit_file`'s per-file decisions, out of the tool layer so the single-file call and each entry
 * of a `files` call go through the SAME code: the `.bib` gate on the link-resolved name, the
 * effective rewrite mode, the `excludeComments` syntax refusal, and the service's own planning
 * (link check, external-change check, UTF-8 exactness, every edit-level refusal). Nothing here
 * writes; {@link FileService.writeEditPlan} / {@link FileService.writeEditPlans} do.
 */

/** The flags of one `edit_file` call, which apply to every file it names. */
export interface EditCallFlags {
  confirmBibEdit?: boolean;
  overrideExternalChanges?: boolean;
  preserveOriginal?: boolean;
}

export interface PlannedFileEdit {
  plan: EditPlan;
  /** `FileService.linkTarget` of the path: where the bytes land, when that is elsewhere. */
  target: string | null;
  /** The POSIX path the confirmation diff names (the link target for a write through a link). */
  diffPath: string;
  effectiveMode: RewriteMode;
  preservedEdits: number;
  resolved: ResolvedRewriteMode;
  isBib: boolean;
  targetIsBib: boolean;
  eligible: boolean;
}

/**
 * The literal-name `.bib` gate, checked before the project is even resolved (as `edit_file`
 * always has): a caller-named `.bib` without `confirmBibEdit` is refused outright.
 */
export function assertBibConfirmedByName(relPath: string, flags: EditCallFlags): void {
  if (isBibFile(relPath) && !flags.confirmBibEdit) {
    throw new Error(bibEditBlockedMessage(relPath));
  }
}

/**
 * Plan one file's edits under every guard a single-file `edit_file` runs. Must be called inside
 * `ctx.projectManager.runExclusive(id, …)`, as the write that follows must be.
 */
export async function planFileEdit(
  ctx: Pick<AppContext, 'files' | 'rewriteModes' | 'config'>,
  id: string,
  dir: string,
  relPath: string,
  edits: AnyEditOp[],
  flags: EditCallFlags,
): Promise<PlannedFileEdit> {
  const isBib = isBibFile(relPath);
  assertBibConfirmedByName(relPath, flags);
  // Inside the lock, same reasoning as write_file: closes the peer window at no extra cost
  // since every mutator already takes this lock.
  const target = await ctx.files.linkTarget(dir, relPath);
  const targetIsBib = target !== null && isBibFile(target);
  if (targetIsBib && !flags.confirmBibEdit) {
    throw new Error(bibEditBlockedMessage(relPath, target));
  }
  // The only place the effective rewrite mode is derived (the `parseCompilerChoice`
  // lesson) — every other reader of "what mode applies" must call through here.
  const resolved = resolveRewriteMode({
    perCall: flags.preserveOriginal,
    stored: await ctx.rewriteModes.get(id),
    envDefault: ctx.config.rewriteMode ?? DEFAULT_REWRITE_MODE,
  });
  // .bib never preserves (a narrowing on top of the confirmBibEdit gate above, not a
  // replacement for it), and preservation is meaningless outside %-comment documents.
  // Both are judged on the link-resolved name too: the bytes land in the target, so a
  // `notes.tex -> refs.bib` link would otherwise put `%` lines into a bibliography, and
  // a `.tex` link onto a `.md` would comment with a syntax the target does not have.
  // `!isBib` is defensive: '.bib' is absent from LINE_COMMENT_EXTENSIONS, so the
  // extension check below already excludes it — kept so the exemption does not depend
  // on that list.
  const anyBib = isBib || targetIsBib;
  const commentSyntax =
    supportsLineComments(relPath) && (target === null || supportsLineComments(target));
  const eligible = !anyBib && commentSyntax;
  const effectiveMode: RewriteMode = eligible ? resolved.mode : 'off';

  // `excludeComments` is an assertion about which matches must be left alone, so a file
  // with no % comment syntax is refused here rather than filtered against a comment
  // character it does not have — which would silently rewrite every match the caller
  // asked to protect. Judged on the link-resolved name too (as the .bib gate is): the
  // bytes land in the target, so the target's syntax is the one that decides.
  const commentFiltered = edits.findIndex((e) => 'excludeComments' in e && e.excludeComments);
  if (commentFiltered !== -1 && !commentSyntax) {
    const named = target !== null && !supportsLineComments(target) ? target : relPath;
    throw new Error(
      `Edit ${commentFiltered + 1} sets excludeComments, but ${named} has no %-line-comment syntax, so there are no comments to exclude. Drop excludeComments, or target a .tex-family file.`,
    );
  }

  const preserve = createPreserveTransform(effectiveMode);
  const plan = await ctx.files.planEdits(dir, relPath, edits, {
    overrideExternalChanges: flags.overrideExternalChanges,
    preserve,
    excludeMatch: matchIsCommented,
    // Advice on a non-unique refusal only — and only where `%` IS a comment, so a `.md` is never
    // told about comments it does not have.
    commentHint: commentSyntax ? matchIsCommented : undefined,
  });
  return {
    plan,
    target,
    // A write through an in-project link changed the target, so that is the path named.
    diffPath: changedPath(target, relPath),
    effectiveMode,
    preservedEdits: preserve.preservedEdits(),
    resolved,
    isBib,
    targetIsBib,
    eligible,
  };
}

/** The text headline of one file's applied edits — the single-file wording, unchanged. */
export function editHeadline(planned: PlannedFileEdit, res: ApplyEditsResult): string {
  const { preservedEdits, resolved, eligible, isBib, targetIsBib, target } = planned;
  let headline = `applied ${res.appliedEdits} edit(s) to ${res.path}`;
  if (preservedEdits > 0) {
    headline += ` (preserved the original text of ${preservedEdits} edit(s) as comments)`;
  }
  // An explicit preserveOriginal: true/false is an assertion about the MODE, not
  // eligibility (see the compiler-substitution precedent in CLAUDE.md: a substitution
  // the caller did not choose must be named, never applied silently). When the call
  // asserted a non-off mode but the file is ineligible, effectiveMode is silently 'off'
  // in the structured fields — name it in the text instead of adding a new field.
  if (resolved.source === 'call' && resolved.mode !== 'off' && !eligible) {
    const named = target !== null && !supportsLineComments(target) ? target : res.path;
    const reason =
      isBib || targetIsBib
        ? `${targetIsBib && !isBib ? target : res.path} is a .bib file`
        : `${named} has no %-line-comment syntax, so nothing can be preserved there`;
    headline += ` — preserveOriginal was ignored: ${reason}`;
  }
  // Skipped matches are reported in the text channel too, not only in structuredContent:
  // an MCP client that shows only the text would otherwise see "applied 1 edit(s)" for a
  // rename that deliberately left 182 occurrences alone.
  for (const m of res.commentMatches ?? []) {
    headline +=
      `\nedit ${m.edit}: replaced ${m.replaced} occurrence(s), ` +
      `skipped ${m.skippedInComments} inside comments`;
  }
  return headline;
}

/** At most this many entries in one `edit_file` `files` call — the house cap for a list. */
export const EDIT_FILES_MAX = 20;

/**
 * Refuse a `files` list that names one file twice — by spelling (`./a.tex` and `a.tex`), through
 * a link, or by any other alias the filesystem resolves to one entry (judged by `dev:ino`, as the
 * overlay farm judges identity). Two plans over one file would each be computed from the same
 * old bytes, and the second write would silently drop the first's edits. Run before any file is
 * planned, so the refusal is about the list, not about whichever entry happened to fail first.
 */
export async function assertDistinctFiles(dir: string, relPaths: string[]): Promise<void> {
  const seen = new Map<string, string>();
  for (const relPath of relPaths) {
    // An escaping or absolute path is refused here in resolveInside's own words, as planning
    // would refuse it.
    const abs = resolveInside(dir, relPath);
    const keys = [`path:${abs}`];
    try {
      const st = await stat(abs);
      // 0 is what some filesystems report for "no inode number"; never an identity.
      if (st.ino !== 0) keys.push(`ino:${st.dev}:${st.ino}`);
    } catch {
      // Missing or unreadable: planning names the problem for this entry.
    }
    for (const key of keys) {
      const first = seen.get(key);
      if (first !== undefined) {
        throw new Error(
          `files names the same file twice: ${quoteId(first)} and ${quoteId(relPath)}. ` +
            'Put all of its edits in one entry.',
        );
      }
    }
    for (const key of keys) seen.set(key, relPath);
  }
}

/** The inline single-edit fields `edit_file` accepts at top level, as shorthand for `edits`. */
export const INLINE_EDIT_FIELDS = [
  'oldString',
  'newString',
  'replaceAll',
  'excludeComments',
  'startLine',
  'endLine',
] as const;

/** What `edit_file` was asked, before normalisation: the three ways to name the edits. */
export interface EditFileArgs {
  path?: string;
  edits?: AnyEditOp[];
  files?: Array<{ path: string; edits: AnyEditOp[] }>;
  oldString?: string;
  newString?: string;
  replaceAll?: boolean;
  excludeComments?: boolean;
  startLine?: number;
  endLine?: number;
}

/** One file's edits, after normalisation. */
export interface FileEditRequest {
  path: string;
  edits: AnyEditOp[];
}

/**
 * Turn `edit_file`'s arguments into the list of files to edit, refusing every ambiguous mix:
 * `files` with a top-level `path`, `edits` or inline edit field; `edits` with inline fields; and
 * a call naming no edits at all. The inline shorthand (`{path, oldString, newString}` or
 * `{path, startLine, endLine, newString}`) is validated by the same `editItemSchema` an `edits`
 * element is — passed in as `parseEdit`, so an inline edit mixing the two shapes is refused
 * exactly as such an `edits` element would be.
 */
export function normalizeEditArgs(
  args: EditFileArgs,
  parseEdit: (raw: Record<string, unknown>) => AnyEditOp,
): { multi: boolean; files: FileEditRequest[] } {
  const inline: Record<string, unknown> = {};
  for (const key of INLINE_EDIT_FIELDS) {
    if (args[key] !== undefined) inline[key] = args[key];
  }
  const inlineNames = Object.keys(inline);
  if (args.files !== undefined) {
    const extra = [
      ...(args.path !== undefined ? ['path'] : []),
      ...(args.edits !== undefined ? ['edits'] : []),
      ...inlineNames,
    ];
    if (extra.length > 0) {
      throw new Error(
        `files cannot be combined with top-level ${extra.join(', ')}: name each file's path and ` +
          'edits inside its files entry, or drop files and edit one file.',
      );
    }
    if (args.files.length > EDIT_FILES_MAX) {
      throw new Error(
        `files names ${args.files.length} files; at most ${EDIT_FILES_MAX} per call. Split the ` +
          'edits over several calls.',
      );
    }
    return { multi: true, files: args.files };
  }
  if (args.path === undefined) {
    throw new Error(
      'Name the file to edit: path with edits (or one inline edit), or files: [{path, edits}] ' +
        'for several files at once.',
    );
  }
  if (args.edits !== undefined && inlineNames.length > 0) {
    throw new Error(
      'Give the edits either as edits: [...] or as one inline edit, not both (inline field(s) ' +
        `${inlineNames.join(', ')} given beside edits).`,
    );
  }
  if (args.edits !== undefined) {
    return { multi: false, files: [{ path: args.path, edits: args.edits }] };
  }
  if (inlineNames.length === 0) {
    throw new Error(
      'No edits given: pass edits: [{oldString, newString} | {startLine, endLine, newString}], ' +
        'or one such edit inline at top level beside path.',
    );
  }
  return { multi: false, files: [{ path: args.path, edits: [parseEdit(inline)] }] };
}
