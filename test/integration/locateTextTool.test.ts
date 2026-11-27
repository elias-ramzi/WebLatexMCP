import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { sessionStateDir } from '../../src/lib/sessionPaths.js';
import { QUOTE_MAX_FILE_BYTES } from '../../src/lib/quoteLocate.js';
import type { ServerConfig } from '../../src/types.js';
import { expectNoUndeclaredKeys } from '../helpers/outputSchema.js';

/**
 * `locate_text` end to end through an SDK client that listed the tools first — so the client's
 * own `additionalProperties: false` validator is armed and an undeclared key would fail the call —
 * on a `mode: 'local'` project (no git anywhere). Every key of every populated shape (a result
 * with a snippet, one without, a skipped file, the note) is audited against the advertised schema.
 */

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const INTRO = [
  '\\section{Results}',
  '% Except against SafeDrive in reactive traffic (old wording).',
  'Ours wins everywhere except',
  'against SafeDrive in reactive traffic (Tab.~\\ref{tab:main}).',
  '',
].join('\n');

async function setup() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-locate-ws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'wlm-locate-dir-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
  );
  await writeFile(path.join(userDir, 'main.tex'), '\\documentclass{article}\n\\input{sec/intro}\n');
  await mkdir(path.join(userDir, 'sec'), { recursive: true });
  await writeFile(path.join(userDir, 'sec', 'intro.tex'), INTRO);
  // Over the per-file cap: listed, not searched, reported under `skipped`.
  await writeFile(path.join(userDir, 'huge.tex'), 'x '.repeat(QUOTE_MAX_FILE_BYTES / 2 + 10));

  const config: ServerConfig = {
    workspaceRoot: workspace,
    sessionId: 'test',
    projects: [{ id: 'paper', mode: 'local', path: userDir }],
  };
  const ctx = createContext(
    config,
    new CredentialResolver({}),
    { name: 'Test', email: 'test@example.com' },
    new ProjectRegistry(workspace),
  );
  const server = createServer(ctx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.unshift(() => client.close());
  await client.listTools();
  return { client, workspace, userDir };
}

interface Out {
  results: Array<{
    file: string;
    line: number;
    endLine: number;
    matchedBy: string;
    snippet: string | null;
  }>;
  matchCount: number;
  unique: boolean;
  variant: string;
  marginNumbersRemoved: number;
  instructionDropped: boolean;
  skipped: Array<{ path: string; reason: string }>;
  skippedCount: number;
  note?: string;
}

describe('locate_text through an MCP client', () => {
  it('locates a margin-numbered paste in the live text, never the comment, and publishes every key', async () => {
    const { client, workspace, userDir } = await setup();
    const res = await client.callTool({
      name: 'locate_text',
      arguments: {
        project: 'paper',
        text: 'except 105\nagainst SafeDrive in reactive traffic (Tab. 2).\n--> remove',
      },
    });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as unknown as Out;
    await expectNoUndeclaredKeys(client, 'locate_text', out);

    // "Tab. 2" renders \ref, so the whole text is found nowhere; the leading window is, and only
    // in the live lines (the comment on line 2 holds the same words).
    expect(out.results).toEqual([
      expect.objectContaining({ file: 'sec/intro.tex', line: 3, matchedBy: 'leading-window' }),
    ]);
    expect(out.results[0]?.snippet).toContain('Ours wins everywhere except');
    expect(out.results[0]?.snippet).not.toContain('%');
    expect(out.variant).toBe('margin-numbers-removed');
    expect(out.instructionDropped).toBe(true);
    expect(out.skipped).toEqual([{ path: 'huge.tex', reason: 'too-large' }]);
    // A file was not searched, so one candidate is not vouched unique.
    expect(out.unique).toBe(false);
    expect(out.note).toMatch(/not searched/);
    const text = (res.content as Array<{ text: string }>)[0]?.text ?? '';
    expect(text).toContain('sec/intro.tex:3–4 (leading-window)');

    // Read-only and lock-free: no session state was created for the project.
    await expect(stat(sessionStateDir(workspace, 'paper'))).rejects.toThrow();
    // No baseline: a hand edit then a write_file is not refused as an out-of-band change.
    await writeFile(path.join(userDir, 'sec', 'intro.tex'), `${INTRO}hand edit\n`);
    const w = await client.callTool({
      name: 'write_file',
      arguments: { project: 'paper', path: 'sec/intro.tex', content: 'replaced\n' },
    });
    expect(w.isError).toBeFalsy();
  });

  it('a budget-cut snippet still validates against the advertised schema', async () => {
    const { client, userDir } = await setup();
    const block = Array.from({ length: 6 }, (_, k) => `word${k} %${'y'.repeat(400)}`).join('\n');
    for (let i = 0; i < 20; i++) {
      await writeFile(path.join(userDir, `f${String(i).padStart(2, '0')}.tex`), `${block}\n`);
    }
    const res = await client.callTool({
      name: 'locate_text',
      arguments: { project: 'paper', text: 'word0 word1 word2 word3 word4 word5', maxResults: 20 },
    });
    expect(res.isError).toBeFalsy();
    const out = res.structuredContent as unknown as Out & { snippetsOmitted: number };
    await expectNoUndeclaredKeys(client, 'locate_text', out);
    expect(out.matchCount).toBe(20);
    expect(out.snippetsOmitted).toBeGreaterThan(0);
    expect(out.results.some((r) => r.snippet === null)).toBe(true);
  });

  it('refuses fewer than three words in words', async () => {
    const { client } = await setup();
    const res = await client.callTool({
      name: 'locate_text',
      arguments: { project: 'paper', text: 'drop this --> now' },
    });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ text: string }>)[0]?.text).toMatch(/at least 3 are needed/);
  });
});
