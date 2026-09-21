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
import { declaredField } from '../helpers/outputSchema.js';
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
