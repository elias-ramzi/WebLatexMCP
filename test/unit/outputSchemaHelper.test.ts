/**
 * The pointer walk behind `test/helpers/outputSchema.ts`.
 *
 * It is worth its own unit test for one reason: every contract assertion built on it is only as
 * honest as its NEGATIVE answer. A `declaredField` that never returns `undefined` — a wrong
 * `in` check, a swallowed step — turns `expectDeclaredField` into a call that always passes, and
 * the four integration tests that now lean on it would go quiet without failing. So the cases
 * here are mostly the ones that must come back undefined.
 *
 * Hand-built JSON Schema objects, no MCP client: the round trip itself is exercised where the
 * helper is used (and mutation-proved there), while this pins the walk in isolation.
 */
import { describe, it, expect } from 'vitest';
import { declaredField, undeclaredKeys } from '../helpers/outputSchema.js';
import type { JsonSchemaNode } from '../helpers/outputSchema.js';

const SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    count: { type: 'number', description: 'how many' },
    note: { type: 'string' },
    pages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          skipped: { type: 'number', description: 'a counted gap' },
          images: {
            type: 'array',
            items: {
              type: 'object',
              properties: { unreliable: { type: 'boolean' } },
            },
          },
        },
        required: ['skipped'],
      },
    },
    either: {
      anyOf: [
        { type: 'object', properties: { left: { type: 'string' } }, required: ['left'] },
        { type: 'object', properties: { right: { type: 'string' } } },
      ],
    },
  },
  required: ['count', 'pages'],
};

describe('declaredField', () => {
  it('resolves a top-level field and reports whether it is required', () => {
    expect(declaredField(SCHEMA, 'count')).toMatchObject({
      required: true,
      node: { description: 'how many' },
    });
    expect(declaredField(SCHEMA, 'note')?.required).toBe(false);
  });

  it('steps into array items with [] and keeps the holder’s required list', () => {
    expect(declaredField(SCHEMA, 'pages[].skipped')?.required).toBe(true);
    expect(declaredField(SCHEMA, 'pages[].images[].unreliable')).toMatchObject({
      required: false,
    });
  });

  it('looks inside an anyOf branch, and reports the branch that declares the field', () => {
    expect(declaredField(SCHEMA, 'either.left')?.required).toBe(true);
    expect(declaredField(SCHEMA, 'either.right')?.required).toBe(false);
  });

  it('returns undefined for an undeclared leaf — the answer the whole module exists for', () => {
    expect(declaredField(SCHEMA, 'floatsRefused')).toBeUndefined();
    expect(declaredField(SCHEMA, 'pages[].annotationsSkipped')).toBeUndefined();
    expect(declaredField(SCHEMA, 'either.middle')).toBeUndefined();
  });

  it('returns undefined for an undeclared step part-way down, not the node it got to', () => {
    // The failure mode that would matter most: a walk that gives up on a missing intermediate
    // and hands back whatever it last held would report `pages[].images[].unreliable` as
    // declared under a `frames` that does not exist.
    expect(declaredField(SCHEMA, 'frames[].skipped')).toBeUndefined();
    expect(declaredField(SCHEMA, 'pages[].frames[].unreliable')).toBeUndefined();
  });

  it('returns undefined when [] is used on something that is not an array', () => {
    // `note` is a string. Treating a non-array as an array of itself would let a pointer claim a
    // shape the schema never published.
    expect(declaredField(SCHEMA, 'note[]')).toBeUndefined();
    expect(declaredField(SCHEMA, 'count[].anything')).toBeUndefined();
  });

  it('does not mistake a property of the field itself for a declared child', () => {
    // `description` is JSON Schema keyword, not a declared property of `count`.
    expect(declaredField(SCHEMA, 'count.description')).toBeUndefined();
  });
});

/**
 * `undeclaredKeys` walks the other way round — from the emitted payload into the schema — which
 * is the only direction that can find a key nobody thought to name. Its negative answer is the
 * load-bearing one here too, for the mirror-image reason: a walk that reports a declared key as
 * undeclared would make every audit built on it fail noisily and get muted; a walk that reports
 * nothing would make it pass forever.
 */
describe('undeclaredKeys', () => {
  it('returns nothing for a payload every key of which is declared', () => {
    expect(
      undeclaredKeys(SCHEMA, {
        count: 1,
        note: 'x',
        pages: [{ skipped: 0, images: [{ unreliable: true }] }],
        either: { left: 'l' },
      }),
    ).toEqual([]);
  });

  it('names an undeclared top-level key', () => {
    expect(undeclaredKeys(SCHEMA, { count: 1, pages: [], version: 1 })).toEqual(['version']);
  });

  it('names an undeclared key inside an array element, in pointer syntax', () => {
    // The pointer must be the one `declaredField` takes, or a reported hole cannot be pinned
    // with `expectDeclaredField` without being retyped by hand.
    const found = undeclaredKeys(SCHEMA, {
      count: 1,
      pages: [{ skipped: 0, annotationsSkipped: 2 }],
    });
    expect(found).toEqual(['pages[].annotationsSkipped']);
    expect(declaredField(SCHEMA, found[0]!)).toBeUndefined();
  });

  it('descends through nested arrays', () => {
    expect(
      undeclaredKeys(SCHEMA, { count: 1, pages: [{ skipped: 0, images: [{ ctm: 'bad' }] }] }),
    ).toEqual(['pages[].images[].ctm']);
  });

  it('accepts a key declared by ANY branch of a union', () => {
    // `either` is an anyOf; `right` lives only in the second branch. Judging against the first
    // branch alone would report a field the schema does publish.
    expect(undeclaredKeys(SCHEMA, { count: 1, pages: [], either: { right: 'r' } })).toEqual([]);
    expect(undeclaredKeys(SCHEMA, { count: 1, pages: [], either: { middle: 'm' } })).toEqual([
      'either.middle',
    ]);
  });

  it('ignores a key that is explicitly undefined — it never reaches the wire', () => {
    // The distinction #137 turns on: `{ snippet: undefined }` is an own property of the handler's
    // object and survives InMemoryTransport, but JSON drops it, so no client ever sees it.
    expect(undeclaredKeys(SCHEMA, { count: 1, pages: [], extra: undefined })).toEqual([]);
    expect(undeclaredKeys(SCHEMA, { count: 1, pages: [{ skipped: 0, gone: undefined }] })).toEqual(
      [],
    );
  });

  it('reports a key whose value is null — null IS transmitted', () => {
    expect(undeclaredKeys(SCHEMA, { count: 1, pages: [], extra: null })).toEqual(['extra']);
  });

  it('says nothing about the interior of a value the schema describes only as a leaf', () => {
    // `note` is declared as a string. If a handler put an object there the SDK's own parse would
    // have rejected the result; this helper's job is keys the schema CONTRADICTS, and it must not
    // invent findings where the schema publishes no properties to contradict them with.
    expect(undeclaredKeys(SCHEMA, { count: 1, pages: [], note: { deep: 1 } })).toEqual([]);
  });

  it('does not treat a JSON Schema keyword as a declared property', () => {
    // `description`/`type`/`required` sit alongside `properties`, not inside it. Reading them as
    // declarations would silently accept any payload key that happens to share their name.
    expect(undeclaredKeys(SCHEMA, { count: 1, pages: [], description: 'x', required: [] })).toEqual(
      ['description', 'required'],
    );
  });
});
