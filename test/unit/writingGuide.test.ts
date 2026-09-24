import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadWritingGuide,
  buildInstructions,
  loadExtraWritingGuide,
  composeWritingGuide,
  EXTRA_GUIDE_HEADING,
} from '../../src/lib/writingGuide.js';

describe('loadWritingGuide', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'writing-guide-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('loads the bundled docs/writing-guide.md by default', async () => {
    const guide = await loadWritingGuide({});
    expect(guide).toContain('Writing Academic Articles in LaTeX');
  });

  it('reads an override path from WEB_LATEX_MCP_WRITING_GUIDE', async () => {
    const custom = path.join(tmp, 'guide.md');
    await writeFile(custom, '# Custom guide\n\nUse the past tense.\n');
    const guide = await loadWritingGuide({ WEB_LATEX_MCP_WRITING_GUIDE: custom });
    expect(guide).toBe('# Custom guide\n\nUse the past tense.');
  });

  it('returns undefined when the file is missing', async () => {
    const guide = await loadWritingGuide({
      WEB_LATEX_MCP_WRITING_GUIDE: path.join(tmp, 'nope.md'),
    });
    expect(guide).toBeUndefined();
  });

  it('returns undefined for an empty file', async () => {
    const empty = path.join(tmp, 'empty.md');
    await writeFile(empty, '   \n');
    const guide = await loadWritingGuide({ WEB_LATEX_MCP_WRITING_GUIDE: empty });
    expect(guide).toBeUndefined();
  });
});

describe('buildInstructions', () => {
  it('frames the guide and embeds its content', () => {
    const out = buildInstructions('GUIDE_BODY');
    expect(out).toContain('LaTeX (.tex) files through this server');
    expect(out).toContain('GUIDE_BODY');
  });

  it('always includes the PDF-comment workflow, even with no guide', () => {
    const out = buildInstructions(undefined);
    expect(out).toContain('list_comments');
    expect(out).toContain('resolve_comments');
    expect(out).not.toContain('LaTeX (.tex) files through this server');
  });

  it('includes the comment workflow alongside a guide', () => {
    expect(buildInstructions('GUIDE_BODY')).toContain('list_comments');
  });

  it('combines the writing and concurrency guides when both are present', () => {
    const out = buildInstructions('WRITING_BODY', 'CONCURRENCY_BODY');
    expect(out).toContain('WRITING_BODY');
    expect(out).toContain('CONCURRENCY_BODY');
    expect(out).toContain('committing or pushing changes');
  });

  it('frames the concurrency guide alone when only it is present', () => {
    const out = buildInstructions(undefined, 'CONCURRENCY_BODY');
    expect(out).toContain('CONCURRENCY_BODY');
    expect(out).not.toContain('LaTeX (.tex) files through this server');
  });

  it('mentions precedence only when hasExtra is explicitly passed true (base + extra both composed)', () => {
    const { text: composed, hasExtra } = composeWritingGuide('BASE_BODY', 'EXTRA_BODY');
    expect(hasExtra).toBe(true);
    const out = buildInstructions(composed, undefined, hasExtra);
    expect(out).toMatch(/precedence|take(s)? precedence|override/i);
  });

  it('does not mention precedence for a base-only guide even when hasExtra is omitted', () => {
    const out = buildInstructions('BASE_BODY');
    expect(out).not.toMatch(/precedence/i);
  });

  it('does not mention precedence when the base guide happens to contain the extra-guide heading text but no extra guide was configured (FALSE CLAIM guard)', () => {
    const baseWithHeadingText = `BASE_INTRO\n\n${EXTRA_GUIDE_HEADING}\n\nBASE_TAIL`;
    // hasExtra defaults to false: no extra guide was actually composed.
    const out = buildInstructions(baseWithHeadingText);
    expect(out).not.toMatch(/precedence/i);
  });

  it('does not mention precedence for an extra-only guide (no base) even though the heading text is present (VACUOUS CLAIM guard)', () => {
    const { text: composed, hasExtra } = composeWritingGuide(undefined, 'EXTRA_BODY');
    expect(hasExtra).toBe(false); // extra-only: not BOTH base and extra
    const out = buildInstructions(composed, undefined, hasExtra);
    expect(out).not.toMatch(/precedence/i);
  });
});

describe('composeWritingGuide', () => {
  it('puts base first, heading second, extra last, and reports hasExtra true', () => {
    const { text: out, hasExtra } = composeWritingGuide('BASE_BODY', 'EXTRA_BODY');
    expect(out).toBeDefined();
    expect(hasExtra).toBe(true);
    const composed = out as string;
    const baseIdx = composed.indexOf('BASE_BODY');
    const headingIdx = composed.indexOf(EXTRA_GUIDE_HEADING);
    const extraIdx = composed.indexOf('EXTRA_BODY');
    expect(baseIdx).toBeGreaterThanOrEqual(0);
    expect(headingIdx).toBeGreaterThan(baseIdx);
    expect(extraIdx).toBeGreaterThan(headingIdx);
  });

  it('returns base unchanged when there is no extra, and hasExtra false', () => {
    const { text, hasExtra } = composeWritingGuide('BASE_BODY', undefined);
    expect(text).toBe('BASE_BODY');
    expect(hasExtra).toBe(false);
  });

  it('returns heading + extra when there is no base, and hasExtra false (extra-only is not "both")', () => {
    const { text: out, hasExtra } = composeWritingGuide(undefined, 'EXTRA_BODY');
    expect(out).toContain(EXTRA_GUIDE_HEADING);
    expect(out).toContain('EXTRA_BODY');
    expect((out as string).indexOf(EXTRA_GUIDE_HEADING)).toBeLessThan(
      (out as string).indexOf('EXTRA_BODY'),
    );
    expect(hasExtra).toBe(false);
  });

  it('returns undefined text and hasExtra false when neither is present', () => {
    const { text, hasExtra } = composeWritingGuide(undefined, undefined);
    expect(text).toBeUndefined();
    expect(hasExtra).toBe(false);
  });
});

describe('loadExtraWritingGuide', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'extra-guide-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('reads a temp file', async () => {
    const file = path.join(tmp, 'extra.md');
    await writeFile(file, 'Write lidar, never LiDAR.\n');
    const guide = await loadExtraWritingGuide(file);
    expect(guide).toBe('Write lidar, never LiDAR.');
  });

  it('returns undefined and warns on stderr for a missing path', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const guide = await loadExtraWritingGuide(path.join(tmp, 'nope.md'));
    expect(guide).toBeUndefined();
    expect(spy).toHaveBeenCalled();
  });

  it('returns undefined for an empty/whitespace-only file', async () => {
    const file = path.join(tmp, 'empty.md');
    await writeFile(file, '   \n');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const guide = await loadExtraWritingGuide(file);
    expect(guide).toBeUndefined();
    expect(spy).toHaveBeenCalled();
  });

  it('returns undefined with no warning when the path is undefined', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const guide = await loadExtraWritingGuide(undefined);
    expect(guide).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });
});
