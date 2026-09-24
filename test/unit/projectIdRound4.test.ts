import { describe, it, expect, vi, afterEach } from 'vitest';
import { projectIdProblem, quoteId } from '../../src/lib/projectId.js';
import { judgeProject } from '../../src/prompts/skills.js';
import { loadConfig } from '../../src/config.js';

const U = (...cps: number[]): string => String.fromCodePoint(...cps);

describe('projectIdProblem — characters that look like something else', () => {
  it.each([
    ['NBSP', 0xa0],
    ['Ogham space mark', 0x1680],
    ['en quad', 0x2000],
    ['hair space', 0x200a],
    ['narrow no-break space', 0x202f],
    ['medium mathematical space', 0x205f],
    ['ideographic space', 0x3000],
  ])('refuses a %s inside an id, which looks like an ordinary space', (_name, cp) => {
    const id = `My${U(cp)}Thesis`;
    expect(projectIdProblem('My Thesis')).toBeUndefined();
    expect(projectIdProblem(id)).toMatch(/space/);
  });

  it.each([
    ['line separator', 0x2028],
    ['paragraph separator', 0x2029],
  ])('refuses a %s inside an id', (_name, cp) => {
    expect(projectIdProblem(`a${U(cp)}b`)).toMatch(/separator/);
  });

  it('refuses a combining mark in first place, which draws onto what precedes the id', () => {
    expect(projectIdProblem(`${U(0x301)}a`)).toMatch(/combining mark/);
    // Anywhere else a mark is part of the word it follows.
    expect(projectIdProblem(`e${U(0x301)}x`.normalize('NFC'))).toBeUndefined();
    expect(projectIdProblem(`क${U(0x94d)}ष`)).toBeUndefined();
  });
});

describe('an id the rule accepts is displayed verbatim', () => {
  // The contract `isJoinerInWord` states: an accepted id can be copied back out of any message
  // that quotes it. Checked for every code point, alone, first, and between two letters.
  // The display test runs first because it is the cheap one; the rule is asked only about an id
  // that would be displayed differently.
  it('holds for every code point in every position', { timeout: 60_000 }, () => {
    const bad: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = U(cp);
      for (const id of [c, `${c}a`, `a${c}b`]) {
        const shown = quoteId(id);
        if (shown === `"${id}"` || projectIdProblem(id) !== undefined) continue;
        bad.push(`U+${cp.toString(16).toUpperCase()} in ${shown}`);
      }
      if (bad.length > 5) break;
    }
    expect(bad).toEqual([]);
  });

  it('holds for a joiner inside a word of a script that uses it', () => {
    for (const id of [`می${U(0x200c)}خواهم`, `क${U(0x94d, 0x200d)}ष`]) {
      expect(projectIdProblem(id), id).toBeUndefined();
      expect(quoteId(id)).toBe(`"${id}"`);
    }
  });
});

describe('ids written to stderr and into errors go through quoteId', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('judgeProject: a newline in a client-supplied id cannot forge a stderr line', () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
    const verdict = judgeProject('paper\n[web-latex-mcp] forged line', () => {
      throw new Error('lookup failed');
    });
    expect(verdict).toBe('unverified');
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain('\n');
    expect(errors[0]).toContain(quoteId('paper\n[web-latex-mcp] forged line'));
  });

  it('loadConfig: a WEB_LATEX_MCP_SESSION with no usable characters is quoted, not echoed raw', () => {
    const raw = `!\n${U(0x202e)}!`;
    let message = '';
    try {
      loadConfig({ WEB_LATEX_MCP_SESSION: raw });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/WEB_LATEX_MCP_SESSION/);
    expect(message).not.toContain('\n');
    expect(message).not.toContain(U(0x202e));
    expect(message).toContain(quoteId(raw));
  });

  it('loadConfig: a reserved WEB_LATEX_MCP_SESSION is quoted, not echoed raw', () => {
    const raw = 'shelves\n!';
    let message = '';
    try {
      loadConfig({ WEB_LATEX_MCP_SESSION: raw });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/reserved/);
    expect(message).not.toContain('\n');
    expect(message).toContain(quoteId(raw));
  });
});
