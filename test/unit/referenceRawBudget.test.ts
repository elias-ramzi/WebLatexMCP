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
  planReferenceRaw,
  rawElisionMarker,
  REFERENCE_RAW_BUDGET,
  REFERENCE_MAX_RAW_LENGTH,
  RAW_PROPERTY_JSON_OVERHEAD,
  RAW_OMITTED_JSON_OVERHEAD,
  MAX_RAW_MARKER_COST,
} from '../../src/lib/referenceRawBudget.js';
import { REFERENCE_FIELDS_BUDGET } from '../../src/lib/referenceFieldsBudget.js';
import { parseReferences, type ReferenceEntry } from '../../src/lib/references.js';

/**
 * Entries built by the REAL parser from real bibliography text, not by hand — the same tie
 * `referenceFieldsBudget.test.ts` keeps for `fields`. `planReferenceRaw` takes a structural
 * `RawBearing`, so TypeScript's excess-property check never fires on the tool's real call; feeding
 * it the parser's own output means these tests exercise the `raw` slices `list_references`
 * actually emits (`text.slice(at, close + 1)` for BibTeX, a trimmed paragraph for prose) rather
 * than a shape invented here that could drift away from them without anything failing.
 */
function bibText(key: string, fields: Record<string, string>): string {
  const body = Object.entries(fields)
    .map(([name, value]) => `  ${name} = {${value}},`)
    .join('\n');
  return `@article{${key},\n${body}\n}\n`;
}

function bibEntries(text: string): ReferenceEntry[] {
  const parsed = parseReferences(text, 'ref.bib');
  if (parsed.length === 0 || parsed.some((e) => e.format !== 'bibtex')) {
    throw new Error('fixture did not parse as BibTeX');
  }
  return parsed;
}

function bibEntry(key: string, fields: Record<string, string>): ReferenceEntry {
  return bibEntries(bibText(key, fields))[0]!;
}

/** A prose entry — `raw` is document text in this format too, and is budgeted the same way. */
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
 * What one entry's `raw` channel really costs in the encoded result: the difference between the
 * entry as it will be sent and the same entry with `raw`/`rawOmitted` removed. Derived from
 * `JSON.stringify` rather than from the module's own constants, so a pin below cannot pass by
 * agreeing with a mistake.
 */
function renderedRawCost(entry: ReferenceEntry & { rawOmitted?: number }): number {
  const without: Record<string, unknown> = { ...entry };
  delete without.raw;
  delete without.rawOmitted;
  return JSON.stringify(entry).length - JSON.stringify(without).length;
}

/**
 * The most an entry cut to nothing can cost: the property overhead, the worst-case marker, and the
 * counter. This is the documented overspend — a marker-only entry is charged although the budget
 * is already gone, because a `raw` of `''` would read as "the entry as written is empty".
 */
const MAX_MARKER_ONLY_COST =
  RAW_PROPERTY_JSON_OVERHEAD + MAX_RAW_MARKER_COST + RAW_OMITTED_JSON_OVERHEAD + 16;

describe('planReferenceRaw — nothing to cut', () => {
  it('passes an ordinary bibliography through verbatim, with no marker, count or note', () => {
    const entries = [
      bibEntry('he2016deep', { title: 'Deep Residual Learning', year: '2016' }),
      bibEntry('cabon2020virtual', { title: 'Virtual KITTI 2', year: '2020' }),
      proseEntry(),
    ];

    const plan = planReferenceRaw(entries);

    expect(plan.entries.map((e) => e.raw)).toEqual(entries.map((e) => e.raw));
    expect(plan.entries.some((e) => 'rawOmitted' in e)).toBe(false);
    expect(plan.truncatedOversize).toBe(0);
    expect(plan.truncatedBySize).toBe(0);
    expect(plan.charactersOmitted).toBe(0);
    // Absent, not present-and-zero: a note is a report of something that happened.
    expect(plan.note).toBeUndefined();
  });

  it('never reorders, and never prefers a short entry over a long one', () => {
    const entries = [
      bibEntry('long', { note: 'x'.repeat(REFERENCE_MAX_RAW_LENGTH) }),
      bibEntry('short', { title: 'Tiny' }),
    ];

    const plan = planReferenceRaw(entries);

    expect(plan.entries.map((e) => e.key)).toEqual(['long', 'short']);
  });
});

describe('planReferenceRaw — the per-entry length gate', () => {
  it('cuts an over-long entry to a marked PREFIX and counts what it cut', () => {
    const abstract = 'very '.repeat(REFERENCE_MAX_RAW_LENGTH); // far past the gate
    const entry = bibEntry('verbose2024', { title: 'A Modest Title', abstract });

    const plan = planReferenceRaw([entry]);
    const planned = plan.entries[0]!;
    const omitted = planned.rawOmitted!;

    // A prefix of the verbatim text, so the head of the entry — type, key, first fields — is
    // exactly what the document wrote. Nothing is reformatted, reordered or completed.
    const kept = planned.raw.slice(0, planned.raw.length - `\n${rawElisionMarker(omitted)}`.length);
    expect(entry.raw.startsWith(kept)).toBe(true);
    expect(kept.length).toBeLessThanOrEqual(REFERENCE_MAX_RAW_LENGTH);
    expect(kept).toContain('@article{verbose2024');

    // The cut is VISIBLE in the text itself and COUNTED in the structured channel — never a
    // silent slice, which is the whole reason this is not `raw.slice(0, N)`.
    expect(planned.raw.endsWith(rawElisionMarker(omitted))).toBe(true);
    expect(omitted).toBe(entry.raw.length - kept.length);
    expect(kept.length + omitted).toBe(entry.raw.length);

    expect(plan.truncatedOversize).toBe(1);
    expect(plan.truncatedBySize).toBe(0);
    expect(plan.charactersOmitted).toBe(omitted);
  });

  it('names only the bound that fired, and points at the verbatim text', () => {
    const plan = planReferenceRaw([bibEntry('big', { note: 'n'.repeat(4000) })]);

    expect(plan.note).toContain(`first ${REFERENCE_MAX_RAW_LENGTH} characters`);
    // The shared budget did NOT fire here, so the note must not send the reader after it.
    expect(plan.note).not.toContain(`${REFERENCE_RAW_BUDGET}-char budget`);
    expect(plan.note).toContain('PREFIX');
    expect(plan.note).toContain('rawOmitted');
  });

  it('is not sticky: a long entry does not cut the short ones behind it', () => {
    const entries = [
      bibEntry('big', { note: 'n'.repeat(4000) }),
      bibEntry('small', { title: 'Tiny' }),
    ];

    const plan = planReferenceRaw(entries);

    expect(plan.entries[0]!.rawOmitted).toBeGreaterThan(0);
    expect(plan.entries[1]!.rawOmitted).toBeUndefined();
    expect(plan.entries[1]!.raw).toBe(entries[1]!.raw);
  });

  it('never splits a surrogate pair, which would invent a character the document never had', () => {
    const entry = bibEntry('emoji', { title: 'T', note: `${'a'.repeat(500)}😀${'b'.repeat(500)}` });
    // Put the gate exactly between the two halves of the astral character, so a naive
    // `slice(0, limit)` would cut the pair in half. Without this the fixture could drift until
    // the boundary falls somewhere harmless and the test passes while proving nothing.
    const limit = entry.raw.indexOf('😀') + 1;
    expect(entry.raw.charCodeAt(limit - 1)).toBeGreaterThanOrEqual(0xd800);
    expect(entry.raw.charCodeAt(limit - 1)).toBeLessThanOrEqual(0xdbff);

    const planned = planReferenceRaw([entry], { maxRawLength: limit }).entries[0]!;
    const kept = planned.raw.slice(
      0,
      planned.raw.length - `\n${rawElisionMarker(planned.rawOmitted!)}`.length,
    );

    expect(kept).toHaveLength(limit - 1);
    expect(/[\uD800-\uDBFF]$/.test(kept)).toBe(false);
    expect(kept).not.toContain('\uFFFD');
    expect(entry.raw.startsWith(kept)).toBe(true);
    // The count stays exact: every character not sent is counted.
    expect(kept.length + planned.rawOmitted!).toBe(entry.raw.length);
  });
});

describe('planReferenceRaw — the shared rendered-size budget', () => {
  /** Twenty realistic-but-bulky entries: ~1900 characters of `raw` each, ~38k in total. */
  function bulkyBibliography(count = 20): ReferenceEntry[] {
    return bibEntries(
      Array.from({ length: count }, (_, i) =>
        bibText(`bulk${i}`, { title: `Entry ${i}`, note: 'n'.repeat(1800) }),
      ).join('\n'),
    );
  }

  it('cuts a TAIL, not holes: the prefix is verbatim and every later entry is cut', () => {
    const entries = bulkyBibliography();

    const plan = planReferenceRaw(entries);

    // Every entry is still returned, in order — only the verbatim text is bounded.
    expect(plan.entries).toHaveLength(entries.length);
    expect(plan.entries.map((e) => e.key)).toEqual(entries.map((e) => e.key));

    const cut = plan.entries.map((e) => e.rawOmitted !== undefined);
    const firstCut = cut.indexOf(true);
    expect(firstCut).toBeGreaterThan(0); // something got through verbatim
    expect(cut.slice(firstCut).every(Boolean)).toBe(true); // …and nothing after it did
    expect(plan.truncatedBySize).toBe(entries.length - firstCut);
    expect(plan.truncatedOversize).toBe(0);
  });

  it('an entry past the budget keeps nothing but the marker, and says how much is missing', () => {
    const entries = bulkyBibliography();

    const plan = planReferenceRaw(entries);
    const last = plan.entries[plan.entries.length - 1]!;

    expect(last.raw).toBe(rawElisionMarker(last.rawOmitted!));
    expect(last.rawOmitted).toBe(entries[entries.length - 1]!.raw.length);
    // `''` would claim the entry as written is empty; the marker says text is missing.
    expect(last.raw).not.toBe('');
  });

  it('holds the whole `raw` channel inside the budget, charged on what is actually sent', () => {
    const entries = bulkyBibliography();

    const plan = planReferenceRaw(entries);
    const rendered = plan.entries.reduce((sum, e) => sum + renderedRawCost(e), 0);
    const verbatim = plan.entries
      .filter((e) => e.rawOmitted === undefined)
      .reduce((sum, e) => sum + renderedRawCost(e), 0);

    // The content the budget governs is inside it, measured off `JSON.stringify` of the very
    // objects the tool hands to `structuredContent`.
    expect(verbatim).toBeLessThanOrEqual(REFERENCE_RAW_BUDGET);
    // And the documented overspend — one marker per cut entry — is the only thing on top.
    expect(rendered).toBeLessThanOrEqual(
      REFERENCE_RAW_BUDGET + plan.truncatedBySize * MAX_MARKER_ONLY_COST,
    );

    // The defect this exists for, stated as a number: unbudgeted, this result is already past
    // the ~67k a client rejected in #68, and 200 entries (the `maxResults` default) is ten times
    // the fixture.
    const unbudgeted = entries.reduce((sum, e) => sum + renderedRawCost(e), 0);
    expect(unbudgeted).toBeGreaterThan(REFERENCE_RAW_BUDGET * 1.5);
  });

  it('names only the budget when only the budget fired, and counts the characters', () => {
    const plan = planReferenceRaw(bulkyBibliography());

    expect(plan.note).toContain(`${REFERENCE_RAW_BUDGET}-char budget`);
    expect(plan.note).not.toContain(`first ${REFERENCE_MAX_RAW_LENGTH} characters`);
    expect(plan.note).toContain(`${plan.charactersOmitted} character(s)`);
    expect(plan.charactersOmitted).toBeGreaterThan(0);
  });

  it('reports both bounds when both fire', () => {
    const entries = [
      bibEntry('huge', { note: 'h'.repeat(REFERENCE_MAX_RAW_LENGTH * 3) }),
      ...bibEntries(
        Array.from({ length: 20 }, (_, i) => bibText(`bulk${i}`, { note: 'n'.repeat(1800) })).join(
          '\n',
        ),
      ),
    ];

    const plan = planReferenceRaw(entries);

    expect(plan.truncatedOversize).toBeGreaterThan(0);
    expect(plan.truncatedBySize).toBeGreaterThan(0);
    expect(plan.note).toContain(`first ${REFERENCE_MAX_RAW_LENGTH} characters`);
    expect(plan.note).toContain(`${REFERENCE_RAW_BUDGET}-char budget`);
  });

  it('honours a caller-supplied budget and gate, since the defaults are only defaults', () => {
    const entries = [bibEntry('a', { title: 'A' }), bibEntry('b', { title: 'B' })];

    const plan = planReferenceRaw(entries, { budget: 1, maxRawLength: 10 });

    expect(plan.entries.every((e) => e.rawOmitted !== undefined)).toBe(true);
    expect(plan.truncatedBySize).toBe(2);
  });
});

describe('planReferenceRaw — the constants', () => {
  it('shares the house figure with the `fields` budget rather than declaring a second one', () => {
    // Two allocations, ONE number: the module imports the figure instead of restating it, so
    // there is a single place to change and no question of which is right.
    expect(REFERENCE_RAW_BUDGET).toBe(REFERENCE_FIELDS_BUDGET);
  });

  it('bounds the marker cost it claims to bound', () => {
    const worst = JSON.stringify(`\n${rawElisionMarker(1_234_567_890)}`).length;
    expect(worst).toBeLessThanOrEqual(MAX_RAW_MARKER_COST);
    // Small enough that repeating it per entry is not itself the oversized payload.
    expect(MAX_RAW_MARKER_COST).toBeLessThan(100);
  });

  it('charges the JSON property overheads it names', () => {
    expect(JSON.stringify({ raw: '' }).length - JSON.stringify({}).length - 2).toBe(
      RAW_PROPERTY_JSON_OVERHEAD - 1,
    );
    expect(RAW_OMITTED_JSON_OVERHEAD).toBe(',"rawOmitted":'.length);
  });
});

/**
 * Through the tool, over a real local project in a temp dir — no git, no network, no mocks.
 *
 * Two things only an end-to-end call can show. First, that the keys are **declared**: an
 * undeclared key does not reach a client at all, because the SDK's `Client` compiles an ajv
 * validator per advertised schema during `listTools()` and rejects the whole result with
 * `-32602 … must NOT have additional properties` (#130, #137, #146). So these assertions go
 * through `tools/list` and then call the tool, which is what arms that validator. Second, that
 * the TEXT channel renders from the already-budgeted payload rather than from the parser's
 * output — rendering the full one would put the oversized payload straight back on the wire.
 */
describe('list_references bounds `raw` on the wire', () => {
  const cleanups: Array<() => Promise<unknown>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(): Promise<{ client: Client; userDir: string }> {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-rawb-ws-'));
    const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-rawb-dir-'));
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

  it('declares `entries[].rawOmitted` and `rawNote`, and emits nothing it does not declare', async () => {
    const { client, userDir } = await setup();
    await writeFile(
      path.join(userDir, 'ref.bib'),
      bibText('verbose2024', {
        title: 'A Modest Title',
        abstract: 'very '.repeat(REFERENCE_MAX_RAW_LENGTH),
        year: '2024',
      }),
    );

    await expectDeclaredField(client, 'list_references', 'entries[].rawOmitted', {
      required: false,
    });
    await expectDeclaredField(client, 'list_references', 'rawNote', { required: false });
    // The `raw` promise itself no longer claims authority unconditionally.
    await expectDeclaredField(client, 'list_references', 'entries[].raw', {
      description: /rawOmitted/,
    });

    const res = await client.callTool({
      name: 'list_references',
      arguments: { project: 'paper', path: 'ref.bib' },
    });
    expect(res.isError).toBeFalsy();
    const { entries, rawNote } = res.structuredContent as {
      entries: Array<{ raw: string; rawOmitted?: number }>;
      rawNote?: string;
    };

    const entry = entries[0]!;
    expect(entry.rawOmitted).toBeGreaterThan(0);
    expect(entry.raw).toMatch(/characters omitted\]$/);
    expect(entry.raw.length).toBeLessThan(REFERENCE_MAX_RAW_LENGTH + 100);
    expect(rawNote).toContain('rawOmitted');

    // The whole payload, not a named pointer: the key nobody thought to ask about is the one
    // that makes a tool uncallable.
    await expectNoUndeclaredKeys(client, 'list_references', res.structuredContent);
  });

  it('bounds the `raw` channel of a real result, and tells a text-only caller it was cut', async () => {
    const { client, userDir } = await setup();
    // Thirty bulky entries — an ordinary page of a Zotero-exported `.bib`, and already past the
    // size a client rejects once every `raw` is sent whole. No `title` field either, so
    // `formatEntry` falls back to `raw` for each heading: the one place the text channel reads
    // `raw` at all, and it must read the BUDGETED one.
    await writeFile(
      path.join(userDir, 'ref.bib'),
      Array.from({ length: 30 }, (_, i) => bibText(`bulk${i}`, { note: 'n'.repeat(1800) })).join(
        '\n',
      ),
    );

    const res = await client.callTool({
      name: 'list_references',
      arguments: { project: 'paper', path: 'ref.bib' },
    });
    expect(res.isError).toBeFalsy();
    const { entries, rawNote } = res.structuredContent as {
      entries: Array<{ raw: string; rawOmitted?: number }>;
      rawNote?: string;
    };
    expect(entries).toHaveLength(30);

    // The channel this budget governs, measured on the wire form of the result the client got.
    const rawChannel = entries.reduce((sum, e) => sum + JSON.stringify(e.raw).length, 0);
    const cut = entries.filter((e) => e.rawOmitted !== undefined).length;
    expect(cut).toBeGreaterThan(0);
    expect(rawChannel).toBeLessThanOrEqual(REFERENCE_RAW_BUDGET + cut * MAX_MARKER_ONLY_COST);
    // Unbudgeted, the same `.bib` sends ~55k characters of `raw` alone.
    expect(entries.reduce((sum, e) => sum + (e.rawOmitted ?? 0) + e.raw.length, 0)).toBeGreaterThan(
      REFERENCE_RAW_BUDGET * 2,
    );

    // A caller reading only the prose channel is told the verbatim text is partial, and the
    // heading of a cut entry is a prefix of the budgeted `raw`, not of the parser's.
    const text = textOf(res);
    expect(rawNote).toBeDefined();
    expect(text).toContain('rawOmitted');
    expect(text).toContain('characters omitted');
  });

  it('leaves an ordinary bibliography verbatim, with no marker and no note', async () => {
    const { client, userDir } = await setup();
    await writeFile(
      path.join(userDir, 'ref.bib'),
      bibText('he2016deep', { title: 'Deep Residual Learning', year: '2016' }),
    );

    const res = await client.callTool({
      name: 'list_references',
      arguments: { project: 'paper', path: 'ref.bib' },
    });
    const { entries, rawNote } = res.structuredContent as {
      entries: Array<{ raw: string; rawOmitted?: number }>;
      rawNote?: string;
    };

    expect(entries[0]!.raw).toContain('@article{he2016deep');
    expect(entries[0]!.raw).not.toContain('characters omitted');
    expect(entries[0]!.rawOmitted).toBeUndefined();
    expect(rawNote).toBeUndefined();
  });
});
