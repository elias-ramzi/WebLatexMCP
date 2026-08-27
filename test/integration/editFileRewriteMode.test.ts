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

/**
 * `edit_file`'s rewrite-preservation wiring: mode resolution (per-call > stored > env default),
 * the `.bib` and non-LaTeX narrowings, and that none of the pre-existing guards (identity check,
 * external-change guard) go quiet under the new path.
 */

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

interface Harness {
  client: Client;
  workspace: string;
  userDir: string;
}

async function setup(envDefault?: string): Promise<Harness> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ovl-rwmode-ws-'));
  const userDir = await mkdtemp(path.join(os.tmpdir(), 'ovl-rwmode-dir-'));
  cleanups.push(
    () => rm(workspace, { recursive: true, force: true }),
    () => rm(userDir, { recursive: true, force: true }),
  );
  const config: ServerConfig = {
    workspaceRoot: workspace,
    sessionId: 'test',
    projects: [],
    ...(envDefault ? { rewriteMode: envDefault as ServerConfig['rewriteMode'] } : {}),
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
  cleanups.push(() => client.close());
  return { client, workspace, userDir };
}

function structured<T>(res: unknown): T {
  return (res as { structuredContent: T }).structuredContent;
}

function textOf(res: unknown): string {
  return JSON.stringify((res as { content?: unknown }).content ?? '');
}

const PARAGRAPH_OLD =
  'The quick brown fox jumps over the lazy dog while the sun sets slowly behind the hills.';
const PARAGRAPH_NEW =
  'A swift fox leaps across the sleeping dog as evening light fades over the distant ridgeline.';

describe('edit_file rewrite-preservation mode', () => {
  it('always preserves the original, %-commented, above the replacement', async () => {
    const { client, userDir } = await setup();
    await writeFile(path.join(userDir, 'main.tex'), `${PARAGRAPH_OLD}\n`, 'utf8');
    await client.callTool({ name: 'register_project', arguments: { project: 'p', path: userDir } });
    await client.callTool({
      name: 'set_rewrite_mode',
      arguments: { project: 'p', mode: 'always' },
    });

    const res = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        path: 'main.tex',
        edits: [{ oldString: PARAGRAPH_OLD, newString: PARAGRAPH_NEW }],
      },
    });
    expect(res.isError ?? false).toBe(false);
    const out = structured<{ rewriteMode: string; preservedEdits: number }>(res);
    expect(out.rewriteMode).toBe('always');
    expect(out.preservedEdits).toBe(1);
    expect(textOf(res)).toContain('preserved');

    const read = await client.callTool({
      name: 'read_file',
      arguments: { project: 'p', path: 'main.tex' },
    });
    const content = structured<{ content: string }>(read).content;
    expect(content).toBe(`% ${PARAGRAPH_OLD}\n${PARAGRAPH_NEW}\n`);
  });

  it('off does not preserve', async () => {
    const { client, userDir } = await setup();
    await writeFile(path.join(userDir, 'main.tex'), `${PARAGRAPH_OLD}\n`, 'utf8');
    await client.callTool({ name: 'register_project', arguments: { project: 'p', path: userDir } });
    await client.callTool({ name: 'set_rewrite_mode', arguments: { project: 'p', mode: 'off' } });

    const res = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        path: 'main.tex',
        edits: [{ oldString: PARAGRAPH_OLD, newString: PARAGRAPH_NEW }],
      },
    });
    const out = structured<{ rewriteMode: string; preservedEdits: number }>(res);
    expect(out.rewriteMode).toBe('off');
    expect(out.preservedEdits).toBe(0);

    const read = await client.callTool({
      name: 'read_file',
      arguments: { project: 'p', path: 'main.tex' },
    });
    expect(structured<{ content: string }>(read).content).toBe(`${PARAGRAPH_NEW}\n`);
  });

  it('prose discriminates: a paragraph rewrite is preserved, a typo fix is not', async () => {
    const { client, userDir } = await setup();
    // The typo-fix sentence must have >= 8 whitespace tokens itself, so this test actually
    // exercises the near-identity (token-overlap) rule in classifyEdit rather than being
    // rejected earlier by the "< 8 words" guard. "We propose a nvoel method for solving this
    // long standing problem in the field." has 14 tokens.
    const TYPO_OLD =
      'We propose a nvoel method for solving this long standing problem in the field.';
    const TYPO_NEW =
      'We propose a novel method for solving this long standing problem in the field.';
    await writeFile(path.join(userDir, 'main.tex'), `${PARAGRAPH_OLD}\n${TYPO_OLD}\n`, 'utf8');
    await client.callTool({ name: 'register_project', arguments: { project: 'p', path: userDir } });
    await client.callTool({ name: 'set_rewrite_mode', arguments: { project: 'p', mode: 'prose' } });

    const rewrite = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        path: 'main.tex',
        edits: [{ oldString: PARAGRAPH_OLD, newString: PARAGRAPH_NEW }],
      },
    });
    expect(structured<{ preservedEdits: number }>(rewrite).preservedEdits).toBe(1);

    // This edit clears the >= 8 token guard (14 tokens) and is majority-prose, so it reaches the
    // near-identity check: only one of 14 tokens changed ("nvoel" -> "novel"), so the token-overlap
    // is well above NEAR_IDENTICAL_OVERLAP_THRESHOLD and classifyEdit calls it 'minor' — the rule
    // this test names.
    const typo = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        path: 'main.tex',
        edits: [{ oldString: TYPO_OLD, newString: TYPO_NEW }],
      },
    });
    expect(structured<{ preservedEdits: number }>(typo).preservedEdits).toBe(0);
  });

  it('preserveOriginal: true overrides a stored off; preserveOriginal: false overrides a stored always', async () => {
    const { client, userDir } = await setup();
    await writeFile(path.join(userDir, 'main.tex'), `${PARAGRAPH_OLD}\nsecond\n`, 'utf8');
    await client.callTool({ name: 'register_project', arguments: { project: 'p', path: userDir } });
    await client.callTool({ name: 'set_rewrite_mode', arguments: { project: 'p', mode: 'off' } });

    const forced = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        path: 'main.tex',
        preserveOriginal: true,
        edits: [{ oldString: PARAGRAPH_OLD, newString: PARAGRAPH_NEW }],
      },
    });
    expect(structured<{ rewriteMode: string; preservedEdits: number }>(forced)).toEqual({
      path: 'main.tex',
      appliedEdits: 1,
      diff: expect.any(String),
      rewriteMode: 'always',
      preservedEdits: 1,
    });

    await client.callTool({
      name: 'set_rewrite_mode',
      arguments: { project: 'p', mode: 'always' },
    });
    const suppressed = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        path: 'main.tex',
        preserveOriginal: false,
        edits: [
          {
            oldString: 'second',
            newString: 'the second replacement line entirely different wording appears here now',
          },
        ],
      },
    });
    const out = structured<{ rewriteMode: string; preservedEdits: number }>(suppressed);
    expect(out.rewriteMode).toBe('off');
    expect(out.preservedEdits).toBe(0);
  });

  it('an env default of "always" preserves with nothing stored for the project', async () => {
    const { client, userDir } = await setup('always');
    await writeFile(path.join(userDir, 'main.tex'), `${PARAGRAPH_OLD}\n`, 'utf8');
    await client.callTool({ name: 'register_project', arguments: { project: 'p', path: userDir } });
    // No set_rewrite_mode call: the project has nothing stored, so it must fall through to the
    // env-configured default rather than the built-in 'off'.

    const res = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        path: 'main.tex',
        edits: [{ oldString: PARAGRAPH_OLD, newString: PARAGRAPH_NEW }],
      },
    });
    const out = structured<{ rewriteMode: string; preservedEdits: number }>(res);
    expect(out.rewriteMode).toBe('always');
    expect(out.preservedEdits).toBe(1);
  });

  it('preserving duplicates a phrase, so a later edit matching it in both places is refused', async () => {
    const { client, userDir } = await setup();
    const SECOND_PARAGRAPH =
      'Second paragraph mentions the lazy dog again later in this very sentence for context.';
    await writeFile(
      path.join(userDir, 'main.tex'),
      `${PARAGRAPH_OLD}\n${SECOND_PARAGRAPH}\n`,
      'utf8',
    );
    await client.callTool({ name: 'register_project', arguments: { project: 'p', path: userDir } });
    await client.callTool({
      name: 'set_rewrite_mode',
      arguments: { project: 'p', mode: 'always' },
    });

    // Preserve a rewrite of the first paragraph — it is commented out above the replacement.
    const first = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        path: 'main.tex',
        edits: [{ oldString: PARAGRAPH_OLD, newString: PARAGRAPH_NEW }],
      },
    });
    expect(first.isError ?? false).toBe(false);
    const read = await client.callTool({
      name: 'read_file',
      arguments: { project: 'p', path: 'main.tex' },
    });
    const content = structured<{ content: string }>(read).content;
    expect(content).toBe(`% ${PARAGRAPH_OLD}\n${PARAGRAPH_NEW}\n${SECOND_PARAGRAPH}\n`);

    // "the lazy dog" now occurs twice: once inside the preserved `% ...` comment (it is a
    // substring of the commented-out PARAGRAPH_OLD line), and once, unrelated, in the untouched
    // second paragraph. A second edit_file call targeting that phrase is refused as non-unique —
    // pinning the documented consequence that preservation can make an otherwise-fine oldString
    // ambiguous.
    const secondEdit = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        path: 'main.tex',
        edits: [{ oldString: 'the lazy dog', newString: 'the sleepy dog' }],
      },
    });
    expect(secondEdit.isError).toBe(true);
    expect(textOf(secondEdit)).toMatch(/unique|multiple|ambiguous/i);
  });

  it('a .md file is inert under always, and reports rewriteMode off', async () => {
    const { client, userDir } = await setup();
    await writeFile(path.join(userDir, 'notes.md'), `${PARAGRAPH_OLD}\n`, 'utf8');
    await client.callTool({ name: 'register_project', arguments: { project: 'p', path: userDir } });
    await client.callTool({
      name: 'set_rewrite_mode',
      arguments: { project: 'p', mode: 'always' },
    });

    const res = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        path: 'notes.md',
        edits: [{ oldString: PARAGRAPH_OLD, newString: PARAGRAPH_NEW }],
      },
    });
    const out = structured<{ rewriteMode: string; preservedEdits: number }>(res);
    expect(out.rewriteMode).toBe('off');
    expect(out.preservedEdits).toBe(0);

    const read = await client.callTool({
      name: 'read_file',
      arguments: { project: 'p', path: 'notes.md' },
    });
    expect(structured<{ content: string }>(read).content).toBe(`${PARAGRAPH_NEW}\n`);
  });

  it('a .bib file: refused without confirmBibEdit, and preserves nothing even with confirmBibEdit + always', async () => {
    const { client, userDir } = await setup();
    await writeFile(
      path.join(userDir, 'refs.bib'),
      '@misc{a, title={Old Title Words Here}}\n',
      'utf8',
    );
    await client.callTool({ name: 'register_project', arguments: { project: 'p', path: userDir } });
    await client.callTool({
      name: 'set_rewrite_mode',
      arguments: { project: 'p', mode: 'always' },
    });

    const refused = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        path: 'refs.bib',
        edits: [{ oldString: 'Old Title Words Here', newString: 'New Title Words Here' }],
      },
    });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('confirmBibEdit');

    const allowed = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        path: 'refs.bib',
        confirmBibEdit: true,
        edits: [{ oldString: 'Old Title Words Here', newString: 'New Title Words Here' }],
      },
    });
    expect(allowed.isError ?? false).toBe(false);
    const out = structured<{ rewriteMode: string; preservedEdits: number }>(allowed);
    expect(out.rewriteMode).toBe('off');
    expect(out.preservedEdits).toBe(0);

    const read = await client.callTool({
      name: 'read_file',
      arguments: { project: 'p', path: 'refs.bib' },
    });
    expect(structured<{ content: string }>(read).content).toBe(
      '@misc{a, title={New Title Words Here}}\n',
    );
  });

  it('the external-change guard still fires under always', async () => {
    const { client, userDir } = await setup();
    await writeFile(path.join(userDir, 'main.tex'), `${PARAGRAPH_OLD}\n`, 'utf8');
    await client.callTool({ name: 'register_project', arguments: { project: 'p', path: userDir } });
    await client.callTool({
      name: 'set_rewrite_mode',
      arguments: { project: 'p', mode: 'always' },
    });

    // Record a baseline via a full read.
    await client.callTool({ name: 'read_file', arguments: { project: 'p', path: 'main.tex' } });
    // Now the file changes on disk outside the server.
    await writeFile(path.join(userDir, 'main.tex'), `${PARAGRAPH_OLD}\nout-of-band edit\n`, 'utf8');

    const res = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        path: 'main.tex',
        edits: [{ oldString: PARAGRAPH_OLD, newString: PARAGRAPH_NEW }],
      },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('changed');
  });

  it(
    'a paragraph rewrite under the default mode (nothing configured) applies unchanged, with ' +
      'no % comment added, because the built-in default is "off" — preservation is opt-in',
    async () => {
      const { client, userDir } = await setup();
      // A line-aligned, majority-prose, genuinely-rewritten paragraph: exactly the shape
      // classifyEdit calls 'prose' and, under the old 'prose' default, would have been preserved
      // as a commented-out block above the replacement. Under the new 'off' default it must not
      // be — the point of this test is that a caller who configures nothing gets their document
      // edited and nothing else.
      await writeFile(path.join(userDir, 'main.tex'), `${PARAGRAPH_OLD}\n`, 'utf8');
      await client.callTool({
        name: 'register_project',
        arguments: { project: 'p', path: userDir },
      });
      // Default mode: no set_rewrite_mode call, and setup() passes no envDefault, so this
      // exercises the built-in DEFAULT_REWRITE_MODE end to end.

      const res = await client.callTool({
        name: 'edit_file',
        arguments: {
          project: 'p',
          path: 'main.tex',
          edits: [{ oldString: PARAGRAPH_OLD, newString: PARAGRAPH_NEW }],
        },
      });
      expect(res.isError ?? false).toBe(false);
      const out = structured<{ rewriteMode: string; preservedEdits: number }>(res);
      expect(out.rewriteMode).toBe('off');
      expect(out.preservedEdits).toBe(0);

      const read = await client.callTool({
        name: 'read_file',
        arguments: { project: 'p', path: 'main.tex' },
      });
      const resultContent = structured<{ content: string }>(read).content;
      expect(resultContent).toBe(`${PARAGRAPH_NEW}\n`);
      expect(resultContent).not.toContain('%');
      expect(resultContent).not.toContain(PARAGRAPH_OLD);
    },
  );

  it(
    'a mid-line deletion under an explicit prose mode leaves the rest of the line ' +
      'intact and uncommented, and reports preservedEdits: 0',
    async () => {
      const { client, userDir } = await setup();
      const MID_LINE_OLD =
        'This is a long prose sentence with many ordinary words here to satisfy the prose gate.';
      const content = `Alpha beta. ${MID_LINE_OLD} Gamma delta.\n`;
      await writeFile(path.join(userDir, 'main.tex'), content, 'utf8');
      await client.callTool({
        name: 'register_project',
        arguments: { project: 'p', path: userDir },
      });
      // Explicit, since the built-in default is now 'off' and this test is about the
      // line-alignment guard within 'prose', not about what the default is.
      await client.callTool({
        name: 'set_rewrite_mode',
        arguments: { project: 'p', mode: 'prose' },
      });

      const res = await client.callTool({
        name: 'edit_file',
        arguments: {
          project: 'p',
          path: 'main.tex',
          edits: [{ oldString: MID_LINE_OLD, newString: '' }],
        },
      });
      expect(res.isError ?? false).toBe(false);
      const out = structured<{ rewriteMode: string; preservedEdits: number }>(res);
      expect(out.rewriteMode).toBe('prose');
      // Not line-aligned (MID_LINE_OLD starts and ends mid-line), so preservation must decline —
      // otherwise "Gamma delta." would be silently commented out even though it was never part
      // of oldString.
      expect(out.preservedEdits).toBe(0);

      const read = await client.callTool({
        name: 'read_file',
        arguments: { project: 'p', path: 'main.tex' },
      });
      const resultContent = structured<{ content: string }>(read).content;
      expect(resultContent).toBe('Alpha beta.  Gamma delta.\n');
      expect(resultContent).not.toContain('%');
      expect(resultContent).toContain('Gamma delta.');
    },
  );

  it(
    'a preserved comment survives verbatim when the original prose contains $-patterns ' +
      '(the server generates the replacement text server-side here, so this hits text the ' +
      'user never typed — String.prototype.replace would otherwise mangle $&/$$/etc. in it)',
    async () => {
      const { client, userDir } = await setup();
      const DOLLAR_OLD =
        'The mean score $a$&$b$ improves over every previous published baseline here today.';
      const DOLLAR_NEW =
        'The updated score now clearly exceeds every previous published baseline reported here.';
      await writeFile(path.join(userDir, 'main.tex'), `${DOLLAR_OLD}\n`, 'utf8');
      await client.callTool({
        name: 'register_project',
        arguments: { project: 'p', path: userDir },
      });
      await client.callTool({
        name: 'set_rewrite_mode',
        arguments: { project: 'p', mode: 'always' },
      });

      const res = await client.callTool({
        name: 'edit_file',
        arguments: {
          project: 'p',
          path: 'main.tex',
          edits: [{ oldString: DOLLAR_OLD, newString: DOLLAR_NEW }],
        },
      });
      expect(res.isError ?? false).toBe(false);
      const out = structured<{ preservedEdits: number }>(res);
      expect(out.preservedEdits).toBe(1);

      const read = await client.callTool({
        name: 'read_file',
        arguments: { project: 'p', path: 'main.tex' },
      });
      const content = structured<{ content: string }>(read).content;
      expect(content).toBe(`% ${DOLLAR_OLD}\n${DOLLAR_NEW}\n`);
    },
  );

  it('a whole-line deletion under always is still preserved (line-aligned match)', async () => {
    const { client, userDir } = await setup();
    const WHOLE_LINE_OLD =
      'This whole line should be preserved as a comment when it is deleted outright entirely.';
    await writeFile(
      path.join(userDir, 'main.tex'),
      `${WHOLE_LINE_OLD}\nsecond line stays.\n`,
      'utf8',
    );
    await client.callTool({ name: 'register_project', arguments: { project: 'p', path: userDir } });
    await client.callTool({
      name: 'set_rewrite_mode',
      arguments: { project: 'p', mode: 'always' },
    });

    const res = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        path: 'main.tex',
        edits: [{ oldString: WHOLE_LINE_OLD, newString: '' }],
      },
    });
    const out = structured<{ preservedEdits: number }>(res);
    expect(out.preservedEdits).toBe(1);

    const read = await client.callTool({
      name: 'read_file',
      arguments: { project: 'p', path: 'main.tex' },
    });
    expect(structured<{ content: string }>(read).content).toBe(
      `% ${WHOLE_LINE_OLD}\nsecond line stays.\n`,
    );
  });

  it('an edit with replaceAll is never preserved, even under always', async () => {
    const { client, userDir } = await setup();
    const REPEATED =
      'The quick brown fox jumps over the lazy dog while the sun sets slowly behind the hills.';
    await writeFile(
      path.join(userDir, 'main.tex'),
      `${REPEATED}\nsomething else here.\n${REPEATED}\n`,
      'utf8',
    );
    await client.callTool({ name: 'register_project', arguments: { project: 'p', path: userDir } });
    await client.callTool({
      name: 'set_rewrite_mode',
      arguments: { project: 'p', mode: 'always' },
    });

    const res = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        path: 'main.tex',
        edits: [{ oldString: REPEATED, newString: PARAGRAPH_NEW, replaceAll: true }],
      },
    });
    expect(res.isError ?? false).toBe(false);
    const out = structured<{ rewriteMode: string; preservedEdits: number }>(res);
    expect(out.rewriteMode).toBe('always');
    expect(out.preservedEdits).toBe(0);

    const read = await client.callTool({
      name: 'read_file',
      arguments: { project: 'p', path: 'main.tex' },
    });
    const resultContent = structured<{ content: string }>(read).content;
    expect(resultContent).toBe(`${PARAGRAPH_NEW}\nsomething else here.\n${PARAGRAPH_NEW}\n`);
    expect(resultContent).not.toContain('%');
  });

  it('oldString === newString still errors under preserveOriginal: true', async () => {
    const { client, userDir } = await setup();
    await writeFile(path.join(userDir, 'main.tex'), `${PARAGRAPH_OLD}\n`, 'utf8');
    await client.callTool({ name: 'register_project', arguments: { project: 'p', path: userDir } });

    const res = await client.callTool({
      name: 'edit_file',
      arguments: {
        project: 'p',
        path: 'main.tex',
        preserveOriginal: true,
        edits: [{ oldString: PARAGRAPH_OLD, newString: PARAGRAPH_OLD }],
      },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/identical/);
  });
});
