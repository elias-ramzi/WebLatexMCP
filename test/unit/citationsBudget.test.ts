import { describe, it, expect } from 'vitest';
import {
  ALLOCATION_ORDER,
  CITATIONS_CONTENT_BUDGET,
  CITATIONS_MAX_FINDINGS,
  CITATIONS_MAX_PLACES,
  planCitationsPayload,
  type CitationsFindings,
} from '../../src/lib/citationsBudget.js';
import { missingRequiredFields, parseReferences } from '../../src/lib/references.js';

function empty(): CitationsFindings {
  return {
    undefinedCitations: [],
    uncitedEntries: [],
    duplicateKeys: [],
    incompleteEntries: [],
  };
}

function places(n: number, path = 'main.tex'): Array<{ path: string; line: number }> {
  return Array.from({ length: n }, (_, i) => ({ path, line: i + 1 }));
}

function undefinedCitations(n: number, uses = 1): CitationsFindings['undefinedCitations'] {
  return Array.from({ length: n }, (_, i) => ({
    key: `missing${String(i).padStart(4, '0')}`,
    uses: places(uses),
  }));
}

function uncited(n: number, title = 'A Paper'): CitationsFindings['uncitedEntries'] {
  return Array.from({ length: n }, (_, i) => ({
    key: `dead${String(i).padStart(4, '0')}`,
    path: 'refs.bib',
    line: i + 1,
    title,
  }));
}

function duplicates(n: number, occ = 2): CitationsFindings['duplicateKeys'] {
  return Array.from({ length: n }, (_, i) => ({
    key: `dup${String(i).padStart(4, '0')}`,
    occurrences: places(occ, 'refs.bib'),
  }));
}

function incomplete(n: number, missing = ['author']): CitationsFindings['incompleteEntries'] {
  return Array.from({ length: n }, (_, i) => ({
    key: `thin${String(i).padStart(4, '0')}`,
    path: 'refs.bib',
    line: i + 1,
    type: 'article',
    missing: [...missing],
  }));
}

/** What the four lists actually cost once encoded, which is what the budget claims to bound. */
function renderedSize(plan: {
  undefinedCitations: unknown;
  uncitedEntries: unknown;
  duplicateKeys: unknown;
  incompleteEntries: unknown;
}): number {
  return (
    JSON.stringify(plan.undefinedCitations).length +
    JSON.stringify(plan.uncitedEntries).length +
    JSON.stringify(plan.duplicateKeys).length +
    JSON.stringify(plan.incompleteEntries).length
  );
}

describe('planCitationsPayload', () => {
  it('passes a small report through untouched, with no note and no omissions', () => {
    const findings: CitationsFindings = {
      undefinedCitations: undefinedCitations(2, 3),
      uncitedEntries: uncited(3),
      duplicateKeys: duplicates(1),
      incompleteEntries: incomplete(2),
    };
    const plan = planCitationsPayload(findings);

    expect(plan.undefinedCitations).toEqual(findings.undefinedCitations);
    expect(plan.uncitedEntries).toEqual(findings.uncitedEntries);
    expect(plan.duplicateKeys).toEqual(findings.duplicateKeys);
    expect(plan.incompleteEntries).toEqual(findings.incompleteEntries);
    expect(plan.undefinedCitationsOmitted).toBe(0);
    expect(plan.uncitedEntriesOmitted).toBe(0);
    expect(plan.duplicateKeysOmitted).toBe(0);
    expect(plan.incompleteEntriesOmitted).toBe(0);
    expect(plan.note).toBeUndefined();
    // The counters are not carried as explicit `undefined`s either: an explicitly-undefined key
    // survives InMemoryTransport but not JSON, so it is not a hole a test may leave open.
    expect(Object.keys(plan.undefinedCitations[0]!)).toEqual(['key', 'uses']);
  });

  it('empty findings plan to empty lists, zero counters and no note', () => {
    const plan = planCitationsPayload(empty());
    expect(plan.undefinedCitations).toEqual([]);
    expect(plan.uncitedEntries).toEqual([]);
    expect(plan.duplicateKeys).toEqual([]);
    expect(plan.incompleteEntries).toEqual([]);
    expect(plan.note).toBeUndefined();
  });

  it('caps each list at CITATIONS_MAX_FINDINGS and counts the rest, per list', () => {
    // The ordinary case from #154: a group .bib of 300 entries, 80 of them cited.
    const plan = planCitationsPayload({
      undefinedCitations: undefinedCitations(25),
      uncitedEntries: uncited(220),
      duplicateKeys: duplicates(21),
      incompleteEntries: incomplete(30),
    });

    expect(CITATIONS_MAX_FINDINGS).toBe(20);
    expect(plan.undefinedCitations).toHaveLength(20);
    expect(plan.undefinedCitationsOmitted).toBe(5);
    expect(plan.duplicateKeys).toHaveLength(20);
    expect(plan.duplicateKeysOmitted).toBe(1);
    expect(plan.incompleteEntries).toHaveLength(20);
    expect(plan.incompleteEntriesOmitted).toBe(10);
    expect(plan.uncitedEntries).toHaveLength(20);
    expect(plan.uncitedEntriesOmitted).toBe(200);
    // total = shown + omitted, for every list. Nothing is cut silently.
    expect(plan.uncitedEntries.length + plan.uncitedEntriesOmitted).toBe(220);
    expect(plan.note).toContain('uncitedEntries: showing 20 of 220');
    expect(plan.note).toContain('per-list cap');
  });

  it('honours maxResults in both directions, over the default cap', () => {
    const findings = { ...empty(), uncitedEntries: uncited(50) };
    expect(planCitationsPayload(findings, { maxResults: 5 }).uncitedEntries).toHaveLength(5);
    expect(planCitationsPayload(findings, { maxResults: 5 }).uncitedEntriesOmitted).toBe(45);
    const raised = planCitationsPayload(findings, { maxResults: 50 });
    expect(raised.uncitedEntries).toHaveLength(50);
    expect(raised.uncitedEntriesOmitted).toBe(0);
    expect(raised.note).toBeUndefined();
  });

  it('cuts the NESTED arrays too, each with its own counter', () => {
    // One missing key cited 400 times is a single finding carrying 400 {path,line} objects —
    // capping the outer list alone leaves it entirely uncut.
    const plan = planCitationsPayload({
      ...empty(),
      undefinedCitations: [{ key: 'ghost', uses: places(400) }],
      duplicateKeys: [{ key: 'twice', occurrences: places(37, 'refs.bib') }],
      incompleteEntries: [
        { key: 'thin', path: 'refs.bib', line: 1, type: 'x', missing: places(25).map(String) },
      ],
    });

    expect(CITATIONS_MAX_PLACES).toBe(20);
    expect(plan.undefinedCitations[0]!.uses).toHaveLength(20);
    expect(plan.undefinedCitations[0]!.usesOmitted).toBe(380);
    expect(plan.duplicateKeys[0]!.occurrences).toHaveLength(20);
    expect(plan.duplicateKeys[0]!.occurrencesOmitted).toBe(17);
    expect(plan.incompleteEntries[0]!.missing).toHaveLength(20);
    expect(plan.incompleteEntries[0]!.missingOmitted).toBe(5);
    // The outer lists were never capped, so those counters stay honest at zero.
    expect(plan.undefinedCitationsOmitted).toBe(0);
    expect(plan.note).toContain('nested use/occurrence/field');
  });

  it('omits an inner counter entirely when nothing was cut', () => {
    const plan = planCitationsPayload({
      ...empty(),
      undefinedCitations: [{ key: 'ghost', uses: places(CITATIONS_MAX_PLACES) }],
    });
    expect(plan.undefinedCitations[0]).not.toHaveProperty('usesOmitted');
  });

  it('cuts uncitedEntries FIRST and undefinedCitations LAST when the budget is tight', () => {
    // The ordering the issue is about: a single global budget spent in declaration order would
    // have cut the list that breaks the build because the advisory one ran first.
    const plan = planCitationsPayload(
      {
        undefinedCitations: undefinedCitations(20),
        uncitedEntries: uncited(20),
        duplicateKeys: duplicates(20),
        incompleteEntries: incomplete(20),
      },
      // Room for roughly the first list and a little more, nothing like all four.
      { budget: 1400 },
    );

    expect(plan.undefinedCitations).toHaveLength(20);
    expect(plan.undefinedCitationsOmitted).toBe(0);
    expect(plan.uncitedEntries).toHaveLength(0);
    expect(plan.uncitedEntriesOmitted).toBe(20);
    // And the two in between are cut before the build-breaking one, after the advisory one.
    expect(plan.duplicateKeysOmitted + plan.incompleteEntriesOmitted).toBeGreaterThan(0);
    expect(plan.note).toContain('character budget');
  });

  it('spends the budget strictly in ALLOCATION_ORDER: a cut list stops the ones behind it', () => {
    // duplicateKeys is cut mid-list, so the cheaper lists after it in the order get nothing —
    // never a few tiny advisory rows slipping in behind a truncated higher-priority list.
    const plan = planCitationsPayload(
      {
        undefinedCitations: undefinedCitations(20),
        duplicateKeys: duplicates(20),
        incompleteEntries: incomplete(20),
        uncitedEntries: uncited(20, ''),
      },
      { budget: 1400 },
    );
    expect(ALLOCATION_ORDER).toEqual([
      'undefinedCitations',
      'duplicateKeys',
      'incompleteEntries',
      'uncitedEntries',
    ]);
    expect(plan.duplicateKeys.length).toBeGreaterThan(0);
    expect(plan.duplicateKeysOmitted).toBeGreaterThan(0);
    expect(plan.incompleteEntries).toEqual([]);
    expect(plan.uncitedEntries).toEqual([]);
    expect(plan.incompleteEntriesOmitted).toBe(20);
    expect(plan.uncitedEntriesOmitted).toBe(20);
  });

  it('keeps the first undefined citation even when it alone exceeds the budget', () => {
    // A report that lists nothing tells the caller nothing — not even which key breaks the build.
    const plan = planCitationsPayload(
      { ...empty(), undefinedCitations: [{ key: 'x'.repeat(5000), uses: places(1) }] },
      { budget: 100 },
    );
    expect(plan.undefinedCitations).toHaveLength(1);
    expect(plan.undefinedCitationsOmitted).toBe(0);
  });

  it('does NOT extend that exception to the lists carrying document-controlled free text', () => {
    const plan = planCitationsPayload(
      { ...empty(), uncitedEntries: uncited(1, 'T'.repeat(5000)) },
      { budget: 100 },
    );
    expect(plan.uncitedEntries).toEqual([]);
    expect(plan.uncitedEntriesOmitted).toBe(1);
  });

  it('bounds the RENDERED size of the four lists, not an internal content count', () => {
    // A BibTeX title is LaTeX, and LaTeX is backslash-dense: charging raw `.length` would
    // under-count these by roughly half. The budget has to hold against JSON.stringify.
    const plan = planCitationsPayload({
      undefinedCitations: undefinedCitations(20, 40),
      uncitedEntries: uncited(1000, '\\emph{Über} "Deep\\Learning"\t'.repeat(20)),
      duplicateKeys: duplicates(20, 40),
      incompleteEntries: incomplete(20, ['author', 'title', 'journal|journaltitle']),
    });
    expect(renderedSize(plan)).toBeLessThanOrEqual(CITATIONS_CONTENT_BUDGET);
    expect(plan.uncitedEntriesOmitted).toBeGreaterThan(0);
  });

  it('bounds the default report even when every list is adversarially long', () => {
    const plan = planCitationsPayload({
      undefinedCitations: undefinedCitations(5000, 500),
      uncitedEntries: uncited(5000, 'x'.repeat(300)),
      duplicateKeys: duplicates(5000, 500),
      incompleteEntries: incomplete(
        5000,
        Array.from({ length: 50 }, (_, i) => `f${i}`),
      ),
    });
    expect(renderedSize(plan)).toBeLessThanOrEqual(CITATIONS_CONTENT_BUDGET);
  });

  it('never loses a finding: shown + omitted equals what came in, for every list', () => {
    const findings: CitationsFindings = {
      undefinedCitations: undefinedCitations(137, 3),
      uncitedEntries: uncited(412),
      duplicateKeys: duplicates(9),
      incompleteEntries: incomplete(64),
    };
    const plan = planCitationsPayload(findings, { budget: 2500 });
    expect(plan.undefinedCitations.length + plan.undefinedCitationsOmitted).toBe(137);
    expect(plan.uncitedEntries.length + plan.uncitedEntriesOmitted).toBe(412);
    expect(plan.duplicateKeys.length + plan.duplicateKeysOmitted).toBe(9);
    expect(plan.incompleteEntries.length + plan.incompleteEntriesOmitted).toBe(64);
  });

  it('cuts a tail, never a cherry-picked subset: the kept keys are the leading ones', () => {
    const findings = { ...empty(), uncitedEntries: uncited(50) };
    const plan = planCitationsPayload(findings, { maxResults: 7 });
    expect(plan.uncitedEntries.map((e) => e.key)).toEqual(
      findings.uncitedEntries.slice(0, 7).map((e) => e.key),
    );
  });
});

describe('CITATIONS_MAX_PLACES against the required-field table', () => {
  /**
   * `incompleteEntries[].missing` is filtered from `REQUIRED_FIELDS` in `src/lib/references.ts`,
   * a fixed table — not document-controlled — whose longest rows (`inbook`, `incollection`) hold
   * five specs. The cap is there as a belt on that table growing, so it must stay comfortably
   * above it: if this ever fails, `missingOmitted` has started truncating a real finding and the
   * cap, not the table, is what to revisit.
   */
  it('never truncates a real missing-field list for any entry type the parser knows', () => {
    const types = [
      'article',
      'inproceedings',
      'conference',
      'incollection',
      'inbook',
      'book',
      'booklet',
      'phdthesis',
      'mastersthesis',
      'techreport',
      'manual',
      'proceedings',
      'unpublished',
    ];
    for (const type of types) {
      const [entry] = parseReferences(`@${type}{k${type},\n  note = {}\n}\n`, 'refs.bib');
      expect(entry, type).toBeDefined();
      expect(missingRequiredFields(entry!).length, type).toBeLessThanOrEqual(CITATIONS_MAX_PLACES);
    }
  });
});
