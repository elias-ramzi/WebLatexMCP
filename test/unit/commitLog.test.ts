import { describe, it, expect } from 'vitest';
import { parseCommitLog } from '../../src/services/gitService.js';

/** NUL-prefixed commit header, matching `git log --format=%x00%H%x09%s`. */
const header = (hash: string, subject: string): string => `\u0000${hash}\t${subject}`;

describe('parseCommitLog', () => {
  it('parses two commits, the first with two files', () => {
    const out = [
      header('aaaa1111', 'second commit'),
      '',
      '3\t1\tmain.tex',
      '10\t0\tsections/new.tex',
      '',
      header('bbbb2222', 'first commit'),
      '',
      '1\t0\tmain.tex',
      '',
    ].join('\n');

    const commits = parseCommitLog(out);

    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual({
      hash: 'aaaa1111',
      message: 'second commit',
      files: [
        { path: 'main.tex', added: 3, removed: 1 },
        { path: 'sections/new.tex', added: 10, removed: 0 },
      ],
    });
    expect(commits[1]).toEqual({
      hash: 'bbbb2222',
      message: 'first commit',
      files: [{ path: 'main.tex', added: 1, removed: 0 }],
    });
  });

  it('treats a binary file (- - counts) as 0/0, and keeps a tab inside the subject', () => {
    const out = [header('cccc3333', 'add figure\twith a tab'), '', '-\t-\tfig.png', ''].join('\n');

    const commits = parseCommitLog(out);

    expect(commits).toHaveLength(1);
    expect(commits[0]?.message).toBe('add figure\twith a tab');
    expect(commits[0]?.files).toEqual([{ path: 'fig.png', added: 0, removed: 0 }]);
  });

  it('gives a merge commit with no numstat lines an empty files array', () => {
    const out = [
      header('dddd4444', 'Merge branch into main'),
      '',
      header('eeee5555', 'some other commit'),
      '',
      '1\t1\tmain.tex',
      '',
    ].join('\n');

    const commits = parseCommitLog(out);

    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual({ hash: 'dddd4444', message: 'Merge branch into main', files: [] });
    expect(commits[1]?.files).toEqual([{ path: 'main.tex', added: 1, removed: 1 }]);
  });

  it('keeps the raw rename path string as-is', () => {
    const out = [header('ffff6666', 'rename a file'), '', '0\t0\told.tex => new.tex', ''].join(
      '\n',
    );

    const commits = parseCommitLog(out);

    expect(commits[0]?.files).toEqual([{ path: 'old.tex => new.tex', added: 0, removed: 0 }]);
  });

  it('returns [] on empty input', () => {
    expect(parseCommitLog('')).toEqual([]);
  });

  it('gives an empty message for a NUL header line with no subject', () => {
    const out = [`\u0000abcdef1234567890`, ''].join('\n');

    const commits = parseCommitLog(out);

    expect(commits).toHaveLength(1);
    expect(commits[0]).toEqual({ hash: 'abcdef1234567890', message: '', files: [] });
  });

  it('strips a trailing CR from CRLF-terminated lines, keeping paths and subjects clean', () => {
    const out = [
      header('aaaa1111', 'second commit'),
      '',
      '3\t1\tmain.tex',
      '10\t0\tsections/new.tex',
      '',
      header('bbbb2222', 'first commit'),
      '',
      '1\t0\tmain.tex',
      '',
    ].join('\r\n');

    const commits = parseCommitLog(out);

    expect(commits).toHaveLength(2);
    expect(commits[0]).toEqual({
      hash: 'aaaa1111',
      message: 'second commit',
      files: [
        { path: 'main.tex', added: 3, removed: 1 },
        { path: 'sections/new.tex', added: 10, removed: 0 },
      ],
    });
    expect(commits[1]).toEqual({
      hash: 'bbbb2222',
      message: 'first commit',
      files: [{ path: 'main.tex', added: 1, removed: 0 }],
    });
    // None of the parsed strings retain a stray \r.
    for (const commit of commits) {
      expect(commit.hash).not.toMatch(/\r/);
      expect(commit.message).not.toMatch(/\r/);
      for (const file of commit.files) {
        expect(file.path).not.toMatch(/\r/);
      }
    }
  });
});
