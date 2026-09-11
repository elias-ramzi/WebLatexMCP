import { describe, it, expect } from 'vitest';
import {
  renderConflictText,
  renderRebasedOver,
  renderCommitLines,
} from '../../src/lib/conflictText.js';
import type { ConflictReport, RemoteCommit } from '../../src/services/gitService.js';

const REMOTE_HEAD = 'e782dae2c0ffee1234567890abcdef0011223344';
const MERGE_BASE = 'ba5eba5e1122334455667788990011223344aabb';

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
    mergeBase: MERGE_BASE,
    remoteCommits: [
      {
        hash: 'abc1234def',
        message: 'reword scaling section',
        files: [{ path: 'sections/04.tex', added: 3, removed: 1 }],
      },
    ],
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
    expect(text).toContain(MERGE_BASE); // merge-base sha, so base is fetchable by ref
    expect(text).toContain('expectedRemoteHead');
    expect(text).toContain('reword scaling section');
    // Landed-upstream commit lists the file it touched, with line counts.
    expect(text).toContain('+3/-1 sections/04.tex');
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
      files: [{ ...base.files[0]!, theirs: huge, base: huge }],
    });

    expect(text).not.toContain(huge);
    // theirs points at the remote ref; base points at the merge-base sha — both shell-free.
    expect(text).toContain('read_file("sections/04.tex", ref="origin/master")');
    expect(text).toContain(`read_file("sections/04.tex", ref="${MERGE_BASE}")`);
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
    const text = renderRebasedOver([
      {
        hash: 'deadbeef00',
        message: 'their edit',
        files: [{ path: 'main.tex', added: 2, removed: 0 }],
      },
    ]);
    expect(text).toContain('Rebased over 1 commit(s)');
    // The file the commit touched is listed too, not just the hash/subject.
    expect(text).toContain('+2/-0 main.tex');
    expect(renderRebasedOver([])).toBe('');
    expect(renderRebasedOver(undefined)).toBe('');
  });
});

describe('renderCommitLines', () => {
  function commit(hash: string, message: string, files: RemoteCommit['files'] = []): RemoteCommit {
    return { hash, message, files };
  }

  it('prints a file line per file, with added/removed counts', () => {
    const lines = renderCommitLines([
      commit('aaaaaaaa1111', 'edit two files', [
        { path: 'main.tex', added: 3, removed: 1 },
        { path: 'sections/new.tex', added: 10, removed: 0 },
      ]),
    ]);
    expect(lines[0]).toBe('  aaaaaaaa edit two files');
    expect(lines).toContain('      +3/-1 main.tex');
    expect(lines).toContain('      +10/-0 sections/new.tex');
  });

  it('caps files per commit and adds a "more file(s)" line', () => {
    const files = Array.from({ length: 8 }, (_, i) => ({
      path: `f${i}.tex`,
      added: 1,
      removed: 0,
    }));
    const lines = renderCommitLines([commit('bbbbbbbb2222', 'many files', files)], {
      maxFiles: 5,
    });
    const fileLines = lines.filter((l) => l.startsWith('      +'));
    expect(fileLines).toHaveLength(5);
    expect(lines).toContain('      … 3 more file(s)');
  });

  it('caps commits and adds a "more commit(s)" line', () => {
    const commits = Array.from({ length: 25 }, (_, i) => commit(`cccc${i}`, `commit ${i}`));
    const lines = renderCommitLines(commits, { maxCommits: 20 });
    const commitLines = lines.filter((l) => /^ {2}c{4}\d+ /.test(l));
    expect(commitLines).toHaveLength(20);
    expect(lines[lines.length - 1]).toBe('  … 5 more commit(s) (see structuredContent)');
  });
});
