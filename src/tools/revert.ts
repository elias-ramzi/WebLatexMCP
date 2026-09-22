import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import type { DiffFile } from '../services/gitService.js';
import { errorResult } from '../lib/errors.js';
import { foldCase } from '../lib/caseFold.js';
import { isBibFile, bibEditBlockedMessage } from '../lib/bib.js';
import { toPosix } from '../lib/paths.js';

const inputSchema = {
  project: z.string().optional(),
  commits: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      'Commit shas to revert, newest first. Matched literally. Applied in the order given, in one ' +
        'git revert --no-commit, so a later one may depend on an earlier one being undone first.',
    ),
  confirm: z.literal(true).describe('Must be true — revert rewrites the working tree.'),
  expectRef: z
    .string()
    .optional()
    .describe(
      'A commit-ish the reverted files should end up matching — normally the commit before the one ' +
        'being reverted. Compared over the reverted paths only, and reported as matchesRef.',
    ),
  confirmBibEdit: z
    .boolean()
    .optional()
    .describe('Required when a reverted commit touches a .bib bibliography file.'),
};

const outputSchema = {
  status: z.enum(['reverted', 'conflict']),
  reverted: z.boolean(),
  commits: z.array(z.string()),
  files: z.array(z.object({ path: z.string(), added: z.number(), removed: z.number() })),
  filesChanged: z.number(),
  matchesRef: z
    .boolean()
    .nullable()
    .describe('Whether the reverted paths now match expectRef. null when expectRef was not given.'),
  expectRef: z
    .string()
    .nullable()
    .describe(
      'The commit-ish matchesRef was judged against, as the caller spelled it (validated to resolve ' +
        'in this clone). null when it was not given.',
    ),
  mismatchedFiles: z.array(z.object({ path: z.string(), added: z.number(), removed: z.number() })),
  conflictPaths: z.array(z.string()),
  oursRef: z.string().nullable(),
  theirsRef: z.string().nullable(),
};

/**
 * A shadow entry's content, as TEXT whenever the bytes are text. `ShadowStore.record` flags an
 * entry `binary` when EITHER side arrives as a Buffer, stickily and for the life of the entry —
 * and a binary entry is never three-way merged: `refresh` marks it `conflicted` outright as soon
 * as HEAD moves to different bytes. Handing it Buffers unconditionally would therefore wedge
 * every reverted `.tex`: one peer commit touching that file and this session's revert is excluded
 * from `scope: "session"` permanently, escapable only by `scope: "all"` or a discard. The
 * "no such thing as a merged PNG" rationale for `binary` does not apply to a reverted LaTeX file,
 * so decode when the content IS text and keep the Buffer only when it genuinely is not.
 *
 * A NUL byte is the test, the same one git itself uses to call a blob binary — cheap, and it
 * never mis-reads UTF-8 text as binary.
 */
function asShadowContent(bytes: Buffer | null): string | Buffer | null {
  if (bytes === null) return null;
  return bytes.includes(0) ? bytes : bytes.toString('utf8');
}

export function registerRevert(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'revert',
    {
      title: 'Revert commits into the working tree',
      description:
        'Undo one or more committed changes, leaving the result uncommitted in the working tree ' +
        'so it can be reviewed with `diff` and landed with `commit`. Commits are matched ' +
        'literally and applied in the order given. Destructive — requires confirm=true. Refuses ' +
        'a merge commit (it would need a mainline), a path that is or lies under a symbolic ' +
        'link, a path with uncommitted changes (commit or discard those first), anything staged ' +
        'anywhere in the clone (aborting a conflicted revert resets the whole index, which would ' +
        'destroy staged work), and a .bib bibliography unless confirmBibEdit=true. On a conflict ' +
        'nothing is changed on disk: the revert is aborted and the conflicting paths are named.',
      inputSchema,
      outputSchema,
    },
    async ({ project, commits, expectRef, confirmBibEdit }) => {
      try {
        // Git-backed: a local project would have this operate on whatever repository happens to
        // contain the user's own directory, so refuse it before anything else.
        ctx.projectManager.requireGitProject(project, 'revert commits in');
        const { id, dir } = await ctx.projectManager.requireProjectDir(project);
        return await ctx.projectManager.runExclusive(id, async () => {
          // Mutating tool: in-process mutex AND cross-process lock file, so a sibling agent
          // session over the same clone cannot interleave with the revert.
          const pre = await ctx.git.revertPreflight(dir, commits, expectRef);

          // Refusals, in precedence order. Each one throws before `revertApply` touches anything.
          if (pre.mergeCommits.length > 0) {
            throw new Error(
              `Merge commit(s): ${pre.mergeCommits.join(', ')}. Reverting a merge needs a ` +
                'mainline (which parent to keep), and `revert` deliberately does not take one — ' +
                'pick the side you meant and revert its own commits instead.',
            );
          }
          if (pre.linkPaths.length > 0) {
            const named = pre.linkPaths
              .map(
                (p) =>
                  `"${p}" is a symbolic link (or lies under one); reverting it would write ` +
                  'outside the project.',
              )
              .join(' ');
            throw new Error(`${named} Refused — a link out is never followed here.`);
          }
          const bibPaths = pre.touchedPaths.filter((p) => isBibFile(p));
          // Same `!== true` shape as every other `confirmBibEdit` gate in the tool layer: an
          // optional boolean, so an omitted or false value refuses identically.
          if (bibPaths.length > 0 && confirmBibEdit !== true) {
            const first = bibPaths[0] ?? '';
            throw new Error(
              `${bibEditBlockedMessage(first)}${
                bibPaths.length > 1
                  ? ` The reverted commits also touch: ${bibPaths.slice(1).join(', ')}.`
                  : ''
              }`,
            );
          }
          if (pre.dirtyPaths.length > 0) {
            throw new Error(
              `Uncommitted changes at: ${pre.dirtyPaths.join(', ')}. Reverting would overwrite ` +
                "them (they may be another session's in-flight work), and git itself refuses to " +
                'do that. Commit or discard those paths first, then retry.',
            );
          }

          // Staged content ANYWHERE in the clone, not only under the reverted paths. A revert
          // that conflicts can only be undone with `git revert --abort`, and that is a
          // `reset --merge` to the stored head: verified against real git, it silently resets the
          // whole index, so a peer session's `git add`ed file on a path this revert never touches
          // comes back at HEAD with its staged work destroyed — the same loss that makes a
          // whole-tree `reset --hard` forbidden as a restore path here. Refusing while anything is
          // staged is what makes the abort *provably* safe rather than usually safe: with an index
          // equal to HEAD, the abort has nothing to destroy. It is checked up front because by the
          // time a conflict is known the damage would already be unavoidable.
          if (pre.stagedPaths.length > 0) {
            throw new Error(
              `Staged changes at: ${pre.stagedPaths.join(', ')}. If this revert conflicted it ` +
                "would have to be aborted, and git's abort resets the whole index — that staged " +
                "work (possibly another session's) would be lost. Land it with `commit` and " +
                'scope: "all" (or scope: "paths" naming them) — the DEFAULT session scope stages ' +
                "this session's own shadow, not a hand-staged index, so it would not land that " +
                'work at all. Every scope resets the index to HEAD first, so either way the ' +
                'staged state is cleared; `git reset` does it directly if you have a shell. Then ' +
                'retry.',
            );
          }

          const res = await ctx.git.revertApply(dir, pre.commits, pre.touchedPaths, expectRef);

          if (res.status === 'conflict') {
            // `revertApply` aborted: the tree is exactly as it was, so there is nothing to
            // un-record. No content is returned either — `read_file` takes a `ref`, so both
            // sides are one call away and nothing here needs budgeting the way `push`'s
            // rendered conflict payload does.
            const oursRef = 'HEAD';
            // Spelled the one way docs/tools.md's opening line promises ("file paths are always
            // POSIX, on every OS"), from one conversion feeding the text channel and
            // `structuredContent` alike — `mismatchedFiles` on the success path already was, and
            // `files`/`conflictPaths` were not, which is how one result came to carry two
            // spellings of the same kind of data (#148 §2). git's own output is `/`-separated, so
            // this changes nothing on any platform; it makes the rule uniform. Note what stays
            // native: `pre.touchedPaths` is what `settleAll`, `readAtRefBytes` and `readBytes`
            // are given below, and is never converted — the trap `toPosixOut`'s doc comment names.
            const conflictPaths = res.conflictPaths.map(toPosix);
            // Only when ONE commit with ONE parent was reverted does a single ref name what the
            // revert would restore. For a multi-commit revert each commit restores its own
            // parent, and a root commit has none — `<sha>^` would not even resolve. Null then,
            // rather than pointing the caller at a ref that answers a different question.
            const theirsRef = pre.restoreRef;
            const text = [
              `revert conflicted — nothing changed on disk (the revert was aborted).`,
              `conflicting: ${conflictPaths.join(', ')}`,
              theirsRef === null
                ? `Read the current content with read_file and ref "${oursRef}". Each reverted ` +
                  'commit restores its own parent, so read the side you want at that commit' +
                  "'s own parent. Resolve by editing the files yourself, or revert a narrower " +
                  'set of commits.'
                : `Read either side with read_file and a ref: "${oursRef}" for the current ` +
                  `content, "${theirsRef}" for what the revert would restore. Resolve by ` +
                  'editing the files yourself, or revert a narrower set of commits.',
            ].join('\n');
            return {
              content: [{ type: 'text', text }],
              structuredContent: {
                status: res.status,
                reverted: false,
                commits: res.commits,
                files: [],
                filesChanged: res.filesChanged,
                matchesRef: null,
                expectRef: expectRef ?? null,
                mismatchedFiles: [],
                conflictPaths,
                oursRef,
                theirsRef,
              },
            };
          }

          // The revert rewrote these files, so without this the next `edit_file` on one would
          // throw ExternalChangeError for a change the SERVER made. `resetBaselines` is
          // dir-wide (there is no per-path variant), so this also drops the out-of-band-edit
          // claim for files the revert never touched — a known, accepted over-reset, the same
          // one `discard` takes.
          ctx.files.resetBaselines(dir);

          // Register this session as live BEFORE claiming any lines. `SessionRegistry.touch` is
          // what creates `session.json`, and `runExclusive`'s lock file does not — so a session
          // whose first mutation is a revert (`project_sync` -> `diff` -> `revert` touches
          // nothing else) would own a `shadow.json` with no session record, `peers()` would drop
          // it, and a peer's `commit scope: "paths"` or `push` would sweep up the reverted lines
          // as owned by nobody. Same order as `createSessionRecorder`: touch, then record.
          //
          // Then settle the reverted paths in EVERY session's record — never `clearAll`, which
          // would drop peers' records for files nothing happened to and let a later
          // `commit scope: "paths"` sweep up those peers' lines as if nobody owned them. Across
          // sessions because a peer holding a stale shadow entry for a reverted path would, at
          // its next session-scoped commit, stage that shadow's content through `commitContents`
          // and re-install the very lines just reverted. Folded exactly when git folds
          // (`core.ignorecase`), like `commit`/`discard`: a session's entry can be keyed under a
          // different spelling than the one the revert named.
          //
          // Both steps run AFTER the revert is on disk, so neither may fail the call: the record
          // loop below already follows that rule, and a throw here would report "the revert
          // failed" over a revert that landed — inviting a retry that reverts twice. Log instead;
          // the cost is attribution, which is what the loop's own failure path also trades away.
          //
          // They are caught SEPARATELY, and that separation is the point. The heartbeat and the
          // settle are independent, and only the settle protects a PEER: under one `try` a failed
          // `touch` skips `settleAll` entirely, leaving every peer's stale entry standing — which
          // is precisely the silent re-install this block exists to prevent, now reachable through
          // an unrelated disk error. `createSessionRecorder` splits them for the same reason, in
          // its own words: its failure "says nothing about the shadow".
          let touchErr: unknown;
          try {
            await ctx.sessions.touch(id);
          } catch (err) {
            touchErr = err;
          }
          try {
            // A clone whose `core.ignorecase` cannot be read is settled BYTE-EXACT rather than not
            // at all: missing a peer entry that differs only in ASCII case is a far smaller loss
            // than leaving every peer's entry for every reverted path standing, and byte-exact is
            // what the rest of the server falls back to anyway.
            let fold: ((p: string) => string) | undefined;
            try {
              if (await ctx.git.isCaseInsensitive(dir)) fold = foldCase;
            } catch (err) {
              console.error(
                '[web-latex-mcp] could not read core.ignorecase after the revert; settling the ' +
                  `reverted paths byte-exact: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
            await ctx.shadows.settleAll(id, pre.touchedPaths, fold);
          } catch (err) {
            console.error(
              '[web-latex-mcp] the revert landed, but settling the reverted paths across ' +
                `sessions failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          if (touchErr !== undefined) {
            console.error(
              '[web-latex-mcp] the revert landed, but registering this session as live failed, ' +
                'so its lines may read as owned by nobody: ' +
                `${touchErr instanceof Error ? touchErr.message : String(touchErr)}`,
            );
          }

          // Own the reverted lines. `before` is HEAD's bytes, and that is correct rather than a
          // shortcut: the dirty-path refusal above proved the working tree equalled HEAD for
          // every touched path, so HEAD's bytes ARE the pre-revert content. Without a record the
          // reverted lines would be owned by nobody, a default session-scoped `commit` would
          // stage nothing, and the "review with diff, land with commit" story would not work.
          // No `recordBaseline`: the default false is right, since a path that writes nothing
          // must claim nothing. `strictLinks` because these paths come from git, not the caller.
          // Paths the revert RESTORED — see the text below for why they are collected here.
          const restored: string[] = [];
          for (const rel of pre.touchedPaths) {
            try {
              const beforeBytes = await ctx.git.readAtRefBytes(dir, 'HEAD', rel);
              // No blob at HEAD means the revert restored this path (it undid a deletion). The
              // scoped unstage drops from the index every path HEAD does not have, so such a file
              // ends up UNTRACKED — and `git diff` ignores untracked files entirely, so the
              // `diff` this tool points the caller at shows nothing for it. Collected so the text
              // can say so; an empty diff must not read as "the revert did nothing".
              if (beforeBytes === null) restored.push(rel);
              const before = asShadowContent(beforeBytes);
              const after = asShadowContent(
                await ctx.files.readBytes(dir, { path: rel, strictLinks: true }),
              );
              await ctx.shadows.record(id, dir, rel, before, after);
            } catch (err) {
              // The revert is ALREADY on disk by now, so this must never fail the call — the same
              // rule `FileService.notify` follows: losing attribution is a far smaller problem
              // than reporting an error for a change that actually landed, and a thrown error
              // here would also abandon every remaining path in the loop unrecorded. Until #66
              // §7 this was not hypothetical but ROUTINE: `readBytes` was capped at the 2 MiB
              // *text* cap, so any revert restoring a figure this server had itself imported
              // landed here and left the path flagged for good. It now has its own
              // `MAX_BINARY_READ_BYTES` (derived from `MAX_ASSET_BYTES`), so that case is gone.
              // The branch is not decorative without it: an unreadable file, a permission
              // change, or a blob genuinely past the binary cap still reach it.
              //
              // Fail closed instead, exactly as `createSessionRecorder` does: flag the path
              // `conflicted` + `unrecorded` so a peer's `commit scope: "paths"` REFUSES it rather
              // than reading it as owned by nobody and sweeping up lines this session is
              // responsible for. Only a deliberate take or a discard ends that state.
              try {
                await ctx.shadows.markUnrecorded(id, rel);
              } catch (markErr) {
                console.error(
                  `[web-latex-mcp] could not mark "${rel}" unrecorded after its revert shadow ` +
                    `record failed: ${markErr instanceof Error ? markErr.message : String(markErr)}`,
                );
              }
              console.error(
                `[web-latex-mcp] could not attribute the revert of "${rel}" to this session: ` +
                  `${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }

          // Measured by `revertApply` itself, against the index while the revert still sat in it —
          // a comparison made out here, after the unstage, cannot see a file the revert RESTORED
          // (it is untracked by then, and `git diff <ref>` ignores untracked files), and reported
          // an exactly-correct revert as a mismatch. Scoped to the reverted paths, never the whole
          // tree, or a peer's unrelated dirty file would make an exact revert report `false`. With
          // NO reverted paths, or no `expectRef`, `revertApply` returns `null` and `matchesRef`
          // stays `null`: `true` over an empty set is the one answer an assertion must never give,
          // since it would read as "verified exact" having verified nothing.
          const mismatchedFiles: DiffFile[] = (res.mismatchedFiles ?? []).map((f) => ({
            ...f,
            path: toPosix(f.path),
          }));
          const matchesRef: boolean | null =
            res.mismatchedFiles === null ? null : mismatchedFiles.length === 0;

          // As on the conflict branch above: one conversion each, for both channels. `restored`
          // holds `pre.touchedPaths` entries, so it is converted HERE for display only — the
          // array itself was handed to git and to `FileService` untouched.
          const files = res.files.map((f) => ({ ...f, path: toPosix(f.path) }));
          const conflictPaths = res.conflictPaths.map(toPosix);
          const restoredOut = restored.map(toPosix);
          const added = files.reduce((sum, f) => sum + f.added, 0);
          const removed = files.reduce((sum, f) => sum + f.removed, 0);
          const shas = pre.commits.map((c) => c.slice(0, 8)).join(', ');
          const text = [
            `reverted ${shas} — ${res.filesChanged} file(s), +${added} -${removed}, ` +
              'not committed',
            ...files.map((f) => `  ${f.path} +${f.added} -${f.removed}`),
            matchesRef === null
              ? ''
              : matchesRef
                ? `the reverted paths now match "${expectRef ?? ''}"`
                : `the reverted paths do NOT match "${expectRef ?? ''}": ` +
                  mismatchedFiles.map((f) => `${f.path} +${f.added} -${f.removed}`).join(', '),
            restoredOut.length === 0
              ? ''
              : `restored, and therefore untracked — \`diff\` does NOT show ` +
                `${restoredOut.length === 1 ? 'it' : 'them'} (git diff ignores untracked files); ` +
                `read ${restoredOut.length === 1 ? 'it' : 'them'} with \`read_file\` or see ` +
                `\`status\`: ${restoredOut.join(', ')}`,
            'Nothing is committed — review with `diff`, then land it with `commit`.',
          ]
            .filter(Boolean)
            .join('\n');

          return {
            content: [{ type: 'text', text }],
            structuredContent: {
              status: res.status,
              reverted: true,
              commits: res.commits,
              files,
              filesChanged: res.filesChanged,
              matchesRef,
              expectRef: expectRef ?? null,
              mismatchedFiles,
              conflictPaths,
              oursRef: null,
              theirsRef: null,
            },
          };
        });
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}
