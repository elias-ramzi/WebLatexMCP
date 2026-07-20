import { describe, it, expect } from 'vitest';
import { renderConflictText, renderRebasedOver } from '../../src/lib/conflictText.js';
import type { ConflictReport } from '../../src/services/gitService.js';

const REMOTE_HEAD = 'e782dae2c0ffee1234567890abcdef0011223344';

function report(overrides: Partial<ConflictReport> = {}): ConflictReport {
  return {
    files: [
      {
        path: 'sections/04.tex',
        base: 'alpha\nbeta\ngamma\n',
        ours: 'alpha\nbeta-local\ngamma\n',
        theirs: 'alpha\nbeta-remote\ngamma\n',
        hunks: [{ startLine: 2, endLine: 6, local: ['beta-local'], remote: ['beta-remote'] }],
      },
    ],
    conflictPaths: ['sections/04.tex'],
    rebasedOnto: 'origin/master',
    remoteHead: REMOTE_HEAD,
    remoteCommits: [{ hash: 'abc1234def', message: 'reword scaling section' }],
    guidance: 'resolve the overlap',
    ...overrides,
  };
}

describe('renderConflictText', () => {
  it('puts the full resolution payload in the visible text', () => {
    const text = renderConflictText('Rebase conflicts in 1 file(s).', report());

    // Per the acceptance test: paths, remoteHead (full + abbrev), remoteCommits, and per-file
    // content are all present in the model-visible text — not only in structuredContent.
    expect(text).toContain('sections/04.tex');
    expect(text).toContain(REMOTE_HEAD); // full sha
    expect(text).toContain('e782dae2'); // abbreviated
    expect(text).toContain('expectedRemoteHead');
    expect(text).toContain('reword scaling section');
    // All three full sides.
    expect(text).toContain('alpha\nbeta\ngamma\n'); // base
    expect(text).toContain('beta-local'); // ours
    expect(text).toContain('beta-remote'); // theirs
    // Marker view too.
    expect(text).toContain('<<<<<<< ours');
  });

  it('elides an oversized side with a read_file pointer instead of dumping it', () => {
    const huge = 'x'.repeat(20000);
    const base = report();
    const text = renderConflictText('conflict', {
      ...base,
      files: [{ ...base.files[0]!, theirs: huge }],
    });

    expect(text).not.toContain(huge);
    expect(text).toContain('read_file("sections/04.tex", ref="origin/master")');
  });

  it('marks an absent side (added/deleted) rather than showing null', () => {
    const rep = report();
    const text = renderConflictText('conflict', {
      ...rep,
      files: [{ ...rep.files[0]!, base: null }],
    });
    expect(text).toContain('base (common ancestor): (absent');
  });
});

describe('renderRebasedOver', () => {
  it('summarizes the commits landed underneath a successful push', () => {
    expect(renderRebasedOver([{ hash: 'deadbeef00', message: 'their edit' }])).toContain(
      'Rebased over 1 commit(s)',
    );
    expect(renderRebasedOver([])).toBe('');
    expect(renderRebasedOver(undefined)).toBe('');
  });
});
