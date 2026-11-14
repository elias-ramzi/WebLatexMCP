import { describe, it, expect } from 'vitest';
import { WorkGate } from '../../src/lib/workGate.js';
import { gatedCompiler, gatedRenderer } from '../../src/services/gatedWork.js';
import { parseMaxParallelBuilds } from '../../src/config.js';
import type { LatexCompiler } from '../../src/services/compiler.js';
import type { PdfRenderService } from '../../src/services/pdfRender.js';

/** A job the test finishes by hand, recording when it started. */
function deferred(log: string[], name: string) {
  let finish!: () => void;
  let fail!: (e: Error) => void;
  const done = new Promise<string>((resolve, reject) => {
    finish = () => resolve(name);
    fail = reject;
  });
  return {
    job: () => {
      log.push(`start ${name}`);
      return done;
    },
    finish,
    fail,
  };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('WorkGate', () => {
  it('runs at most `limit` jobs, and starts the rest in arrival order', async () => {
    const gate = new WorkGate(2);
    const log: string[] = [];
    const jobs = ['a', 'b', 'c', 'd'].map((n) => deferred(log, n));
    const results = jobs.map((j) => gate.run(j.job));
    await tick();
    expect(log).toEqual(['start a', 'start b']);
    expect([gate.active, gate.waiting]).toEqual([2, 2]);

    jobs[1]!.finish();
    await tick();
    expect(log).toEqual(['start a', 'start b', 'start c']);

    // A newcomer arriving as a slot frees does not jump the queue.
    const e = deferred(log, 'e');
    const late = gate.run(e.job);
    jobs[0]!.finish();
    await tick();
    expect(log.slice(3)).toEqual(['start d']);

    jobs[2]!.finish();
    jobs[3]!.finish();
    await tick();
    expect(log.at(-1)).toBe('start e');
    e.finish();
    expect(await Promise.all([...results, late])).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect([gate.active, gate.waiting]).toEqual([0, 0]);
  });

  it("frees the slot when a job fails, and hands the caller the job's error", async () => {
    const gate = new WorkGate(1);
    const log: string[] = [];
    const bad = deferred(log, 'bad');
    const next = deferred(log, 'next');
    const failing = gate.run(bad.job);
    const waiting = gate.run(next.job);
    bad.fail(new Error('latexmk exploded'));
    await expect(failing).rejects.toThrow('latexmk exploded');
    await tick();
    expect(log).toEqual(['start bad', 'start next']);
    next.finish();
    await expect(waiting).resolves.toBe('next');
    expect(gate.active).toBe(0);
  });

  it('refuses a limit that is not a positive integer', () => {
    expect(() => new WorkGate(0)).toThrow(RangeError);
    expect(() => new WorkGate(1.5)).toThrow(RangeError);
  });
});

describe('the gated compiler and renderer', () => {
  it('queue compiles and PDF loads behind one gate, but never the availability probes', async () => {
    const gate = new WorkGate(1);
    const log: string[] = [];
    const build = deferred(log, 'compile');
    const compiler: LatexCompiler = {
      isAvailable: async () => true,
      compile: () => build.job() as never,
    };
    const renderer = {
      canRasterize: async () => true,
      pageCount: async () => {
        log.push('start pageCount');
        return 3;
      },
    } as unknown as PdfRenderService;
    const c = gatedCompiler(compiler, gate);
    const r = gatedRenderer(renderer, gate);

    const compiling = c.compile({} as never);
    const counting = r.pageCount('/x.pdf');
    await tick();
    expect(log).toEqual(['start compile']);
    // Probes answer while the slot is taken.
    await expect(c.isAvailable()).resolves.toBe(true);
    await expect(r.canRasterize()).resolves.toBe(true);

    build.finish();
    await compiling;
    await expect(counting).resolves.toBe(3);
    expect(log).toEqual(['start compile', 'start pageCount']);
  });
});

describe('WEB_LATEX_MCP_MAX_PARALLEL_BUILDS', () => {
  it('defaults to 2 and accepts a whole number from 1 to 32', () => {
    expect(parseMaxParallelBuilds(undefined)).toBe(2);
    expect(parseMaxParallelBuilds('  ')).toBe(2);
    expect(parseMaxParallelBuilds(' 1 ')).toBe(1);
    expect(parseMaxParallelBuilds('32')).toBe(32);
  });

  it('refuses anything else, quoting the value', () => {
    for (const bad of ['0', '33', '1.5', '-1', '2e1', 'two', '0x2']) {
      expect(() => parseMaxParallelBuilds(bad)).toThrow(/WEB_LATEX_MCP_MAX_PARALLEL_BUILDS "/);
    }
  });
});
