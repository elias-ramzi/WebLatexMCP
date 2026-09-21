import { describe, it, expect } from 'vitest';
import {
  planLabelPages,
  labelRefusalMessage,
  labelResolutionNote,
  labelPageRangeMessage,
  describeResolvedLabels,
  isRomanPage,
  parsePrintedPage,
} from '../../src/lib/labelPages.js';
import type { AuxFloatsResult, AuxLabel } from '../../src/lib/auxFloats.js';

function aux(
  entries: Array<[label: string, page: string]>,
  extra?: Partial<Omit<AuxFloatsResult, 'floats'>>,
): AuxFloatsResult {
  const floats: AuxLabel[] = entries.map(([label, page]) => ({ label, number: '1', page }));
  return { floats, omitted: 0, total: floats.length, dropped: 0, ...extra };
}

describe('parsePrintedPage', () => {
  it('accepts a decimal page and rejects everything that is not one', () => {
    expect(parsePrintedPage('3')).toBe(3);
    expect(parsePrintedPage('1')).toBe(1);
    expect(parsePrintedPage('1234567')).toBe(1234567);
    // The values just outside: 0 is not a 1-based page, and the rest are not decimal at all.
    expect(parsePrintedPage('0')).toBeUndefined();
    expect(parsePrintedPage('')).toBeUndefined();
    expect(parsePrintedPage('iv')).toBeUndefined();
    expect(parsePrintedPage('A-3')).toBeUndefined();
    expect(parsePrintedPage('3a')).toBeUndefined();
    expect(parsePrintedPage(' 3')).toBeUndefined();
    expect(parsePrintedPage('3.0')).toBeUndefined();
    expect(parsePrintedPage('-3')).toBeUndefined();
    expect(parsePrintedPage('12345678')).toBeUndefined();
    expect(parsePrintedPage('\\hbox {3}')).toBeUndefined();
  });
});

describe('isRomanPage', () => {
  it('recognizes roman front-matter pages in either case, and nothing else', () => {
    for (const roman of ['i', 'ii', 'iv', 'ix', 'xiv', 'IV', 'XVIII', 'mcmxc']) {
      expect(isRomanPage(roman)).toBe(true);
    }
    // The empty string matches the all-optional regex on its own — guarded separately, and a
    // decimal page must never read as evidence of renumbering.
    expect(isRomanPage('')).toBe(false);
    expect(isRomanPage('3')).toBe(false);
    expect(isRomanPage('A-3')).toBe(false);
    expect(isRomanPage('iv3')).toBe(false);
  });
});

describe('planLabelPages', () => {
  it('resolves a label to the printed page the .aux records', () => {
    const plan = planLabelPages(['tab:results'], aux([['tab:results', '7']]));
    expect(plan.failed).toEqual([]);
    expect(plan.resolved).toEqual([{ label: 'tab:results', printedPage: '7', page: 7 }]);
    expect(plan.pages).toEqual([7]);
  });

  it('renders a shared page once while echoing both labels, and collapses a repeated label', () => {
    const plan = planLabelPages(
      ['tab:a', 'fig:b', 'tab:a'],
      aux([
        ['tab:a', '4'],
        ['fig:b', '4'],
      ]),
    );
    expect(plan.pages).toEqual([4]);
    expect(plan.resolved.map((r) => r.label)).toEqual(['tab:a', 'fig:b']);
  });

  it('keeps request order for distinct pages', () => {
    const plan = planLabelPages(
      ['fig:late', 'tab:early'],
      aux([
        ['tab:early', '2'],
        ['fig:late', '9'],
      ]),
    );
    expect(plan.pages).toEqual([9, 2]);
  });

  it('fails a label with no \\newlabel in the .aux, and renders nothing at all', () => {
    const plan = planLabelPages(['tab:new', 'fig:known'], aux([['fig:known', '2']]));
    expect(plan.failed).toEqual([{ label: 'tab:new', reason: 'notFound' }]);
    // The load-bearing half: one failure empties the plan, so the caller cannot be handed the
    // page of the label that DID resolve as if it answered both.
    expect(plan.resolved).toEqual([]);
    expect(plan.pages).toEqual([]);
  });

  it('refuses a printed page that is not a decimal integer rather than mapping it to a page', () => {
    const plan = planLabelPages(['sec:preface'], aux([['sec:preface', 'iv']]));
    expect(plan.failed).toEqual([
      { label: 'sec:preface', reason: 'notAPageNumber', printedPage: 'iv' },
    ]);
    expect(plan.pages).toEqual([]);
  });

  it('refuses an ARABIC label too once the document shows roman pages (the offset is unknowable)', () => {
    const plan = planLabelPages(
      ['tab:results'],
      aux([
        ['sec:preface', 'iv'],
        ['tab:results', '3'],
      ]),
    );
    expect(plan.failed).toEqual([{ label: 'tab:results', reason: 'renumbered', printedPage: '3' }]);
    expect(plan.pages).toEqual([]);
    expect(plan.renumberedBy?.label).toBe('sec:preface');
  });

  it('reports the label’s own bad page rather than the document-wide verdict', () => {
    const plan = planLabelPages(
      ['sec:preface'],
      aux([
        ['sec:preface', 'iv'],
        ['tab:results', '3'],
      ]),
    );
    expect(plan.failed[0]?.reason).toBe('notAPageNumber');
  });

  it('resolves a multiply-defined label to its first record', () => {
    const plan = planLabelPages(
      ['tab:dup'],
      aux([
        ['tab:dup', '2'],
        ['tab:dup', '8'],
      ]),
    );
    expect(plan.resolved[0]?.page).toBe(2);
  });

  it('fails every label against an empty index (nothing compiled yet)', () => {
    const plan = planLabelPages(
      ['fig:a'],
      aux([], { note: 'No .aux found in the build directory' }),
    );
    expect(plan.failed.map((f) => f.reason)).toEqual(['notFound']);
  });
});

describe('labelRefusalMessage', () => {
  it('names the missing label, the rerun case, and the explicit-pages escape hatch', () => {
    const index = aux([['fig:known', '2']]);
    const plan = planLabelPages(['tab:new'], index);
    const msg = labelRefusalMessage(plan, index);
    expect(msg).toContain('tab:new');
    expect(msg).toContain('no \\newlabel');
    expect(msg).toMatch(/Rerun to get cross-references right/);
    expect(msg).toContain('pdf_geometry');
    expect(msg).toContain('pages:');
    // Never a suggested page: the whole point is that nothing is guessed.
    expect(msg).not.toMatch(/page 1\b/);
  });

  it('carries the reader’s own "no .aux" note through, so "not found" is not misreported', () => {
    const index = aux([], { note: 'No .aux found in the build directory (/tmp/x/main.aux)' });
    const plan = planLabelPages(['fig:a'], index);
    expect(labelRefusalMessage(plan, index)).toContain('No .aux found in the build directory');
  });

  it('says a miss may be past the entry cap when the reader omitted entries', () => {
    const index = aux([['fig:known', '2']], { omitted: 7, total: 8 });
    const plan = planLabelPages(['fig:far'], index);
    const msg = labelRefusalMessage(plan, index);
    expect(msg).toMatch(/7 more were not searched/);
    expect(msg).toMatch(/rather than undefined/);
  });

  it('says so when entries were unreportable, rather than calling the label undefined', () => {
    const index = aux([['fig:known', '2']], { dropped: 2 });
    const plan = planLabelPages(['fig:odd'], index);
    expect(labelRefusalMessage(plan, index)).toMatch(/2 \\newlabel entr\(ies\).*unreportable/);
  });

  it('explains a roman printed page with the page it found', () => {
    const index = aux([['sec:preface', 'iv']]);
    const plan = planLabelPages(['sec:preface'], index);
    const msg = labelRefusalMessage(plan, index);
    expect(msg).toContain('"iv"');
    expect(msg).toContain('not a decimal page number');
    // A per-label problem, not a "compile again" one — the rerun advice belongs only to notFound.
    expect(msg).not.toMatch(/Rerun to get cross-references right/);
  });

  it('names the evidence label behind a document-wide renumbering refusal', () => {
    const index = aux([
      ['sec:preface', 'iv'],
      ['tab:results', '3'],
    ]);
    const plan = planLabelPages(['tab:results'], index);
    const msg = labelRefusalMessage(plan, index);
    expect(msg).toContain('tab:results');
    expect(msg).toContain('sec:preface');
    expect(msg).toContain('renumbers its pages');
  });
});

describe('labelResolutionNote / describeResolvedLabels / labelPageRangeMessage', () => {
  it('states that the page came from the LAST COMPILE, not the source on disk', () => {
    const plan = planLabelPages(['tab:a'], aux([['tab:a', '5']]));
    const note = labelResolutionNote(plan);
    expect(note).toContain('LAST COMPILE');
    expect(note).toContain('tab:a -> page 5');
    expect(note).toMatch(/recompile/i);
  });

  it('renders the mapping as label -> page pairs', () => {
    const plan = planLabelPages(
      ['tab:a', 'fig:b'],
      aux([
        ['tab:a', '5'],
        ['fig:b', '6'],
      ]),
    );
    expect(describeResolvedLabels(plan.resolved)).toBe('tab:a -> page 5, fig:b -> page 6');
  });

  it('keeps the renderer’s own range message and adds where the number came from', () => {
    const plan = planLabelPages(['tab:a'], aux([['tab:a', '9']]));
    const msg = labelPageRangeMessage(plan, 'Page 9 is out of range: this document has 3 page(s).');
    expect(msg).toContain('Page 9 is out of range');
    expect(msg).toContain('tab:a -> page 9');
    expect(msg).toMatch(/stale/);
    expect(msg).toMatch(/Compile again/);
  });
});
