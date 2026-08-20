import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/server.js';
import { createContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * The case this exists for: a document that is neither on a git remote nor a `.bib`. A proposal
 * drafted in markdown, sitting in a directory the author already has, with its reference list
 * written as a numbered section and its citations as pandoc `[@key]`. Nothing here may need git.
 */
const PROPOSAL = [
  '# EuroHPC Regular Access — compute proposal',
  '',
  'The approach follows [@he2016deep] and extends @cabon2020virtual.',
  'A key baseline is missing from the bibliography [@ghost2030].',
  '',
  '## References',
  '',
  '1. He, K., Zhang, X., Ren, S., & Sun, J. (2016). "Deep Residual Learning for Image ' +
    'Recognition." CVPR.',
  '2. Cabon, Y., Murray, N., & Humenberger, M. (2020). Virtual KITTI 2. arXiv:2001.10773.',
  '',
].join('\n');

const BIB = [
  '@string{cvpr = "IEEE/CVF Conference on Computer Vision and Pattern Recognition"}',
  '',
  '@inproceedings{he2016deep,',
  '  title     = {Deep Residual Learning for {Image} Recognition},',
  '  author    = {He, Kaiming and Zhang, Xiangyu and Ren, Shaoqing and Sun, Jian},',
  '  booktitle = cvpr,',
  '  year      = {2016},',
  '}',
  '',
  '@article{cabon2020virtual,',
  '  title  = {Virtual {KITTI} 2},',
  '  author = {Cabon, Yohann and others},',
  '  year   = {2020},',
  '}',
  '',
  '@inproceedings{never2019cited,',
  '  title     = {Nobody Refers To This},',
  '  author    = {Lonely, Ann},',
  '  booktitle = cvpr,',
  '  year      = {2019},',
  '}',
  '',
].join('\n');

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(): Promise<{ client: Client; userDir: string }> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-refs-ws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-refs-dir-'));
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

  await writeFile(path.join(userDir, 'proposal.md'), PROPOSAL);
  await client.callTool({
    name: 'register_project',
    arguments: { project: 'proposal', path: userDir },
  });
  return { client, userDir };
}

function textOf(res: unknown): string {
  return JSON.stringify((res as { content?: unknown }).content ?? '');
}

describe('references in a local, non-.bib document', () => {
  it('lists the reference list of a markdown document, with no remote and no .bib', async () => {
    const { client } = await setup();

    const res = await client.callTool({
      name: 'list_references',
      arguments: { project: 'proposal' },
    });
    expect(res.isError).toBeFalsy();
    const { entries, sources } = res.structuredContent as {
      entries: Array<Record<string, unknown>>;
      sources: Array<{ path: string }>;
    };
    expect(sources.map((s) => s.path)).toEqual(['proposal.md']);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      format: 'prose',
      label: '1',
      title: 'Deep Residual Learning for Image Recognition',
      year: 2016,
      path: 'proposal.md',
    });
    expect(entries[1]).toMatchObject({ arxivId: '2001.10773', year: 2020 });
    // The heuristics never hide the source text.
    expect(entries[1]!.raw).toContain('Virtual KITTI 2');
  });

  it('finds prose documents through list_files', async () => {
    const { client } = await setup();
    const res = await client.callTool({
      name: 'list_files',
      arguments: { project: 'proposal', filter: 'docs' },
    });
    expect(textOf(res)).toContain('proposal.md (doc');
  });

  it('filters a .bib to the entry the user is asking about', async () => {
    const { client, userDir } = await setup();
    await writeFile(path.join(userDir, 'ref.bib'), BIB);

    const res = await client.callTool({
      name: 'list_references',
      arguments: { project: 'proposal', path: 'ref.bib', filter: 'cabon' },
    });
    const { entries, totalCount } = res.structuredContent as {
      entries: Array<Record<string, unknown>>;
      totalCount: number;
    };
    expect(totalCount).toBe(3);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      key: 'cabon2020virtual',
      format: 'bibtex',
      truncatedAuthors: true,
      year: 2020,
    });
  });

  it('cross-checks pandoc citations in markdown against a .bib', async () => {
    const { client, userDir } = await setup();
    await writeFile(path.join(userDir, 'ref.bib'), BIB);

    const res = await client.callTool({
      name: 'check_citations',
      arguments: { project: 'proposal' },
    });
    expect(res.isError).toBeFalsy();
    const report = res.structuredContent as {
      documents: string[];
      bibliographySources: string[];
      undefinedCitations: Array<{ key: string; uses: Array<{ path: string; line: number }> }>;
      uncitedEntries: Array<{ key: string }>;
      incompleteEntries: Array<{ key: string; missing: string[] }>;
      duplicateKeys: unknown[];
    };
    expect(report.documents).toEqual(['proposal.md']);
    expect(report.bibliographySources).toEqual(['ref.bib']);
    expect(report.undefinedCitations).toEqual([
      { key: 'ghost2030', uses: [{ path: 'proposal.md', line: 4 }] },
    ]);
    expect(report.uncitedEntries.map((e) => e.key)).toEqual(['never2019cited']);
    expect(report.incompleteEntries).toEqual([
      {
        key: 'cabon2020virtual',
        path: 'ref.bib',
        line: 10,
        type: 'article',
        missing: ['journal|journaltitle'],
      },
    ]);
    expect(report.duplicateKeys).toEqual([]);
    // The whole report has to survive a client that drops structuredContent.
    expect(textOf(res)).toContain('ghost2030');
    expect(textOf(res)).toContain('never2019cited');
  });

  it('reports duplicate cite keys across bibliographies', async () => {
    const { client, userDir } = await setup();
    await writeFile(path.join(userDir, 'ref.bib'), BIB);
    await writeFile(
      path.join(userDir, 'extra.bib'),
      '@misc{he2016deep, title={A Clashing Copy}, year={2016}}\n',
    );

    const res = await client.callTool({
      name: 'check_citations',
      arguments: { project: 'proposal' },
    });
    const { duplicateKeys } = res.structuredContent as {
      duplicateKeys: Array<{ key: string; occurrences: Array<{ path: string }> }>;
    };
    expect(duplicateKeys).toHaveLength(1);
    expect(duplicateKeys[0]!.key).toBe('he2016deep');
    expect(duplicateKeys[0]!.occurrences.map((o) => o.path).sort()).toEqual([
      'extra.bib',
      'ref.bib',
    ]);
  });

  it('says what to do when there is no bibliography to check against', async () => {
    const { client, userDir } = await setup();
    await rm(path.join(userDir, 'proposal.md'));
    await writeFile(path.join(userDir, 'notes.md'), '# Notes\n\nNothing to cite here.\n');
    const res = await client.callTool({
      name: 'check_citations',
      arguments: { project: 'proposal' },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/No reference entries found/);
  });

  it('does not claim "none found" when the references are a keyless prose list', async () => {
    // The draft has real references — they are just numbered, not keyed. Reporting that as "no
    // reference entries found" sends the caller looking for a file that is already right there.
    const { client } = await setup();
    const res = await client.callTool({
      name: 'check_citations',
      arguments: { project: 'proposal' },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(
      /Found 2 reference\(s\) in proposal\.md, but none carry a cite key/,
    );
    expect(textOf(res)).toMatch(/list_references/);
  });

  it('reads a thebibliography out of a .tex, keys and all', async () => {
    const { client, userDir } = await setup();
    await mkdir(path.join(userDir, 'src'), { recursive: true });
    await writeFile(
      path.join(userDir, 'src', 'main.tex'),
      [
        '\\documentclass{article}',
        '\\begin{document}',
        'Prior work \\citep{he2016deep} matters.',
        '\\begin{thebibliography}{9}',
        '\\bibitem{he2016deep} K. He et al., "Deep Residual Learning," CVPR, 2016.',
        '\\end{thebibliography}',
        '\\end{document}',
        '',
      ].join('\n'),
    );

    const listed = await client.callTool({
      name: 'list_references',
      arguments: { project: 'proposal', path: 'src/main.tex' },
    });
    const { entries } = listed.structuredContent as { entries: Array<Record<string, unknown>> };
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ key: 'he2016deep', format: 'bibitem', year: 2016 });

    const checked = await client.callTool({
      name: 'check_citations',
      arguments: {
        project: 'proposal',
        documents: ['src/main.tex'],
        bibliography: ['src/main.tex'],
      },
    });
    const { undefinedCitations, uncitedEntries } = checked.structuredContent as {
      undefinedCitations: unknown[];
      uncitedEntries: unknown[];
    };
    expect(undefinedCitations).toEqual([]);
    expect(uncitedEntries).toEqual([]);
  });
});
