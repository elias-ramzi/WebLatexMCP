import { describe, it, expect } from 'vitest';
import { remoteBranchMissingNote, syncState, syncSummary } from '../../src/lib/syncState.js';

describe('syncState', () => {
  it('classifies the four states from ahead/behind', () => {
    expect(syncState(0, 0)).toBe('in-sync');
    expect(syncState(2, 0)).toBe('ahead');
    expect(syncState(0, 3)).toBe('behind');
    expect(syncState(1, 1)).toBe('diverged');
  });
});

describe('syncSummary', () => {
  it('leads with divergence and the push-may-conflict consequence when ahead and behind', () => {
    const s = syncSummary('main', 1, 2);
    expect(s).toMatch(/diverged/);
    expect(s).toMatch(/1 ahead/);
    expect(s).toMatch(/2 behind/);
    expect(s).toMatch(/may conflict/);
  });

  it('flags a moved remote when only behind', () => {
    const s = syncSummary('main', 0, 4);
    expect(s).toMatch(/behind 4/);
    expect(s).toMatch(/origin\/main moved/);
    expect(s).toMatch(/before pushing/);
  });

  it('flags unpushed commits when only ahead', () => {
    expect(syncSummary('master', 3, 0)).toMatch(/ahead 3.*unpushed/);
  });

  it('reports in-sync when neither ahead nor behind', () => {
    expect(syncSummary('main', 0, 0)).toBe('in sync with origin/main');
  });
});

describe('remote branch missing', () => {
  it('wins over the counts, so a pruned branch is never "in-sync"', () => {
    expect(syncState(0, 0, true)).toBe('remote-branch-missing');
    expect(syncState(3, 0, true)).toBe('remote-branch-missing');
    expect(syncSummary('master', 0, 0, true)).not.toMatch(/in sync/);
    expect(syncSummary('master', 2, 0, true)).toMatch(/origin\/master no longer exists.*2 local/);
  });

  it('names the branches the remote has now, capped, and the unpushed count', () => {
    const many = Array.from({ length: 8 }, (_, i) => `b${i}`);
    const note = remoteBranchMissingNote('master', many, 3);
    expect(note).toMatch(/"b0", "b1", "b2", "b3", "b4" and 3 more/);
    expect(note).toMatch(/3 local commit\(s\) are on no remote branch/);
    expect(remoteBranchMissingNote('master', ['renamed'], 0)).not.toMatch(/local commit/);
  });
});

describe('remoteBranchMissingNote bounds what the remote named', () => {
  it('clips each listed branch name and escapes what it cannot show', () => {
    // Branch names come from the remote, so one of them can be as long, and hold whatever
    // characters, the remote allows. Each is clipped and quoted like any other remote-supplied
    // name, and the note stays bounded however long the names are.
    const huge = 'x'.repeat(5000);
    const note = remoteBranchMissingNote(
      'master',
      [huge, 'a"b', `c${String.fromCharCode(0x202e)}d`],
      0,
    );
    expect(note).not.toContain(huge);
    expect(note).toMatch(/"x{1,100}…"/);
    expect(note).toContain('"a\\"b"');
    expect(note).toContain('"c\\u{202E}d"');
    const worst = remoteBranchMissingNote('master', Array(8).fill(huge), 9);
    expect(worst.length).toBeLessThan(2000);
  });
});
