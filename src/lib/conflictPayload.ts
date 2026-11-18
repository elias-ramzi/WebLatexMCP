import { z } from 'zod';
import type { ConflictReport } from '../services/gitService.js';
import { renderConflictText, buildConflictFilePayload, capRemoteCommits } from './conflictText.js';
import {
  planConflictPayload,
  CONFLICT_MAX_FILES,
  CONFLICT_MAX_SPANS,
  CONFLICT_MAX_COMMITS,
  CONFLICT_MAX_COMMIT_FILES,
} from './conflictBudget.js';

/**
 * The rebase-conflict payload shared by `push` and `project_sync` mode "rebase": the zod pieces
 * both `outputSchema`s declare, and the one builder both tools call, so a conflict reaches the
 * caller in the same shape, budgeted the same way, whichever tool's rebase hit it.
 */

const conflictHunkSchema = z.object({
  startLine: z.number(),
  endLine: z.number(),
  local: z.array(z.string()),
  remote: z.array(z.string()),
});

const conflictElisionSchema = z.object({
  chars: z.number().describe('The TRUE (untruncated) character count of the elided part.'),
  ref: z
    .string()
    .optional()
    .describe(
      'Sides only. Normally the read_file(path, ref) call that fetches this part in full — but ' +
        'when the two histories are unrelated there is no merge base to read the `base` side ' +
        'from, and this instead states that, so check it looks like a call before issuing one.',
    ),
  count: z.number().optional().describe('hunks only: how many hunks were elided.'),
  spans: z
    .array(z.object({ startLine: z.number(), endLine: z.number() }))
    .optional()
    .describe(
      'hunks only: the line span each elided hunk covered in the conflicted working file — ' +
        `capped at the first ${CONFLICT_MAX_SPANS}; \`count\` is the true total, so \`count > ` +
        'spans.length` means the rest were dropped.',
    ),
});

/** `null` is ambiguous by itself: "absent" (added/deleted) and "elided for size" both look like
 * `null`. The `elided.<key>` entry is what tells them apart — see `conflictFileSchema.elided`. */
const nullSideDescribe = (label: string, key: 'base' | 'ours' | 'theirs'): string =>
  `Full content ${label}, or null. null with no matching \`elided.${key}\` entry means the file ` +
  `did not exist on this side (added/deleted); null WITH an \`elided.${key}\` entry means the ` +
  "content was dropped to fit the payload budget — fetch it via that entry's `ref`.";

export const conflictFileSchema = z.object({
  path: z.string(),
  base: z
    .string()
    .nullable()
    .describe(nullSideDescribe('at the merge-base (common ancestor)', 'base')),
  ours: z.string().nullable().describe(nullSideDescribe('of our (local) version', 'ours')),
  theirs: z
    .string()
    .nullable()
    .describe(nullSideDescribe('of the remote version that landed', 'theirs')),
  hunks: z
    .array(conflictHunkSchema)
    .describe(
      'Marker view of just the overlapping regions. Empty when elided for size — see `elided.hunks`.',
    ),
  elided: z
    .object({
      base: conflictElisionSchema.optional(),
      ours: conflictElisionSchema.optional(),
      theirs: conflictElisionSchema.optional(),
      hunks: conflictElisionSchema.optional(),
    })
    .optional()
    .describe(
      'Present iff some part of this file was dropped to fit the payload budget (conflictDetail: ' +
        '"auto", the default). Absent when everything for this file fit, or when conflictDetail: ' +
        '"full" was requested.',
    ),
});

export const diffFileSchema = z.object({
  path: z.string(),
  added: z.number(),
  removed: z.number(),
});

export const remoteCommitSchema = z.object({
  hash: z.string(),
  message: z.string(),
  files: z
    .array(diffFileSchema)
    .describe(
      'Files the commit touched, with added/removed line counts — enough to see what a remote ' +
        '"Update on Overleaf." commit changed without a shell. For the content, use `diff` with ' +
        'ref: "<hash>~1..<hash>".',
    ),
  filesOmitted: z
    .number()
    .optional()
    .describe(
      `Files beyond the first ${CONFLICT_MAX_COMMIT_FILES} of this commit, not listed above — ` +
        'diff with ref: "<hash>~1..<hash>" for the full list. Only present on a conflict result ' +
        'with conflictDetail: "auto" (the default) when this commit touched more.',
    ),
});

/** The conflict keys of an `outputSchema`, identical in `push` and `project_sync`. */
export const conflictOutputFields = {
  conflictFiles: z.array(conflictFileSchema).optional(),
  conflictPaths: z.array(z.string()).optional(),
  rebasedOnto: z.string().optional(),
  remoteHead: z.string().optional(),
  mergeBase: z.string().nullable().optional(),
  remoteCommits: z
    .array(remoteCommitSchema)
    .optional()
    .describe(
      `On a conflict result with conflictDetail: "auto" (the default), capped at ${CONFLICT_MAX_COMMITS} ` +
        `commits (each with at most ${CONFLICT_MAX_COMMIT_FILES} files, see \`filesOmitted\`) — see ` +
        '`remoteCommitsOmitted` for how many more landed. Uncapped for conflictDetail: "full", and ' +
        'uncapped on a successful push (rebasedOver).',
    ),
  remoteCommitsOmitted: z
    .number()
    .optional()
    .describe(
      `Commits beyond the ${CONFLICT_MAX_COMMITS} listed in \`remoteCommits\`, not present there — ` +
        'status.behindCommits lists them all, since the clone is back at its pre-rebase state ' +
        'after a conflict aborts the rebase. Present only on a conflict result with ' +
        'conflictDetail: "auto" when something was actually omitted.',
    ),
  conflictTruncated: z
    .boolean()
    .optional()
    .describe(
      'True iff conflictDetail: "auto" cut anything to fit the payload budget — a file in ' +
        `conflictFiles carries an \`elided\` entry, or conflicted files past ${CONFLICT_MAX_FILES} ` +
        'got no per-file block at all (still listed in conflictPaths). Absent unless the result ' +
        'is a conflict.',
    ),
};

/**
 * The structured conflict keys and the text rendering, both from ONE `planConflictPayload` call:
 * the plan object is passed verbatim to `buildConflictFilePayload` and `renderConflictText`, so
 * the two channels can never disagree about what got cut.
 */
export function conflictPayload(
  conflict: ConflictReport,
  detail: 'auto' | 'full',
): { fields: Record<string, unknown>; text: (summary: string) => string } {
  const plan = planConflictPayload(conflict.files, {
    detail,
    refs: { mergeBase: conflict.mergeBase, rebasedOnto: conflict.rebasedOnto },
  });
  const fields: Record<string, unknown> = {
    conflictFiles: buildConflictFilePayload(conflict, plan),
    conflictPaths: conflict.conflictPaths,
    rebasedOnto: conflict.rebasedOnto,
    remoteHead: conflict.remoteHead,
    mergeBase: conflict.mergeBase,
  };
  // "full" is the escape hatch for a caller that wants the complete payload and can take the
  // size — lifting the per-file caps but leaving remoteCommits capped would be inconsistent.
  if (detail === 'full') {
    fields.remoteCommits = conflict.remoteCommits;
  } else {
    const capped = capRemoteCommits(conflict.remoteCommits);
    fields.remoteCommits = capped.commits;
    if (capped.omitted > 0) fields.remoteCommitsOmitted = capped.omitted;
  }
  fields.conflictTruncated = plan.truncated;
  return {
    fields,
    text: (summary) => renderConflictText(summary, conflict, { plan, detail }),
  };
}
