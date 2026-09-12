import type { MutationRecorder } from '../services/fileService.js';

/**
 * Dependencies `createSessionRecorder` needs, kept as plain functions rather than the concrete
 * services (`ProjectManager`, `SessionRegistry`, `ShadowStore`) so this module — and its tests —
 * never have to construct a real clone or a real git repository.
 */
export interface SessionRecorderDeps {
  /** Resolve a clone directory to the project id it belongs to, or `undefined` for anything else. */
  idForDir(dir: string): string | undefined;
  isLocal(id: string): boolean;
  touch(id: string): Promise<void>;
  record(
    id: string,
    dir: string,
    rel: string,
    before: string | Buffer | null,
    after: string | Buffer | null,
  ): Promise<void>;
  markUnrecorded(id: string, rel: string): Promise<void>;
  /** Defaults to `console.error`, prefixed like every other stderr line this server logs. */
  warn?: (msg: string) => void;
}

/**
 * Builds the `MutationRecorder` wired into `FileService` — the seam where every write this server
 * makes is folded into the acting session's shadow, so `commit` can later stage that session's
 * lines alone.
 *
 * `FileService.notify` never fails the write when this throws — it logs to stderr and moves on
 * (the file is already on disk; losing attribution is a far smaller problem than reporting an
 * error for a change that actually landed). That means a `record` failure otherwise leaves the
 * session with an edit in the working tree and *no* shadow index entry for it: a peer's
 * `commit scope: "paths"` would see the path as owned by nobody and sweep it up, and the session's
 * own `commit` would silently omit it. `markUnrecorded` closes that gap by flagging the path
 * `conflicted` (which is what actually excludes it and keeps it sticky) even though the shadow
 * itself could not be updated — fail closed, the same way an unreadable peer index is treated as
 * owning everything rather than nothing.
 *
 * `touch` is only a liveness heartbeat (so a session that merely writes still shows up to peers
 * before it commits) — it says nothing about whether *this* change made it into the shadow, so
 * its failure alone must never mark the path. It runs in its own try/catch, and `record` still
 * runs whether or not `touch` succeeded; only `record` throwing (with or without a prior touch
 * failure) marks the path unrecorded. A touch failure that did not stop a successful `record` is
 * still real and still worth logging — but not by rethrowing it: `FileService.notify` logs every
 * throw from this function as "could not attribute the change ... to this session", which would
 * be false here (the change *was* attributed; only the heartbeat failed) and would send a future
 * reader after the wrong bug. So it is logged directly, via `warn`, instead.
 */
export function createSessionRecorder(deps: SessionRecorderDeps): MutationRecorder {
  const warn = deps.warn ?? ((msg: string) => console.error(`[web-latex-mcp] ${msg}`));

  return {
    async record(dir, rel, before, after) {
      const id = deps.idForDir(dir);
      if (!id) return; // not one of our clones — nothing to attribute it to

      // Shadows exist so a commit carries one session's lines and nobody else's. A local project
      // is never committed by this server, and reading `HEAD` there would mean reading whatever
      // repository happens to contain the user's directory — so it is left out entirely.
      if (deps.isLocal(id)) return;

      // Editing is what makes a session worth knowing about, so this doubles as its heartbeat —
      // otherwise a session that only writes would stay invisible to its peers until it committed.
      // Its own failure says nothing about the shadow, so it is captured, not thrown, here.
      let touchErr: unknown;
      try {
        await deps.touch(id);
      } catch (err) {
        touchErr = err;
      }

      try {
        await deps.record(id, dir, rel, before, after);
      } catch (err) {
        try {
          await deps.markUnrecorded(id, rel);
        } catch (markErr) {
          warn(
            `could not mark "${rel}" unrecorded after its shadow record failed for session ` +
              `attribution: ${markErr instanceof Error ? markErr.message : String(markErr)}`,
          );
        }
        // Rethrow so FileService.notify still logs the original failure — this function only adds
        // the fail-closed marking, it never swallows the reason the record itself failed.
        throw err;
      }

      if (touchErr !== undefined) {
        // record() succeeded, so the path stays unmarked. Warn directly rather than rethrowing:
        // FileService.notify would log any throw here as a failed attribution, which is not what
        // happened — the change was recorded fine, only the liveness heartbeat failed.
        warn(
          `heartbeat for project "${id}" failed while recording "${rel}" (the change itself ` +
            `was recorded): ${touchErr instanceof Error ? touchErr.message : String(touchErr)}`,
        );
      }
    },
  };
}
