import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import type { ServerConfig } from '../../src/types.js';
import { expectDeclaredField, expectNoUndeclaredKeys } from '../helpers/outputSchema.js';
import {
  ALLOCATION_ORDER,
  AUTHORS_OMITTED_JSON_OVERHEAD,
  AUTHORS_PROPERTY_JSON_OVERHEAD,
  MAX_ENTRY_COUNTER_COST,
  MAX_TYPED_MARKER_COST,
  planReferenceTyped,
  REFERENCE_MAX_AUTHORS,
  REFERENCE_MAX_IDENTITY_LENGTH,
  REFERENCE_MAX_TYPED_VALUE_LENGTH,
  REFERENCE_TYPED_BUDGET,
  renderReferenceLine,
  TYPED_OMITTED_JSON_OVERHEAD,
  typedElisionMarker,
  type TypedBearing,
  type TypedBudgetedEntry,
} from '../../src/lib/referenceTypedBudget.js';
import {
  REFERENCE_FIELDS_BUDGET,
  FIELDS_MAP_JSON_OVERHEAD,
} from '../../src/lib/referenceFieldsBudget.js';
import {
  MAX_RAW_MARKER_COST,
  RAW_PROPERTY_JSON_OVERHEAD,
} from '../../src/lib/referenceRawBudget.js';
import { parseReferences, type ReferenceEntry } from '../../src/lib/references.js';

/**
 * Entries built by the REAL parser from real bibliography text, never by hand — the tie
 * `referenceFieldsBudget.test.ts` and `referenceRawBudget.test.ts` both keep. The typed fields are
 * exactly the parser's own slices (a BibTeX `title` value, a `and`-split author list, a quoted
 * span out of a prose paragraph), so a change to what the parser claims shows up here rather than
 * being hidden behind a shape invented in this file.
 */
type Located = ReferenceEntry & { path: string };

function located(text: string, file: string): Located[] {
  return parseReferences(text, file).map((e) => ({ ...e, path: file }));
}

function bibText(key: string, fields: Record<string, string>): string {
  const body = Object.entries(fields)
    .map(([name, value]) => `  ${name} = {${value}},`)
    .join('\n');
  return `@article{${key},\n${body}\n}\n`;
}

function bibEntries(text: string): Located[] {
  const parsed = located(text, 'ref.bib');
  if (parsed.length === 0 || parsed.some((e) => e.format !== 'bibtex')) {
    throw new Error('fixture did not parse as BibTeX');
  }
  return parsed;
}

function bibEntry(key: string, fields: Record<string, string>): Located {
  return bibEntries(bibText(key, fields))[0]!;
}

/** An ordinary, well-formed bibliography: nothing here should ever be cut at these sizes. */
function ordinaryBibliography(count: number): Located[] {
  return bibEntries(
    Array.from({ length: count }, (_, i) =>
      bibText(`smith${i}2020deep`, {
        title: `Deep Residual Learning for Image Recognition, Part ${i}`,
        author: 'He, Kaiming and Zhang, Xiangyu and Ren, Shaoqing and Sun, Jian',
        journal: 'IEEE/CVF Conference on Computer Vision and Pattern Recognition',
        doi: '10.1109/CVPR.2016.90',
        year: '2016',
      }),
    ).join('\n'),
  );
}

/**
 * What the typed region really costs in the result, in BOTH channels: the difference between the
 * entry as it will be sent and the same entry with every typed key removed, in the JSON encoding
 * and in the rendered text. Derived here from `JSON.stringify` and the real renderer rather than
 * from the planner's own constants, so a pin below cannot pass by agreeing with a mistake.
 */
const TYPED_KEYS = [
  'key',
  'label',
  'type',
  'title',
  'authors',
  'venue',
  'doi',
  'url',
  'arxivId',
  'typedOmitted',
  'authorsOmitted',
];

function withoutTyped(entry: TypedBudgetedEntry<TypedBearing>): TypedBudgetedEntry<TypedBearing> {
  const bare = { ...entry } as Record<string, unknown>;
  for (const key of TYPED_KEYS) delete bare[key];
  bare.authors = [];
  return bare as unknown as TypedBudgetedEntry<TypedBearing>;
}

function renderedTypedCost(entry: TypedBudgetedEntry<TypedBearing>): number {
  const bare = withoutTyped(entry);
  return (
    JSON.stringify(entry).length -
    JSON.stringify(bare).length +
    Math.max(0, renderReferenceLine(entry).length - renderReferenceLine(bare).length)
  );
}

function typedChannel(entries: ReadonlyArray<TypedBudgetedEntry<TypedBearing>>): number {
  return entries.reduce((sum, e) => sum + renderedTypedCost(e), 0);
}

/** The documented per-entry overspend: a marker-only title plus the two counters. */
const MAX_PER_ENTRY_OVERSPEND = MAX_TYPED_MARKER_COST + MAX_ENTRY_COUNTER_COST;

describe('planReferenceTyped — nothing to cut', () => {
  it('passes an ordinary bibliography through untouched, with no marker, counter or note', () => {
    const entries = ordinaryBibliography(10);

    const plan = planReferenceTyped(entries);

    expect(plan.entries.map((e) => e.title)).toEqual(entries.map((e) => e.title));
    expect(plan.entries.map((e) => e.authors)).toEqual(entries.map((e) => e.authors));
    expect(plan.entries.map((e) => e.venue)).toEqual(entries.map((e) => e.venue));
    expect(plan.entries.map((e) => e.doi)).toEqual(entries.map((e) => e.doi));
    expect(plan.entries.some((e) => 'typedOmitted' in e)).toBe(false);
    expect(plan.entries.some((e) => 'authorsOmitted' in e)).toBe(false);
    expect(plan.charactersOmitted).toBe(0);
    // Absent, not present-and-zero: a note reports something that happened.
    expect(plan.note).toBeUndefined();
  });

  it('never reorders, and never prefers a small entry over a large one', () => {
    const entries = [
      bibEntry('bulky', { title: 'T'.repeat(REFERENCE_MAX_TYPED_VALUE_LENGTH) }),
      bibEntry('tiny', { title: 'Tiny' }),
    ];

    const plan = planReferenceTyped(entries);

    expect(plan.entries.map((e) => e.key)).toEqual(['bulky', 'tiny']);
  });

  it('leaves a field the parser never claimed absent, and says so by omitting the counter', () => {
    // The parser under-claims for prose on purpose; the budget runs after it and never widens it.
    const entries = located(
      '1. Smith, J. (2020). Nothing a heuristic can split out of this line. Journal.\n',
      'doc.md',
    );
    expect(entries[0]!.title).toBeUndefined();

    const plan = planReferenceTyped(entries);

    expect(plan.entries[0]!.title).toBeUndefined();
    expect(plan.entries[0]!.typedOmitted).toBeUndefined();
  });
});

describe('planReferenceTyped — prose-shaped values are cut, never dropped', () => {
  it('cuts an over-long title to a MARKED prefix and counts the characters', () => {
    const title = `Deep Residual Learning ${'and more '.repeat(600)}`;
    const entries = [bibEntry('verbose2024', { title })];

    const plan = planReferenceTyped(entries);
    const entry = plan.entries[0]!;

    expect(entry.title!.startsWith('Deep Residual Learning')).toBe(true);
    expect(entry.title).toContain('characters omitted]');
    expect(entry.title!.length).toBeLessThan(REFERENCE_MAX_TYPED_VALUE_LENGTH + 60);
    // Against the PARSER's own value, not the fixture's: BibTeX trims what it hands back.
    expect(entry.typedOmitted).toBe(entries[0]!.title!.length - REFERENCE_MAX_TYPED_VALUE_LENGTH);
    expect(plan.truncatedOversize).toBe(1);
    expect(plan.note).toContain(`first ${REFERENCE_MAX_TYPED_VALUE_LENGTH} characters`);
  });

  it('bounds the heuristic title of a PROSE document, which has no .bib gate anywhere', () => {
    // The shape the issue names: a quoted span in free text is however long the delimiters are
    // apart, and `references.ts` claims all of it. No BibTeX, no `.bib`, no other bound.
    const slurped = 'Lorem ipsum dolor sit amet '.repeat(300);
    const entries = located(`1. Smith, J. (2020). "${slurped}" Journal of Things.\n`, 'doc.md');
    expect(entries[0]!.format).toBe('prose');
    expect(entries[0]!.title!.length).toBeGreaterThan(REFERENCE_MAX_TYPED_VALUE_LENGTH * 3);

    const plan = planReferenceTyped(entries);
    const entry = plan.entries[0]!;

    expect(entry.title!.length).toBeLessThan(REFERENCE_MAX_TYPED_VALUE_LENGTH + 60);
    expect(entry.title).toContain('characters omitted]');
    expect(entry.typedOmitted).toBeGreaterThan(0);
  });

  it('never splits a surrogate pair, which would invent a character the document never had', () => {
    const entries = [
      bibEntry('emoji', { title: `${'a'.repeat(REFERENCE_MAX_TYPED_VALUE_LENGTH - 1)}😀 tail` }),
    ];

    const plan = planReferenceTyped(entries);
    const title = plan.entries[0]!.title!;

    expect(title).not.toContain('�');
    expect(
      [...title].every((ch) => ch.codePointAt(0)! < 0xd800 || ch.codePointAt(0)! > 0xdfff),
    ).toBe(true);
  });
});

describe('planReferenceTyped — identity and identifiers are dropped whole, never truncated', () => {
  it('drops an absurdly long cite key rather than handing back a key that does not exist', () => {
    const key = 'k'.repeat(REFERENCE_MAX_IDENTITY_LENGTH + 1);
    const entries = [bibEntry(key, { title: 'A Modest Title' })];

    const plan = planReferenceTyped(entries);
    const entry = plan.entries[0]!;

    expect(entry.key).toBeUndefined();
    // Not a prefix of it either: half a cite key would be indistinguishable from a real one.
    // Judged on the typed region alone — `raw` is the verbatim entry and still has the key,
    // which is exactly what makes dropping it survivable rather than lossy.
    const typedOnly = { ...entry, raw: undefined, fields: undefined };
    expect(JSON.stringify(typedOnly)).not.toContain('kkkk');
    expect(entry.typedOmitted).toBe(key.length);
    expect(plan.omittedOversize).toBe(1);
    // The entry is still locatable, which is the reason dropping it is survivable.
    expect(entry.path).toBe('ref.bib');
    expect(entry.line).toBe(1);
    expect(plan.note).toContain('dropped whole');
  });

  it('keeps every ordinary key and label, however exhausted the budget is', () => {
    const entries = ordinaryBibliography(12);

    const plan = planReferenceTyped(entries, { budget: 1 });

    expect(plan.entries.map((e) => e.key)).toEqual(entries.map((e) => e.key));
    // …while everything the pool governs is gone from the same entries.
    expect(plan.entries.every((e) => e.venue === undefined)).toBe(true);
    expect(plan.entries.every((e) => e.doi === undefined)).toBe(true);
  });

  it('drops an over-long DOI or URL whole: half an identifier resolves to nothing', () => {
    const url = `https://example.com/${'x'.repeat(REFERENCE_MAX_TYPED_VALUE_LENGTH)}`;
    const doi = `10.1109/${'y'.repeat(REFERENCE_MAX_TYPED_VALUE_LENGTH)}`;
    const entries = [bibEntry('long2024', { title: 'A Modest Title', url, doi })];

    const plan = planReferenceTyped(entries);
    const entry = plan.entries[0]!;

    expect(entry.url).toBeUndefined();
    expect(entry.doi).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain('characters omitted]');
    expect(plan.omittedOversize).toBe(2);
    expect(entry.typedOmitted).toBe(url.length + doi.length);
  });
});

describe('planReferenceTyped — authors get an element cap as well as a charge', () => {
  /** The collaboration list the issue names: ordinary in high-energy physics and in benchmarks. */
  function collaboration(count: number): Located[] {
    const names = Array.from({ length: count }, (_, i) => `Author${i}, A.`).join(' and ');
    return [bibEntry('atlas2012higgs', { title: 'Observation of a New Particle', author: names })];
  }

  it('returns the first 20 of 200 names and reports the rest as a count', () => {
    const entries = collaboration(200);
    expect(entries[0]!.authors).toHaveLength(200);

    const plan = planReferenceTyped(entries);
    const entry = plan.entries[0]!;

    expect(entry.authors).toHaveLength(REFERENCE_MAX_AUTHORS);
    expect(entry.authorsOmitted).toBe(200 - REFERENCE_MAX_AUTHORS);
    // A TAIL in the document's order: the first author, the one a citation is spoken by, is kept.
    expect(entry.authors[0]).toBe('A. Author0');
    expect(entry.authors).toEqual(entries[0]!.authors.slice(0, REFERENCE_MAX_AUTHORS));
    expect(plan.authorsOmittedByCap).toBe(180);
    expect(plan.note).toContain(`at most ${REFERENCE_MAX_AUTHORS}`);
  });

  it('is a different claim from `truncatedAuthors`, which is the DOCUMENT abbreviating', () => {
    const plan = planReferenceTyped(collaboration(200));
    const entry = plan.entries[0]!;

    // The document named all 200, so it never said `and others` — the cut is ours, and only ours.
    expect(entry.truncatedAuthors).toBe(false);
    expect(entry.authorsOmitted).toBeGreaterThan(0);
  });

  it('bounds a character budget a count alone would not: 200 one-word names still cost', () => {
    const plan = planReferenceTyped(collaboration(200));

    expect(typedChannel(plan.entries)).toBeLessThanOrEqual(
      REFERENCE_TYPED_BUDGET + MAX_PER_ENTRY_OVERSPEND,
    );
    // The defect as a number: unbudgeted, one entry alone carries this much author text.
    expect(typedChannel(collaboration(200))).toBeGreaterThan(2 * REFERENCE_MAX_TYPED_VALUE_LENGTH);
  });
});

describe('planReferenceTyped — the shared budget, spent in priority order', () => {
  it('gives EVERY entry its title before giving any entry its URL', () => {
    // Entry-first spending would hand the first few entries everything and the rest nothing —
    // including their titles, which is the field this module exists to protect.
    const entries = ordinaryBibliography(60).map((e, i) => ({
      ...e,
      url: `https://example.com/paper/${i}/${'p'.repeat(200)}`,
    }));

    const plan = planReferenceTyped(entries);

    expect(plan.entries.every((e) => e.title !== undefined)).toBe(true);
    expect(plan.entries.every((e) => !e.title!.includes('characters omitted'))).toBe(true);
    // The lowest-priority field is the one that went.
    expect(plan.entries.filter((e) => e.url !== undefined).length).toBeLessThan(
      plan.entries.length,
    );
  });

  it('cuts a TAIL within a pass, not holes', () => {
    const entries = ordinaryBibliography(60);

    const plan = planReferenceTyped(entries);

    const withVenue = plan.entries.map((e) => e.venue !== undefined);
    const firstCut = withVenue.indexOf(false);
    expect(firstCut).toBeGreaterThan(0);
    expect(withVenue.slice(firstCut).some(Boolean)).toBe(false);
  });

  it('keeps a MARKER on a title the pool refused, so the text cannot fall back to `raw`', () => {
    const entries = ordinaryBibliography(400);

    const plan = planReferenceTyped(entries);
    const starved = plan.entries[plan.entries.length - 1]!;

    expect(starved.title).toBe(typedElisionMarker(entries[entries.length - 1]!.title!.length));
    expect(starved.typedOmitted).toBeGreaterThan(0);
    // The renderer's `raw` fallback is what this marker exists to disarm.
    expect(renderReferenceLine(starved)).not.toContain('@article');
  });

  it('holds the typed channel inside the budget, charged on what is actually sent', () => {
    const entries = ordinaryBibliography(200);

    const plan = planReferenceTyped(entries);
    const cut = plan.entries.filter((e) => e.typedOmitted !== undefined).length;

    expect(cut).toBeGreaterThan(0);
    expect(typedChannel(plan.entries)).toBeLessThanOrEqual(
      REFERENCE_TYPED_BUDGET + cut * MAX_PER_ENTRY_OVERSPEND,
    );
    // The defect this exists for, stated as a number: unbudgeted, the parsed fields of an
    // ORDINARY 200-entry bibliography (`maxResults`' own default) already cost three times this
    // region's whole allocation, before `fields`, `raw` or the per-entry scaffold are counted.
    expect(typedChannel(entries)).toBeGreaterThan(3 * REFERENCE_TYPED_BUDGET);
  });

  it('honours a caller-supplied budget, gate and cap, since the defaults are only defaults', () => {
    const entries = ordinaryBibliography(3);

    const plan = planReferenceTyped(entries, { budget: 1, maxValueLength: 10, maxAuthors: 1 });

    expect(plan.entries.every((e) => e.authors.length === 0)).toBe(true);
    expect(plan.entries.every((e) => e.typedOmitted! > 0)).toBe(true);
  });
});

describe('planReferenceTyped — the constants and the allocation table', () => {
  it('shares the house figure with its two siblings rather than declaring a third number', () => {
    expect(REFERENCE_TYPED_BUDGET).toBe(REFERENCE_FIELDS_BUDGET);
  });

  it('ranks every typed field exactly once, so none is silently unbudgeted', () => {
    const ranked = ALLOCATION_ORDER.map((s) => s.field);
    expect([...ranked].sort()).toEqual(
      ['arxivId', 'authors', 'doi', 'key', 'label', 'title', 'type', 'url', 'venue'].sort(),
    );
    // The order IS the behaviour: title first, url and type last.
    expect(ranked[2]).toBe('title');
    expect(ranked[3]).toBe('authors');
    expect(ranked[ranked.length - 1]).toBe('type');
    // Exactly one field keeps a marker past the pool, and it is the one the renderer falls back
    // for. Two would double the overspend; none would let `raw` back into the text channel.
    expect(ALLOCATION_ORDER.filter((s) => s.markerWhenExhausted).map((s) => s.field)).toEqual([
      'title',
    ]);
  });

  it('charges the JSON property overheads it names', () => {
    expect(AUTHORS_PROPERTY_JSON_OVERHEAD).toBe(',"authors":[]'.length);
    expect(TYPED_OMITTED_JSON_OVERHEAD).toBe(',"typedOmitted":'.length);
    expect(AUTHORS_OMITTED_JSON_OVERHEAD).toBe(',"authorsOmitted":'.length);
  });

  it('bounds the marker cost it claims to bound, and keeps it cheap enough to repeat', () => {
    expect(JSON.stringify(typedElisionMarker(1_234_567_890)).length).toBeLessThanOrEqual(
      MAX_TYPED_MARKER_COST,
    );
    expect(MAX_TYPED_MARKER_COST).toBeLessThan(100);
  });
});

describe('renderReferenceLine', () => {
  it('tells a text-only reader that the author list was cut', () => {
    const plan = planReferenceTyped([
      bibEntry('big2012', {
        title: 'A Paper',
        author: Array.from({ length: 50 }, (_, i) => `Author${i}, A.`).join(' and '),
      }),
    ]);

    expect(renderReferenceLine(plan.entries[0]!)).toContain('(+30 more)');
  });

  it('still falls back to `raw` for an entry the parser gave no title', () => {
    const entries = located(
      '1. Smith, J. (2020). Nothing a heuristic can split out of this line. Journal.\n',
      'doc.md',
    );
    const plan = planReferenceTyped(entries);

    expect(plan.entries[0]!.title).toBeUndefined();
    expect(renderReferenceLine(plan.entries[0]!)).toContain('Nothing a heuristic');
  });
});

/**
 * Through the tool, over a real local project in a temp dir — no git, no network, no mocks.
 *
 * The keys are asserted off a real `listTools()` round trip because that is the only thing that
 * proves they are DECLARED: the SDK's `Client` compiles an ajv validator per advertised schema
 * during `listTools()` and rejects a result carrying an undeclared key with
 * `-32602 … must NOT have additional properties`, returning no result at all. `list_references`
 * was uncallable from v0.6.0 for exactly that (#137), and the `shelve` trio from its first release
 * (#146), so every counter added here goes through this door.
 */
describe('list_references bounds the parsed fields on the wire', () => {
  const cleanups: Array<() => Promise<unknown>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(): Promise<{ client: Client; userDir: string }> {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-typedb-ws-'));
    const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-typedb-dir-'));
    cleanups.push(
      () => rm(workspace, { recursive: true, force: true }),
      () => rm(userDir, { recursive: true, force: true }),
    );
    const config: ServerConfig = { workspaceRoot: workspace, sessionId: 'test', projects: [] };
    const ctx = createContext(
      config,
      new CredentialResolver({}),
      { name: 'Test', email: 'test@example.com' },
      new ProjectRegistry(workspace),
    );
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());
    await client.callTool({
      name: 'register_project',
      arguments: { project: 'paper', path: userDir },
    });
    return { client, userDir };
  }

  function textOf(res: unknown): string {
    return JSON.stringify((res as { content?: unknown }).content ?? '');
  }

  type WireEntry = TypedBudgetedEntry<TypedBearing> & {
    raw: string;
    rawOmitted?: number;
    fields?: Record<string, string>;
    fieldsOmitted?: number;
  };

  it('declares every counter it emits, and emits nothing it does not declare', async () => {
    const { client, userDir } = await setup();
    // One file that fires all three budgets at once: bulky field maps and `raw`, a 200-author
    // list, and a title no `.bib` should carry.
    await writeFile(
      path.join(userDir, 'ref.bib'),
      [
        bibText('huge2024', {
          title: `A Title ${'that runs on '.repeat(400)}`,
          author: Array.from({ length: 200 }, (_, i) => `Author${i}, A.`).join(' and '),
          note: 'n'.repeat(1900),
        }),
        ...Array.from({ length: 40 }, (_, i) =>
          bibText(`bulk${i}`, {
            title: `Entry ${i} ${'with a fairly long descriptive title '.repeat(4)}`,
            author: 'He, Kaiming and Zhang, Xiangyu and Ren, Shaoqing',
            journal: 'IEEE/CVF Conference on Computer Vision and Pattern Recognition',
            note: 'n'.repeat(900),
          }),
        ),
      ].join('\n'),
    );

    await expectDeclaredField(client, 'list_references', 'entries[].typedOmitted', {
      required: false,
    });
    await expectDeclaredField(client, 'list_references', 'entries[].authorsOmitted', {
      required: false,
    });
    await expectDeclaredField(client, 'list_references', 'typedNote', { required: false });
    // The promises the cuts qualify: a caller sent to `raw` has to be told `raw` can be cut too.
    await expectDeclaredField(client, 'list_references', 'entries[].title', {
      description: /characters omitted/,
    });
    await expectDeclaredField(client, 'list_references', 'entries[].key', {
      description: /dropped whole/,
    });
    // `format` is where a caller is told to fall back to `raw`; #147 made `raw` cuttable and
    // #165 makes `title` cuttable, so that sentence has to name the case where neither is whole.
    await expectDeclaredField(client, 'list_references', 'entries[].format', {
      description: /rawOmitted/,
    });

    const res = await client.callTool({
      name: 'list_references',
      arguments: { project: 'paper', path: 'ref.bib' },
    });
    expect(res.isError).toBeFalsy();

    // The whole payload against the whole schema: the key nobody thought to ask about is the one
    // that makes a tool uncallable.
    await expectNoUndeclaredKeys(client, 'list_references', res.structuredContent);
  });

  it('caps a 200-author entry and reports the total, in both channels', async () => {
    const { client, userDir } = await setup();
    await writeFile(
      path.join(userDir, 'ref.bib'),
      bibText('atlas2012higgs', {
        title: 'Observation of a New Particle',
        author: Array.from({ length: 200 }, (_, i) => `Author${i}, A.`).join(' and '),
        year: '2012',
      }),
    );

    const res = await client.callTool({
      name: 'list_references',
      arguments: { project: 'paper', path: 'ref.bib' },
    });
    const { entries, typedNote } = res.structuredContent as {
      entries: WireEntry[];
      typedNote?: string;
    };

    expect(entries[0]!.authors).toHaveLength(REFERENCE_MAX_AUTHORS);
    expect(entries[0]!.authorsOmitted).toBe(180);
    expect(typedNote).toContain(`at most ${REFERENCE_MAX_AUTHORS}`);
    // The text channel is rendered from the already-cut payload, and says what it cut.
    const text = textOf(res);
    expect(text).toContain('(+180 more)');
    expect(text).not.toContain('Author199');
  });

  it('bounds the heuristic title of a prose document, which has no .bib gate at all', async () => {
    const { client, userDir } = await setup();
    const slurped = 'Lorem ipsum dolor sit amet consectetur '.repeat(200);
    await writeFile(
      path.join(userDir, 'notes.md'),
      ['# Notes', '', '## References', '', `1. Smith, J. (2020). "${slurped}" Journal.`, ''].join(
        '\n',
      ),
    );

    const res = await client.callTool({
      name: 'list_references',
      arguments: { project: 'paper', path: 'notes.md' },
    });
    const { entries, typedNote } = res.structuredContent as {
      entries: WireEntry[];
      typedNote?: string;
    };

    expect(entries[0]!.format).toBe('prose');
    expect(entries[0]!.title!.length).toBeLessThan(REFERENCE_MAX_TYPED_VALUE_LENGTH + 60);
    expect(entries[0]!.title).toContain('characters omitted]');
    expect(entries[0]!.typedOmitted).toBeGreaterThan(0);
    expect(typedNote).toBeDefined();
    // Rendered from the cut payload: the text channel carries the marker, not the paragraph.
    const text = textOf(res);
    expect(text).toContain('characters omitted');
    expect(text.length).toBeLessThan(slurped.length);
  });

  it('holds all THREE document-controlled regions inside their budgets at once', async () => {
    const { client, userDir } = await setup();
    // 120 entries, each with a long title, a long author list, a long venue and a 1200-character
    // note: every region over its allocation, which is the case the three planners have to bound
    // together rather than one at a time.
    await writeFile(
      path.join(userDir, 'ref.bib'),
      Array.from({ length: 120 }, (_, i) =>
        bibText(`bulk${i}`, {
          title: `Entry ${i} ${'with a long descriptive subtitle '.repeat(6)}`,
          author: Array.from({ length: 30 }, (_, a) => `Author${a}, A.`).join(' and '),
          journal: `Proceedings of the ${'Very '.repeat(20)}Long Conference`,
          note: 'n'.repeat(1200),
        }),
      ).join('\n'),
    );

    const res = await client.callTool({
      name: 'list_references',
      arguments: { project: 'paper', path: 'ref.bib' },
    });
    expect(res.isError).toBeFalsy();
    const { entries } = res.structuredContent as { entries: WireEntry[] };
    expect(entries).toHaveLength(120);

    const fieldsChannel = entries.reduce(
      (sum, e) =>
        e.fields ? sum + JSON.stringify(e.fields).length + FIELDS_MAP_JSON_OVERHEAD : sum,
      0,
    );
    const rawChannel = entries.reduce(
      (sum, e) => sum + JSON.stringify(e.raw).length + RAW_PROPERTY_JSON_OVERHEAD,
      0,
    );
    const typed = typedChannel(entries);

    // The figure decision 3 of `referenceTypedBudget.ts` argues for: three allocations of the one
    // house constant, 3 x 20000 = 60000 RENDERED characters across both channels — the typed
    // region being the only one charged against the text as well — plus the per-entry overspends
    // each planner documents (a marker on a cut `raw`, a marker on a starved `title`, the
    // counters that make a cut visible).
    const cut = entries.filter(
      (e) => e.typedOmitted !== undefined || e.rawOmitted !== undefined,
    ).length;
    expect(cut).toBeGreaterThan(0);
    expect(fieldsChannel + rawChannel + typed).toBeLessThanOrEqual(
      3 * REFERENCE_FIELDS_BUDGET +
        cut * (MAX_RAW_MARKER_COST + MAX_PER_ENTRY_OVERSPEND + RAW_PROPERTY_JSON_OVERHEAD),
    );
    // And each region is separately inside its own allocation, so one cannot hide behind another.
    expect(fieldsChannel).toBeLessThanOrEqual(REFERENCE_FIELDS_BUDGET + FIELDS_MAP_JSON_OVERHEAD);
    expect(typed).toBeLessThanOrEqual(REFERENCE_TYPED_BUDGET + cut * MAX_PER_ENTRY_OVERSPEND);
  });

  it('leaves an ordinary bibliography alone: no counters, no markers, no note', async () => {
    const { client, userDir } = await setup();
    await writeFile(
      path.join(userDir, 'ref.bib'),
      bibText('he2016deep', {
        title: 'Deep Residual Learning for Image Recognition',
        author: 'He, Kaiming and Zhang, Xiangyu and Ren, Shaoqing and Sun, Jian',
        booktitle: 'IEEE/CVF Conference on Computer Vision and Pattern Recognition',
        doi: '10.1109/CVPR.2016.90',
        year: '2016',
      }),
    );

    const res = await client.callTool({
      name: 'list_references',
      arguments: { project: 'paper', path: 'ref.bib' },
    });
    const { entries, typedNote } = res.structuredContent as {
      entries: WireEntry[];
      typedNote?: string;
    };

    expect(entries[0]!.title).toBe('Deep Residual Learning for Image Recognition');
    expect(entries[0]!.authors).toHaveLength(4);
    expect(entries[0]!.doi).toBe('10.1109/CVPR.2016.90');
    expect(entries[0]!.typedOmitted).toBeUndefined();
    expect(entries[0]!.authorsOmitted).toBeUndefined();
    expect(typedNote).toBeUndefined();
    expect(textOf(res)).not.toContain('characters omitted');
  });
});
