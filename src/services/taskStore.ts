import { randomUUID } from 'node:crypto';

/**
 * The tasks a session runs in the background (#290): MCP's Tasks extension
 * (`io.modelcontextprotocol/tasks`, SEP-2663), where a `tools/call` answers with a task the client
 * polls (`tasks/get`) and can cancel (`tasks/cancel`) instead of holding the call open.
 *
 * One store per session scope (`createSessionContext`), so a task is reachable from the session
 * that started it — under the shared server, each 2026-07-28 request builds a fresh server, and the
 * scope is what outlives them. In memory only: a task does not survive the process, and a client
 * polling after a restart is told the task is unknown.
 *
 * A finished task is kept for {@link TASK_TTL_MS} so a client polling late still reads its result,
 * then dropped; a running one is never dropped. Status transitions are one-way: `working` →
 * `completed` | `failed` | `cancelled`, the first to land wins.
 */

/** How long a finished task stays readable. Reported as the task's `ttlMs`. */
export const TASK_TTL_MS = 60 * 60 * 1000;
/** How often a client should poll (`pollIntervalMs`). A build takes seconds to minutes. */
export const TASK_POLL_INTERVAL_MS = 2_000;

export type TaskStatus = 'working' | 'completed' | 'failed' | 'cancelled';

/** A task as `tasks/get` reports it: SEP-2663's `DetailedTask` (minus `input_required`). */
export interface DetailedTask {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs: number;
  /** The call's own result, `completed` only (a tool result with `isError` included). */
  result?: Record<string, unknown>;
  /** The JSON-RPC error that failed it, `failed` only. */
  error?: { code: number; message: string };
}

interface TaskRecord {
  task: DetailedTask;
  abort: AbortController;
  dropTimer?: NodeJS.Timeout;
}

/** What a task's work is handed: the cancellation signal and a way to report a pass. */
export interface TaskRun {
  signal: AbortSignal;
  progress: (message: string) => void;
}

export class TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /**
   * Start `work` in the background and return its task, already `working` — readable through
   * {@link get} before this returns, as SEP-2663 requires of a task handed to a client. A result
   * is `completed`; a throw is `failed` (a JSON-RPC internal error); a run whose signal was
   * aborted is `cancelled` whatever it returned, since what it built is incomplete.
   */
  start(
    work: (run: TaskRun) => Promise<Record<string, unknown>>,
    statusMessage?: string,
  ): DetailedTask {
    const stamp = this.now().toISOString();
    const record: TaskRecord = {
      task: {
        taskId: randomUUID(),
        status: 'working',
        ...(statusMessage !== undefined ? { statusMessage } : {}),
        createdAt: stamp,
        lastUpdatedAt: stamp,
        ttlMs: TASK_TTL_MS,
        pollIntervalMs: TASK_POLL_INTERVAL_MS,
      },
      abort: new AbortController(),
    };
    this.tasks.set(record.task.taskId, record);
    const run: TaskRun = {
      signal: record.abort.signal,
      progress: (message) => this.update(record, { statusMessage: message }),
    };
    void Promise.resolve()
      .then(() => work(run))
      .then(
        (result) =>
          record.abort.signal.aborted
            ? this.finish(record, { status: 'cancelled', statusMessage: 'Cancelled.' })
            : this.finish(record, { status: 'completed', result }),
        (err: unknown) =>
          record.abort.signal.aborted
            ? this.finish(record, { status: 'cancelled', statusMessage: 'Cancelled.' })
            : this.finish(record, {
                status: 'failed',
                error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
              }),
      );
    return { ...record.task };
  }

  /** The task's current state, or `undefined` for an id this session does not know. */
  get(taskId: string): DetailedTask | undefined {
    const record = this.tasks.get(taskId);
    return record ? { ...record.task } : undefined;
  }

  /**
   * Ask a running task to stop (its signal aborts; the work decides when it has). `false` for an
   * id this session does not know; `true` otherwise, a finished task included (nothing to do).
   */
  cancel(taskId: string): boolean {
    const record = this.tasks.get(taskId);
    if (!record) return false;
    if (record.task.status === 'working') {
      this.update(record, { statusMessage: 'Cancelling…' });
      record.abort.abort();
    }
    return true;
  }

  /** Abort every running task and forget them all (the session is closing). */
  close(): void {
    for (const record of this.tasks.values()) {
      record.abort.abort();
      clearTimeout(record.dropTimer);
    }
    this.tasks.clear();
  }

  private update(record: TaskRecord, change: Partial<DetailedTask>): void {
    if (record.task.status !== 'working') return;
    record.task = { ...record.task, ...change, lastUpdatedAt: this.now().toISOString() };
  }

  private finish(record: TaskRecord, change: Partial<DetailedTask>): void {
    if (record.task.status !== 'working') return;
    const { statusMessage: _previous, ...task } = record.task;
    record.task = { ...task, ...change, lastUpdatedAt: this.now().toISOString() };
    record.dropTimer = setTimeout(() => this.tasks.delete(record.task.taskId), TASK_TTL_MS);
    record.dropTimer.unref?.();
  }
}
