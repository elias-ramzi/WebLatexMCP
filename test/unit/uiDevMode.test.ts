import { describe, expect, it, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import {
  CHILD_ENV,
  DevReloader,
  devSystemPrompt,
  ERROR_ENV,
  findDevRepo,
  liveStep,
  RELOAD_EXIT,
  sourceRev,
  superviseUi,
  TOKEN_ENV,
  WATCH_ENV,
} from '../../src/ui/devMode.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'wlm-dev-'));
  dirs.push(d);
  return d;
}

async function checkout(dir: string, name = 'web-latex-mcp'): Promise<string> {
  await mkdir(path.join(dir, '.git'), { recursive: true });
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }));
  return dir;
}

/** A build: dist/index.js and the page, as the dev build lays them out. */
async function build(dir: string): Promise<string> {
  await mkdir(path.join(dir, 'dist', 'ui'), { recursive: true });
  await mkdir(path.join(dir, 'ui', 'js'), { recursive: true });
  await writeFile(path.join(dir, 'dist', 'index.js'), '');
  await writeFile(path.join(dir, 'ui', 'js', 'app.js'), '');
  return path.join(dir, 'dist', 'index.js');
}

describe('findDevRepo', () => {
  it('finds the checkout the UI runs from, else the one it was started in', async () => {
    const repo = await checkout(await tmp());
    const env = {};
    expect(findDevRepo({ env, cwd: '/', root: repo })).toEqual({ repo });
    const elsewhere = await tmp();
    await mkdir(path.join(repo, 'src', 'ui'), { recursive: true });
    expect(findDevRepo({ env, cwd: path.join(repo, 'src', 'ui'), root: elsewhere })).toEqual({
      repo,
    });
  });

  it('says so when a named folder is no checkout of WebLatexMCP, and when none is found', async () => {
    const other = await checkout(await tmp(), 'something-else');
    const r = findDevRepo({ given: other, env: {}, cwd: '/', root: await tmp() });
    expect(r.repo).toBeUndefined();
    expect(r.problem).toMatch(/not a git checkout of WebLatexMCP/);
    const fromEnv = findDevRepo({
      env: { WEB_LATEX_MCP_DEV_REPO: other },
      cwd: '/',
      root: await tmp(),
    });
    expect(fromEnv.problem).toMatch(/not a git checkout/);
    const none = findDevRepo({ env: {}, cwd: await tmp(), root: await tmp() });
    expect(none.problem).toMatch(/--repo/);
  });
});

describe('the dev brief', () => {
  it('rebuilds a checkout the UI runs from, and says what to do with another build', async () => {
    const repo = await checkout(await tmp());
    expect(liveStep(repo, repo, { PATH: '' })).toMatch(/npm --prefix .* run build/);
    expect(liveStep(repo, await tmp(), { PATH: '' })).toMatch(/cannot update by itself/);
    const bin = await tmp();
    await writeFile(path.join(bin, 'web-latex-mcp-dev-update'), '');
    expect(liveStep(repo, await tmp(), { PATH: bin })).toMatch(/web-latex-mcp-dev-update/);
    const brief = devSystemPrompt(repo, 'LIVE STEP.');
    expect(brief).toContain(repo);
    expect(brief).toContain('LIVE STEP.');
    expect(brief).toMatch(/worktree/);
    expect(brief).toMatch(/pull request into dev/);
    expect(brief).toMatch(/never force-push/i);
  });
});

describe('sourceRev', () => {
  it('changes when a page file changes', async () => {
    const entry = await build(await tmp());
    const before = sourceRev(entry);
    expect(sourceRev(entry)).toBe(before);
    const later = new Date(Date.now() + 5000);
    await utimes(path.join(path.dirname(entry), '..', 'ui', 'js', 'app.js'), later, later);
    expect(sourceRev(entry)).not.toBe(before);
  });

  it.skipIf(process.platform === 'win32')(
    'changes when the link it was started through moves',
    async () => {
      const base = await tmp();
      await build(path.join(base, 'a'));
      await build(path.join(base, 'b'));
      const current = path.join(base, 'current');
      await symlink(path.join(base, 'a'), current);
      const entry = path.join(current, 'dist', 'index.js');
      const before = sourceRev(entry);
      await unlink(current);
      await symlink(path.join(base, 'b'), current);
      expect(sourceRev(entry)).not.toBe(before);
    },
  );
});

describe('DevReloader', () => {
  it('reloads once a change reads the same twice, and only when no chat is working', () => {
    let rev = 'r1';
    let busy = false;
    let reloads = 0;
    const r = new DevReloader(
      'entry',
      () => busy,
      () => reloads++,
      1000,
      () => rev,
    );
    r.check();
    expect(r.pending).toBe(false);
    rev = 'r2';
    r.check(); // seen once: a build may still be writing
    expect(r.pending).toBe(false);
    busy = true;
    r.check();
    expect(r.pending).toBe(true);
    expect(reloads).toBe(0);
    r.check();
    expect(reloads).toBe(0);
    busy = false;
    r.check();
    expect(reloads).toBe(1);
  });
});

class FakeChild extends EventEmitter {
  stderr = new EventEmitter();
  killed: string[] = [];
  constructor(
    readonly script: string,
    readonly args: string[],
    readonly env: NodeJS.ProcessEnv,
  ) {
    super();
  }
  kill(sig: string): boolean {
    this.killed.push(sig);
    queueMicrotask(() => this.emit('exit', 0, null));
    return true;
  }
  ready(port: number): void {
    this.emit('message', { ready: port });
  }
  exit(code: number): void {
    this.emit('exit', code, null);
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await tick();
  }
  throw new Error('timed out waiting');
}

describe('superviseUi', () => {
  it('starts the UI again on a reload, on its port with its token, without reopening the page', async () => {
    const children: FakeChild[] = [];
    const io = { env: { PATH: '/bin' }, out: () => undefined, err: () => undefined };
    let stop = (): void => undefined;
    const done = superviseUi(
      {
        entry: '/no/such/entry.js',
        args: ['--port', '0', '--to', 'ws'],
        open: true,
        spawnChild: (script, args, env) => {
          const c = new FakeChild(script, args, env);
          children.push(c);
          return c as unknown as ChildProcess;
        },
        onStop: (s) => (stop = s),
      },
      io,
    );
    await until(() => children.length === 1);
    const first = children[0] as FakeChild;
    expect(first.args).toEqual(['ui', '--to', 'ws', '--port', '0', '--open']);
    expect(first.env[CHILD_ENV]).toBe('1');
    expect(first.env[WATCH_ENV]).toBe('/no/such/entry.js');
    const token = first.env[TOKEN_ENV];
    expect(token).toMatch(/^[\w-]{20,}$/);
    first.ready(4321);
    first.exit(RELOAD_EXIT);
    await until(() => children.length === 2);
    const second = children[1] as FakeChild;
    expect(second.args).toEqual(['ui', '--to', 'ws', '--port', '4321', '--no-open']);
    expect(second.env[TOKEN_ENV]).toBe(token);
    second.ready(4321);
    stop();
    expect(await done).toBe(0);
    expect(second.killed).toEqual(['SIGTERM']);
  });

  it.skipIf(process.platform === 'win32')(
    'goes back to the build before when a new one does not start, and says why',
    async () => {
      const base = await tmp();
      await build(path.join(base, 'a'));
      await build(path.join(base, 'b'));
      const current = path.join(base, 'current');
      await symlink(path.join(base, 'a'), current);
      const entry = path.join(current, 'dist', 'index.js');
      const children: FakeChild[] = [];
      let stop = (): void => undefined;
      const done = superviseUi(
        {
          entry,
          args: [],
          open: false,
          spawnChild: (script, args, env) => {
            const c = new FakeChild(script, args, env);
            children.push(c);
            return c as unknown as ChildProcess;
          },
          onStop: (s) => (stop = s),
        },
        { env: {}, out: () => undefined, err: () => undefined },
      );
      await until(() => children.length === 1);
      (children[0] as FakeChild).ready(5000);
      await unlink(current);
      await symlink(path.join(base, 'b'), current);
      (children[0] as FakeChild).exit(RELOAD_EXIT);
      await until(() => children.length === 2);
      const broken = children[1] as FakeChild;
      expect(broken.script).toBe(entry);
      broken.stderr.emit('data', Buffer.from('SyntaxError: Unexpected token\n'));
      broken.exit(1);
      await until(() => children.length === 3);
      const back = children[2] as FakeChild;
      expect(back.script).toMatch(/[\\/]a[\\/]dist[\\/]index\.js$/);
      expect(back.env[ERROR_ENV]).toMatch(/did not start.*SyntaxError/s);
      expect(back.env[WATCH_ENV]).toBe(entry);
      back.ready(5000);
      // a fixed build: the next reload runs the link's target again, with no error
      back.exit(RELOAD_EXIT);
      await until(() => children.length === 4);
      const fixed = children[3] as FakeChild;
      expect(fixed.script).toBe(entry);
      expect(fixed.env[ERROR_ENV]).toBeUndefined();
      fixed.ready(5000);
      stop();
      expect(await done).toBe(0);
    },
  );

  it('gives up on a UI that keeps stopping, and ends with a first start that fails', async () => {
    const children: FakeChild[] = [];
    const spawnChild = (script: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess => {
      const c = new FakeChild(script, args, env);
      children.push(c);
      return c as unknown as ChildProcess;
    };
    const io = { env: {}, out: () => undefined, err: () => undefined };
    const failing = superviseUi(
      { entry: '/e.js', args: [], open: false, spawnChild, onStop: () => {} },
      io,
    );
    await until(() => children.length === 1);
    (children[0] as FakeChild).exit(3);
    expect(await failing).toBe(3);

    children.length = 0;
    const crashing = superviseUi(
      { entry: '/e.js', args: [], open: false, spawnChild, onStop: () => {} },
      io,
    );
    for (let i = 0; i < 4; i++) {
      await until(() => children.length === i + 1);
      (children[i] as FakeChild).ready(1);
      (children[i] as FakeChild).exit(9);
    }
    expect(await crashing).toBe(9);
  });
});
