import { describe, it, expect } from 'vitest';
import { parseBibtex, missingRequiredFields } from '../../src/lib/references.js';
import { planReferenceFields } from '../../src/lib/referenceFieldsBudget.js';
import { CredentialResolver } from '../../src/services/auth.js';
import type { ExecResult } from '../../src/lib/exec.js';

/**
 * Maps keyed by a string the DOCUMENT or the CALLER chose — a BibTeX entry type, a BibTeX field
 * name, a git remote's host — must not answer for `Object.prototype`'s members. On a `{}` literal,
 * `table['constructor']` is the global `Object` function, so an unknown key read as a known one.
 */
describe('document-keyed maps ignore Object.prototype', () => {
  it('an entry of type @constructor has no required fields rather than crashing the check', () => {
    // Pre-fix: REQUIRED_FIELDS['constructor'] was `Object`, and `.filter` on it threw a TypeError
    // out of `missingRequiredFields` — i.e. out of list_references / check_citations.
    const [entry] = parseBibtex('@constructor{k1,\n  title = {T},\n}\n');
    expect(entry?.type).toBe('constructor');
    expect(missingRequiredFields(entry!)).toEqual([]);
  });

  it('a field map answers only for the fields the entry declares', () => {
    const [entry] = parseBibtex(
      '@misc{k2,\n  constructor = {C},\n  tostring = {T},\n  title = {X},\n}\n',
    );
    const fields = entry!.fields!;
    expect(Object.keys(fields)).toEqual(['constructor', 'tostring', 'title']);
    expect(fields.constructor).toBe('C');
    expect(fields.tostring).toBe('T');

    const [bare] = parseBibtex('@misc{k3,\n  title = {X},\n}\n');
    // Pre-fix `'constructor' in fields` was true (inherited) and `fields.valueOf` a function.
    expect('constructor' in bare!.fields!).toBe(false);
    expect('valueOf' in bare!.fields!).toBe(false);
    expect((bare!.fields as Record<string, unknown>).hasOwnProperty).toBeUndefined();
  });

  it('planReferenceFields keeps a field literally named __proto__ as a field', () => {
    // Not producible by parseBibtex today (its field-name rule demands a leading letter), but
    // `planReferenceFields` takes any `FieldsBearing`: on a `{}` literal the assignment
    // `kept['__proto__'] = value` hit the prototype setter, which ignores a string, so the field
    // vanished while `keptCount` still counted it — a silent cut with no `fieldsOmitted`.
    const fields = JSON.parse('{"__proto__": "P", "title": "X"}') as Record<string, string>;
    const plan = planReferenceFields([{ fields }]);
    const out = plan.entries[0]!.fields!;
    expect(Object.keys(out)).toEqual(['__proto__', 'title']);
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toBe('P');
    expect(JSON.parse(JSON.stringify(out))).toEqual(fields);
  });
});

describe('host-keyed credential defaults ignore Object.prototype', () => {
  const failExec = async (): Promise<ExecResult> => ({
    code: 1,
    stdout: '',
    stderr: 'not found',
    timedOut: false,
  });

  for (const host of ['constructor', '__proto__']) {
    it(`a remote on host "${host}" gets no host default`, async () => {
      // Pre-fix HOST_DEFAULTS[host] was `Object`/`Object.prototype`, whose `tokenEnv` is
      // undefined, so the resolver looked up `env[undefined]` — the env var literally named
      // "undefined" — and handed its value to that remote as the token.
      const resolver = new CredentialResolver({ undefined: 'not-for-this-host' }, failExec);
      const auth = await resolver.resolve({ gitUrl: `https://${host}/repo.git` });
      expect(auth.token).toBeUndefined();
      expect(auth.username).toBe('git');
    });
  }
});
