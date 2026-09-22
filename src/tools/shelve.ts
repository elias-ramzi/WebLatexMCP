import { z } from 'zod';
import path from 'node:path';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AppContext } from '../context.js';
import { errorResult } from '../lib/errors.js';
import { foldCase } from '../lib/caseFold.js';
import { coversPath, peerOwnership } from '../lib/commitPaths.js';
import { collectPeerShadows } from '../lib/peerAttribution.js';
import { isBibFile } from '../lib/bib.js';
import { resolveInside, toPosix } from '../lib/paths.js';
import { capUnshelveConflict, countLines, planUnshelveFile } from '../lib/shelf.js';
import type { ShelfFileStatus, ShelfManifest, UnshelveConflictFile } from '../lib/shelf.js';
import type { ShelfFileInput } from '../services/shelfStore.js';
import {
  CONFLICT_MAX_FILES,
  CONFLICT_SIDE_CAP,
  CONFLICT_CONTENT_BUDGET,
} from '../lib/conflictBudget.js';

/**
 * `shelve` / `unshelve` / `list_shelves` — issue #86.
 *
 * `push` refuses to rebase over an uncommitted tracked file, and until now every exit it offered
 * either PUBLISHED that file (`commit`, or a `message` on `push`) or DESTROYED it (`discard`).
 * The ordinary case — push section A while section B is mid-sentence — had no safe way out.
 * `shelve` is that exit, and it is deliberately caller-driven: the caller picks the moment, names
 * the paths, and sees the result. It is explicitly NOT an auto-stash inside `push` or
 * `project_sync`; #68 §2 argues against the implicit form and is right.
 *
 * **`git stash` is deliberately not the mechanism.** A stash is a ref inside the shared clone,
 * invisible to every tool here and to every peer session; an unreclaimed `stash@{0}` sat for five
 * days in a real session. The server owning the operation — with a listable, labelled,
 * project-scoped shelf outside the clone — is the whole point.
 *
 * Tools stay thin, as everywhere: the id, the manifest and the conflict capping live in
 * `src/lib/shelf.ts`, the on-disk store in `src/services/shelfStore.ts`, the git probes in
 * `GitService`. What is here is schema, orchestration and formatting.
 */

/**
 * How many shelves one `list_shelves` result names, and how many file entries each one shows.
 *
 * Nothing reaps a shelf — only a successful `unshelve` removes one — so abandoned shelves
 * accumulate on disk forever, and an unbounded listing grows with them. 20 matches the house
 * figure for a capped list (`capList`, `CONFLICT_MAX_FILES`). The cut is a TAIL of the
 * newest-first order, so the shelves a caller is most likely to want are the ones they get, and
 * the omitted ones stay unshelvable by id — this bounds the report, never the store.
 */
const MAX_LISTED_SHELVES = 20;
const MAX_LISTED_FILES_PER_SHELF = 20;

const pathsSchema = z
  .array(z.string())
  .min(1, 'Name at least one path — shelve never guesses which of your changes to set aside.')
  .describe(
    'Project-relative paths to set aside. Matched LITERALLY — no globs, exact case, no ".." ' +
      "segments — exactly as commit's and discard's paths are, so a typo fails loudly instead " +
      'of matching something else. Naming a directory covers the changed files under it. Every ' +
      'named path must actually be changed in the working tree; one that is not is refused ' +
      'rather than silently ignored.',
  );

const confirmBibEditSchema = z
  .boolean()
  .optional()
  .describe(
    'Required (true) when any covered path is a .bib — including one reached through a symlink, ' +
      'since the gate judges the link-resolved name. Same gate as write_file/edit_file: a ' +
      'bibliography is not ordinary prose, and moving one out of (or back into) the tree is not ' +
      'something to do by accident.',
  );

const shelfFileShape = z.object({
  path: z.string().describe('Project-relative, POSIX on every OS.'),
  status: z
    .enum(['modified', 'added', 'deleted'])
    .describe(
      '"modified" — tracked and changed; "added" — untracked, so the shelf holds no HEAD side ' +
        'and shelving REMOVES the file; "deleted" — tracked and removed, so the shelf holds no ' +
        "content side and shelving puts HEAD's copy back.",
    ),
  added: z.number().describe('Lines added relative to HEAD.'),
  removed: z.number().describe('Lines removed relative to HEAD.'),
});

const shelfShape = z.object({
  version: z
    .number()
    .int()
    .describe(
      "The manifest's schema version, currently 1. Server-authored, and informational: this " +
        'server only ever reads back a shelf it wrote itself, so a caller needs it solely to ' +
        'tell two manifest shapes apart if a later one is ever added. Declared rather than ' +
        'dropped because the handlers emit it, and a key the schema omits is one the SDK ' +
        'rejects the whole result over (#146) — it is not a field a caller has to act on.',
    ),
  id: z.string().describe('The shelf id, `sh-` + 8 hex. Pass it to unshelve.'),
  label: z.string().nullable().describe('The caller-supplied label, or null.'),
  createdAt: z.string().describe('ISO 8601.'),
  sessionId: z
    .string()
    .describe(
      'The session that took the shelf. INFORMATIONAL ONLY — shelves are project-scoped, and ' +
        'any session on the project may unshelve this one.',
    ),
  headSha: z
    .string()
    .describe(
      'HEAD when the shelf was taken, or "unborn". unshelve compares the shelf\'s stored base ' +
        'against HEAD as it is NOW, per file, rather than against this — a HEAD that moved ' +
        'without touching the shelved files is not a conflict.',
    ),
  files: z.array(shelfFileShape),
});

/** Resolve the fold once per handler, as `commit` does: the decision is the caller's, never the
 *  lib's. Byte-exact unless the clone says `core.ignorecase`. */
async function foldFor(ctx: AppContext, dir: string): Promise<((p: string) => string) | undefined> {
  return (await ctx.git.isCaseInsensitive(dir)) ? foldCase : undefined;
}

/**
 * Refuse if any live peer owns one of `paths`, and refuse if we cannot tell.
 *
 * **`peerEntries` returning `null` means the index was UNREADABLE, never "owns nothing".** That
 * is the single most likely defect in this whole feature, so it is one shared helper rather than
 * two hand-rolled copies: both operations move content under a path a peer may be editing, which
 * is exactly what `commit scope: "paths"` refuses on, and for the same reason.
 */
async function refuseOnPeerOwnership(
  ctx: AppContext,
  id: string,
  paths: string[],
  fold: ((p: string) => string) | undefined,
  action: 'shelve' | 'unshelve',
): Promise<void> {
  const peers = await ctx.sessions.livePeers(id);
  const entriesBySession = await collectPeerShadows(ctx.shadows, id, peers);
  const { owned, unreadable } = peerOwnership(paths, peers, entriesBySession, fold);
  if (unreadable.length > 0) {
    throw new Error(
      `Cannot tell what live session "${unreadable[0]}" owns (its change index is unreadable), ` +
        `so ${action} refuses. Wait for it to finish, or ask it to commit.`,
    );
  }
  if (owned.length > 0) {
    const named = owned.map((o) => `${o.path} ("${o.sessionId}")`).join(', ');
    throw new Error(
      `Owned by a live session: ${named}. ${
        action === 'shelve'
          ? "Shelving would take that session's in-flight lines out of the working tree"
          : "Unshelving would write over that session's in-flight lines"
      }. Wait for it to commit.`,
    );
  }
}

/**
 * Refuse a `.bib` without `confirmBibEdit`, then refuse a path that is a symlink on any side.
 *
 * **Order is deliberate and is a message-precedence choice, not a weakening.** Both gates refuse,
 * so which fires only decides what the caller is told — and the bibliography message names the
 * real hazard (`figures/x.png` is a link onto `refs.bib`) where the generic link message would
 * hide it. No path either gate would refuse is ever accepted.
 *
 * The `.bib` gate judges the **link-resolved** name as well as the literal one, exactly as
 * `write_file`/`edit_file` do: the bytes land at the far end of the link, so that is what the
 * name-based gate has to look at.
 */
async function refuseOnGuardedPaths(
  ctx: AppContext,
  dir: string,
  paths: string[],
  confirmBibEdit: boolean | undefined,
): Promise<void> {
  if (confirmBibEdit !== true) {
    for (const rel of paths) {
      let judged: string;
      try {
        judged = (await ctx.files.linkTarget(dir, rel)) ?? rel;
      } catch {
        // The link could not be resolved (it escapes, or is unreadable). That is the symlink
        // gate's call to make and it runs next; here we simply fall back to the literal name
        // rather than letting an unresolvable path skip the .bib check entirely.
        judged = rel;
      }
      if (isBibFile(rel) || isBibFile(judged)) {
        const via = isBibFile(rel) ? rel : `${rel} -> ${judged}`;
        throw new Error(
          `Refusing to move a bibliography without confirmation: ${via}. Pass ` +
            'confirmBibEdit: true if that is really what you mean.',
        );
      }
    }
  }

  const links = await ctx.git.linkPathsAmong(dir, paths);
  if (links.length > 0) {
    throw new Error(
      `Refusing a symbolic link: ${links.join(', ')}. This operation writes file CONTENT at a ` +
        'path, and writing through a link puts the bytes wherever the link points — possibly ' +
        'outside the project. A path that could not be judged at all counts as a link here, on ' +
        'purpose. Resolve the link by hand, or name the real file.',
    );
  }
}

/** The dirty paths a shelve may take: everything `status` reports as changed, in one list. */
function dirtyPathsOf(status: {
  staged: string[];
  unstaged: string[];
  untracked: string[];
}): string[] {
  return [...new Set([...status.staged, ...status.unstaged, ...status.untracked])].map(toPosix);
}

export function registerShelve(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'shelve',
    {
      title: 'Set uncommitted work aside, outside the clone',
      description:
        "Take the named paths' working-tree content OUT of the clone into a shelf held beside " +
        "it, and restore those paths to HEAD. The exit push's dirty-tree refusal points at: the " +
        'only one that neither publishes your work (commit, or a message on push) nor destroys ' +
        'it (discard). Bring it back with unshelve. ' +
        'Deliberately NOT git stash: a stash is a ref inside the shared clone, invisible to every ' +
        'tool here and to every peer session, which is how one sits unreclaimed for days. A shelf ' +
        'lives under <workspace>/.sessions/<project>/, is labelled, and is listable. ' +
        'Shelves are PROJECT-scoped, not session-scoped — any session on this project can list ' +
        'and unshelve one, which is the point. ' +
        'Refuses, taking nothing, when a live peer session owns one of the paths, or when it ' +
        "cannot read that peer's change index to tell (an unreadable index is never read as " +
        '"owns nothing"). Refuses a .bib without confirmBibEdit, and a path that is a symbolic ' +
        'link on any side. Mutating: takes the per-project lock.',
      inputSchema: {
        project: z.string().optional(),
        paths: pathsSchema,
        label: z
          .string()
          .max(200)
          .optional()
          .describe('A short note to recognise this shelf by in list_shelves. Free text.'),
        confirmBibEdit: confirmBibEditSchema,
      },
      outputSchema: {
        shelf: shelfShape,
        restored: z
          .array(z.string())
          .describe(
            'The paths put back to HEAD (POSIX); untracked ones were removed. Staged paths are ' +
              'refused before this point rather than appearing here, because restoring one to ' +
              'HEAD does not actually clear it from the tree.',
          ),
      },
    },
    async ({ project, paths, label, confirmBibEdit }) => {
      try {
        // FIRST, before anything reads the directory: a local project has no HEAD of ours to
        // restore to, and shelving there would act on whatever repository happens to contain the
        // user's own directory.
        ctx.projectManager.requireGitProject(project, 'shelve work in');
        const { id, dir } = await ctx.projectManager.requireProjectDir(project);
        return await ctx.projectManager.runExclusive(id, async () => {
          const fold = await foldFor(ctx, dir);
          const status = await ctx.git.status(dir);
          const dirty = dirtyPathsOf(status);

          // Literal matching, like commit's and discard's: a named path covers the dirty paths
          // under it, and a name that covers nothing is refused rather than quietly dropped.
          const covered = dirty.filter((d) => paths.some((p) => coversPath(p, d, fold)));
          const uncovered = paths.filter((p) => !dirty.some((d) => coversPath(p, d, fold)));
          if (uncovered.length > 0) {
            throw new Error(
              `Nothing to shelve at: ${uncovered.join(', ')} — not changed in the working tree. ` +
                'Paths are matched literally: no globs, exact case, and no ".." segments.',
            );
          }

          await refuseOnGuardedPaths(ctx, dir, covered, confirmBibEdit);
          await refuseOnPeerOwnership(ctx, id, covered, fold, 'shelve');

          // A STAGED path is refused outright, before anything is written. `discard`'s
          // path-limited branch runs `git checkout -- <paths>` with no index reset, so it
          // restores from the INDEX, not HEAD — and `clean -f` cannot remove a staged new file.
          // Shelving a staged path therefore reported success while leaving the content in the
          // tree: the push this tool exists to unblock still refused, the work was duplicated,
          // and the shelf could never be reclaimed because unshelve then saw a dirty tree.
          // `revert` already refuses anything staged, for its own reasons; this refuses only the
          // paths it was asked about, and says how to get out.
          const staged = new Set(status.staged.map(toPosix));
          const stagedCovered = covered.filter((p) => staged.has(p));
          if (stagedCovered.length > 0) {
            throw new Error(
              `Staged, so shelve refuses: ${stagedCovered.join(', ')}. Shelving restores a path ` +
                'to HEAD, and a staged change would survive that and leave the work in the tree ' +
                'with a shelf that can never be reclaimed. Unstage first (`git reset` those ' +
                'paths), or commit them.',
            );
          }

          const untracked = new Set(status.untracked.map(toPosix));
          const stats = new Map(
            (
              await ctx.git.statAgainstHead(
                dir,
                covered.filter((p) => !untracked.has(p)),
              )
            ).map((f) => [toPosix(f.path), f]),
          );

          const files: ShelfFileInput[] = [];
          for (const rel of covered) {
            const abs = resolveInside(dir, rel);
            const content = await readFile(abs).catch((err: NodeJS.ErrnoException) => {
              if (err.code === 'ENOENT') return null; // deleted in the working tree
              throw err;
            });
            const base = untracked.has(rel) ? null : await ctx.git.readAtRefBytes(dir, 'HEAD', rel);
            const status_: ShelfFileStatus =
              content === null ? 'deleted' : base === null ? 'added' : 'modified';
            const stat = stats.get(rel);
            files.push({
              path: rel,
              status: status_,
              // An untracked file never appears in `git diff HEAD` — see statAgainstHead — so its
              // lines are counted here, from the bytes actually being taken, rather than made up.
              added: stat?.added ?? (status_ === 'added' && content ? countLines(content) : 0),
              removed: stat?.removed ?? (status_ === 'deleted' && base ? countLines(base) : 0),
              content,
              base,
            });
          }

          // THE SHELF IS FULLY ON DISK BEFORE THE WORKING TREE IS TOUCHED. This ordering is not
          // an implementation detail: a crash between the two leaves a shelf whose content is
          // still in the tree — visible, recoverable, at worst a no-op restore. The opposite
          // order loses the work outright.
          const manifest = await ctx.shelves.create(id, {
            label: label ?? null,
            headSha: await ctx.git.headSha(dir),
            files,
          });

          // Reuses discard rather than growing a second path-limited checkout: it already
          // resolves case onto the index spelling, restricts `checkout` to the tracked subset,
          // `clean -f`s the untracked remainder, and carries --literal-pathspecs everywhere. The
          // covered set came from `git status`, so it and discard's pathspecs agree exactly.
          await ctx.git.discard(dir, covered);
          // The tree was rewritten under the caller; without this the next edit_file throws
          // ExternalChangeError for a change the server itself made.
          ctx.files.resetBaselines(dir);
          // Settle, and deliberately do NOT record. Taking content out is what a path-limited
          // discard does to the tree, so it does to the records what that does: settle the named
          // paths in EVERY session, because a peer holding a stale entry would re-install these
          // very lines at its next session-scoped commit (the hazard CLAUDE.md names for revert).
          // Never clearAll — this is path-limited, and dropping a peer's record for a file
          // nothing happened to is what lets a later scope:"paths" take its lines. And no record
          // afterwards, unlike revert: the tree now equals HEAD for these paths, so there is
          // nothing for anyone to own.
          await ctx.shadows.settleAll(id, covered, fold);
          // Same heartbeat its sibling takes. shelve bypasses FileService entirely for its
          // reads, so without this a session whose only activity is shelving ages toward
          // STALE_MS and starts reading dead to peers — which is what the ownership refusals
          // above are consulted for.
          try {
            await ctx.sessions.touch(id);
          } catch (err) {
            process.stderr.write(`shelve: session heartbeat failed: ${String(err)}\n`);
          }

          const lines = manifest.files.map(
            (f) => `  ${f.path} (${f.status}, +${f.added}/-${f.removed})`,
          );
          const text = [
            `shelved ${manifest.files.length} file(s) as ${manifest.id}` +
              (manifest.label ? ` — "${manifest.label}"` : ''),
            ...lines,
            `  bring it back with unshelve { id: "${manifest.id}" }`,
          ].join('\n');
          return {
            content: [{ type: 'text' as const, text }],
            structuredContent: { shelf: { ...manifest }, restored: covered },
          };
        });
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

/** Sides of a conflict report are decoded as UTF-8. See the schema note: the SHELF holds the
 *  exact bytes either way, so a lossy decode here costs a display, never data. */
function asText(b: Buffer | null): string | null {
  return b === null ? null : b.toString('utf8');
}

/**
 * What to hand `ShadowStore.record` — text when the bytes are text, the Buffer only when they
 * are genuinely binary. The same transform `revert` applies, and for the same reason:
 * `record` sets a STICKY `binary` flag for any `Buffer` argument, and a binary entry is never
 * three-way merged. Passing a `.tex` file's Buffer through therefore makes every later
 * same-file/different-paragraph edit by a peer a permanent `conflicted` entry instead of the
 * silent merge the shadow design exists to do — and nothing would say so except `shadow.json`.
 */
function asShadowContent(bytes: Buffer | null): string | Buffer | null {
  if (bytes === null) return null;
  return bytes.includes(0) ? bytes : bytes.toString('utf8');
}

export function registerUnshelve(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'unshelve',
    {
      title: 'Put a shelf back into the working tree',
      description:
        'Restore a shelf taken by shelve. Any session on the project can unshelve any of its ' +
        'shelves — they are project-scoped by design. ' +
        'REFUSES rather than overwrites: if the working tree has changed under a shelved path, ' +
        'or HEAD has moved so the shelved edit no longer applies to the content it was made ' +
        'against, nothing is written, the tree is left exactly as it was, and the SHELF IS LEFT ' +
        'INTACT. The refusal reports base/ours/theirs per file the way a push conflict does, ' +
        'rather than writing conflict markers into your files — so resolving the collision and ' +
        'calling unshelve again recovers every byte, including any the report had to elide. ' +
        'A successful unshelve REMOVES the shelf; an unshelve that refuses does not. ' +
        'Refuses a .bib without confirmBibEdit, a path that is a symbolic link on any side, and ' +
        "a path a live peer session owns (or one it cannot read that peer's index to judge). " +
        'Mutating: takes the per-project lock.',
      inputSchema: {
        project: z.string().optional(),
        id: z
          .string()
          .describe('The shelf id from shelve or list_shelves — `sh-` followed by 8 hex digits.'),
        confirmBibEdit: confirmBibEditSchema,
      },
      outputSchema: {
        restored: z
          .boolean()
          .describe('True when the shelf was written back and removed; false on a refusal.'),
        shelf: shelfShape.optional().describe('The shelf that was restored. Absent on a refusal.'),
        files: z
          .array(z.string())
          .optional()
          .describe('Paths written (or removed, for a "deleted" entry). Absent on a refusal.'),
        conflicts: z
          .array(
            z.object({
              path: z.string(),
              reason: z
                .enum(['dirty', 'head-moved'])
                .describe(
                  '"dirty" — the working tree changed under this path since the shelve, so ' +
                    'restoring would overwrite live content. "head-moved" — HEAD\'s content for ' +
                    'this path is no longer what the shelved edit was made against, so ' +
                    'restoring would silently drop whatever landed in between.',
                ),
              base: z
                .string()
                .nullable()
                .describe("HEAD's content when the shelf was taken; null if the file was new."),
              ours: z.string().nullable().describe('What is in the working tree now.'),
              theirs: z
                .string()
                .nullable()
                .describe('The shelved content; null if the shelf recorded a deletion.'),
              elided: z
                .object({
                  base: z.number().optional(),
                  ours: z.number().optional(),
                  theirs: z.number().optional(),
                })
                .optional()
                .describe(
                  "Present only for sides CUT for size, giving each one's true character " +
                    'count. A null side WITHOUT an entry here means the side is genuinely ' +
                    'absent (the file was added, or deleted) — never confuse the two.',
                ),
            }),
          )
          .optional()
          .describe(
            'Present only on a refusal. Sides are UTF-8 decoded for display; the shelf itself ' +
              'holds the exact bytes, so a binary file reads oddly here and restores exactly.',
          ),
        conflictPaths: z
          .array(z.string())
          .optional()
          .describe(
            'Every conflicting path. Never capped and never elided — this is the list ' +
              'you need in order to act.',
          ),
        note: z
          .string()
          .optional()
          .describe('Names whichever cap actually fired, and never one that did not.'),
      },
    },
    async ({ project, id: shelfId, confirmBibEdit }) => {
      try {
        ctx.projectManager.requireGitProject(project, 'unshelve work in');
        const { id, dir } = await ctx.projectManager.requireProjectDir(project);
        return await ctx.projectManager.runExclusive(id, async () => {
          // assertShelfId runs inside ShelfStore.read, BEFORE any path join — the id is
          // interpolated into a filesystem path, so it never reaches one partly validated.
          const shelf = await ctx.shelves.read(id, shelfId);
          if (!shelf) {
            throw new Error(
              `No shelf "${shelfId}" on this project. Run list_shelves to see what is ` +
                'outstanding. (A shelf whose manifest is missing or unreadable is not a shelf: ' +
                'a half-written one is invisible rather than corrupt, by design.)',
            );
          }
          const manifest = shelf.manifest;
          const rels = manifest.files.map((f) => f.path);

          const fold = await foldFor(ctx, dir);
          await refuseOnGuardedPaths(ctx, dir, rels, confirmBibEdit);
          await refuseOnPeerOwnership(ctx, id, rels, fold, 'unshelve');

          const status = await ctx.git.status(dir);
          // Folded, like every other by-name comparison in this file. `git status` reports the
          // spelling that is ON DISK, so on an ignorecase clone a shelf entry for `notes.tex`
          // never matched a live `Notes.tex` and the dirty check silently passed — on exactly
          // the platforms (macOS, Windows) where core.ignorecase is git's default.
          const key = (rel: string): string => (fold ? fold(rel) : rel);
          const dirtyNow = new Set(dirtyPathsOf(status).map(key));

          // Read every side BEFORE writing anything: the conflict check and the rollback both
          // need the current bytes, and a check that read as it wrote could leave half a shelf
          // applied over a collision it had not reached yet.
          const current = new Map<string, Buffer | null>();
          const headNow = new Map<string, Buffer | null>();
          for (const rel of rels) {
            current.set(
              rel,
              await readFile(resolveInside(dir, rel)).catch((err: NodeJS.ErrnoException) => {
                if (err.code === 'ENOENT') return null;
                throw err;
              }),
            );
            headNow.set(rel, await ctx.git.readAtRefBytes(dir, 'HEAD', rel));
          }

          const conflicts: UnshelveConflictFile[] = [];
          for (const file of manifest.files) {
            const rel = file.path;
            const shelved = await shelf.content(rel);
            const base = await shelf.base(rel);
            // The decision is a pure function over bytes (src/lib/shelf.ts), deliberately: it
            // used to be inline here, had no seam anyone could unit-test, and silently
            // overwrote a user's file at a path `git status` declines to report. `dirty` is
            // git's own answer rather than a byte comparison, because only git applies the
            // path's clean filter (the #63 defect); everything else planUnshelveFile decides
            // from the bytes themselves.
            const verdict = planUnshelveFile({
              base,
              shelved,
              current: current.get(rel) ?? null,
              headNow: headNow.get(rel) ?? null,
              dirty: dirtyNow.has(key(rel)),
            });
            if (verdict.kind !== 'conflict') continue;
            conflicts.push({
              path: rel,
              reason: verdict.reason,
              base: asText(base),
              ours: asText(current.get(rel) ?? null),
              theirs: asText(shelved),
            });
          }

          if (conflicts.length > 0) {
            const plan = capUnshelveConflict(conflicts, {
              maxFiles: CONFLICT_MAX_FILES,
              sideCap: CONFLICT_SIDE_CAP,
              // All three of #68's bounds, not two. The per-side cap and the file cap alone let
              // 20 files x 3 sides x 12000 characters through with nothing individually over a
              // cap — 720k, `truncated: false`, and the result undeliverable.
              totalBudget: CONFLICT_CONTENT_BUDGET,
            });
            const header =
              `unshelve refused: ${plan.paths.length} path(s) would be overwritten or no ` +
              `longer apply. NOTHING was written and shelf ${manifest.id} is intact.`;
            const lines = plan.files.map((f) => `  ${f.path} (${f.reason})`);
            const rest =
              plan.paths.length > plan.files.length
                ? [`  … all conflicting paths: ${plan.paths.join(', ')}`]
                : [];
            const text = [header, ...lines, ...rest, plan.note ? `  note: ${plan.note}` : '']
              .filter(Boolean)
              .join('\n');
            return {
              content: [{ type: 'text' as const, text }],
              structuredContent: {
                restored: false,
                conflicts: plan.files.map((f) => ({ ...f })),
                conflictPaths: plan.paths,
                note: plan.note || undefined,
              },
            };
          }

          // No conflicts. Write, with a rollback that puts every touched path back exactly as it
          // was if any write fails — the same unwind rule resolvePush follows, so a failed
          // restore never leaves the tree half-applied.
          const written: string[] = [];
          try {
            for (const file of manifest.files) {
              const rel = file.path;
              // Pushed BEFORE the write, not after. `writeFile` can fail part-way (ENOSPC, EIO)
              // and leave a truncated file, and the path most likely to be damaged is exactly
              // the one that threw — which an after-the-write push excludes from the rollback.
              written.push(rel);
              const abs = resolveInside(dir, rel);
              const shelved = await shelf.content(rel);
              if (shelved === null) {
                // The shelf recorded a deletion: restoring it deletes the file again.
                await rm(abs, { force: true });
              } else {
                await mkdir(path.dirname(abs), { recursive: true });
                await writeFile(abs, shelved);
              }
            }
          } catch (err) {
            for (const rel of written) {
              const abs = resolveInside(dir, rel);
              const before = current.get(rel) ?? null;
              if (before === null) await rm(abs, { force: true });
              else await writeFile(abs, before);
            }
            throw err;
          }

          // The tree was rewritten under the caller — without this the next edit_file throws
          // ExternalChangeError for a change the server itself made.
          ctx.files.resetBaselines(dir);

          // From here the bytes are ON DISK and the call has succeeded. Nothing below may fail
          // it: throwing now would report "the unshelve failed" over one that landed, inviting a
          // retry that restores twice. Each step gets its OWN try/catch, not one around all of
          // them — under a single try a failed `touch` would skip the settle and leave every
          // peer's stale entry standing, which is the silent re-install the settle prevents.
          try {
            await ctx.sessions.touch(id);
          } catch (err) {
            process.stderr.write(`unshelve: session heartbeat failed: ${String(err)}\n`);
          }
          try {
            // Settle then record, exactly as revert does: the restored bytes are content no
            // session currently owns, so ownership is decided rather than observed. settleAll
            // first across EVERY session (a peer's stale entry would otherwise re-install the
            // pre-unshelve content at its next session commit), then record into THIS session,
            // which is the one that asked for the restore.
            await ctx.shadows.settleAll(id, rels, fold);
          } catch (err) {
            process.stderr.write(`unshelve: settling peer records failed: ${String(err)}\n`);
          }
          for (const file of manifest.files) {
            try {
              await ctx.shadows.record(
                id,
                dir,
                file.path,
                // `before` is the bytes actually captured immediately before the write — exact,
                // not convenient. A three-way merge against the wrong base is how a shadow ends
                // up carrying lines nobody wrote.
                asShadowContent(current.get(file.path) ?? null),
                asShadowContent(await shelf.content(file.path)),
              );
            } catch (err) {
              process.stderr.write(`unshelve: recording ${file.path} failed: ${String(err)}\n`);
            }
          }

          // Only now, with the content demonstrably back in the tree, is the shelf dropped. A
          // refusal above never reaches this, which is what makes "the shelf is intact" true.
          //
          // Guarded like everything else past the write, and it sits UNDER the comment that says
          // so: an unguarded rm here (EACCES, or EBUSY/ENOTEMPTY on Windows, which this repo's
          // own bareRepo helper documents and retries for) would report "the unshelve failed"
          // over one that fully landed. The caller would retry, hit the now-restored tree, and
          // get a conflict whose `ours` and `theirs` are identical.
          let shelfRemoved = true;
          try {
            await ctx.shelves.remove(id, manifest.id);
          } catch (err) {
            shelfRemoved = false;
            process.stderr.write(
              `unshelve: removing shelf ${manifest.id} failed: ${String(err)}\n`,
            );
          }

          const text = [
            `unshelved ${manifest.id}` + (manifest.label ? ` — "${manifest.label}"` : ''),
            ...manifest.files.map((f) => `  ${f.path} (${f.status})`),
            shelfRemoved
              ? '  the shelf has been removed'
              : `  NOTE: the content is restored, but shelf ${manifest.id} could not be removed ` +
                'and will still appear in list_shelves. Unshelving it again will report a ' +
                'conflict whose sides are identical — that is this, not lost work.',
          ].join('\n');
          return {
            content: [{ type: 'text' as const, text }],
            structuredContent: { restored: true, shelf: { ...manifest }, files: rels },
          };
        });
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}

export function registerListShelves(server: McpServer, ctx: AppContext): void {
  server.registerTool(
    'list_shelves',
    {
      title: 'List the work set aside on this project',
      description:
        'Every outstanding shelf on the project, newest first. Read-only, and takes NO lock. ' +
        "A peer's shelve/unshelve DOES rewrite this directory concurrently, so that is not the " +
        'reason: what makes the lock-free read safe is that a shelf becomes visible only when ' +
        'its manifest lands, the manifest is written last, and it is written atomically — so a ' +
        'shelf mid-write is skipped, never half-read. ' +
        "Shelves are project-scoped, so this lists every session's, not just this one's — an " +
        'invisible per-session shelf is exactly the unreclaimed git stash this feature replaces. ' +
        'A shelf directory with no readable manifest is skipped rather than reported as empty.',
      inputSchema: { project: z.string().optional() },
      outputSchema: {
        shelves: z.array(shelfShape),
        shelvesOmitted: z
          .number()
          .describe(
            `Shelves past the ${MAX_LISTED_SHELVES}-per-call cap, oldest first — they still ` +
              'exist and are still unshelvable by id. A shelf is removed only by a successful ' +
              'unshelve, so an abandoned one accumulates; this bounds the REPORT, never the ' +
              'store.',
          ),
        filesOmitted: z
          .number()
          .describe(
            `Per-shelf file entries past the ${MAX_LISTED_FILES_PER_SHELF} listed for each ` +
              "shelf, summed. Each shelf's own files[] is truncated, never reordered.",
          ),
      },
    },
    async ({ project }) => {
      try {
        ctx.projectManager.requireGitProject(project, 'list shelves for');
        const { id } = await ctx.projectManager.requireProjectDir(project);
        const all: ShelfManifest[] = await ctx.shelves.list(id);
        // Bounded in both dimensions. Every field here is document-shaped (a `\label`-adjacent
        // path, a caller-supplied label) and nothing ever reaps a shelf, so an unbounded listing
        // grows without limit — the same class of defect #68 fixed for push conflicts and #80
        // for the floats payload, and the same answer: cut a tail, count it, never reorder.
        const shelves = all.slice(0, MAX_LISTED_SHELVES).map((s) => ({
          ...s,
          files: s.files.slice(0, MAX_LISTED_FILES_PER_SHELF),
        }));
        const shelvesOmitted = all.length - shelves.length;
        const filesOmitted = all
          .slice(0, MAX_LISTED_SHELVES)
          .reduce((n, s) => n + Math.max(0, s.files.length - MAX_LISTED_FILES_PER_SHELF), 0);
        const text =
          all.length === 0
            ? 'no shelves on this project'
            : [
                `${shelves.length} of ${all.length} shelf/shelves, newest first:`,
                ...shelves.map(
                  (s) =>
                    `  ${s.id}${s.label ? ` — "${s.label}"` : ''} · ${s.files.length} file(s) · ` +
                    `${s.createdAt} · taken by "${s.sessionId}"`,
                ),
                shelvesOmitted > 0
                  ? `  … ${shelvesOmitted} older shelf/shelves not listed (still unshelvable by id)`
                  : '',
                filesOmitted > 0 ? `  … ${filesOmitted} file entr(ies) not listed` : '',
              ]
                .filter(Boolean)
                .join('\n');
        return {
          content: [{ type: 'text' as const, text }],
          structuredContent: {
            shelves: shelves.map((s) => ({ ...s })),
            shelvesOmitted,
            filesOmitted,
          },
        };
      } catch (err) {
        return errorResult(err, ctx.credentials.allSecrets());
      }
    },
  );
}
