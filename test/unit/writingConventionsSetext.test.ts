import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import {
  appendWritingConvention,
  countWritingConventions,
} from '../../src/lib/writingConventions.js';

/**
 * A continuation line made only of `-` or `=` (up to 3 spaces of indent, trailing whitespace
 * allowed) right under a text line is a SETEXT heading underline in CommonMark: the text line
 * above it becomes an H2/H1. Inside a rule's bullet that forges a heading in the composed guide
 * just as an ATX `#` would, so the underline's first character is escaped. A continuation line
 * that is a real list item (`- nested`) is left alone, as it always was — only a line that is
 * nothing but the underline run is touched.
 */
describe('appendWritingConvention: setext heading underlines', () => {
  let dir: string;
  let target: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wlm-writing-setext-'));
    target = path.join(dir, 'conventions.md');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('escapes a "---" or "===" continuation line so it cannot underline the line above', async () => {
    await appendWritingConvention(target, 'Forged H2\n---\nmore text');
    await appendWritingConvention(target, 'Forged H1\n===\nmore text');
    // Beside them, what is NOT an underline stays byte-identical: a continuation list item (a
    // nested list, as before), a spaced thematic break, and dashes inside text.
    await appendWritingConvention(target, 'rules:\n- nested item\n- - -\na -- b == c');
    const after = await readFile(target, 'utf8');
    expect(after).toContain('- Forged H2\n  \\---\n  more text\n');
    expect(after).toContain('- Forged H1\n  \\===\n  more text\n');
    expect(after).toContain('- rules:\n  - nested item\n  - - -\n  a -- b == c\n');
  });

  it('escapes a lone "-", a "- " (an empty item cannot interrupt a paragraph) and an indented run', async () => {
    await appendWritingConvention(target, 'one\n-\ntwo\n- \nthree\n   ----  \nfour');
    const after = await readFile(target, 'utf8');
    expect(after).toContain('- one\n  \\-\n  two\n  \\- \n  three\n     \\----  \n  four\n');
  });

  it('never writes a line a CommonMark reader would take as a setext underline', async () => {
    await appendWritingConvention(target, 'a\n--\nb\n==\nc\n - \nd\n  =  ');
    const after = await readFile(target, 'utf8');
    // Every continuation line carries the 2-space bullet indent; an underline allows up to 3
    // spaces of indent relative to the item's content, so 2..5 in the file.
    for (const line of after.split('\n')) {
      expect(line).not.toMatch(/^ {2,5}(?:=+|-+)\s*$/);
    }
    await expect(countWritingConventions(target)).resolves.toBe(1);
  });
});
