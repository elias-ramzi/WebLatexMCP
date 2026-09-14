import { describe, it, expect } from 'vitest';
import { hasLinkOnConflictSide } from '../../src/services/gitService.js';

/**
 * `resolvePush` refuses a resolution for a path that is a symlink on OUR or THEIR side of a
 * paused rebase conflict — judged from `git ls-files -s`, which during a conflict lists one line
 * per stage (1 = base, 2 = ours, 3 = theirs). The base stage is deliberately not a side: a link
 * both sides already replaced with a file leaves nothing a content resolution could land on.
 */
describe('hasLinkOnConflictSide', () => {
  const blob = '4a58007052a65fbc2fc3f910f2855f45a4058e74';
  const line = (mode: string, stage: number, name = 'notes.tex'): string =>
    `${mode} ${blob} ${stage}\t${name}`;

  it('is false for a plain regular-file content conflict', () => {
    const out = [line('100644', 1), line('100644', 2), line('100644', 3)].join('\n') + '\n';
    expect(hasLinkOnConflictSide(out)).toBe(false);
  });

  it('is true when OUR stage is a link', () => {
    const out = [line('100644', 1), line('120000', 2), line('100644', 3)].join('\n') + '\n';
    expect(hasLinkOnConflictSide(out)).toBe(true);
  });

  it('is true when THEIR stage is a link', () => {
    const out = [line('100644', 1), line('100644', 2), line('120000', 3)].join('\n') + '\n';
    expect(hasLinkOnConflictSide(out)).toBe(true);
  });

  it('is true when only one side is present (delete/modify) and it is a link', () => {
    expect(hasLinkOnConflictSide(line('100644', 1) + '\n' + line('120000', 3) + '\n')).toBe(true);
  });

  it('is false when only the BASE stage is a link', () => {
    const out = [line('120000', 1), line('100644', 2), line('100644', 3)].join('\n') + '\n';
    expect(hasLinkOnConflictSide(out)).toBe(false);
  });

  it('is false for a merged (stage 0) link — not a conflict side', () => {
    expect(hasLinkOnConflictSide(line('120000', 0) + '\n')).toBe(false);
  });

  it('is false for empty output', () => {
    expect(hasLinkOnConflictSide('')).toBe(false);
  });

  it('reads the mode off the first column only, not off the file name', () => {
    expect(hasLinkOnConflictSide(line('100644', 2, '120000') + '\n')).toBe(false);
  });
});
