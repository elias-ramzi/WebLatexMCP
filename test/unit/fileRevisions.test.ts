import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { FileRevisionTracker } from '../../src/services/fileRevisions.js';

const abs = (p: string) => path.resolve('/tmp/proj', p);

describe('FileRevisionTracker', () => {
  it('reports no baseline until a file is recorded', () => {
    const t = new FileRevisionTracker();
    expect(t.hasBaseline(abs('main.tex'))).toBe(false);
    // Without a baseline a file is never "stale" but is "external" (unknown to the tools).
    expect(t.isStale(abs('main.tex'), 'x')).toBe(false);
    expect(t.isExternal(abs('main.tex'), 'x')).toBe(true);
  });

  it('treats matching content as up-to-date and changed content as stale/external', () => {
    const t = new FileRevisionTracker();
    t.record(abs('main.tex'), 'hello');
    expect(t.hasBaseline(abs('main.tex'))).toBe(true);
    expect(t.isStale(abs('main.tex'), 'hello')).toBe(false);
    expect(t.isExternal(abs('main.tex'), 'hello')).toBe(false);
    expect(t.isStale(abs('main.tex'), 'hello world')).toBe(true);
    expect(t.isExternal(abs('main.tex'), 'hello world')).toBe(true);
  });

  it('normalizes paths so the same file matches regardless of form', () => {
    const t = new FileRevisionTracker();
    t.record('/tmp/proj/a/../main.tex', 'hello');
    expect(t.isStale(abs('main.tex'), 'changed')).toBe(true);
  });

  it('forgets a single file', () => {
    const t = new FileRevisionTracker();
    t.record(abs('main.tex'), 'hello');
    t.forget(abs('main.tex'));
    expect(t.hasBaseline(abs('main.tex'))).toBe(false);
  });

  it('resets every baseline under a dir but leaves others', () => {
    const t = new FileRevisionTracker();
    t.record(abs('main.tex'), 'a');
    t.record(abs('chapters/intro.tex'), 'b');
    const outside = path.resolve('/tmp/other/x.tex');
    t.record(outside, 'c');

    t.reset('/tmp/proj');

    expect(t.hasBaseline(abs('main.tex'))).toBe(false);
    expect(t.hasBaseline(abs('chapters/intro.tex'))).toBe(false);
    expect(t.hasBaseline(outside)).toBe(true);
  });

  it('does not reset a sibling dir with a shared name prefix', () => {
    const t = new FileRevisionTracker();
    const sibling = path.resolve('/tmp/proj-2/x.tex');
    t.record(sibling, 'a');
    t.reset('/tmp/proj');
    expect(t.hasBaseline(sibling)).toBe(true);
  });

  it('accepts a Buffer baseline and detects staleness against other Buffers', () => {
    const t = new FileRevisionTracker();
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    const other = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]);
    t.record(abs('fig.png'), buf);
    expect(t.isStale(abs('fig.png'), buf)).toBe(false);
    expect(t.isStale(abs('fig.png'), other)).toBe(true);
  });

  it(
    'hashes a string and its identical UTF-8 Buffer the same way — a disagreement here would ' +
      'silently disarm the out-of-band-edit guard for a file written as text and re-read as bytes',
    () => {
      const t = new FileRevisionTracker();
      t.record(abs('main.tex'), 'héllo');
      expect(t.isStale(abs('main.tex'), Buffer.from('héllo', 'utf8'))).toBe(false);

      const t2 = new FileRevisionTracker();
      t2.record(abs('main.tex'), Buffer.from('héllo', 'utf8'));
      expect(t2.isStale(abs('main.tex'), 'héllo')).toBe(false);
    },
  );

  it('isExternal with a Buffer: no baseline is external, a matching Buffer is not', () => {
    const t = new FileRevisionTracker();
    const buf = Buffer.from([0x00, 0xff, 0xfe]);
    expect(t.isExternal(abs('fig.png'), buf)).toBe(true);
    t.record(abs('fig.png'), buf);
    expect(t.isExternal(abs('fig.png'), buf)).toBe(false);
    expect(t.isExternal(abs('fig.png'), Buffer.from([0x01]))).toBe(true);
  });
});
