import { describe, expect, it } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { planEditDiff, LONG_LINE_CHARS } from '../../src/lib/editDiff.js';
import { CHANGE_DIFF_BUDGET } from '../../src/lib/diffBudget.js';
import { applyCompileDefaults } from '../../src/lib/compileDefaults.js';
import { CompileDefaultsStore } from '../../src/services/compileDefaultsStore.js';
import {
  assertCompileRequested,
  summarizeCompile,
  SUMMARY_MAX_ERRORS,
} from '../../src/lib/compileSummary.js';
import { otherRegistryHint } from '../../src/lib/otherRegistry.js';
import { TectonicCompiler } from '../../src/services/compiler.js';
import type { ExecResult } from '../../src/lib/exec.js';

describe('planEditDiff: the confirmation diff of one edit_file call', () => {
  it('shows only what this call changed, with two lines of context', () => {
    const before = 'a\nb\nc\nd\ne\nf\ng\nh\n';
    const after = 'a\nb\nc\nD\ne\nf\ng\nh\n';
    const { diff, truncated, condensed } = planEditDiff(before, after, 'main.tex');
    expect(truncated).toBe(false);
    expect(condensed).toBe(false);
    expect(diff).toBe(
      'diff --git a/main.tex b/main.tex\n--- a/main.tex\n+++ b/main.tex\n' +
        '@@ -2,5 +2,5 @@\n b\n c\n-d\n+D\n e\n f\n',
    );
  });

  it('splits distant changes into separate hunks', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `l${i}\n`);
    const after = [...lines];
    after[3] = 'X\n';
    after[25] = 'Y\n';
    const { diff } = planEditDiff(lines.join(''), after.join(''), 'f.tex');
    expect(diff.match(/^@@ /gm)).toHaveLength(2);
    expect(diff).toContain('-l3\n+X\n');
    expect(diff).toContain('-l25\n+Y\n');
  });

  it('cuts a paragraph-long line around the change instead of omitting the hunk (#4)', () => {
    const para = 'Lorem ipsum dolor sit amet, '.repeat(80);
    const before = `\\section{A}\n\n${para}the old word. ${para}\n`;
    const after = before.replace('the old word', 'the new word');
    const { diff, truncated, condensed } = planEditDiff(before, after, 'main.tex');
    expect(truncated).toBe(false);
    expect(condensed).toBe(true);
    expect(diff).toContain('the old word');
    expect(diff).toContain('the new word');
    expect(diff).toMatch(/…\[\d+ chars\]…/);
    expect(diff.length).toBeLessThan(CHANGE_DIFF_BUDGET / 2);
  });

  it('cuts a long unpaired line to its head', () => {
    const long = 'x'.repeat(LONG_LINE_CHARS * 3);
    const { diff, condensed } = planEditDiff('a\n', `a\n${long}\n`, 'f.tex');
    expect(condensed).toBe(true);
    expect(diff).toContain(`+${'x'.repeat(LONG_LINE_CHARS)}…[${LONG_LINE_CHARS * 2} chars]…`);
  });

  it('marks a missing final newline and is empty for no change', () => {
    expect(planEditDiff('a\n', 'a\n', 'f').diff).toBe('');
    expect(planEditDiff('a\nb', 'a\nc', 'f').diff).toContain(
      '-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n',
    );
  });

  it('does not repeat earlier changes to the file (only before → after)', () => {
    // `before` already differs from any HEAD; only the new change is reported.
    const { diff } = planEditDiff('edited earlier\nx\n', 'edited earlier\ny\n', 'f');
    expect(diff).not.toContain('+edited earlier');
    expect(diff).toContain('-x\n+y\n');
  });
});

describe('compile defaults', () => {
  it('fills only the fields the call left out, and names them', () => {
    const { args, applied } = applyCompileDefaults(
      { project: 'p', timeoutSec: 30 } as {
        project: string;
        timeoutSec?: number;
        compiler?: 'latexmk' | 'tectonic';
      },
      { compiler: 'tectonic', timeoutSec: 600 },
    );
    expect(args).toEqual({ project: 'p', timeoutSec: 30, compiler: 'tectonic' });
    expect(applied).toEqual(['compiler']);
    expect(applyCompileDefaults({ timeoutSec: 5 }, null)).toEqual({
      args: { timeoutSec: 5 },
      applied: [],
    });
  });

  it('stores, reads back, ignores an invalid file and clears', async () => {
    const ws = await mkdtemp(path.join(os.tmpdir(), 'wlm-defaults-'));
    try {
      const store = new CompileDefaultsStore(ws);
      expect(await store.get('p')).toBeNull();
      await store.set('p', { compiler: 'tectonic', timeoutSec: 600 });
      expect(await store.get('p')).toEqual({ compiler: 'tectonic', timeoutSec: 600 });
      const file = path.join(ws, '.sessions', 'p', 'compile-defaults.json');
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
        compiler: 'tectonic',
        timeoutSec: 600,
      });
      await writeFile(file, JSON.stringify({ compiler: 'pdflatex' }));
      expect(await store.get('p')).toBeNull();
      await store.clear('p');
      expect(await store.get('p')).toBeNull();
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });
});

describe('compile summary for the write tools', () => {
  it('keeps the first errors, counts the rest, and cuts long messages', () => {
    const errors = Array.from({ length: 8 }, (_, i) => ({
      severity: 'error',
      file: 'main.tex',
      line: i + 1,
      message: i === 0 ? 'm'.repeat(500) : `err ${i}`,
    }));
    const { summary, text } = summarizeCompile({
      content: [{ type: 'text', text: 'FAILED main.tex with latexmk in 1.0s — 8 error(s)\nmore' }],
      structuredContent: {
        success: false,
        compiler: 'latexmk',
        errors,
        warnings: [{}, {}],
        errorsOmittedByCap: 2,
        resolvedComments: 0,
      },
    });
    expect(summary.errorCount).toBe(10);
    expect(summary.warningCount).toBe(2);
    expect(summary.errors).toHaveLength(SUMMARY_MAX_ERRORS);
    expect(summary.errors[0]!.message.length).toBeLessThanOrEqual(201);
    expect(text.split('\n')[0]).toBe('FAILED main.tex with latexmk in 1.0s — 8 error(s)');
    expect(text).toContain('main.tex:2: err 1');
    expect(text).toContain('… 5 more error(s)');
    expect(text).toContain('resolved 0 comment(s)');
  });

  it('reports a compile that could not run without failing the write', () => {
    const { summary, text } = summarizeCompile({
      isError: true,
      content: [{ type: 'text', text: 'Error: latexmk is not installed' }],
    });
    expect(summary.success).toBe(false);
    expect(summary.failure).toContain('latexmk is not installed');
    expect(text).toMatch(/^compile did not run/);
  });

  it('refuses resolveComments without compile: true', () => {
    expect(() => assertCompileRequested(undefined, ['c1'])).toThrow(/needs compile: true/);
    expect(() => assertCompileRequested(true, ['c1'])).not.toThrow();
    expect(() => assertCompileRequested(undefined, undefined)).not.toThrow();
  });
});

describe('unknown project: the other registry is named (#6)', () => {
  it('suggests the registration found in the home registry, credential redacted', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'wlm-home-'));
    const local = await mkdtemp(path.join(os.tmpdir(), 'wlm-local-'));
    try {
      await mkdir(home, { recursive: true });
      await writeFile(
        path.join(home, 'registry.json'),
        JSON.stringify({
          argus: { gitUrl: 'https://user:s3cret@git.example.com/argus.git' },
          notes: { mode: 'local', path: '/data/notes' },
        }),
      );
      const hint = otherRegistryHint('argus', local, home);
      expect(hint).toContain('register_project');
      expect(hint).toContain('git.example.com/argus.git');
      expect(hint).not.toContain('s3cret');
      expect(hint).toContain('WEB_LATEX_MCP_WORKSPACE');
      expect(otherRegistryHint('notes', local, home)).toContain('path "/data/notes"');
      expect(otherRegistryHint('missing', local, home)).toBe('');
      // A server already on the home workspace has nothing else to look in.
      expect(otherRegistryHint('argus', home, home)).toBe('');
    } finally {
      await rm(home, { recursive: true, force: true });
      await rm(local, { recursive: true, force: true });
    }
  });
});

describe('tectonic writes SyncTeX (#3)', () => {
  it('passes --synctex so viewer comments map back to source', async () => {
    const project = await mkdtemp(path.join(os.tmpdir(), 'wlm-tect-'));
    try {
      await writeFile(path.join(project, 'main.tex'), '\\documentclass{article}\n');
      let seen: string[] = [];
      const run = async (_cmd: string, args: string[]): Promise<ExecResult> => {
        seen = args;
        return { code: 0, stdout: '', stderr: '', timedOut: false };
      };
      await new TectonicCompiler(run).compile({ projectDir: project, rootFile: 'main.tex' });
      expect(seen).toContain('--synctex');
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});
