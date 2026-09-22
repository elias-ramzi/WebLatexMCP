import { describe, it, expect } from 'vitest';
import {
  planReferenceFields,
  REFERENCE_FIELDS_BUDGET,
  REFERENCE_MAX_FIELDS_PER_ENTRY,
  REFERENCE_MAX_FIELD_NAME_LENGTH,
  REFERENCE_MAX_FIELD_VALUE_LENGTH,
  FIELDS_MAP_JSON_OVERHEAD,
  FIELD_PAIR_JSON_OVERHEAD,
  MAX_FIELD_PAIR_COST,
} from '../../src/lib/referenceFieldsBudget.js';
import { parseReferences, type ReferenceEntry } from '../../src/lib/references.js';

/**
 * Entries built by the REAL parser from real BibTeX text, not by hand.
 *
 * That tie is the point, the same way `floatsBudget.test.ts` builds its entries as the `.aux`
 * reader's own `AuxLabel`: `planReferenceFields` takes a structural `FieldsBearing`, and the tool
 * hands it a variable rather than an object literal, so TypeScript's excess-property check never
 * fires on the real call. Feeding it the parser's own output means these tests exercise the field
 * maps `list_references` actually emits — lowercased names, `@string` macros already expanded —
 * rather than a shape invented here that could drift away from them without anything failing.
 */
function bibEntry(key: string, fields: Record<string, string>): ReferenceEntry {
  const body = Object.entries(fields)
    .map(([name, value]) => `  ${name} = {${value}},`)
    .join('\n');
  const parsed = parseReferences(`@article{${key},\n${body}\n}\n`, 'ref.bib');
  const entry = parsed[0];
  if (!entry || entry.format !== 'bibtex') throw new Error('fixture did not parse as BibTeX');
  return entry;
}

/** A prose entry — the parser gives these no `fields` map at all. */
function proseEntry(): ReferenceEntry {
  const parsed = parseReferences(
    '1. He, K., Zhang, X. (2016). "Deep Residual Learning." CVPR.\n',
    'proposal.md',
  );
  const entry = parsed[0];
  if (!entry || entry.format !== 'prose') throw new Error('fixture did not parse as prose');
  return entry;
}

/**
 * What one entry's `fields` property really costs in the encoded result: the difference between
 * the entry with it and the same entry without it. Derived from `JSON.stringify` rather than from
 * the module's own constants, so a pin below cannot pass by agreeing with a mistake.
 */
function renderedFieldsCost(entry: ReferenceEntry & { fields?: Record<string, string> }): number {
  if (!entry.fields) return 0;
  const without: Record<string, unknown> = { ...entry };
  delete without.fields;
  return JSON.stringify(entry).length - JSON.stringify(without).length;
}

/** The accounting the planner claims to charge, restated here independently of the module. */
function accountedFieldsCost(fields: Record<string, string>): number {
  return (
    FIELDS_MAP_JSON_OVERHEAD +
    Object.entries(fields).reduce(
      (sum, [name, value]) =>
        sum + JSON.stringify(name).length + JSON.stringify(value).length + FIELD_PAIR_JSON_OVERHEAD,
      0,
    )
  );
}

describe('planReferenceFields — nothing to cut', () => {
  it('passes an ordinary bibliography through untouched, with no note and no counts', () => {
    const entries = [
      bibEntry('he2016deep', {
        title: 'Deep Residual Learning for {Image} Recognition',
        author: 'He, Kaiming and Zhang, Xiangyu',
        booktitle: 'CVPR',
        year: '2016',
      }),
      bibEntry('cabon2020virtual', { title: 'Virtual {KITTI} 2', year: '2020' }),
    ];

    const plan = planReferenceFields(entries);

    expect(plan.note).toBeUndefined();
    expect(plan.omittedOversize + plan.omittedByCap + plan.omittedBySize).toBe(0);
    expect(plan.entries.map((e) => e.fields)).toEqual(entries.map((e) => e.fields));
    expect(plan.entries.every((e) => e.fieldsOmitted === undefined)).toBe(true);
  });

  it('leaves an entry the parser gave no field map alone — no `fields`, no `fieldsOmitted`', () => {
    const prose = proseEntry();
    expect(prose.fields).toBeUndefined();

    const [planned] = planReferenceFields([prose]).entries;

    expect(planned).toBeDefined();
    expect('fields' in planned!).toBe(false);
    expect(planned!.fieldsOmitted).toBeUndefined();
  });

  it('keeps an empty map empty rather than dropping the key — @misc{k} has no fields', () => {
    const parsed = parseReferences('@misc{bare}\n', 'ref.bib');
    expect(parsed[0]?.fields).toEqual({});

    const [planned] = planReferenceFields(parsed).entries;

    expect(planned!.fields).toEqual({});
    expect(planned!.fieldsOmitted).toBeUndefined();
  });
});

describe('planReferenceFields — the per-entry field cap', () => {
  const many = Object.fromEntries(
    Array.from({ length: REFERENCE_MAX_FIELDS_PER_ENTRY + 5 }, (_, i) => [`f${i}`, `v${i}`]),
  );

  it('keeps the first fields the document writes and counts the tail, never reordering', () => {
    const [planned] = planReferenceFields([bibEntry('bloated', many)]).entries;

    const kept = Object.keys(planned!.fields!);
    expect(kept).toHaveLength(REFERENCE_MAX_FIELDS_PER_ENTRY);
    // The document's own order, prefix-wise: a cut tail, never a cherry-pick.
    expect(kept).toEqual(Object.keys(many).slice(0, REFERENCE_MAX_FIELDS_PER_ENTRY));
    expect(planned!.fieldsOmitted).toBe(5);
  });

  it('names only the cap in the note — not the length gates or the budget', () => {
    const plan = planReferenceFields([bibEntry('bloated', many)]);

    expect(plan.omittedByCap).toBe(5);
    expect(plan.omittedOversize).toBe(0);
    expect(plan.omittedBySize).toBe(0);
    expect(plan.note).toContain(`at most ${REFERENCE_MAX_FIELDS_PER_ENTRY} fields`);
    expect(plan.note).not.toMatch(/budget/);
    expect(plan.note).not.toMatch(/shortened/);
    // The remedy is always the same one, and it is always stated.
    expect(plan.note).toContain('`raw`');
  });
});

describe('planReferenceFields — the length gates drop, they never truncate', () => {
  it('drops an over-long value whole and leaves every kept value byte-exact', () => {
    const abstract = 'x'.repeat(REFERENCE_MAX_FIELD_VALUE_LENGTH + 1);
    const entry = bibEntry('withabstract', {
      title: 'A Short Title',
      abstract,
      year: '2024',
    });

    const plan = planReferenceFields([entry]);
    const fields = plan.entries[0]!.fields!;

    expect(Object.keys(fields)).toEqual(['title', 'year']);
    // The whole point: no truncated `abstract` masquerading as an exact BibTeX value.
    expect(Object.values(fields).some((v) => abstract.startsWith(v) && v.length > 0)).toBe(false);
    expect(plan.omittedOversize).toBe(1);
    expect(plan.entries[0]!.fieldsOmitted).toBe(1);
    expect(plan.note).toContain('dropped whole');
    expect(plan.note).not.toMatch(/at most \d+ fields/);
  });

  it('keeps a value exactly at the gate — the bound is inclusive, not off by one', () => {
    const value = 'y'.repeat(REFERENCE_MAX_FIELD_VALUE_LENGTH);
    const plan = planReferenceFields([bibEntry('edge', { note: value })]);

    expect(plan.entries[0]!.fields).toEqual({ note: value });
    expect(plan.omittedOversize).toBe(0);
  });

  it('drops an over-long field NAME, which is document-controlled too', () => {
    const name = `f${'z'.repeat(REFERENCE_MAX_FIELD_NAME_LENGTH)}`;
    const plan = planReferenceFields([bibEntry('longname', { title: 'Fine', [name]: 'v' })]);

    expect(plan.entries[0]!.fields).toEqual({ title: 'Fine' });
    expect(plan.omittedOversize).toBe(1);
  });
});

describe('planReferenceFields — the shared rendered-size budget', () => {
  /** Twelve entries each carrying ~2000 characters of fields: ~24k, over the 20000 budget. */
  function bigBibliography(): ReferenceEntry[] {
    return Array.from({ length: 12 }, (_, i) =>
      bibEntry(`e${i}`, {
        title: `Entry ${i}`,
        note: 'n'.repeat(REFERENCE_MAX_FIELD_VALUE_LENGTH - 1),
      }),
    );
  }

  it('cuts a tail across entries and never leaves a hole in the middle', () => {
    const plan = planReferenceFields(bigBibliography());

    const withFields = plan.entries.map((e) => 'fields' in e);
    const firstCut = withFields.indexOf(false);
    expect(firstCut).toBeGreaterThan(0);
    // Sticky: once the budget refuses a field, nothing later gets one — a describable prefix
    // ("the first N entries carry their fields"), not entries 1, 2 and 7.
    expect(withFields.slice(firstCut).some(Boolean)).toBe(false);
    expect(plan.omittedBySize).toBeGreaterThan(0);
    expect(plan.note).toContain(`${REFERENCE_FIELDS_BUDGET}-char budget`);
  });

  it('reports an entirely-cut entry as a count, never as an empty map', () => {
    const plan = planReferenceFields(bigBibliography());
    const cut = plan.entries.filter((e) => !('fields' in e));

    expect(cut.length).toBeGreaterThan(0);
    for (const entry of cut) {
      // `fieldsOmitted` present and `fields` absent says "this entry HAS fields and none fit".
      // An empty map would say "this entry has no fields", which is a different, false claim.
      expect(entry.fieldsOmitted).toBe(2);
      expect(entry.fields).toBeUndefined();
    }
  });

  it('charges what the caller actually receives, and stays inside the budget', () => {
    const plan = planReferenceFields(bigBibliography());

    let rendered = 0;
    for (const entry of plan.entries) {
      if (!entry.fields) continue;
      const accounted = accountedFieldsCost(entry.fields);
      // The accounting is an UPPER bound on the real encoded cost, never a low one.
      expect(accounted).toBeGreaterThanOrEqual(renderedFieldsCost(entry));
      rendered += renderedFieldsCost(entry);
    }
    expect(rendered).toBeLessThanOrEqual(REFERENCE_FIELDS_BUDGET);
  });

  it('charges JSON-escaped width, so backslash-dense LaTeX costs what it really costs', () => {
    const entries = [
      bibEntry('a', { title: '\\,'.repeat(450) }),
      bibEntry('b', { title: '\\,'.repeat(450) }),
    ];
    const value = entries[0]!.fields!.title!;
    // A budget exactly big enough for BOTH maps if each character were charged its raw width —
    // the accounting mistake `conflictBudget.ts` measured a 6x under-count from. LaTeX is
    // backslash-dense, so the encoded width is far larger and only the first map fits.
    const naivePerMap = FIELDS_MAP_JSON_OVERHEAD + 'title'.length + 2 + value.length + 2 + 2;

    const plan = planReferenceFields(entries, { budget: naivePerMap * 2 });

    expect(JSON.stringify(value).length).toBeGreaterThan(value.length * 1.4);
    expect(plan.entries[0]!.fields).toEqual(entries[0]!.fields);
    expect(plan.entries[1]!.fields).toBeUndefined();
    expect(plan.omittedBySize).toBe(1);
  });

  it('needs no keep-at-least-one exception: one gated pair always fits the default budget', () => {
    // Structural, from the constants: the two length gates bound one pair's encoded cost, so the
    // case `floatsBudget.ts`/`searchBudget.ts` have to excuse cannot arise at the default budget.
    expect(MAX_FIELD_PAIR_COST + FIELDS_MAP_JSON_OVERHEAD).toBeLessThan(REFERENCE_FIELDS_BUDGET);

    // And empirically, on the worst pair the gates admit: every character an escape that doubles.
    const worst = bibEntry('worst', {
      [`f${'a'.repeat(REFERENCE_MAX_FIELD_NAME_LENGTH - 1)}`]: '\\'.repeat(
        REFERENCE_MAX_FIELD_VALUE_LENGTH,
      ),
    });
    const kept = planReferenceFields([worst]).entries[0]!.fields!;
    expect(Object.keys(kept)).toHaveLength(1);
    expect(accountedFieldsCost(kept)).toBeLessThanOrEqual(
      MAX_FIELD_PAIR_COST + FIELDS_MAP_JSON_OVERHEAD,
    );
  });

  it('reports every bound that fired, and only those', () => {
    const plan = planReferenceFields(
      [
        bibEntry('mixed', {
          title: 'Kept',
          abstract: 'x'.repeat(REFERENCE_MAX_FIELD_VALUE_LENGTH + 1),
          note: 'n'.repeat(500),
        }),
        bibEntry('later', { title: 'Cut by the budget' }),
      ],
      { budget: 120 },
    );

    expect(plan.omittedOversize).toBe(1);
    expect(plan.omittedBySize).toBe(2);
    expect(plan.omittedByCap).toBe(0);
    expect(plan.note).toContain('dropped whole');
    expect(plan.note).toContain('120-char budget');
    expect(plan.note).not.toMatch(/at most \d+ fields/);
  });
});
