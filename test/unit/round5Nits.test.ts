import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadConfig, parseExtraWritingGuide } from '../../src/config.js';
import { createSessionRecorder } from '../../src/lib/mutationRecorder.js';
import { stripGitUrlCredentials } from '../../src/lib/gitUrlCredentials.js';

const NL = String.fromCharCode(0x0a);
const RLO = String.fromCharCode(0x202e);
/** A value that, interpolated raw, forges a second stderr line and flips the rest of it. */
const FORGED = `bad${NL}[web-latex-mcp] forged line${RLO}`;
const notInRepo = (): boolean => false;

function captureStderr(): { lines: string[] } {
  const out = { lines: [] as string[] };
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    out.lines.push(args.map(String).join(' '));
  });
  return out;
}

function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected a throw');
}

function expectEscaped(msg: string): void {
  expect(msg).not.toContain(NL);
  expect(msg).not.toContain(RLO);
  expect(msg).toContain('\\u{A}');
  expect(msg).toContain('\\u{202E}');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('config — a rejected env value is escaped in the message that names it', () => {
  it('WEB_LATEX_MCP_COMPILER', () => {
    expectEscaped(
      thrownMessage(() => loadConfig({ WEB_LATEX_MCP_COMPILER: FORGED }, '/w', notInRepo)),
    );
  });

  it('WEB_LATEX_MCP_VIEWER_TARGET', () => {
    expectEscaped(
      thrownMessage(() => loadConfig({ WEB_LATEX_MCP_VIEWER_TARGET: FORGED }, '/w', notInRepo)),
    );
  });

  it('WEB_LATEX_MCP_VIEWER_PORT', () => {
    expectEscaped(
      thrownMessage(() => loadConfig({ WEB_LATEX_MCP_VIEWER_PORT: FORGED }, '/w', notInRepo)),
    );
  });

  it('WEB_LATEX_MCP_WRITING_GUIDE_EXTRA', () => {
    const err = captureStderr();
    expect(parseExtraWritingGuide(`file:${FORGED}`, '/w')).toEqual({});
    expect(err.lines).toHaveLength(1);
    expectEscaped(err.lines[0]!);
  });

  it.each([
    ['WEB_LATEX_MCP_REFERENCE_SOURCE'],
    ['WEB_LATEX_MCP_REWRITE_MODE'],
    ['WEB_LATEX_MCP_CONTACT_EMAIL'],
  ])('%s (already elided, now escaped too)', (name) => {
    const err = captureStderr();
    loadConfig({ [name]: FORGED }, '/w', notInRepo);
    const line = err.lines.find((l) => l.includes(name));
    expect(line).toBeDefined();
    expectEscaped(line!);
  });

  it('bounds an over-long value while escaping it', () => {
    const msg = thrownMessage(() =>
      loadConfig({ WEB_LATEX_MCP_COMPILER: `${NL}${'x'.repeat(5000)}` }, '/w', notInRepo),
    );
    expect(msg).not.toContain(NL);
    expect(msg.length).toBeLessThan(400);
    expect(msg).toContain('(5001 characters)');
  });

  it('a plain rejected value reads as before', () => {
    expect(thrownMessage(() => loadConfig({ WEB_LATEX_MCP_COMPILER: 'pdflatex' }))).toBe(
      'WEB_LATEX_MCP_COMPILER "pdflatex" is invalid; expected one of: latexmk, tectonic.',
    );
  });
});

describe('createSessionRecorder — the path in its stderr lines is escaped', () => {
  const REL = `a${NL}[web-latex-mcp] forged.tex`;

  it('when marking unrecorded fails', async () => {
    const warnings: string[] = [];
    const recorder = createSessionRecorder({
      idForDir: () => 'demo',
      isLocal: () => false,
      touch: async () => {},
      record: () => Promise.reject(new Error('record failed')),
      markUnrecorded: () => Promise.reject(new Error('mark failed')),
      warn: (m) => warnings.push(m),
    });
    await expect(recorder.record('/clone', REL, null, 'x')).rejects.toThrow('record failed');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain(NL);
    expect(warnings[0]).toContain('\\u{A}');
  });

  it('when the heartbeat fails', async () => {
    const warnings: string[] = [];
    const recorder = createSessionRecorder({
      idForDir: () => 'demo',
      isLocal: () => false,
      touch: () => Promise.reject(new Error('touch failed')),
      record: async () => {},
      markUnrecorded: async () => {},
      warn: (m) => warnings.push(m),
    });
    await recorder.record('/clone', REL, null, 'x');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain(NL);
    expect(warnings[0]).toContain('\\u{A}');
  });
});

describe('stripGitUrlCredentials — a path segment publishes its exact spelling only', () => {
  it('drops a mixed-case token whose lower-case form is the path segment', () => {
    const token = 'Tok3nTok3nTok3nTok3nX';
    expect(
      stripGitUrlCredentials(`https://${token}@host.example/${token.toLowerCase()}/r`),
    ).toEqual({
      url: `https://host.example/${token.toLowerCase()}/r`,
      stripped: true,
      removed: 'token',
    });
  });

  it('still keeps a name the path spells identically', () => {
    const url = 'https://Tok3nTok3nTok3nTok3nX@host.example/Tok3nTok3nTok3nTok3nX/r';
    expect(stripGitUrlCredentials(url)).toEqual({ url, stripped: false });
  });

  it('still folds case against a host label (DNS is case-insensitive)', () => {
    const url = 'https://ContosoEngineeringTeam@contosoengineeringteam.visualstudio.com/p/_git/r';
    expect(stripGitUrlCredentials(url)).toEqual({ url, stripped: false });
  });
});
