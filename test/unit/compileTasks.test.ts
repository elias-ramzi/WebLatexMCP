import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { TaskStore, TASK_TTL_MS } from '../../src/services/taskStore.js';
import { progressReader } from '../../src/services/compiler.js';
import { execCapture } from '../../src/lib/exec.js';

describe('TaskStore', () => {
  it('runs work in the background: working, then completed with its result', async () => {
    const store = new TaskStore();
    let finish!: (v: Record<string, unknown>) => void;
    const task = store.start(() => new Promise((r) => (finish = r)), 'Starting.');
    expect(task).toMatchObject({
      status: 'working',
      statusMessage: 'Starting.',
      ttlMs: TASK_TTL_MS,
    });
    expect(store.get(task.taskId)?.status).toBe('working');
    await new Promise((r) => setTimeout(r, 0));
    finish({ content: [] });
    await expect.poll(() => store.get(task.taskId)?.status).toBe('completed');
    expect(store.get(task.taskId)).toMatchObject({ result: { content: [] } });
    expect(store.get(task.taskId)?.statusMessage).toBeUndefined();
  });

  it('reports progress while working, and only then', async () => {
    const store = new TaskStore();
    let progress!: (m: string) => void;
    let finish!: () => void;
    const { taskId } = store.start(
      (run) =>
        new Promise((r) => {
          progress = run.progress;
          finish = () => r({});
        }),
    );
    await new Promise((r) => setTimeout(r, 0));
    progress('latexmk: run 2 of pdflatex');
    expect(store.get(taskId)?.statusMessage).toBe('latexmk: run 2 of pdflatex');
    finish();
    await expect.poll(() => store.get(taskId)?.status).toBe('completed');
    progress('late');
    expect(store.get(taskId)?.statusMessage).toBeUndefined();
  });

  it('fails on a throw, and cancels on request whatever the work returns', async () => {
    const store = new TaskStore();
    const failed = store.start(async () => {
      throw new Error('boom');
    });
    await expect.poll(() => store.get(failed.taskId)?.status).toBe('failed');
    expect(store.get(failed.taskId)?.error).toEqual({ code: -32603, message: 'boom' });

    let seen: AbortSignal | undefined;
    const cancelled = store.start(
      (run) =>
        new Promise((r) => {
          seen = run.signal;
          run.signal.addEventListener('abort', () => r({ content: [] }));
        }),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(store.cancel(cancelled.taskId)).toBe(true);
    await expect.poll(() => store.get(cancelled.taskId)?.status).toBe('cancelled');
    expect(seen?.aborted).toBe(true);
    expect(store.cancel('unknown')).toBe(false);
    expect(store.get('unknown')).toBeUndefined();
  });

  it('aborts every running task when the session closes', async () => {
    const store = new TaskStore();
    let seen: AbortSignal | undefined;
    const { taskId } = store.start(
      (run) =>
        new Promise(() => {
          seen = run.signal;
        }),
    );
    await new Promise((r) => setTimeout(r, 0));
    store.close();
    expect(seen?.aborted).toBe(true);
    expect(store.get(taskId)).toBeUndefined();
  });
});

describe('progressReader', () => {
  it('passes on latexmk pass announcements, reassembled across chunks, and nothing else', () => {
    const seen: string[] = [];
    const read = progressReader('latexmk', (m) => seen.push(m))!;
    read('Latexmk: applying rule ...\nRun num');
    read("ber 1 of rule 'pdflatex'\nThis is pdfTeX, Version 3.14\n");
    read("Run number 2 of rule 'biber'\n");
    read("Run number 3 of rule 'injected; rm -rf'\n");
    expect(seen).toEqual(['latexmk: run 1 of pdflatex', 'latexmk: run 2 of biber']);
    expect(progressReader('latexmk', undefined)).toBeUndefined();
  });

  it('reads tectonic passes', () => {
    const seen: string[] = [];
    const read = progressReader('tectonic', (m) => seen.push(m))!;
    read('note: Running TeX ...\nnote: Rerunning TeX because "main.aux" changed\n');
    expect(seen).toEqual(['tectonic: running TeX', 'tectonic: rerunning TeX']);
  });
});

describe.skipIf(process.platform === 'win32')('execCapture with a signal', () => {
  it('kills the child and the processes it started', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wlm-killtree-'));
    try {
      const pidFile = path.join(dir, 'grandchild.pid');
      const abort = new AbortController();
      const run = execCapture('sh', ['-c', `sleep 30 & echo $! > "${pidFile}"; wait`], {
        signal: abort.signal,
        timeoutMs: 20_000,
      });
      let grandchild = 0;
      await expect
        .poll(async () => {
          grandchild = Number((await readFile(pidFile, 'utf8').catch(() => '')).trim());
          return grandchild > 0;
        })
        .toBe(true);
      abort.abort();
      const res = await run;
      expect(res.aborted).toBe(true);
      await expect
        .poll(() => {
          try {
            process.kill(grandchild, 0);
            return 'alive';
          } catch {
            return 'gone';
          }
        })
        .toBe('gone');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
