import { describe, it, expect } from 'vitest';
import { overlayNeverReadHint, OVERLAY_UNREAD_NAMES_BUDGET } from '../../src/tools/compile.js';
import { quoteId } from '../../src/lib/projectId.js';

/*
 * The compile tool's own hint builder `overlayNeverReadHint` (#216 — one budgeted line for every
 * overlaid file the variant build never opened, charged on the SUM of the two channels the hint
 * ships in). `shellEscapeOverriddenHint` moved to `src/services/compiler.ts`, and its tests to
 * `laneC1ShellHint.test.ts`.
 */

/** What a string costs rendered in both channels: as printed, plus inside a JSON string. */
function bothChannels(s: string): number {
  return s.length + JSON.stringify(s).length - 2;
}

/** The names the hint lists, in order: a prefix of `names`, as `quoteId` shows them. */
function namedPrefix(hint: string, names: string[]): string[] {
  const named: string[] = [];
  for (const n of names) {
    if (!hint.includes(quoteId(n))) break;
    named.push(n);
  }
  return named;
}

describe('overlayNeverReadHint (#216)', () => {
  it('says it in ONE line for several files, naming each in order', () => {
    const names = ['sections/a.tex', 'sections/b.tex', 'c.tex'];
    const hint = overlayNeverReadHint(names, true);
    expect(hint).not.toContain('\n');
    expect(hint).toContain(
      'The build never read the overlaid files "sections/a.tex", "sections/b.tex", "c.tex" ' +
        '(neither its .fls nor its .fdb_latexmk lists them)',
    );
    expect(hint).not.toContain('more');
    const failed = overlayNeverReadHint(names, false);
    expect(failed).not.toContain('\n');
    expect(failed).toContain(
      'The build stopped before reading the overlaid files "sections/a.tex"',
    );
  });

  it('counts the names that do not fit as ", and N more" in the same sentence', () => {
    // 150-character names: a handful fit the share, the rest are counted.
    const names = Array.from({ length: 20 }, (_, i) => `${'n'.repeat(140)}-${i}.tex`);
    const hint = overlayNeverReadHint(names, true);
    const named = namedPrefix(hint, names);
    expect(named.length).toBeGreaterThan(0);
    expect(named.length).toBeLessThan(names.length);
    expect(hint).toContain(`, and ${names.length - named.length} more (neither`);
    expect(hint).not.toContain('\n');
  });

  it('says the names are too long to list when not even the first one fits', () => {
    const hint = overlayNeverReadHint([`${'x'.repeat(2100)}.tex`, 'short.tex'], true);
    expect(hint).toContain('2 overlaid file(s) (their names are too long to list here)');
    expect(hint).not.toContain('x'.repeat(100));
    // A name is never cut short, and a later short one is not listed past a longer one either:
    // the named set is a prefix.
    expect(hint).not.toContain('short.tex');
  });

  it('bounds the list by the SUM of both channels, not by the larger one', () => {
    // A backslash costs one character as printed and, escaped by quoteId, two more inside the
    // JSON string — so charging the JSON form alone let the two channels together carry well past
    // the budget.
    const names = Array.from({ length: 20 }, (_, i) => `d${'\\'.repeat(60)}${'n'.repeat(60)}${i}`);
    const hint = overlayNeverReadHint(names, true);
    const named = namedPrefix(hint, names);
    expect(named.length).toBeGreaterThan(0);
    expect(named.length).toBeLessThan(names.length);
    const list = named.map(quoteId).join(', ');
    expect(hint).toContain(list);
    expect(bothChannels(list)).toBeLessThanOrEqual(OVERLAY_UNREAD_NAMES_BUDGET);
    // And the prefix is the longest that fits: one more name would not have.
    const oneMore = [...named, names[named.length]!].map(quoteId).join(', ');
    expect(bothChannels(oneMore)).toBeGreaterThan(OVERLAY_UNREAD_NAMES_BUDGET);
  });

  it('keeps 20 names near PATH_MAX within the budget', () => {
    const PATH_MAX = 4096;
    const names = Array.from(
      { length: 20 },
      (_, i) => `${'p'.repeat(PATH_MAX - 10)}-${String(i).padStart(2, '0')}.tex`,
    );
    for (const success of [true, false]) {
      const hint = overlayNeverReadHint(names, success);
      expect(hint).toContain('20 overlaid file(s) (their names are too long to list here)');
      // The fixed sentence only: no name reached either channel.
      expect(bothChannels(hint)).toBeLessThan(1000);
    }
    // Names of about half the budget: the first fits, the rest are counted, and the rendered
    // total over both channels stays within the budget plus the fixed sentence.
    const half = Array.from({ length: 20 }, (_, i) => `${'q'.repeat(900)}-${i}.tex`);
    const hint = overlayNeverReadHint(half, true);
    expect(namedPrefix(hint, half)).toHaveLength(1);
    expect(hint).toContain(', and 19 more (neither');
    expect(bothChannels(hint)).toBeLessThan(OVERLAY_UNREAD_NAMES_BUDGET + 1000);
  });
});
