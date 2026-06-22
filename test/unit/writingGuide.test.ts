import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadWritingGuide, buildInstructions } from '../../src/lib/writingGuide.js';

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

  it('reads an override path from GIT_MCP_WRITING_GUIDE', async () => {
    const custom = path.join(tmp, 'guide.md');
    await writeFile(custom, '# Custom guide\n\nUse the past tense.\n');
    const guide = await loadWritingGuide({ GIT_MCP_WRITING_GUIDE: custom });
    expect(guide).toBe('# Custom guide\n\nUse the past tense.');
  });

  it('returns undefined when the file is missing', async () => {
    const guide = await loadWritingGuide({ GIT_MCP_WRITING_GUIDE: path.join(tmp, 'nope.md') });
    expect(guide).toBeUndefined();
  });

  it('returns undefined for an empty file', async () => {
    const empty = path.join(tmp, 'empty.md');
    await writeFile(empty, '   \n');
    const guide = await loadWritingGuide({ GIT_MCP_WRITING_GUIDE: empty });
    expect(guide).toBeUndefined();
  });
});

describe('buildInstructions', () => {
  it('frames the guide and embeds its content', () => {
    const out = buildInstructions('GUIDE_BODY');
    expect(out).toContain('LaTeX (.tex) files through this server');
    expect(out).toContain('GUIDE_BODY');
  });

  it('returns undefined when there is no guide', () => {
    expect(buildInstructions(undefined)).toBeUndefined();
  });
});
