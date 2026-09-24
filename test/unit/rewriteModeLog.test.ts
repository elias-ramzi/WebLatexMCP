import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseRewriteMode } from '../../src/config.js';
import { DEFAULT_REWRITE_MODE } from '../../src/lib/rewriteMode.js';

describe('parseRewriteMode logs a rejected value elided, like its sibling parsers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('elides an over-long rejected value instead of dumping it to stderr verbatim', () => {
    // Same bound parseReferenceSource and parseContactEmail apply to their rejection lines: a
    // pasted multi-kilobyte env var costs one short, marked line, not kilobytes of log.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const huge = 'q'.repeat(5000);

    expect(parseRewriteMode(huge)).toEqual({ mode: DEFAULT_REWRITE_MODE, explicit: false });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const message = String(errorSpy.mock.calls[0]?.[0]);
    expect(message).toContain('WEB_LATEX_MCP_REWRITE_MODE');
    expect(message).not.toContain(huge);
    expect(message).toContain('(5000 characters)');
    expect(message.length).toBeLessThan(600);
    // stdout is the JSON-RPC channel.
    expect(logSpy).not.toHaveBeenCalled();
  });

  it('still echoes a short rejected value in full, so the typo stays visible', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    parseRewriteMode('  Sometimes  ');
    const message = String(errorSpy.mock.calls[0]?.[0]);
    expect(message).toContain('"Sometimes"');
    expect(message).not.toContain('characters)');
  });
});
