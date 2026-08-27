import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, mkdir, writeFile, stat } from 'node:fs/promises';
import { RewriteModeStore } from '../../src/services/rewriteModeStore.js';
import { rewriteModePath, sessionStateDir } from '../../src/lib/sessionPaths.js';

describe('RewriteModeStore', () => {
  let workspace: string;
  let store: RewriteModeStore;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-rewritemode-'));
    store = new RewriteModeStore(workspace);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('returns null when nothing is stored for a project', async () => {
    expect(await store.get('unknown-project')).toBeNull();
  });

  it('round-trips a stored mode', async () => {
    await store.set('paper', 'always');
    expect(await store.get('paper')).toBe('always');

    await store.set('paper', 'off');
    expect(await store.get('paper')).toBe('off');
  });

  it('isolates state per project', async () => {
    await store.set('paper-a', 'always');
    await store.set('paper-b', 'off');

    expect(await store.get('paper-a')).toBe('always');
    expect(await store.get('paper-b')).toBe('off');
    expect(await store.get('paper-c')).toBeNull();
  });

  it('resolves a malformed JSON file to null without throwing', async () => {
    const file = rewriteModePath(workspace, 'broken');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, '{ not valid json', 'utf8');

    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(store.get('broken')).resolves.toBeNull();
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });

  it('resolves a well-formed file holding an unknown mode string to null', async () => {
    const file = rewriteModePath(workspace, 'weird');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ mode: 'sometimes' }), 'utf8');

    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(store.get('weird')).resolves.toBeNull();
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });

  it.each([
    // Only 'null' is a real regression case: a plain `JSON.parse` of the literal `null` passes
    // any naive `typeof x === 'object'` check (`typeof null === 'object'`), so a store that
    // didn't explicitly reject `null` would try to read a `.mode` property off it — the other
    // three (a number, a bare string, an array) already failed that same shape check before this
    // test existed, and are kept here for breadth, not because they ever broke.
    ['null', 'null'],
    ['a number', '123'],
    ['a bare string', JSON.stringify('off')],
    ['an array', JSON.stringify([])],
  ])('resolves a well-formed JSON file holding %s to null without throwing', async (_desc, raw) => {
    const file = rewriteModePath(workspace, 'non-object');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, raw, 'utf8');

    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(store.get('non-object')).resolves.toBeNull();
    expect(stderr).toHaveBeenCalled();
    stderr.mockRestore();
  });

  it('stores an object with a mode field, not a bare string', async () => {
    await store.set('paper', 'prose');
    const raw = await import('node:fs/promises').then((fs) =>
      fs.readFile(rewriteModePath(workspace, 'paper'), 'utf8'),
    );
    expect(JSON.parse(raw)).toEqual({ mode: 'prose' });
  });

  it('lands the state file under <workspaceRoot>/.sessions/<projectId>/, never inside a clone', async () => {
    // Simulate a clone directory sitting next to the sessions state, the way ProjectManager
    // lays out a real workspace, and assert the store never touches it.
    const cloneDir = path.join(workspace, 'paper');
    await mkdir(cloneDir, { recursive: true });
    await writeFile(path.join(cloneDir, 'main.tex'), '\\documentclass{article}', 'utf8');

    await store.set('paper', 'always');

    const file = rewriteModePath(workspace, 'paper');
    expect(file).toBe(path.join(sessionStateDir(workspace, 'paper'), 'rewrite-mode.json'));
    expect(path.dirname(file)).not.toBe(cloneDir);

    // The clone directory holds exactly what we put there — nothing the store wrote landed inside it.
    const cloneEntries = await import('node:fs/promises').then((fs) => fs.readdir(cloneDir));
    expect(cloneEntries).toEqual(['main.tex']);

    // The state file genuinely exists under .sessions/.
    await expect(stat(file)).resolves.toBeDefined();
    expect(file.includes(`${path.sep}.sessions${path.sep}`)).toBe(true);
  });
});
