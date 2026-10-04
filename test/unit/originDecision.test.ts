import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  decideOrigin,
  localPathKind,
  originNote,
  originValueToWrite,
  parseOriginRecord,
  originRefusalMessage,
  pendingOriginNote,
  unownedOriginNote,
  withOriginNote,
  type OriginState,
} from '../../src/lib/originRepoint.js';
import { quoteId } from '../../src/lib/projectId.js';
import { errorResult } from '../../src/lib/errors.js';

/**
 * `decideOrigin` is the ownership rule: `origin` is rewritten only while it is still exactly what
 * the server last wrote (its record), and never on a guess about which URLs name one repository.
 * Every branch, plus the messages built from it.
 */

const A = 'https://git.example/o/a.git';
const B = 'https://git.example/o/b.git';
const SECRET = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const count = (text: string, needle: string): number => text.split(needle).length - 1;

function state(over: Partial<OriginState>): OriginState {
  const originUrls = over.originUrls ?? [A];
  return {
    originUrls,
    localOriginUrls: over.localOriginUrls ?? originUrls,
    record: over.record,
    heldStripped: over.heldStripped ?? A,
    heldCarriesToken: over.heldCarriesToken ?? false,
    ...(over.realpath ? { realpath: over.realpath } : {}),
  };
}

describe('decideOrigin', () => {
  describe('more than one origin URL (a push mirror) is a hand configuration the server never owns', () => {
    const mirror = 'https://mirror.example/o/a.git';

    it('leaves it unchanged, writing no record, when the first URL is the held one', () => {
      expect(decideOrigin(state({ originUrls: [A, mirror] }))).toEqual({
        kind: 'unchanged',
        writeRecord: false,
      });
      expect(
        decideOrigin(state({ originUrls: [A, mirror], record: { heldUrl: A, originUrl: A } })),
      ).toEqual({ kind: 'unchanged', writeRecord: false });
    });

    it('is unowned when the first URL differs and the registration has not changed', () => {
      expect(decideOrigin(state({ originUrls: [B, mirror] }))).toEqual({ kind: 'unowned' });
      expect(
        decideOrigin(state({ originUrls: [B, mirror], record: { heldUrl: A, originUrl: B } })),
      ).toEqual({ kind: 'unowned' });
    });

    it('refuses only when the registration changed, so a write would be needed', () => {
      expect(
        decideOrigin(
          state({ originUrls: [A, mirror], record: { heldUrl: A, originUrl: A }, heldStripped: B }),
        ),
      ).toEqual({ kind: 'refuse', reason: 'multiple' });
    });
  });

  it('adds a missing origin — unless the held URL carries a token', () => {
    expect(decideOrigin(state({ originUrls: [] }))).toEqual({ kind: 'add', value: A });
    expect(decideOrigin(state({ originUrls: [], record: { heldUrl: B, originUrl: B } }))).toEqual({
      kind: 'add',
      value: A,
    });
    expect(decideOrigin(state({ originUrls: [], heldCarriesToken: true }))).toEqual({
      kind: 'refuse',
      reason: 'token',
    });
  });

  describe('no record', () => {
    it('adopts an origin equal to the held URL', () => {
      expect(decideOrigin(state({}))).toEqual({ kind: 'unchanged', writeRecord: true });
    });

    it('judges local paths by realpath when one is supplied (git records $PWD, Node the real cwd)', () => {
      // Separator-agnostic: on Windows both sides arrive resolved, as `D:\link\r.git`.
      const realpath = (p: string) => p.replace(/([\\/])link([\\/])/, '$1real$2');
      expect(
        decideOrigin(state({ originUrls: ['/link/r.git'], heldStripped: '/real/r.git', realpath })),
      ).toEqual({ kind: 'unchanged', writeRecord: true });
      expect(
        decideOrigin(
          state({
            originUrls: ['/link/r.git'],
            heldStripped: '/real/r.git',
            realpath: () => undefined,
          }),
        ),
      ).toEqual({ kind: 'unowned' });
      expect(
        decideOrigin(state({ originUrls: ['/link/r.git'], heldStripped: '/real/r.git' })),
      ).toEqual({ kind: 'unowned' });
      // Never for a URL.
      expect(
        decideOrigin(
          state({
            originUrls: ['https://h/link/r.git'],
            heldStripped: 'https://h/real/r.git',
            realpath,
          }),
        ),
      ).toEqual({ kind: 'unowned' });
    });

    it("adopts git's absolutised form of a relative held path", () => {
      const rel = path.join('..', 'g1', 'remote.git');
      const recorded = path.join(process.cwd(), '..', 'g1', 'remote.git');
      expect(decideOrigin(state({ originUrls: [recorded], heldStripped: rel }))).toEqual({
        kind: 'unchanged',
        writeRecord: true,
      });
    });

    it('never resolves a URL with a scheme as a path', () => {
      expect(
        decideOrigin(state({ originUrls: ['file:///x/./r.git'], heldStripped: 'file:///x/r.git' })),
      ).toEqual({ kind: 'unowned' });
    });

    it('leaves anything else unowned — an SSH alias for the same repository included', () => {
      expect(decideOrigin(state({ originUrls: ['git@github-work:o/a.git'] }))).toEqual({
        kind: 'unowned',
      });
      expect(decideOrigin(state({ originUrls: [B] }))).toEqual({ kind: 'unowned' });
      // Even with a token held: unowned writes nothing, so the token rule never comes into it.
      expect(decideOrigin(state({ originUrls: [B], heldCarriesToken: true }))).toEqual({
        kind: 'unowned',
      });
    });
  });

  describe('record, origin untouched since the server wrote it', () => {
    const record = { heldUrl: A, originUrl: A };

    it('is unchanged while the held URL is the recorded one', () => {
      expect(decideOrigin(state({ record }))).toEqual({ kind: 'unchanged', writeRecord: false });
    });

    it('re-points when the held URL changed', () => {
      expect(decideOrigin(state({ record, heldStripped: B }))).toEqual({
        kind: 'repoint',
        value: B,
      });
    });

    it('compares the RAW origin against the record: a token added by hand makes it not owned', () => {
      const tokened = `https://user:${SECRET}@git.example/o/a.git`;
      const rec = { heldUrl: A, originUrl: 'https://user@git.example/o/a.git' };
      expect(decideOrigin(state({ originUrls: [tokened], record: rec, heldStripped: B }))).toEqual({
        kind: 'refuse',
        reason: 'conflict',
      });
      expect(decideOrigin(state({ originUrls: [tokened], record: rec }))).toEqual({
        kind: 'unowned',
        credentialOnDisk: true,
      });
      // Even a record that names the token-bearing value itself does not make it owned.
      expect(
        decideOrigin(
          state({
            originUrls: [tokened],
            record: { heldUrl: A, originUrl: tokened },
            heldStripped: B,
          }),
        ),
      ).toEqual({ kind: 'refuse', reason: 'conflict' });
    });

    it('refuses a re-point to a URL carrying a token', () => {
      expect(decideOrigin(state({ record, heldStripped: B, heldCarriesToken: true }))).toEqual({
        kind: 'refuse',
        reason: 'token',
      });
    });

    it('refuses a re-point when origin is not defined in .git/config alone', () => {
      expect(decideOrigin(state({ record, heldStripped: B, localOriginUrls: [] }))).toEqual({
        kind: 'refuse',
        reason: 'external',
      });
      expect(decideOrigin(state({ record, heldStripped: B, localOriginUrls: ['x'] }))).toEqual({
        kind: 'refuse',
        reason: 'external',
      });
    });
  });

  describe('record, origin edited by hand since', () => {
    const record = { heldUrl: A, originUrl: A };
    const alias = 'git@github-work:o/a.git';

    it('re-records a hand edit that already names the held URL', () => {
      expect(decideOrigin(state({ originUrls: [B], record, heldStripped: B }))).toEqual({
        kind: 'unchanged',
        writeRecord: true,
      });
    });

    it('respects the hand edit while the registration is unchanged', () => {
      expect(decideOrigin(state({ originUrls: [alias], record }))).toEqual({ kind: 'unowned' });
    });

    it('refuses when both the origin and the registration changed', () => {
      expect(decideOrigin(state({ originUrls: [alias], record, heldStripped: B }))).toEqual({
        kind: 'refuse',
        reason: 'conflict',
      });
    });
  });
});

describe('relative held paths are written as git clone writes them', () => {
  it('localPathKind follows git: a URL, scp-like host:path, or a local path', () => {
    for (const platform of ['linux', 'win32'] as const) {
      expect(localPathKind('b.git', platform)).toBe('relative');
      expect(localPathKind('../g1/b.git', platform)).toBe('relative');
      expect(localPathKind('./a:b', platform)).toBe('relative');
      // A "/" before "://": not a scheme, so a path (git's url_is_local_not_ssh).
      expect(localPathKind('./a://b', platform)).toBe('relative');
      expect(localPathKind('../x://y', platform)).toBe('relative');
      expect(localPathKind('host:path/b.git', platform)).toBeUndefined();
      expect(localPathKind('git@host:o/b.git', platform)).toBeUndefined();
      expect(localPathKind('ext::ssh host b', platform)).toBeUndefined();
      expect(localPathKind('https://host/o/b.git', platform)).toBeUndefined();
      expect(localPathKind('file:///srv/b.git', platform)).toBeUndefined();
    }
    expect(localPathKind('/srv/git/b.git', 'linux')).toBe('absolute');
    // A DOS drive is local on win32 only; on POSIX git reads `C:/x` as scp-like host "C".
    expect(localPathKind('C:\\x\\b.git', 'win32')).toBe('absolute');
    expect(localPathKind('C:/x/b.git', 'win32')).toBe('absolute');
    expect(localPathKind('C:b.git', 'win32')).toBe('relative');
    expect(localPathKind('C:/x/b.git', 'linux')).toBeUndefined();
    expect(localPathKind('C:b.git', 'linux')).toBeUndefined();
  });

  it('originValueToWrite resolves only a relative local path, against the cwd', () => {
    expect(originValueToWrite('b.git')).toBe(path.resolve('b.git'));
    expect(originValueToWrite('/srv/b.git')).toBe('/srv/b.git');
    expect(originValueToWrite('git@host:o/b.git')).toBe('git@host:o/b.git');
    expect(originValueToWrite(B)).toBe(B);
  });

  it('a re-point to a relative held path writes the resolved path', () => {
    expect(
      decideOrigin(state({ record: { heldUrl: A, originUrl: A }, heldStripped: 'b.git' })),
    ).toEqual({ kind: 'repoint', value: path.resolve('b.git') });
    expect(decideOrigin(state({ originUrls: [], heldStripped: 'b.git' }))).toEqual({
      kind: 'add',
      value: path.resolve('b.git'),
    });
  });

  it('a held URL moving between a relative path and its absolute form re-records, without a re-point', () => {
    const abs = path.resolve('b.git');
    expect(
      decideOrigin(
        state({
          originUrls: [abs],
          record: { heldUrl: 'b.git', originUrl: abs },
          heldStripped: abs,
        }),
      ),
    ).toEqual({ kind: 'unchanged', writeRecord: true });
    expect(
      decideOrigin(
        state({
          originUrls: [abs],
          record: { heldUrl: abs, originUrl: abs },
          heldStripped: 'b.git',
        }),
      ),
    ).toEqual({ kind: 'unchanged', writeRecord: true });
  });

  it('never resolves a relative origin as a path: git resolves it against the clone, not the cwd', () => {
    expect(decideOrigin(state({ originUrls: ['b.git'], heldStripped: 'b.git' }))).toEqual({
      kind: 'unchanged',
      writeRecord: true,
    });
    expect(decideOrigin(state({ originUrls: ['./b.git'], heldStripped: 'b.git' }))).toEqual({
      kind: 'unowned',
    });
  });
});

describe("an origin carrying a password or token is never the server's", () => {
  const pat = `https://me:${SECRET}@git.example/o/a.git`;

  it('with no record, it is never adopted or written, whatever the held URL', () => {
    for (const held of [A, B, 'https://me@git.example/o/a.git']) {
      expect(decideOrigin(state({ originUrls: [pat], heldStripped: held }))).toEqual({
        kind: 'unowned',
        credentialOnDisk: true,
      });
    }
    expect(decideOrigin(state({ originUrls: [`https://${SECRET}@git.example/o/a.git`] }))).toEqual({
      kind: 'unowned',
      credentialOnDisk: true,
    });
    // Not even with a token held (the env URL cloned as-is).
    expect(
      decideOrigin(
        state({
          originUrls: [pat],
          heldStripped: 'https://me@git.example/o/a.git',
          heldCarriesToken: true,
        }),
      ),
    ).toEqual({ kind: 'unowned', credentialOnDisk: true });
  });

  it("a push mirror whose first URL is the held one once its token is stripped is still not the server's", () => {
    expect(
      decideOrigin(state({ originUrls: [`https://${SECRET}@git.example/o/a.git`, B] })),
    ).toEqual({ kind: 'unowned', credentialOnDisk: true });
  });

  it('a token added by hand to a recorded origin whose stripped form IS the held URL: unowned, no record write', () => {
    expect(
      decideOrigin(
        state({
          originUrls: [`https://${SECRET}@git.example/o/a.git`],
          record: { heldUrl: A, originUrl: A },
        }),
      ),
    ).toEqual({ kind: 'unowned', credentialOnDisk: true });
  });

  it('a held URL carrying a token: the note blames the configured URL, offers no *** command, names the way out', () => {
    const tokenedHeld = `https://me:${SECRET}@git.example/o/a.git`;
    for (const r of [
      { origin: tokenedHeld, credentialOnDisk: true },
      { origin: 'git@github-work:o/a.git', credentialOnDisk: false },
    ]) {
      const note = unownedOriginNote(r.origin, tokenedHeld, 'ws/paper', r.credentialOnDisk);
      expect(note).toMatch(/configured URL embeds a password or token/);
      expect(note).toContain('WEB_LATEX_MCP_PROJECTS');
      expect(note).toContain('register_project');
      // The clone made from the configured URL is not "an origin the server did not set"; an
      // unrelated origin still is.
      if (r.credentialOnDisk) expect(note).not.toMatch(/did not set this origin/);
      else expect(note).toMatch(/did not set this origin, or no longer owns it/);
      expect(note).not.toMatch(/older version/);
      expect(/`git remote set-url origin ([^`]*)`/.exec(note)?.[1]).toBe(
        quoteId('https://me@git.example/o/a.git'),
      );
      expect(note).not.toContain(SECRET);
      expect(count(note, 'leaves it as it is')).toBe(1);
    }
  });

  it('the remedy for a relative held path is the absolute path the server would write', () => {
    const note = unownedOriginNote('git@github-work:o/a.git', 'b.git', 'ws/paper');
    expect(/`git remote set-url origin ([^`]*)`/.exec(note)?.[1]).toBe(
      quoteId(path.resolve('b.git')),
    );
  });

  it('without a token held, the note does not claim the server never set it', () => {
    const note = unownedOriginNote('git@github-work:o/a.git', A, 'ws/paper');
    expect(note).toMatch(/did not set this origin, or no longer owns it/);
  });

  it('a push mirror whose first URL carries a token is not "unchanged"', () => {
    expect(decideOrigin(state({ originUrls: [pat, B] }))).toEqual({
      kind: 'unowned',
      credentialOnDisk: true,
    });
  });

  it('the note says it holds a token, redacted, with the remedy — and where fetch and push go when it is another URL', () => {
    const same = originNote(
      { kind: 'unowned', previous: pat, pushUrls: [], credentialOnDisk: true },
      A,
      'ws/paper',
      'x',
    );
    expect(same).toMatch(/holds a password or token/);
    expect(same).toMatch(/e\.g\. an older version of this server/);
    expect(same).toContain('git remote set-url origin');
    expect(same).toContain(quoteId(A));
    expect(same).toContain(quoteId('https://me:***@git.example/o/a.git'));
    expect(same).not.toContain(SECRET);
    expect(same).not.toMatch(/not to the registered URL/);

    const other = originNote(
      { kind: 'unowned', previous: pat, pushUrls: [], credentialOnDisk: true },
      B,
      'ws/paper',
      'x',
    );
    expect(other).toMatch(/holds a password or token/);
    expect(other).toMatch(/fetch and push go there, not to the registered URL/);
    expect(other).not.toContain(SECRET);
    expect(count(other, 'git remote set-url origin')).toBe(1);

    const pending = pendingOriginNote(
      { kind: 'unowned', credentialOnDisk: true },
      { originUrls: [pat] },
      A,
      'ws/paper',
    );
    expect(pending).toBe(same);
  });
});

describe('on an error path the remedy survives the error scrubber', () => {
  // `errorResult` → `redact` rewrites ANY userinfo in an https URL, a login name included, so an
  // exact command naming `https://org@…` would reach the caller as `https://***@…`.
  const held = 'https://org@dev.azure.com/org/p/_git/r';
  const unowned = {
    kind: 'unowned' as const,
    previous: 'git@ssh.dev.azure.com:v3/org/p/r',
    pushUrls: [],
  };
  const errorText = (note: string): string => {
    const res = errorResult(withOriginNote(new Error('boom'), note), []);
    return (res.content as Array<{ text: string }>).map((c) => c.text).join('');
  };

  it('a held URL with a login: the error variant names list_projects and the login, never a *** command', () => {
    const text = errorText(originNote(unowned, held, 'ws/paper', 'x', { forError: true }));
    expect(text).toContain('git remote set-url origin <url>');
    expect(text).toContain('list_projects');
    expect(text).toContain(quoteId('org'));
    expect(/`git remote set-url origin ([^`]*)`/.exec(text)?.[1]).toBe('<url>');
  });

  it('the same for a credential-bearing origin and for a held URL whose token was stripped to user@', () => {
    for (const [origin, h, cred] of [
      [
        `https://me:${SECRET}@bitbucket.example/me/r.git`,
        'https://me@bitbucket.example/me/r.git',
        true,
      ],
      [
        `https://me:${SECRET}@bitbucket.example/me/r.git`,
        `https://me:${SECRET}@bitbucket.example/me/r.git`,
        true,
      ],
    ] as const) {
      const text = errorText(
        originNote(
          {
            kind: 'unowned',
            previous: origin,
            pushUrls: [],
            ...(cred ? { credentialOnDisk: true as const } : {}),
          },
          h,
          'ws/paper',
          'x',
          { forError: true },
        ),
      );
      expect(/`git remote set-url origin ([^`]*)`/.exec(text)?.[1]).toBe('<url>');
      expect(text).toContain('list_projects');
      expect(text).toContain(quoteId('me'));
      expect(text).not.toContain(SECRET);
    }
  });

  it('the success variant keeps the exact command', () => {
    const note = originNote(unowned, held, 'ws/paper', 'x');
    expect(/`git remote set-url origin ([^`]*)`/.exec(note)?.[1]).toBe(quoteId(held));
  });

  it('without a userinfo, the error variant is the success one', () => {
    expect(originNote(unowned, A, 'ws/paper', 'x', { forError: true })).toBe(
      originNote(unowned, A, 'ws/paper', 'x'),
    );
    expect(errorText(originNote(unowned, A, 'ws/paper', 'x', { forError: true }))).toContain(
      `git remote set-url origin ${quoteId(A)}`,
    );
  });
});

describe('parseOriginRecord: anything but one non-empty value of each key is no record', () => {
  it('reads a whole record', () => {
    expect(parseOriginRecord([A], [A])).toEqual({ heldUrl: A, originUrl: A });
  });

  it('a partial, doubled or empty record is none — so a hand-set origin is never rewritten through it', () => {
    expect(parseOriginRecord([A], [])).toBeUndefined();
    expect(parseOriginRecord([], [A])).toBeUndefined();
    expect(parseOriginRecord([A, B], [A])).toBeUndefined();
    expect(parseOriginRecord([A], [A, B])).toBeUndefined();
    expect(parseOriginRecord([''], [A])).toBeUndefined();
    expect(parseOriginRecord([A], [''])).toBeUndefined();
    const alias = 'git@github-work:o/a.git';
    expect(
      decideOrigin(
        state({ originUrls: [alias], record: parseOriginRecord([''], [alias]), heldStripped: B }),
      ),
    ).toEqual({ kind: 'unowned' });
  });
});

describe('the messages', () => {
  const dir = path.join('ws', 'paper');
  const tokened = `https://user:${SECRET}@git.example/o/a.git`;

  it('every refusal is fixed words with URLs redacted and quoted', () => {
    for (const reason of ['multiple', 'token', 'external', 'conflict'] as const) {
      const m = originRefusalMessage(reason, { held: tokened, origin: tokened, dir, count: 3 });
      expect(m).not.toContain(SECRET);
      expect(m).toContain(quoteId('https://user:***@git.example/o/a.git'));
      expect(m).toMatch(/nothing was fetched or pushed/);
    }
    expect(originRefusalMessage('multiple', { held: A, origin: A, dir, count: 3 })).toMatch(
      /has 3 URLs/,
    );
    expect(originRefusalMessage('token', { held: A, origin: A, dir })).toContain(
      'WEB_LATEX_MCP_PROJECTS',
    );
    const conflict = originRefusalMessage('conflict', { held: B, origin: 'git@h:o/a', dir });
    expect(conflict).toContain(quoteId('git@h:o/a'));
    expect(conflict).toContain(quoteId(B));
    expect(conflict).toContain(quoteId('ws/paper'));
    expect(conflict).toContain('git remote set-url origin');
  });

  it('originNote: a re-point names both URLs and any pushurl; unowned names the remedy; unchanged says nothing', () => {
    const repointed = originNote(
      { kind: 'repointed', previous: tokened, pushUrls: [tokened] },
      B,
      dir,
      'this sync fetches from it',
    );
    expect(repointed).toContain('origin was re-pointed from');
    expect(repointed).toContain(quoteId(B));
    expect(repointed).toMatch(/pushurl is set .* so push still goes there/);
    expect(repointed).not.toContain(SECRET);
    expect(originNote({ kind: 'unchanged', previous: A, pushUrls: [] }, A, dir, 'x')).toBe('');
    const unowned = originNote({ kind: 'unowned', previous: tokened, pushUrls: [] }, B, dir, 'x');
    expect(unowned).toBe(unownedOriginNote(tokened, B, dir));
    expect(unowned).not.toContain(SECRET);
    expect(unowned).toContain('git remote set-url origin');
  });

  it('pendingOriginNote previews each decision', () => {
    const s = { originUrls: [A] };
    expect(pendingOriginNote({ kind: 'unchanged', writeRecord: true }, s, A, dir)).toBe('');
    expect(pendingOriginNote({ kind: 'repoint', value: B }, s, B, dir)).toContain(
      're-points it to',
    );
    expect(pendingOriginNote({ kind: 'add', value: B }, { originUrls: [] }, B, dir)).toContain(
      'adds one',
    );
    expect(pendingOriginNote({ kind: 'unowned' }, s, B, dir)).toContain('leaves it as it is');

    expect(pendingOriginNote({ kind: 'refuse', reason: 'conflict' }, s, B, dir)).toMatch(
      /will refuse/,
    );
  });

  it('withOriginNote appends to an error message, keeping the cause, and is a no-op without a note', () => {
    const err = new Error('boom');
    expect(withOriginNote(err, '')).toBe(err);
    const noted = withOriginNote(err, ' note.') as Error;
    expect(noted.message).toBe('boom note.');
    expect(noted.cause).toBe(err);
  });
});
