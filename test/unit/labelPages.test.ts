import { describe, it, expect } from 'vitest';
import {
  planLabelPages,
  labelRefusalMessage,
  labelResolutionNote,
  labelPageRangeMessage,
  describeResolvedLabels,
  buildPageLabelIndex,
  isRomanPage,
  parsePrintedPage,
  MAX_AMBIGUOUS_CANDIDATES,
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

describe('buildPageLabelIndex', () => {
  it('maps each printed label to the 1-based pages printing it, in page order', () => {
    const index = buildPageLabelIndex(['i', 'ii', '1', '2']);
    expect(index?.get('i')).toEqual([1]);
    expect(index?.get('ii')).toEqual([2]);
    expect(index?.get('1')).toEqual([3]);
    expect(index?.get('2')).toEqual([4]);
  });

  it('collects every page that prints one label rather than keeping only the first', () => {
    // A restarted \pagenumbering: "1" is printed twice. Keeping one would make the ambiguity
    // undetectable downstream, which is the whole failure the refusal exists for.
    expect(buildPageLabelIndex(['1', '2', '1', '2'])?.get('1')).toEqual([1, 3]);
  });

  it('treats "no usable tree" as undefined in all three of its shapes', () => {
    // All three must reach the inferred fallback, not a wall of printedPageAbsent refusals.
    expect(buildPageLabelIndex(null)).toBeUndefined();
    expect(buildPageLabelIndex(undefined)).toBeUndefined();
    expect(buildPageLabelIndex([])).toBeUndefined();
    expect(buildPageLabelIndex(['', '', ''])).toBeUndefined();
  });

  it('drops an individual blank entry rather than making it matchable', () => {
    const index = buildPageLabelIndex(['', '1', '']);
    expect(index?.get('')).toBeUndefined();
    expect(index?.get('1')).toEqual([2]);
  });

  it('matches literally — no trimming, no case folding, no numeric coercion', () => {
    const index = buildPageLabelIndex([' 3', '3', 'IV']);
    expect(index?.get('3')).toEqual([2]);
    expect(index?.get(' 3')).toEqual([1]);
    expect(index?.get('iv')).toBeUndefined();
    expect(index?.get('03')).toBeUndefined();
  });
});

describe('planLabelPages against the PDF’s own /PageLabels', () => {
  it('resolves a ROMAN printed page to its real page index instead of refusing it', () => {
    // The whole point of #112: with the tree in hand there is nothing to infer, so the refusal
    // the inferred route has to make ('notAPageNumber') is not merely skipped — it is wrong here.
    const plan = planLabelPages(['sec:preface'], aux([['sec:preface', 'iv']]), [
      'i',
      'ii',
      'iii',
      'iv',
      '1',
      '2',
    ]);
    expect(plan.failed).toEqual([]);
    expect(plan.resolved).toEqual([{ label: 'sec:preface', printedPage: 'iv', page: 4 }]);
    expect(plan.labelSource).toBe('pageLabels');
  });

  it('resolves an ARABIC label in a renumbered document to the OFFSET page, not the printed one', () => {
    // The silently-wrong-page bug in its narrowest form (issue #112's own example): a thesis
    // scheme prints "A-3", which is no evidence the inferred route recognises, so printed page
    // "2" used to resolve to PDF page 2 — three pages early — and render perfectly plausibly.
    const labels = ['A-1', 'A-2', 'A-3', '1', '2', '3'];
    const index = aux([
      ['tab:appendix', 'A-3'],
      ['tab:results', '2'],
    ]);
    expect(planLabelPages(['tab:results'], index, labels).resolved).toEqual([
      { label: 'tab:results', printedPage: '2', page: 5 },
    ]);
    // The value just outside: the same .aux with no tree resolves to the wrong page 2 — which is
    // exactly why the tree is consulted, and what this test would silently lose if the lookup
    // were dropped.
    expect(planLabelPages(['tab:results'], index).resolved).toEqual([
      { label: 'tab:results', printedPage: '2', page: 2 },
    ]);
  });

  it('refuses a printed page the PDF prints TWICE, naming both candidates', () => {
    // A restarted \pagenumbering maps "1" to two pages. Taking the first is a coin flip dressed
    // up as an answer, and the wrong side of it renders the front matter for a body-text label.
    const plan = planLabelPages(['tab:results'], aux([['tab:results', '1']]), ['1', '2', '1', '2']);
    expect(plan.resolved).toEqual([]);
    expect(plan.pages).toEqual([]);
    expect(plan.failed).toEqual([
      {
        label: 'tab:results',
        reason: 'ambiguousPrintedPage',
        printedPage: '1',
        candidatePages: [1, 3],
        candidatePagesOmitted: 0,
      },
    ]);
  });

  it('caps the candidate list and counts the rest rather than listing a whole document', () => {
    const many = Array.from({ length: MAX_AMBIGUOUS_CANDIDATES + 5 }, () => '1');
    const plan = planLabelPages(['tab:x'], aux([['tab:x', '1']]), many);
    const failure = plan.failed[0];
    expect(failure?.reason).toBe('ambiguousPrintedPage');
    expect(failure?.candidatePages).toHaveLength(MAX_AMBIGUOUS_CANDIDATES);
    expect(failure?.candidatePagesOmitted).toBe(5);
  });

  it('calls a printed page the PDF does not print a STALE .aux, not an unknown label', () => {
    // The distinction requirement A4 protects: the \newlabel is right there, so "no \newlabel
    // for it" would send the caller hunting for a typo in a label that is plainly defined.
    const plan = planLabelPages(['tab:results'], aux([['tab:results', '9']]), ['1', '2', '3']);
    expect(plan.failed).toEqual([
      { label: 'tab:results', reason: 'printedPageAbsent', printedPage: '9' },
    ]);
  });

  it('still reports a label absent from the .aux as notFound, tree or no tree', () => {
    // The other side of the same distinction: a missing \newlabel is not a stale page.
    const plan = planLabelPages(['tab:new'], aux([['fig:known', '1']]), ['1', '2']);
    expect(plan.failed).toEqual([{ label: 'tab:new', reason: 'notFound' }]);
  });

  it('never applies the inferred route’s refusals when a tree is present', () => {
    // A roman label elsewhere in the .aux is the 'renumbered' evidence — and under /PageLabels
    // it is just another lookup key, so the arabic label beside it must resolve.
    const plan = planLabelPages(
      ['tab:results'],
      aux([
        ['sec:preface', 'iii'],
        ['tab:results', '2'],
      ]),
      ['i', 'ii', 'iii', '1', '2', '3'],
    );
    expect(plan.failed).toEqual([]);
    expect(plan.resolved[0]?.page).toBe(5);
    expect(plan.renumberedBy).toBeUndefined();
  });

  it('falls back to the inferred route — refusals and all — for a degenerate tree', () => {
    // pdf.js yields "" for a /Nums entry carrying neither /S nor /P. Believing such a tree would
    // refuse every label in the document with printedPageAbsent: a wrong certainty replacing a
    // working heuristic.
    const plan = planLabelPages(['sec:preface'], aux([['sec:preface', 'iv']]), ['', '', '', '']);
    expect(plan.labelSource).toBe('printedPage');
    expect(plan.failed).toEqual([
      { label: 'sec:preface', reason: 'notAPageNumber', printedPage: 'iv' },
    ]);
  });

  it('reports labelSource as printedPage when the PDF has no tree at all', () => {
    expect(planLabelPages(['tab:a'], aux([['tab:a', '3']]), null).labelSource).toBe('printedPage');
    expect(planLabelPages(['tab:a'], aux([['tab:a', '3']])).labelSource).toBe('printedPage');
  });

  it('empties the plan when one of several labels is ambiguous', () => {
    const plan = planLabelPages(
      ['fig:ok', 'tab:dup'],
      aux([
        ['fig:ok', '2'],
        ['tab:dup', '1'],
      ]),
      ['1', '2', '1'],
    );
    expect(plan.resolved).toEqual([]);
    expect(plan.pages).toEqual([]);
    expect(plan.failed.map((f) => f.reason)).toEqual(['ambiguousPrintedPage']);
  });
});

describe('labelRefusalMessage for the /PageLabels refusals', () => {
  it('says a printed page the PDF never prints means the .aux is stale, and to recompile', () => {
    const index = aux([['tab:results', '9']]);
    const plan = planLabelPages(['tab:results'], index, ['1', '2', '3']);
    const msg = labelRefusalMessage(plan, index);
    expect(msg).toContain('tab:results');
    expect(msg).toContain('"9"');
    expect(msg).toContain('/PageLabels');
    expect(msg).toMatch(/stale/);
    expect(msg).toMatch(/Compile again/);
    // Must NOT read as an unknown label: that sends the caller after a typo instead of a rebuild.
    expect(msg).not.toContain('no \\newlabel');
  });

  it('names both pages behind an ambiguous printed page and never suggests one of them', () => {
    const index = aux([['tab:results', '1']]);
    const plan = planLabelPages(['tab:results'], index, ['1', '2', '1', '2']);
    const msg = labelRefusalMessage(plan, index);
    expect(msg).toContain('PDF pages 1, 3');
    expect(msg).toMatch(/pagenumbering/);
    expect(msg).toContain('pages:');
  });

  it('counts the candidates it did not list', () => {
    const many = Array.from({ length: MAX_AMBIGUOUS_CANDIDATES + 3 }, () => '1');
    const index = aux([['tab:x', '1']]);
    const msg = labelRefusalMessage(planLabelPages(['tab:x'], index, many), index);
    expect(msg).toContain(`${MAX_AMBIGUOUS_CANDIDATES + 3} different pages`);
    expect(msg).toContain('and 3 more');
  });
});

describe('labelResolutionNote states which route resolved the pages', () => {
  it('says the page index came from the PDF’s /PageLabels when it did', () => {
    const plan = planLabelPages(['sec:preface'], aux([['sec:preface', 'iv']]), [
      'i',
      'ii',
      'iii',
      'iv',
    ]);
    const note = labelResolutionNote(plan);
    expect(note).toContain('/PageLabels');
    expect(note).toContain('sec:preface -> page 4');
    expect(note).toContain('LAST COMPILE');
    // The caveat that no longer applies must not be repeated: under the tree a renumbered
    // document resolves rather than being refused.
    expect(note).not.toMatch(/one arabic run/);
  });

  it('says the printed page was used directly when the PDF carries no tree', () => {
    const note = labelResolutionNote(planLabelPages(['tab:a'], aux([['tab:a', '5']])));
    expect(note).toContain('no /PageLabels tree');
    expect(note).toMatch(/nothing renumbered/);
  });
});
