import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import type { ServerConfig } from '../../src/types.js';
import { CITATIONS_MAX_FILES } from '../../src/lib/citationsBudget.js';

/**
 * `check_citations` refuses a bibliography made only of numbered (keyless) prose reference
 * lists, and names the files it found them in. That list of names is document-controlled in
 * length — one entry per prose file carrying a reference list — so it is capped the house way
 * (`capList`: 20 names, then "… N more") rather than joined in full into the error text.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const PROSE_REFS = [
  '# Notes',
  '',
  '## References',
  '',
  '1. He, K., Zhang, X., Ren, S., & Sun, J. (2016). "Deep Residual Learning for Image ' +
    'Recognition." CVPR.',
  '',
].join('\n');

async function setup(fileCount: number): Promise<Client> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-keyless-ws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-keyless-dir-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
  );
  const config: ServerConfig = { workspaceRoot: workspace, sessionId: 'test', projects: [] };
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
  cleanups.push(() => client.close());

  for (let i = 0; i < fileCount; i++) {
    await writeFile(path.join(userDir, `note${String(i).padStart(3, '0')}.md`), PROSE_REFS);
  }
  await client.callTool({
    name: 'register_project',
    arguments: { project: 'notes', path: userDir },
  });
  return client;
}

function textOf(res: unknown): string {
  const content = (res as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => c.text ?? '').join('\n');
}

describe('check_citations: the keyless-bibliography refusal', () => {
  it('names at most CITATIONS_MAX_FILES files and counts the rest', async () => {
    const total = CITATIONS_MAX_FILES + 17;
    const client = await setup(total);
    const res = await client.callTool({
      name: 'check_citations',
      arguments: { project: 'notes' },
    });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    // Every reference is still counted, whatever the cap on names.
    expect(text).toContain(`Found ${total} reference(s) in `);
    expect(text).toContain('but none carry a cite key');
    // The first CITATIONS_MAX_FILES names are listed, the rest only counted.
    const named = text.match(/note\d{3}\.md/g) ?? [];
    expect(named).toHaveLength(CITATIONS_MAX_FILES);
    expect(text).toContain('note000.md');
    expect(text).not.toContain(`note${String(CITATIONS_MAX_FILES).padStart(3, '0')}.md`);
    expect(text).toContain(`… 17 more`);
  });
});
