import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { quoteId } from '../../src/lib/projectId.js';
import {
  assertRegisteredRootExists,
  describeRootSource,
  detectRootFile,
  resolveRootFile,
} from '../../src/lib/rootFile.js';
import { FileService } from '../../src/services/fileService.js';

const DOC = '\\documentclass{article}\n\\begin{document}x\\end{document}\n';

describe('detectRootFile', () => {
  let dir: string;
  const files = new FileService();

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-rootfile-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function put(rel: string, content: string): Promise<void> {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }

  it('prefers a top-level main.tex over everything', async () => {
    await put('main.tex', 'no class here\n');
    await put('root.tex', DOC);
    expect(await detectRootFile(files, dir)).toBe('main.tex');
  });

  // The reported layout: a vendored template's main.tex in a subfolder (it \input's files one
  // level up, so it never compiles on its own) beside the real top-level root.
  it('prefers a top-level root with \\documentclass over a nested template main.tex', async () => {
    await put('cvpr-template/main.tex', DOC);
    await put('root.tex', DOC);
    await put('sections/intro.tex', 'Intro.\n');
    expect(await detectRootFile(files, dir)).toBe('root.tex');
  });

  it('takes a nested main.tex first among roots at the same depth', async () => {
    await put('paper/appendix.tex', DOC);
    await put('paper/main.tex', DOC);
    await put('notes.tex', 'just notes\n');
    expect(await detectRootFile(files, dir)).toBe('paper/main.tex');
  });

  it('prefers the shallowest \\documentclass', async () => {
    await put('a/b/deep.tex', DOC);
    await put('a/shallow.tex', DOC);
    expect(await detectRootFile(files, dir)).toBe('a/shallow.tex');
  });

  it('falls back to a nested main.tex, then the first .tex, when none has \\documentclass', async () => {
    await put('aaa.tex', 'x\n');
    await put('tpl/main.tex', 'y\n');
    expect(await detectRootFile(files, dir)).toBe('tpl/main.tex');
    await rm(path.join(dir, 'tpl'), { recursive: true });
    expect(await detectRootFile(files, dir)).toBe('aaa.tex');
  });

  it('throws when there is no .tex at all', async () => {
    await put('README.md', '# x\n');
    await expect(detectRootFile(files, dir)).rejects.toThrow(/No \.tex files/);
  });
});

describe('resolveRootFile', () => {
  let dir: string;
  const files = new FileService();

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-rootres-'));
    await writeFile(path.join(dir, 'main.tex'), DOC);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('takes the explicit root, then the registered one, then detection', async () => {
    expect(await resolveRootFile(files, dir, 'root.tex', 'other.tex')).toEqual({
      rootFile: 'other.tex',
      source: 'argument',
    });
    expect(await resolveRootFile(files, dir, 'root.tex')).toEqual({
      rootFile: 'root.tex',
      source: 'registered',
    });
    expect(await resolveRootFile(files, dir, undefined)).toEqual({
      rootFile: 'main.tex',
      source: 'detected',
    });
  });

  // A registered root is an assertion: used as given, not replaced by a guess when it is missing.
  it('does not second-guess a registered root that is not on disk', async () => {
    expect(await resolveRootFile(files, dir, 'missing.tex')).toEqual({
      rootFile: 'missing.tex',
      source: 'registered',
    });
  });
});

// A registered root is used as given (above), so a stale or mistyped one must fail in words that
// say where the root came from and how to get out — not as a latexmk FAILED with 0 errors, or a
// "No compiled PDF found" right after another root compiled.
describe('assertRegisteredRootExists', () => {
  let dir: string;
  const files = new FileService();

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ovl-rootreg-'));
    await writeFile(path.join(dir, 'main.tex'), DOC);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('refuses a registered root that is not in the project, naming it and the way out', async () => {
    const err = await assertRegisteredRootExists(files, dir, 'paper', {
      rootFile: 'gone.tex',
      source: 'registered',
    }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    const msg = err!.message;
    expect(msg).toContain('"gone.tex"');
    expect(msg).toContain('"paper"');
    expect(msg).toMatch(/registered/);
    expect(msg).toContain('register_project');
    expect(msg).toContain('WEB_LATEX_MCP_PROJECTS');
    expect(msg).toMatch(/rootFile/);
  });

  it('refuses a registered root that is a directory, not a file', async () => {
    await mkdir(path.join(dir, 'sub.tex'));
    await expect(
      assertRegisteredRootExists(files, dir, 'paper', {
        rootFile: 'sub.tex',
        source: 'registered',
      }),
    ).rejects.toThrow(/registered/);
  });

  it('accepts a registered root that is on disk', async () => {
    await expect(
      assertRegisteredRootExists(files, dir, 'paper', {
        rootFile: 'main.tex',
        source: 'registered',
      }),
    ).resolves.toBeUndefined();
  });

  // latexmk resolves an extensionless root as TeX does, by appending .tex.
  it('accepts an extensionless registered root whose .tex is on disk', async () => {
    await expect(
      assertRegisteredRootExists(files, dir, 'paper', { rootFile: 'main', source: 'registered' }),
    ).resolves.toBeUndefined();
  });

  async function refusal(rootFile: string): Promise<string> {
    const err = await assertRegisteredRootExists(files, dir, 'paper', {
      rootFile,
      source: 'registered',
    }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    return err!.message;
  }

  // The registered name is config-supplied text: it reaches the message only through quoteId,
  // never raw inside FileService's own `Not a file: "<path>"`.
  it.skipIf(process.platform === 'win32')(
    'escapes a registered root that is a directory, with no raw bidi override or newline',
    async () => {
      const name = 'a‮b\nFAKE LINE.tex';
      await mkdir(path.join(dir, name));
      const msg = await refusal(name);
      expect(msg).not.toContain('‮');
      expect(msg).not.toContain('\n');
      expect(msg).toContain('\\u{202E}');
      expect(msg).toContain('is not a file');
      expect(msg).not.toContain('Not a file');
    },
  );

  it('refuses a registered root outside the project with a fixed reason, not the inner message', async () => {
    const msg = await refusal('../x‮.tex');
    expect(msg).toContain('is outside the project or reached through a link out of it');
    expect(msg).not.toContain('Path escapes');
    expect(msg).not.toContain('‮');
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a registered root that is a link out of the project with the same fixed reason',
    async () => {
      const outside = await mkdtemp(path.join(os.tmpdir(), 'ovl-rootout-'));
      try {
        await writeFile(path.join(outside, 'secret.tex'), DOC);
        await symlink(path.join(outside, 'secret.tex'), path.join(dir, 'linked.tex'));
        const msg = await refusal('linked.tex');
        expect(msg).toContain('is outside the project or reached through a link out of it');
        expect(msg).not.toContain('Path escapes');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    },
  );

  // latexmk's find_basename looks for `<root>.tex` first, whatever the name's extension, and uses
  // the name as given only when that is not a file — so `paper.v2` is built as `paper.v2.tex`.
  it('accepts a dotted extensionless root whose .tex is on disk', async () => {
    await writeFile(path.join(dir, 'paper.v2.tex'), DOC);
    await expect(
      assertRegisteredRootExists(files, dir, 'paper', {
        rootFile: 'paper.v2',
        source: 'registered',
      }),
    ).resolves.toBeUndefined();
  });

  it('accepts a root whose bare name is a directory when its .tex is on disk', async () => {
    await mkdir(path.join(dir, 'paper'));
    await writeFile(path.join(dir, 'paper.tex'), DOC);
    await expect(
      assertRegisteredRootExists(files, dir, 'paper', { rootFile: 'paper', source: 'registered' }),
    ).resolves.toBeUndefined();
  });

  // `<root>.tex` is what latexmk compiles whenever it is a file, even beside a usable `<root>`: a
  // link out there is the file that would be built, so it is refused by that name.
  it.skipIf(process.platform === 'win32')(
    'refuses <root>.tex reached through a link out, even beside a usable <root>',
    async () => {
      const outside = await mkdtemp(path.join(os.tmpdir(), 'ovl-rootout-'));
      try {
        await writeFile(path.join(outside, 'secret.tex'), DOC);
        await writeFile(path.join(dir, 'paper'), DOC);
        await symlink(path.join(outside, 'secret.tex'), path.join(dir, 'paper.tex'));
        const msg = await refusal('paper');
        expect(msg).toContain(
          'root file "paper.tex" is outside the project or reached through a link out of it',
        );
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'names <root>.tex, not a missing <root>, when <root>.tex is a link out',
    async () => {
      const outside = await mkdtemp(path.join(os.tmpdir(), 'ovl-rootout-'));
      try {
        await writeFile(path.join(outside, 'secret.tex'), DOC);
        await symlink(path.join(outside, 'secret.tex'), path.join(dir, 'paper.tex'));
        const msg = await refusal('paper');
        expect(msg).toContain(
          'root file "paper.tex" is outside the project or reached through a link out of it',
        );
        expect(msg).not.toContain('does not exist');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    },
  );

  // An absolute registered root is refused for its spelling, before any lookup: resolveInside's
  // "must be relative" error used to be read as `outside`, so a root INSIDE the project (an env
  // `"rootFile": "/home/u/paper/main.tex"`) was called outside it, with no fix offered.
  it('refuses an absolute registered root inside the project, giving its relative spelling', async () => {
    const msg = await refusal(path.join(dir, 'main.tex'));
    expect(msg).toContain('is an absolute path');
    expect(msg).toContain(`register it as rootFile: ${quoteId('main.tex')}`);
    expect(msg).not.toContain('outside the project');
    expect(msg).not.toContain('Path must be relative');
  });

  it('refuses an absolute registered root outside the project as absolute, offering no spelling', async () => {
    const abs = path.resolve(dir, '..', 'x.tex');
    const msg = await refusal(abs);
    expect(msg).toContain(`root file ${quoteId(abs)} is an absolute path`);
    expect(msg).not.toContain('register it as rootFile');
    expect(msg).not.toContain('cannot be read');
    expect(msg).not.toContain('Path must be relative');
  });

  // A `..` segment that stays inside the project is still looked up (the overlay compile refuses it
  // on its own terms): only an absolute or drive-prefixed spelling is refused before the lookup.
  it('accepts a registered root with a ".." segment that stays inside the project', async () => {
    await expect(
      assertRegisteredRootExists(files, dir, 'paper', {
        rootFile: 'sub/../main.tex',
        source: 'registered',
      }),
    ).resolves.toBeUndefined();
  });

  // `<root>.tex` of a root that leaves the project is never looked at: the refusal names the root
  // the user registered, not a `<root>.tex.tex` they never wrote.
  it('names a climbing registered root as registered, not with .tex appended', async () => {
    const msg = await refusal('../x.tex');
    expect(msg).toContain('root file "../x.tex" is outside the project');
    expect(msg).not.toContain('x.tex.tex');
  });

  it('names an absolute registered root as registered, not with .tex appended', async () => {
    const abs = path.resolve(dir, '..', 'x.tex');
    const msg = await refusal(abs);
    expect(msg).toContain(`root file ${quoteId(abs)} is an absolute path`);
    expect(msg).not.toContain('x.tex.tex');
  });

  // Nothing outside the sandbox is stat-ed: a REGULAR `<outside>/x.tex` beside a registered
  // `../<outside>/x` is never looked at, so the root is refused under the name it was registered
  // with — a stat there would refuse it as "x.tex", disclosing that the outside file exists.
  describe('a regular <root>.tex outside the project', () => {
    let outside: string;
    beforeEach(async () => {
      outside = await mkdtemp(path.join(os.tmpdir(), 'ovl-rootout-'));
      await writeFile(path.join(outside, 'x.tex'), DOC);
    });
    afterEach(async () => {
      await rm(outside, { recursive: true, force: true });
    });

    it('is not stat-ed for a climbing root', async () => {
      const climbing = `../${path.basename(outside)}/x`;
      const msg = await refusal(climbing);
      expect(msg).toContain(`root file ${quoteId(climbing)} is outside the project`);
      expect(msg).not.toContain('x.tex');
    });

    it('is not stat-ed for an absolute root', async () => {
      const abs = path.join(outside, 'x');
      const msg = await refusal(abs);
      expect(msg).toContain(`root file ${quoteId(abs)} is an absolute path`);
      expect(msg).not.toContain('x.tex');
    });
  });

  // latexmk's `-f "$given_name.tex"` follows links: a `paper.tex` that is a regular file it cannot
  // read is still the file it builds, so it is refused by that name.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses an unreadable regular <root>.tex beside a usable <root>',
    async () => {
      await writeFile(path.join(dir, 'paper'), DOC);
      await writeFile(path.join(dir, 'paper.tex'), DOC);
      await chmod(path.join(dir, 'paper.tex'), 0o000);
      try {
        const msg = await refusal('paper');
        expect(msg).toContain('root file "paper.tex" cannot be read');
      } finally {
        await chmod(path.join(dir, 'paper.tex'), 0o644);
      }
    },
  );

  // Where `-f "paper.tex"` is false — a dangling link, a link loop — latexmk builds `paper`, so a
  // usable `paper` is accepted rather than refused under a name latexmk never compiles.
  it.skipIf(process.platform === 'win32')(
    'accepts <root> when <root>.tex is a dangling link out of the project',
    async () => {
      const outside = await mkdtemp(path.join(os.tmpdir(), 'ovl-rootout-'));
      try {
        await writeFile(path.join(dir, 'paper'), DOC);
        await symlink(path.join(outside, 'missing.tex'), path.join(dir, 'paper.tex'));
        await expect(
          assertRegisteredRootExists(files, dir, 'paper', {
            rootFile: 'paper',
            source: 'registered',
          }),
        ).resolves.toBeUndefined();
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'accepts <root> when <root>.tex is a link to itself',
    async () => {
      await writeFile(path.join(dir, 'paper'), DOC);
      await symlink('paper.tex', path.join(dir, 'paper.tex'));
      await expect(
        assertRegisteredRootExists(files, dir, 'paper', {
          rootFile: 'paper',
          source: 'registered',
        }),
      ).resolves.toBeUndefined();
    },
  );

  // A link into a directory nobody can search: `-f` cannot stat it, so latexmk builds `paper`.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'accepts <root> when <root>.tex cannot be stat-ed through a locked directory',
    async () => {
      await writeFile(path.join(dir, 'paper'), DOC);
      await mkdir(path.join(dir, 'locked'));
      await writeFile(path.join(dir, 'locked', 'x.tex'), DOC);
      await symlink(path.join('locked', 'x.tex'), path.join(dir, 'paper.tex'));
      await chmod(path.join(dir, 'locked'), 0o000);
      try {
        await expect(
          assertRegisteredRootExists(files, dir, 'paper', {
            rootFile: 'paper',
            source: 'registered',
          }),
        ).resolves.toBeUndefined();
      } finally {
        await chmod(path.join(dir, 'locked'), 0o755);
      }
    },
  );

  // 252 characters is a legal name; with `.tex` it passes the 255-byte limit, so `-f` is false.
  it.skipIf(process.platform === 'win32')(
    'accepts <root> when <root>.tex would be a name too long to exist',
    async () => {
      const name = 'p'.repeat(252);
      await writeFile(path.join(dir, name), DOC);
      await expect(
        assertRegisteredRootExists(files, dir, 'paper', { rootFile: name, source: 'registered' }),
      ).resolves.toBeUndefined();
    },
  );

  // latexmk tries `Main.TEX.tex` before `Main.TEX`: a `.tex`-looking name is no exception.
  it('accepts a root whose name ends in .TEX when only <root>.tex is on disk', async () => {
    await writeFile(path.join(dir, 'Main.TEX.tex'), DOC);
    await expect(
      assertRegisteredRootExists(files, dir, 'paper', {
        rootFile: 'Main.TEX',
        source: 'registered',
      }),
    ).resolves.toBeUndefined();
  });

  // `<root>.tex` that is not a regular file is not what latexmk builds: it falls through to the
  // name as given.
  it('accepts <root> as given when <root>.tex is a directory', async () => {
    await mkdir(path.join(dir, 'paper.tex'));
    await writeFile(path.join(dir, 'paper'), DOC);
    await expect(
      assertRegisteredRootExists(files, dir, 'paper', { rootFile: 'paper', source: 'registered' }),
    ).resolves.toBeUndefined();
  });

  it('reports the reason for the name as registered when no candidate is usable', async () => {
    await mkdir(path.join(dir, 'paper'));
    expect(await refusal('paper')).toContain('"paper" is not a file');
    expect(await refusal('nothing')).toContain('"nothing" does not exist');
  });

  it('says to name the directory and to repeat the other registration settings', async () => {
    const msg = await refusal('gone.tex');
    expect(msg).toMatch(/path.{0,40}directory/);
    for (const field of ['branch', 'username', 'tokenEnv', 'followSymlinks']) {
      expect(msg).toContain(field);
    }
  });

  it('leaves an explicit root alone, even a missing one', async () => {
    await expect(
      assertRegisteredRootExists(files, dir, 'paper', { rootFile: 'gone.tex', source: 'argument' }),
    ).resolves.toBeUndefined();
  });

  it('leaves a detected root alone', async () => {
    await expect(
      assertRegisteredRootExists(files, dir, 'paper', { rootFile: 'gone.tex', source: 'detected' }),
    ).resolves.toBeUndefined();
  });
});

describe('describeRootSource', () => {
  it('names a root the caller did not name, and where it came from', () => {
    expect(describeRootSource({ rootFile: 'paper.tex', source: 'registered' })).toBe(
      ' for root "paper.tex" (the project\'s registered rootFile)',
    );
    expect(describeRootSource({ rootFile: 'main.tex', source: 'detected' })).toBe(
      ' for root "main.tex" (auto-detected)',
    );
    expect(describeRootSource({ rootFile: 'x.tex', source: 'argument' })).toBe('');
  });
});
