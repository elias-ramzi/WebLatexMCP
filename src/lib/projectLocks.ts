import { Mutex } from 'async-mutex';

/**
 * The in-process half of `ProjectManager.runExclusive`: one mutex per project id, shared by every
 * session scope in the process (`createSharedServices`, `src/context.ts`).
 *
 * Each scope keeps its own `ProjectManager` — session-only registrations, pins and the in-process
 * default are that session's own and must not leak to another — but two scopes of one process
 * queue on one project here, in order and without polling, so only one of them ever reaches the
 * lock file (docs/design/shared-server.md §6). The lock file alone would still keep them apart
 * (`isAbandoned` reads a lock held by this process and thread as live while `heldTokens` has it),
 * but by polling, in no particular order. Hence one table, handed to every scope's manager.
 *
 * `lastHolder` names the session that last released a project's mutex, so a call that waited on
 * the mutex can say who it waited on (`LockAcquisition.waitedOn`) — another scope of this process,
 * or its own session's earlier call.
 */
export class ProjectLocks {
  private readonly entries = new Map<string, { mutex: Mutex; lastHolder?: string }>();

  /** The entry for `id`, created on first use. */
  entry(id: string): { mutex: Mutex; lastHolder?: string } {
    let found = this.entries.get(id);
    if (!found) {
      found = { mutex: new Mutex() };
      this.entries.set(id, found);
    }
    return found;
  }
}
