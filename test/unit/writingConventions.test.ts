import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import {
  appendWritingConvention,
  countWritingConventions,
  WritingConventionsUnconfiguredError,
  guideEditBlockedMessage,
} from '../../src/lib/writingConventions.js';

describe('appendWritingConvention', () => {
  let dir: string;
  let target: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wlm-writing-conventions-'));
    target = path.join(dir, 'conventions.md');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends a bullet to an existing file, leaving every pre-existing line byte-identical', async () => {
    const original = '# My notes\n\nSome hand-written text.\n';
    await writeFile(target, original, 'utf8');

    const result = await appendWritingConvention(target, 'always write lidar, never LiDAR');
    expect(result.created).toBe(false);

    const after = await readFile(target, 'utf8');
    expect(after.startsWith(original)).toBe(true);
    expect(after).toContain('- always write lidar, never LiDAR');
  });

  it('creates the file with a seed intro (no heading — the caller supplies one) when it does not exist, and a second call keeps one intro', async () => {
    const result = await appendWritingConvention(target, 'first rule');
    expect(result.created).toBe(true);
    expect(result.path).toBe(target);

    const contents = await readFile(target, 'utf8');
    // No seeded heading: composeWritingGuide already supplies EXTRA_GUIDE_HEADING when this
    // file is spliced under it, so a seeded H1 here would outrank/duplicate it.
    expect(contents).not.toContain('# Project-specific writing conventions');
    expect(contents).toContain('add_writing_convention');
    expect(contents).toContain('- first rule');

    const second = await appendWritingConvention(target, 'second rule');
    expect(second.created).toBe(false);

    const afterSecond = await readFile(target, 'utf8');
    const introMatches = afterSecond.match(/add_writing_convention/g);
    expect(introMatches).toHaveLength(1);
    expect(afterSecond).toContain('- first rule');
    expect(afterSecond).toContain('- second rule');
  });

  it('creates missing parent directories', async () => {
    const nested = path.join(dir, 'nested', 'sub', 'conventions.md');
    const result = await appendWritingConvention(nested, 'a rule');
    expect(result.created).toBe(true);
    const contents = await readFile(nested, 'utf8');
    expect(contents).toContain('- a rule');
  });

  it('adds a newline before the bullet when the hand-edited file has no trailing newline', async () => {
    await writeFile(target, '# Notes\n\nNo trailing newline here.', 'utf8');
    await appendWritingConvention(target, 'a new rule');
    const contents = await readFile(target, 'utf8');
    expect(contents).toContain('No trailing newline here.\n- a new rule');
  });

  it('keeps continuation lines of a multi-line rule indented under one bullet', async () => {
    await appendWritingConvention(target, 'first line\nsecond line\nthird line');
    const contents = await readFile(target, 'utf8');
    expect(contents).toContain('- first line\n  second line\n  third line');
  });

  it('never lets a rule beginning with a heading marker inject a heading line', async () => {
    const original = await (async () => {
      await appendWritingConvention(target, 'placeholder');
      return readFile(target, 'utf8');
    })();

    await appendWritingConvention(target, '## Something that looks like a heading');
    const after = await readFile(target, 'utf8');
    expect(after.startsWith(original)).toBe(true);
    // The leading `#` is escaped with a backslash so no heading-aware reader can parse the
    // bullet's first line as an ATX heading — the `- ` bullet prefix alone does NOT neutralise
    // it (a heading-aware parser still recognises `- ## text` as list-item text starting with a
    // literal heading marker in some renderers, and this asserts the actual escape, not an
    // accident of the bullet prefix).
    expect(after).toContain('- \\## Something that looks like a heading');
    // No line anywhere in the file may match an ATX heading at or above EXTRA_GUIDE_HEADING's
    // level (H1-H6) — that would silently end the "Project-specific conventions" section for a
    // heading-aware reader, taking every rule appended after it outside the precedence sentence.
    for (const line of after.split('\n')) {
      expect(line).not.toMatch(/^#{1,6}\s/);
    }
    // The visible text survives — only the leading marker is neutralised.
    expect(after).toContain('Something that looks like a heading');
  });

  it('never lets a rule beginning with a blockquote marker inject a blockquote line', async () => {
    const original = await (async () => {
      await appendWritingConvention(target, 'placeholder');
      return readFile(target, 'utf8');
    })();

    await appendWritingConvention(target, '> Something that looks like a quote');
    const after = await readFile(target, 'utf8');
    expect(after.startsWith(original)).toBe(true);
    // The leading `>` is escaped with a backslash so the bullet's first line cannot be parsed as
    // a blockquote — asserting the escape itself, not just the absence of a bare `>` line (which
    // the `- ` bullet prefix alone would already guarantee).
    expect(after).toContain('- \\> Something that looks like a quote');
    for (const line of after.split('\n')) {
      expect(line).not.toMatch(/^\s*>/);
    }
    expect(after).toContain('Something that looks like a quote');
  });

  it('neutralises a heading marker on a continuation line too, not just the first line', async () => {
    await appendWritingConvention(target, 'first line\n## second line looks like a heading');
    const after = await readFile(target, 'utf8');
    // CommonMark allows up to 3 leading spaces before the `#` and still parses an ATX heading,
    // so the 2-space list-continuation indent alone does not neutralise it.
    for (const line of after.split('\n')) {
      expect(line).not.toMatch(/^\s{0,3}#{1,6}\s/);
    }
    expect(after).toContain('second line looks like a heading');
  });

  it('throws WritingConventionsUnconfiguredError with both spellings when path is undefined', async () => {
    await expect(appendWritingConvention(undefined, 'a rule')).rejects.toThrow(
      WritingConventionsUnconfiguredError,
    );
    try {
      await appendWritingConvention(undefined, 'a rule');
      expect.fail('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('WEB_LATEX_MCP_WRITING_GUIDE_EXTRA');
      expect(message).toContain('file://');
    }
  });

  it('rejects an empty rule', async () => {
    await expect(appendWritingConvention(target, '')).rejects.toThrow();
  });

  it('rejects a whitespace-only rule', async () => {
    await expect(appendWritingConvention(target, '   \n  ')).rejects.toThrow();
  });

  it('waits on a held lock and succeeds once it is released', async () => {
    const lockPath = `${target}.lock`;
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, owner: 'other', acquiredAt: new Date().toISOString() }),
    );

    let settled = false;
    const promise = appendWritingConvention(target, 'a rule').then((r) => {
      settled = true;
      return r;
    });

    await new Promise((r) => setTimeout(r, 150));
    expect(settled).toBe(false);

    await rm(lockPath, { force: true });
    const result = await promise;
    expect(result.created).toBe(true);
    expect(settled).toBe(true);
  });

  it('lands both bullets from two concurrent calls without losing either, and seeds the intro exactly once', async () => {
    const [a, b] = await Promise.all([
      appendWritingConvention(target, 'rule A'),
      appendWritingConvention(target, 'rule B'),
    ]);
    expect(a.path).toBe(target);
    expect(b.path).toBe(target);
    const contents = await readFile(target, 'utf8');
    expect(contents).toContain('- rule A');
    expect(contents).toContain('- rule B');
    // The real risk of the create/seed step racing under the lock: two concurrent creators
    // must not each seed the intro, doubling it up.
    const introMatches = contents.match(/add_writing_convention/g);
    expect(introMatches).toHaveLength(1);
  });
});

describe('guideEditBlockedMessage', () => {
  it('names the target path and the confirmGuideEdit flag', () => {
    const msg = guideEditBlockedMessage('/home/user/writing-conventions.md');
    expect(msg).toContain('/home/user/writing-conventions.md');
    expect(msg).toContain('confirmGuideEdit');
  });
});

describe('countWritingConventions', () => {
  let dir: string;
  let target: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'wlm-writing-conventions-count-'));
    target = path.join(dir, 'conventions.md');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('counts 2 bullets after two appendWritingConvention calls', async () => {
    await appendWritingConvention(target, 'first rule');
    await appendWritingConvention(target, 'second rule');
    await expect(countWritingConventions(target)).resolves.toBe(2);
  });

  it('counts a multi-line rule as 1, not one per line', async () => {
    await appendWritingConvention(target, 'first line\nsecond line\nthird line');
    await expect(countWritingConventions(target)).resolves.toBe(1);
  });

  it('returns undefined for an unconfigured (undefined) path', async () => {
    await expect(countWritingConventions(undefined)).resolves.toBeUndefined();
  });

  it('returns undefined rather than throwing for a nonexistent file', async () => {
    await expect(countWritingConventions(path.join(dir, 'missing.md'))).resolves.toBeUndefined();
  });

  it('counts correctly in a file with CRLF line endings', async () => {
    await writeFile(target, '- rule one\r\n- rule two\r\n', 'utf8');
    await expect(countWritingConventions(target)).resolves.toBe(2);
  });

  it('counts a user-hand-written bullet too, alongside an appended one', async () => {
    await appendWritingConvention(target, 'appended rule');
    const contents = await readFile(target, 'utf8');
    await writeFile(target, `${contents}- a hand-written bullet\n`, 'utf8');
    await expect(countWritingConventions(target)).resolves.toBe(2);
  });

  it('returns undefined rather than throwing when targetPath is a directory, not a file', async () => {
    await expect(countWritingConventions(dir)).resolves.toBeUndefined();
  });

  it('counts a rule whose own text starts with "- " as exactly 1, not 2', async () => {
    await appendWritingConvention(target, '- a rule that itself starts with a bullet');
    const contents = await readFile(target, 'utf8');
    expect(contents).toContain('- - a rule that itself starts with a bullet');
    await expect(countWritingConventions(target)).resolves.toBe(1);
  });

  it('counts hand-written "*" and "+" top-level bullets, not just "-"', async () => {
    await writeFile(target, '* star bullet\n+ plus bullet\n', 'utf8');
    await expect(countWritingConventions(target)).resolves.toBe(2);
  });

  it('does not count an indented bullet as top-level', async () => {
    await writeFile(target, '- top level\n  - x\n', 'utf8');
    await expect(countWritingConventions(target)).resolves.toBe(1);
  });

  it('does not count bullets inside a fenced code block', async () => {
    await writeFile(target, '- real rule\n```\n- a\n- b\n```\n', 'utf8');
    await expect(countWritingConventions(target)).resolves.toBe(1);
  });

  it('does not count a spaced thematic break as a rule', async () => {
    await writeFile(target, '- real rule\n\n* * *\n\n- - -\n\n- another rule\n', 'utf8');
    await expect(countWritingConventions(target)).resolves.toBe(2);
  });

  it('does not count bullets inside a fence indented by up to three spaces', async () => {
    await writeFile(target, '- real rule\n   ```\n- a\n- b\n   ```\n', 'utf8');
    await expect(countWritingConventions(target)).resolves.toBe(1);
  });
});
