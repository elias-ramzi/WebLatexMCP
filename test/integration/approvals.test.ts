import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import { DECLINED_MESSAGE } from '../../src/lib/approvals.js';
import type { ApprovalsMode } from '../../src/lib/approvals.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * A guarded change asks the user (#289): a real client with an `elicitation/create` handler, over
 * the 2025-era in-memory transport, so the SDK's legacy shim carries the question. The 2026-07-28
 * path (the client retrying with the answer) is in `protocol2026.test.ts`.
 */

const IDENTITY = { name: 'Test', email: 'test@example.com' };
const BIB = '@misc{seed, title = {Seed}}\n';

type Answer = { action: 'accept'; content: { approve: boolean } } | { action: 'decline' };

describe('approvals: a guarded change asks the user', () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
  });

  async function setup(opts: { elicitation?: boolean; answer?: Answer; mode?: ApprovalsMode }) {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-approve-ws-'));
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wlm-approve-dir-'));
    cleanups.push(
      () => rm(workspace, { recursive: true, force: true }),
      () => rm(dir, { recursive: true, force: true }),
    );
    await writeFile(path.join(dir, 'main.tex'), 'x\n');
    await writeFile(path.join(dir, 'refs.bib'), BIB);
    const config: ServerConfig = {
      workspaceRoot: workspace,
      sessionId: 'approve',
      projects: [{ id: 'doc', mode: 'local', path: dir }],
      defaultProject: 'doc',
      extraWritingGuidePath: path.join(workspace, 'guide-extra.md'),
      ...(opts.mode ? { approvals: opts.mode } : {}),
    };
    const ctx = createContext(
      config,
      new CredentialResolver({}),
      IDENTITY,
      new ProjectRegistry(workspace),
    );
    const server = createServer(ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client(
      { name: 'claude-code', version: '0.0.0' },
      opts.elicitation ? { capabilities: { elicitation: { form: {} } } } : undefined,
    );
    const asked: string[] = [];
    if (opts.elicitation) {
      client.setRequestHandler('elicitation/create', async (request) => {
        asked.push(String((request.params as { message?: unknown }).message));
        return opts.answer ?? { action: 'decline' };
      });
    }
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    cleanups.push(() => client.close());
    return { client, dir, asked };
  }

  const writeBib = (client: Client, flag = true) =>
    client.callTool({
      name: 'write_file',
      arguments: {
        path: 'refs.bib',
        content: '@misc{seed, title = {Changed}}\n',
        ...(flag ? { confirmBibEdit: true } : {}),
      },
    });

  it('writes the .bib only once the user says yes', async () => {
    const { client, dir, asked } = await setup({
      elicitation: true,
      answer: { action: 'accept', content: { approve: true } },
    });
    const res = await writeBib(client);
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('"refs.bib"');
    expect(asked[0]).toContain('bibliography');
    expect(await readFile(path.join(dir, 'refs.bib'), 'utf8')).toContain('Changed');
  });

  it('changes nothing when the user declines, or leaves the box unticked', async () => {
    for (const answer of [
      { action: 'decline' } as const,
      { action: 'accept', content: { approve: false } } as const,
    ]) {
      const { client, dir, asked } = await setup({ elicitation: true, answer });
      const res = await writeBib(client);
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toContain(DECLINED_MESSAGE.slice(0, 40));
      expect(asked).toHaveLength(1);
      expect(await readFile(path.join(dir, 'refs.bib'), 'utf8')).toBe(BIB);
    }
  });

  it('asks nothing for a call that sets no guarded flag: the guard refuses as before', async () => {
    const { client, dir, asked } = await setup({ elicitation: true });
    const res = await writeBib(client, false);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain('confirmBibEdit');
    expect(asked).toEqual([]);
    expect(await readFile(path.join(dir, 'refs.bib'), 'utf8')).toBe(BIB);
  });

  it('keeps the flag alone enough for a client that cannot show a form', async () => {
    const { client, dir } = await setup({ elicitation: false });
    const res = await writeBib(client);
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    expect(await readFile(path.join(dir, 'refs.bib'), 'utf8')).toContain('Changed');
  });

  it('keeps the flag alone enough under WEB_LATEX_MCP_APPROVALS=flag', async () => {
    const { client, dir, asked } = await setup({ elicitation: true, mode: 'flag' });
    const res = await writeBib(client);
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    expect(asked).toEqual([]);
    expect(await readFile(path.join(dir, 'refs.bib'), 'utf8')).toContain('Changed');
  });

  it('asks before a writing-guide rule, quoting the rule', async () => {
    const { client, asked } = await setup({
      elicitation: true,
      answer: { action: 'accept', content: { approve: true } },
    });
    const res = await client.callTool({
      name: 'add_writing_convention',
      arguments: { rule: 'Always write "dataset" as one word.', confirmGuideEdit: true },
    });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    expect(asked[0]).toContain('writing guide');
    expect(asked[0]).toContain('dataset');
  });
});
