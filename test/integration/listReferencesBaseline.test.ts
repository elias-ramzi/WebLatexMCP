import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * `list_references` may claim the out-of-band-edit baseline only for a file whose BYTES the
 * caller received — not merely every entry parsed out of it. A `.tex` with a `thebibliography`
 * returns a handful of `\bibitem`s out of a whole paper; a prose document returns its reference
 * list out of the whole draft; a `.bib` holding `@string` macros or `%` comments returns its
 * entries and never those. Recording any of them resets the guard over text the caller never
 * saw, so the next blind write destroys a hand edit made there.
 *
 * Each test arms the guard with `read_file` first: a write refuses only when a baseline EXISTS
 * and is stale, so the bug is a listing that silently re-records over the hand edit.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(): Promise<{ client: Client; dir: string }> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-refbase-ws-'));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-refbase-dir-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(dir, { recursive: true, force: true }),
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
  await client.callTool({ name: 'register_project', arguments: { project: 'doc', path: dir } });
  return { client, dir };
}

function textOf(res: unknown): string {
  return JSON.stringify((res as { content?: unknown }).content ?? '');
}

interface Listed {
  sources: Array<{ path: string; format: string; count: number }>;
  entries: Array<{ path: string; key?: string; format: string }>;
}

const PAPER = [
  '\\documentclass{article}',
  '\\begin{document}',
  'The method follows prior work~\\cite{he2016deep}.',
  '',
  '\\begin{thebibliography}{1}',
  '\\bibitem{he2016deep} K. He, X. Zhang, S. Ren, and J. Sun. Deep Residual Learning. CVPR, 2016.',
  '\\end{thebibliography}',
  '\\end{document}',
  '',
].join('\n');

describe('the baseline list_references claims is judged on bytes, not entries', () => {
  it('never claims a .tex whose thebibliography it listed: the paper around it was never shown', async () => {
    const { client, dir } = await setup();
    await writeFile(path.join(dir, 'main.tex'), PAPER);

    await client.callTool({ name: 'read_file', arguments: { project: 'doc', path: 'main.tex' } });
    // The user rewrites a sentence of the paper by hand — nowhere near the bibliography.
    const handEdited = PAPER.replace('follows prior work', 'builds on the residual design of');
    await writeFile(path.join(dir, 'main.tex'), handEdited);

    const listed = await client.callTool({
      name: 'list_references',
      arguments: { project: 'doc' },
    });
    const { sources, entries } = listed.structuredContent as unknown as Listed;
    // Every entry main.tex holds is returned, uncut — and still the caller saw one line of it.
    expect(sources).toEqual([{ path: 'main.tex', format: 'bibitem', count: 1 }]);
    expect(entries.map((e) => e.key)).toEqual(['he2016deep']);

    const wrote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'doc', path: 'main.tex', content: PAPER },
    });
    expect(wrote.isError).toBe(true);
    expect(textOf(wrote)).toContain('changed on disk');
    expect(await readFile(path.join(dir, 'main.tex'), 'utf8')).toBe(handEdited);
  });

  it('never claims a prose document whose reference list it listed', async () => {
    const { client, dir } = await setup();
    const draft = [
      '# Proposal',
      '',
      'An opening paragraph the listing never returns.',
      '',
      '## References',
      '',
      '1. He, K., Zhang, X. (2016). "Deep Residual Learning." CVPR.',
      '',
    ].join('\n');
    await writeFile(path.join(dir, 'draft.md'), draft);

    await client.callTool({ name: 'read_file', arguments: { project: 'doc', path: 'draft.md' } });
    const handEdited = draft.replace('An opening paragraph', 'A hand-rewritten paragraph');
    await writeFile(path.join(dir, 'draft.md'), handEdited);

    const listed = await client.callTool({
      name: 'list_references',
      arguments: { project: 'doc', path: 'draft.md' },
    });
    const { entries } = listed.structuredContent as unknown as Listed;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.format).toBe('prose');

    const wrote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'doc', path: 'draft.md', content: draft },
    });
    expect(wrote.isError).toBe(true);
    expect(textOf(wrote)).toContain('changed on disk');
    expect(await readFile(path.join(dir, 'draft.md'), 'utf8')).toBe(handEdited);
  });

  const ENTRY_A =
    '@article{alpha2020,\n  title = {Alpha},\n  journal = venue,\n  year = {2020},\n}';
  const ENTRY_B = '@article{beta2021,\n  title = {Beta},\n  year = {2021},\n}';

  it.each([
    [
      'an @string macro',
      `@string{venue = "Journal of Things"}\n\n${ENTRY_A}\n\n${ENTRY_B}\n`,
      (bib: string) => bib.replace('Journal of Things', 'Journal of Hand Edits'),
    ],
    [
      'a % comment between entries',
      `${ENTRY_A}\n\n% keep beta: reviewer 2 asked for it\n${ENTRY_B}\n`,
      (bib: string) => bib.replace('reviewer 2 asked for it', 'DO NOT DELETE, hand note'),
    ],
    [
      'an @comment block',
      `${ENTRY_A}\n\n@comment{jabref-meta: databaseType:bibtex;}\n\n${ENTRY_B}\n`,
      (bib: string) => bib.replace('databaseType:bibtex', 'databaseType:biblatex'),
    ],
  ])(
    'never claims a .bib holding %s, which no entry carries',
    async (_label, original, handEdit) => {
      const { client, dir } = await setup();
      await writeFile(path.join(dir, 'refs.bib'), original);

      await client.callTool({ name: 'read_file', arguments: { project: 'doc', path: 'refs.bib' } });
      const handEdited = handEdit(original);
      expect(handEdited).not.toBe(original);
      await writeFile(path.join(dir, 'refs.bib'), handEdited);

      const listed = await client.callTool({
        name: 'list_references',
        arguments: { project: 'doc', path: 'refs.bib' },
      });
      const { entries } = listed.structuredContent as unknown as Listed;
      // Both entries come back whole; the text the user edited is in neither.
      expect(entries.map((e) => e.key)).toEqual(['alpha2020', 'beta2021']);

      const wrote = await client.callTool({
        name: 'write_file',
        arguments: { project: 'doc', path: 'refs.bib', content: original, confirmBibEdit: true },
      });
      expect(wrote.isError).toBe(true);
      expect(textOf(wrote)).toContain('changed on disk');
      expect(await readFile(path.join(dir, 'refs.bib'), 'utf8')).toBe(handEdited);
    },
  );

  it('still claims a .bib that is nothing but entries and whitespace, CRLF included', async () => {
    // The narrowing must not become a blanket refusal: a bibliography whose every byte the caller
    // received is one it can base a write on, hand edit and all.
    const { client, dir } = await setup();
    const original = `${ENTRY_B.replace(/\n/g, '\r\n')}\r\n`;
    await writeFile(path.join(dir, 'refs.bib'), original);
    await client.callTool({ name: 'read_file', arguments: { project: 'doc', path: 'refs.bib' } });
    const handEdited = `${original}\r\n\r\n@misc{typed2026,\r\n  title = {By Hand},\r\n}\r\n`;
    await writeFile(path.join(dir, 'refs.bib'), handEdited);

    const listed = await client.callTool({
      name: 'list_references',
      arguments: { project: 'doc', path: 'refs.bib' },
    });
    const { entries } = listed.structuredContent as unknown as Listed;
    expect(entries.map((e) => e.key)).toEqual(['beta2021', 'typed2026']);

    const wrote = await client.callTool({
      name: 'write_file',
      arguments: { project: 'doc', path: 'refs.bib', content: original, confirmBibEdit: true },
    });
    expect(wrote.isError).toBeFalsy();
  });
});
