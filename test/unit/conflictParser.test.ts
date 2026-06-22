import { describe, it, expect } from 'vitest';
import { parseConflictHunks } from '../../src/lib/conflictParser.js';

describe('parseConflictHunks', () => {
  it('returns [] when there are no conflict markers', () => {
    expect(parseConflictHunks('line1\nline2\nline3\n')).toEqual([]);
  });

  it('parses a single merge-style conflict (HEAD = remote during a rebase)', () => {
    // During `pull --rebase`, HEAD is the upstream we replay onto, so the HEAD side is remote.
    const content = [
      'before',
      '<<<<<<< HEAD',
      'the remote sentence.',
      '=======',
      'the local sentence.',
      '>>>>>>> a1b2c3d (local edit)',
      'after',
      '',
    ].join('\n');

    const hunks = parseConflictHunks(content);
    expect(hunks).toEqual([
      {
        startLine: 2,
        endLine: 6,
        remote: ['the remote sentence.'],
        local: ['the local sentence.'],
      },
    ]);
  });

  it('parses multiple conflict hunks in one file', () => {
    const content = [
      'intro',
      '<<<<<<< HEAD',
      'remote A',
      '=======',
      'local A',
      '>>>>>>> sha (a)',
      'middle',
      '<<<<<<< HEAD',
      'remote B1',
      'remote B2',
      '=======',
      'local B',
      '>>>>>>> sha (b)',
      'end',
      '',
    ].join('\n');

    const hunks = parseConflictHunks(content);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ remote: ['remote A'], local: ['local A'] });
    expect(hunks[1]).toMatchObject({
      remote: ['remote B1', 'remote B2'],
      local: ['local B'],
      startLine: 8,
      endLine: 13,
    });
  });

  it('ignores the diff3 base section', () => {
    const content = [
      '<<<<<<< HEAD',
      'remote side',
      '||||||| base',
      'common ancestor',
      '=======',
      'local side',
      '>>>>>>> sha',
      '',
    ].join('\n');

    expect(parseConflictHunks(content)).toEqual([
      { startLine: 1, endLine: 7, remote: ['remote side'], local: ['local side'] },
    ]);
  });

  it('flips the mapping with headSide: "local" (plain merge, not a rebase)', () => {
    const content = ['<<<<<<< HEAD', 'our side', '=======', 'their side', '>>>>>>> sha', ''].join(
      '\n',
    );

    expect(parseConflictHunks(content, { headSide: 'local' })).toEqual([
      { startLine: 1, endLine: 5, local: ['our side'], remote: ['their side'] },
    ]);
  });

  it('captures an empty side as an empty array', () => {
    const content = ['<<<<<<< HEAD', '=======', 'local only', '>>>>>>> sha', ''].join('\n');
    expect(parseConflictHunks(content)).toEqual([
      { startLine: 1, endLine: 4, remote: [], local: ['local only'] },
    ]);
  });
});
