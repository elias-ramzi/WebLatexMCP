import { describe, it, expect } from 'vitest';
import type { Worker } from 'node:worker_threads';
import { RegexScanWorker } from '../../src/lib/searchWorker.js';
import { firstHits } from '../../src/lib/searchMatch.js';

/**
 * The worker that runs `search_files`' regex scans. Constructed straight from a `RegExp`, so a
 * pattern the analyzer would refuse can be handed to it — which is the scenario it exists for.
 */
describe('RegexScanWorker', () => {
  it('reports exactly what the inline scan reports', async () => {
    const scans = ['alpha', 'beta', '  alpha beta', '', 'ALPHA', 'x'.repeat(500) + 'alpha'];
    const matcher = /al+pha/gi;
    const worker = new RegexScanWorker(matcher);
    try {
      const out = await worker.scan(scans, 10_000);
      expect(out.complete).toBe(true);
      expect(out.hits).toEqual(firstHits(scans, matcher).hits);
      // Reused across files: a second scan on the same worker.
      const again = await worker.scan(['no', 'alpha'], 10_000);
      expect(again).toEqual({ hits: [-1, 0], complete: true });
    } finally {
      worker.close();
    }
  });

  it('restarts a worker that died between scans, rather than waiting out the budget', async () => {
    const scanner = new RegexScanWorker(/b/g);
    try {
      expect(await scanner.scan(['abc'], 10_000)).toEqual({ hits: [1], complete: true });
      // Kill the thread behind the scanner's back, between scans — the shape of a crash no
      // scan was waiting on. Nothing is listening for a reply, so nothing rejects.
      const worker = (scanner as unknown as { worker?: Worker }).worker;
      expect(worker).toBeDefined();
      const exited = new Promise<void>((resolve) => worker?.once('exit', () => resolve()));
      await worker?.terminate();
      await exited;
      // The next scan must get a live thread. Posting to the dead one is answered by nothing,
      // so it would sit out the whole budget and come back "cut off" — reported to the caller
      // as the search budget running out, which is not what happened.
      const started = Date.now();
      const next = await scanner.scan(['xbx', 'none'], 5_000);
      expect(next).toEqual({ hits: [1, -1], complete: true });
      expect(Date.now() - started).toBeLessThan(4_000);
    } finally {
      scanner.close();
    }
  });

  it('is stopped at the deadline mid-exec, and claims no line it did not finish', async () => {
    // One exec of this is ~2^28 backtracking steps: seconds on any machine, and uninterruptible
    // on the thread running it.
    const scans = ['fine', 'fine', `${'a'.repeat(28)}!`, 'never'];
    const worker = new RegexScanWorker(/(a+)+$/g);
    const started = Date.now();
    try {
      const out = await worker.scan(scans, 300);
      expect(Date.now() - started).toBeLessThan(2000);
      expect(out.complete).toBe(false);
      // Lines finished just before the cut-off may be uncredited, never the other way round.
      expect(out.hits.length).toBeLessThanOrEqual(2);
      // The scanner is spent: the search it served has timed out.
      expect(await worker.scan(['fine'], 1000)).toEqual({ hits: [], complete: false });
    } finally {
      worker.close();
    }
  });
});
