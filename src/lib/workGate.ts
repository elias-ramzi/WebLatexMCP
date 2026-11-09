/**
 * A first-in, first-out limit on how many heavy jobs run at once in this process: `latexmk` or
 * tectonic compiles and pdf.js document loads (`render_pages`, `extract_text`, `pdf_geometry`,
 * `compile`'s page count). One gate serves every session of a shared server
 * (`createSharedServices`), so N sessions compiling at once queue instead of running N TeX
 * processes and N pdf.js documents side by side (docs/design/shared-server.md §1, measured memory).
 *
 * Callers take a slot **inside** `runExclusive`: a job waiting here holds its project lock, never a
 * slot while waiting for a lock, so a slot is only ever held by work that is running. A waiter in
 * the shared server waits on the in-process mutex, which has no timeout, so a queued compile does
 * not make a peer's `LockTimeoutError` likelier there.
 *
 * Never rejects on its own; a job's error is the caller's, and its slot is released either way.
 */
export class WorkGate {
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError(`WorkGate limit must be a positive integer, got ${String(limit)}`);
    }
  }

  /** Jobs running now. */
  get active(): number {
    return this.running;
  }

  /** Jobs waiting for a slot. */
  get waiting(): number {
    return this.queue.length;
  }

  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.running < this.limit) {
      this.running++;
    } else {
      // The releasing job hands its slot straight to us (`running` unchanged), so a newcomer
      // arriving between the release and our wake-up cannot jump the queue.
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    try {
      return await job();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.running--;
    }
  }
}

/** The default limit, when `WEB_LATEX_MCP_MAX_PARALLEL_BUILDS` is unset. */
export const DEFAULT_MAX_PARALLEL_BUILDS = 2;
/** The highest limit the setting accepts. */
export const MAX_PARALLEL_BUILDS_CEILING = 32;
