import { describe, expect, it } from 'vitest';
import {
  BATCH_BACKOFF_MS,
  BATCH_MESSAGE_CAP,
  BATCH_MESSAGE_CUT_MARKER,
  BATCH_SPACING_MS,
  BATCH_START_DEADLINE_MS,
  capBatchMessage,
  pauseBefore,
  runReferenceBatch,
  type BatchDeps,
} from '../../src/lib/referenceBatch.js';
import type { ResolvedSearch } from '../../src/services/referenceResolver.js';
import type { ReferenceHit } from '../../src/services/referenceBackend.js';

function hit(title: string): ReferenceHit {
  return { key: `dblp:x/${title}`, source: 'dblp', title, authors: ['A. Author'] };
}

/**
 * A fake clock the sleep advances, a script of answers per query, and a log of what happened in
 * which order — so pacing is asserted exactly, without waiting.
 */
function harness(
  answer: (query: string) => ResolvedSearch | Error,
  opts: { searchTakesMs?: number; isFatal?: (err: unknown) => boolean } = {},
) {
  let clock = 0;
  const log: string[] = [];
  const deps: BatchDeps = {
    search: async (query) => {
      log.push(`search ${query}`);
      clock += opts.searchTakesMs ?? 0;
      const out = answer(query);
      if (out instanceof Error) throw out;
      return out;
    },
    sleep: async (ms) => {
      log.push(`sleep ${ms}`);
      clock += ms;
    },
    now: () => clock,
    redact: (message) => message.replaceAll('s3cret', '***'),
    isFatal: opts.isFatal ?? (() => false),
  };
  return { deps, log };
}

const ok = (title: string): ResolvedSearch => ({ hits: [hit(title)], source: 'dblp' });

describe('runReferenceBatch', () => {
  it('runs every query in order, spaced out, never before the first', async () => {
    const { deps, log } = harness((q) => ok(q));
    const run = await runReferenceBatch(['a', 'b', 'c'], deps);

    expect(log).toEqual([
      'search a',
      `sleep ${BATCH_SPACING_MS}`,
      'search b',
      `sleep ${BATCH_SPACING_MS}`,
      'search c',
    ]);
    expect(run.items.map((i) => i.status)).toEqual(['ok', 'ok', 'ok']);
    expect(run.stopped).toBeUndefined();
  });

  it('backs off after a failure, doubling, and resets after an answer', async () => {
    const failing = new Set(['b', 'c']);
    const { deps, log } = harness((q) => (failing.has(q) ? new Error(`boom ${q}`) : ok(q)));
    const run = await runReferenceBatch(['a', 'b', 'c', 'd', 'e'], deps);

    expect(log.filter((l) => l.startsWith('sleep'))).toEqual([
      `sleep ${BATCH_SPACING_MS}`, // a answered
      `sleep ${BATCH_BACKOFF_MS[0]}`, // b failed
      `sleep ${BATCH_BACKOFF_MS[1]}`, // c failed too
      `sleep ${BATCH_SPACING_MS}`, // d answered: back to plain spacing
    ]);
    expect(run.items.map((i) => i.status)).toEqual(['ok', 'error', 'error', 'ok', 'ok']);
  });

  it('keeps one failure from stopping the batch, and stops after three in a row', async () => {
    const { deps } = harness((q) => (q === 'a' ? ok(q) : new Error('429 Too Many Requests')));
    const run = await runReferenceBatch(['a', 'b', 'c', 'd', 'e', 'f'], deps);

    expect(run.items.map((i) => i.status)).toEqual([
      'ok',
      'error',
      'error',
      'error',
      'notRun',
      'notRun',
    ]);
    expect(run.stopped).toBe('failures');
    // Not-run queries keep their text and order, so the caller can send exactly those again.
    expect(run.items.slice(4).map((i) => i.query)).toEqual(['e', 'f']);
  });

  it('starts nothing past the deadline, and never sleeps only to start nothing', async () => {
    const takes = BATCH_START_DEADLINE_MS / 2;
    const { deps, log } = harness((q) => ok(q), { searchTakesMs: takes });
    const run = await runReferenceBatch(['a', 'b', 'c'], deps);

    // a ends at T/2; b would start at T/2 + spacing, inside T; c would start past T.
    expect(run.items.map((i) => i.status)).toEqual(['ok', 'ok', 'notRun']);
    expect(run.stopped).toBe('deadline');
    expect(log.at(-1)).toBe('search b');
  });

  it('raises a refusal every query would share, rather than reporting it per query', async () => {
    const fatal = new Error('invalid source');
    const { deps } = harness(() => fatal, { isFatal: (err) => err === fatal });
    await expect(runReferenceBatch(['a', 'b'], deps)).rejects.toBe(fatal);
  });

  it('redacts, then caps, a failure message', async () => {
    const long = `token s3cret leaked ${'x'.repeat(BATCH_MESSAGE_CAP * 2)}`;
    const { deps } = harness(() => new Error(long));
    const run = await runReferenceBatch(['a'], deps);
    const item = run.items[0]!;
    expect(item.status).toBe('error');
    if (item.status !== 'error') return;
    expect(item.error).not.toContain('s3cret');
    expect(item.error.length).toBe(BATCH_MESSAGE_CAP);
    expect(item.error.endsWith(BATCH_MESSAGE_CUT_MARKER)).toBe(true);
  });

  it('reports a substitution per query, with the note capped', async () => {
    const { deps } = harness(() => ({
      hits: [],
      source: 'crossref',
      fallbackFrom: 'dblp',
      note: 'n'.repeat(BATCH_MESSAGE_CAP + 10),
    }));
    const run = await runReferenceBatch(['a'], deps);
    expect(run.items[0]).toMatchObject({ status: 'ok', source: 'crossref', fallbackFrom: 'dblp' });
    const item = run.items[0]!;
    if (item.status === 'ok') expect(item.note!.length).toBe(BATCH_MESSAGE_CAP);
  });
});

describe('pacing helpers', () => {
  it('repeats the last backoff figure past the table', () => {
    expect(pauseBefore(0)).toBe(BATCH_SPACING_MS);
    expect(pauseBefore(1)).toBe(BATCH_BACKOFF_MS[0]);
    expect(pauseBefore(BATCH_BACKOFF_MS.length + 5)).toBe(BATCH_BACKOFF_MS.at(-1));
  });

  it('leaves a short message whole', () => {
    expect(capBatchMessage('short')).toBe('short');
  });
});
