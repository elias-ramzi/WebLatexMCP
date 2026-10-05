import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import {
  carriesCredential,
  redactGitUrlCredentials,
  stripGitUrlCredentials,
  strippedCredentialsNote,
  strippedCredentialsNoteFor,
} from '../../src/lib/gitUrlCredentials.js';
import { redact } from '../../src/lib/redact.js';
import { unownedOriginNote } from '../../src/lib/originRepoint.js';
import { ProjectManager } from '../../src/services/projectManager.js';
import { ProjectRegistry, registryPath } from '../../src/services/projectRegistry.js';
import { gitUrlOf } from '../../src/lib/projectMode.js';

/**
 * A credential a git URL carries somewhere other than an http(s) userinfo: a password in the
 * userinfo of any other `<scheme>://` URL, a credential query parameter, or a known-prefix token
 * standing as a path segment. Each was persisted to registry.json, written to `origin` and echoed
 * in results and errors.
 */

const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

describe('a password in the userinfo of any <scheme>:// URL', () => {
  it('strips the password and keeps the login, byte-exact', () => {
    for (const [given, kept] of [
      ['ssh://git:s3cret@host.example/o/r.git', 'ssh://git@host.example/o/r.git'],
      ['git+ssh://alice:pw@host.example:2222/r.git', 'git+ssh://alice@host.example:2222/r.git'],
      ['ftp://bob:hunter2@ftp.example/repo.git', 'ftp://bob@ftp.example/repo.git'],
      ['ftps://bob:p@ss@ftp.example/repo.git', 'ftps://bob@ftp.example/repo.git'],
      ['SVN+SSH://u:x@h/r', 'SVN+SSH://u@h/r'],
    ] as const) {
      expect(stripGitUrlCredentials(given)).toEqual({
        url: kept,
        stripped: true,
        removed: 'password',
      });
    }
  });

  it('redacts the password as user:***@', () => {
    expect(redactGitUrlCredentials('ssh://git:s3cret@host.example/o/r.git')).toBe(
      'ssh://git:***@host.example/o/r.git',
    );
    expect(redactGitUrlCredentials('ftps://bob:p@ss@ftp.example/repo.git')).toBe(
      'ftps://bob:***@ftp.example/repo.git',
    );
  });

  it('never judges a non-http login name a token: ssh://git@host and a token-shaped ssh user stay', () => {
    for (const url of [
      'ssh://git@host.example/x',
      `ssh://${TOKEN}@host.example/x`,
      'git@github.com:o/r.git',
      'git@github.com:o/r.git?token=abc',
    ]) {
      expect(stripGitUrlCredentials(url)).toEqual({ url, stripped: false });
      expect(redactGitUrlCredentials(url)).toBe(url);
      expect(carriesCredential(url)).toBe(false);
    }
  });
});

describe('a credential query parameter', () => {
  it('is removed with its & — other parameters and the fragment kept byte-exact', () => {
    const cases: Array<[string, string]> = [
      ['https://h.example/r.git?private_token=XYZ', 'https://h.example/r.git'],
      ['https://h.example/r.git?access_token=XYZ#frag', 'https://h.example/r.git#frag'],
      ['https://h.example/r.git?a=1&token=XYZ&b=%20x', 'https://h.example/r.git?a=1&b=%20x'],
      ['https://h.example/r.git?TOKEN=XYZ&b=2', 'https://h.example/r.git?b=2'],
      ['https://h.example/r.git?a=1&Private%5FToken=XYZ', 'https://h.example/r.git?a=1'],
      ['https://h.example/r.git?ref=main&x=' + TOKEN, 'https://h.example/r.git?ref=main'],
      ['https://h.example/r.git?sig=abc&sp=r&se=2030', 'https://h.example/r.git?sp=r&se=2030'],
      ['https://h.example/r.git?' + TOKEN, 'https://h.example/r.git'],
    ];
    for (const [given, kept] of cases) {
      expect(stripGitUrlCredentials(given)).toEqual({
        url: kept,
        stripped: true,
        removed: 'query',
      });
    }
  });

  it('redacts the value as name=***', () => {
    expect(redactGitUrlCredentials('https://h.example/r.git?a=1&private_token=XYZ#f')).toBe(
      'https://h.example/r.git?a=1&private_token=***#f',
    );
    expect(redactGitUrlCredentials(`https://h.example/r.git?x=${TOKEN}`)).toBe(
      'https://h.example/r.git?x=***',
    );
  });

  it('leaves a non-credential query and a fragment as written', () => {
    for (const url of [
      'https://h.example/r.git?ref=main&depth=1#readme',
      'https://h.example/r.git?tokens=2&keys=a',
      'https://h.example/r.git#token=abc',
    ]) {
      expect(stripGitUrlCredentials(url)).toEqual({ url, stripped: false });
      expect(redactGitUrlCredentials(url)).toBe(url);
    }
  });

  it('reports the userinfo kind when a URL carries both, and removes both', () => {
    expect(stripGitUrlCredentials('https://u:pw@h.example/r.git?token=XYZ&a=1')).toEqual({
      url: 'https://u@h.example/r.git?a=1',
      stripped: true,
      removed: 'password',
      queryRemoved: true,
    });
    expect(redactGitUrlCredentials('https://u:pw@h.example/r.git?token=XYZ&a=1')).toBe(
      'https://u:***@h.example/r.git?token=***&a=1',
    );
  });

  it('has a note that claims only the query was removed, with the supply-it-another-way tail', () => {
    const note = strippedCredentialsNote('query');
    expect(note).toMatch(/query/);
    expect(note).not.toMatch(/username was kept|user:token@|token@\)/);
    expect(note).toMatch(/set_credential/);
    expect(note).toMatch(/tokenEnv/);
    expect(strippedCredentialsNoteFor('https://h.example/r.git?private_token=XYZ')).toBe(note);
    // Both removed: the userinfo sentence, and the query named too.
    expect(strippedCredentialsNoteFor('https://u:pw@h.example/r.git?token=XYZ')).toMatch(
      /user:token@[\s\S]*query/,
    );
  });
});

describe('a known-prefix token as a path segment', () => {
  it('is redacted as *** and flagged, but never stripped (that would name another repository)', () => {
    const url = `https://h.example/${TOKEN}/repo.git`;
    expect(redactGitUrlCredentials(url)).toBe('https://h.example/***/repo.git');
    expect(stripGitUrlCredentials(url)).toEqual({ url, stripped: false, pathToken: true });
    expect(carriesCredential(url)).toBe(true);
  });

  it('spares repository names: hf_utils, ghp_notes, and a long segment without the token mix', () => {
    for (const url of [
      'https://h.example/o/hf_utils.git',
      'https://h.example/ghp_notes/repo.git',
      'https://h.example/o/hf_transformers_examples_repo.git',
    ]) {
      expect(stripGitUrlCredentials(url)).toEqual({ url, stripped: false });
      expect(redactGitUrlCredentials(url)).toBe(url);
      expect(carriesCredential(url)).toBe(false);
    }
  });

  it('refuses the registration, naming the URL redacted and storing nothing', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'ovl-pathtok-'));
    try {
      const registry = new ProjectRegistry(workspaceRoot);
      const pm = new ProjectManager({ workspaceRoot, sessionId: 'test', projects: [] }, registry);
      let message = '';
      try {
        await pm.registerAndPersist({ id: 'paper', gitUrl: `https://h.example/${TOKEN}/repo.git` });
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message).toContain('"https://h.example/***/repo.git"');
      expect(message).not.toContain(TOKEN);
      expect(message).toMatch(/path/);
      expect(message).toMatch(/access token/);
      expect(message).toMatch(/[Nn]othing was stored/);
      expect(message).toMatch(/set_credential/);
      expect(message).toMatch(/tokenEnv/);
      expect(() => pm.getProjectConfig('paper')).toThrow();
      // Pre-fix the URL, token and all, was written here.
      await expect(readFile(registryPath(workspaceRoot), 'utf8')).rejects.toThrow();
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('registers a query-token or ssh-password URL with the credential gone', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'ovl-qtok-'));
    try {
      const pm = new ProjectManager({ workspaceRoot, sessionId: 'test', projects: [] });
      const a = pm.registerProject({ id: 'a', gitUrl: 'https://h.example/a.git?private_token=Z' });
      expect(gitUrlOf(a)).toBe('https://h.example/a.git');
      const b = pm.registerProject({ id: 'b', gitUrl: 'ssh://git:pw@h.example/b.git' });
      expect(gitUrlOf(b)).toBe('ssh://git@h.example/b.git');
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe('redact (free text)', () => {
  it('masks a userinfo password on any scheme://, and keeps the https rule as it was', () => {
    expect(redact('fatal: could not read ssh://git:s3cret@host.example/r.git: denied')).toBe(
      'fatal: could not read ssh://git:***@host.example/r.git: denied',
    );
    expect(redact('ftp://bob:p@ss@ftp.example/x and git+ssh://a:b@h/y')).toBe(
      'ftp://bob:***@ftp.example/x and git+ssh://a:***@h/y',
    );
    expect(redact('cloning https://git:tok_xyz@git.overleaf.com/abc failed')).toBe(
      'cloning https://***@git.overleaf.com/abc failed',
    );
    // A login alone is not a secret off https.
    expect(redact('ssh://git@host.example/r.git')).toBe('ssh://git@host.example/r.git');
  });

  it('masks credential query parameters inside URLs only', () => {
    expect(
      redact(
        "fatal: repository 'https://h.example/r.git?a=1&private_token=XYZ#f' not found; token=keep",
      ),
    ).toBe(
      "fatal: repository 'https://h.example/r.git?a=1&private_token=***#f' not found; token=keep",
    );
    expect(redact(`unable to access https://h.example/r.git?x=${TOKEN}`)).toBe(
      'unable to access https://h.example/r.git?x=***',
    );
    expect(redact('see https://h.example/r.git?ref=main for ?token=abc')).toBe(
      'see https://h.example/r.git?ref=main for ?token=abc',
    );
  });

  // A URL glued onto another with no whitespace between is one match of the free-text rule, and
  // the first URL's parse puts everything after its `#` (or inside its query) out of reach of the
  // path and query rules — so the second URL's credential survived.
  it('masks a credential query parameter in a URL glued onto another URL', () => {
    expect(redact('https://h/r#f,https://h/x?token=SEKRET')).toBe(
      'https://h/r#f,https://h/x?token=***',
    );
    expect(redact('see https://h/r#https://h/x?a=1&private_token=SEKRET#y failed')).toBe(
      'see https://h/r#https://h/x?a=1&private_token=***#y failed',
    );
    expect(redact('https://h/r?a=1,https://h/x?token=SEKRET')).toBe(
      'https://h/r?a=1,https://h/x?token=***',
    );
  });

  it('masks a token-like path segment in a URL glued onto another URL', () => {
    expect(redact(`https://h/r#f,https://h/${TOKEN}/x`)).toBe('https://h/r#f,https://h/***/x');
  });

  it('leaves a fragment with no URL in it as written', () => {
    for (const text of [
      'https://h/r#frag',
      'see https://h.example/r.git?ref=main#L10-L20 for details',
      `https://h/r#${TOKEN}`,
    ]) {
      expect(redact(text)).toBe(text);
    }
  });

  it('stays linear on a long run of glued URLs', () => {
    for (const text of [
      'https://h/r#'.repeat(8_334),
      '#https://'.repeat(11_112),
      'x://'.repeat(25_000),
      'https://h/r?a='.repeat(7_143),
    ]) {
      const start = performance.now();
      redact(text);
      expect(performance.now() - start).toBeLessThan(1000);
    }
  });
});

describe('the unowned-origin note for a held URL carrying such a credential', () => {
  const dir = path.join(os.tmpdir(), 'clone');

  it('never prints a query token in its remedy, and says the configured URL embeds one', () => {
    const held = 'https://h.example/r.git?private_token=XYZsecret';
    const note = unownedOriginNote(held, held, dir, true);
    expect(note).not.toContain('XYZsecret');
    expect(note).toContain('git remote set-url origin "https://h.example/r.git"');
    expect(note).toMatch(/configured URL embeds a password or token/);
  });

  it('never prints a path token in its remedy, which cannot be built tokenless', () => {
    const held = `https://h.example/${TOKEN}/r.git`;
    const note = unownedOriginNote(held, held, dir, true);
    expect(note).not.toContain(TOKEN);
    expect(note).toContain('https://h.example/***/r.git');
    expect(note).toMatch(/once the token is removed from its path/);
  });
});

describe('redact (free text): a token-like path segment inside a URL', () => {
  it('masks it in an env-style git error', () => {
    expect(
      redact(`fatal: repository 'https://h.example/${TOKEN}/r.git/' not found (see ${TOKEN}x)`),
    ).toBe(`fatal: repository 'https://h.example/***/r.git/' not found (see ${TOKEN}x)`);
    expect(redact(`git+ssh://git@h.example/o/${TOKEN}?ref=main#x`)).toBe(
      'git+ssh://git@h.example/o/***?ref=main#x',
    );
  });

  it('leaves hf_utils and a long all-lower-case segment alone', () => {
    for (const text of [
      'cloning https://h.example/o/hf_utils.git failed',
      'cloning https://h.example/o/hf_transformers_examples_repo.git failed',
    ]) {
      expect(redact(text)).toBe(text);
    }
  });
});

describe('redact (free text) is linear on a long run of scheme characters', () => {
  // `redact` runs in every `errorResult`. A match that could start anywhere inside a run of
  // `[A-Za-z0-9+.-]` re-scanned the rest of the run from each position: 40k characters took
  // about 1.5 s, and 100k about ten. The bound is generous on purpose; the fixed version
  // finishes in a few milliseconds.
  for (const [name, text] of [
    ['100k a', 'a'.repeat(100_000)],
    ['100k of a+', 'a+'.repeat(50_000)],
  ] as const) {
    it(name, () => {
      const start = performance.now();
      expect(redact(text)).toBe(text);
      expect(performance.now() - start).toBeLessThan(1000);
    });
  }

  it('still masks a password behind a run of scheme characters, as the URL rules see it', () => {
    expect(redact('see -ssh://u:pw@h/r')).toBe('see -ssh://u:***@h/r');
    expect(redact(`x 1https://h/${TOKEN}/r.git`)).toBe('x 1https://h/***/r.git');
  });
});

describe('redact (free text) masks what redactGitUrlCredentials masks', () => {
  it('a raw "@" in a non-http login: the password before the last "@" is masked', () => {
    const url = 'ssh://a@b:pw@h/r';
    expect(redactGitUrlCredentials(url)).toBe('ssh://a@b:***@h/r');
    expect(redact(`fatal: could not read ${url}: denied`)).toBe(
      'fatal: could not read ssh://a@b:***@h/r: denied',
    );
  });

  it('a port after an ssh login is not a password', () => {
    for (const text of ['ssh://git@host:22/r', 'ssh://git@host:22 failed for a@b']) {
      expect(redact(text)).toBe(text);
    }
  });

  it('a path token behind a backslash in an http(s) URL', () => {
    const url = `https://h\\${TOKEN}\\r.git`;
    expect(redactGitUrlCredentials(url)).toBe('https://h\\***\\r.git');
    expect(redact(`unable to access '${url}'`)).toBe("unable to access 'https://h\\***\\r.git'");
  });
});

describe('a file: URL has no userinfo to judge', () => {
  it('a Windows path with an "@" in it is byte-identical through strip, redact and the check', () => {
    const url = 'file://C:\\Users\\me@corp\\repo.git';
    expect(stripGitUrlCredentials(url)).toEqual({ url, stripped: false });
    expect(redactGitUrlCredentials(url)).toBe(url);
    expect(carriesCredential(url)).toBe(false);
    expect(redact(`cloning ${url} failed`)).toBe(`cloning ${url} failed`);
    expect(redact('FILE://u:p@h/r')).toBe('FILE://u:p@h/r');
  });

  it('its query is judged as before', () => {
    expect(stripGitUrlCredentials('file:///srv/r.git?token=X')).toEqual({
      url: 'file:///srv/r.git',
      stripped: true,
      removed: 'query',
    });
    expect(redactGitUrlCredentials('file:///srv/r.git?a=1&token=X')).toBe(
      'file:///srv/r.git?a=1&token=***',
    );
    expect(redact('cloning file:///srv/r.git?token=X failed')).toBe(
      'cloning file:///srv/r.git?token=*** failed',
    );
    expect(carriesCredential('file:///srv/r.git?token=X')).toBe(true);
  });
});

describe('an empty "?" is removed with the credential', () => {
  it('?&token=S leaves no bare "?", and ?a=1&&token=S keeps ?a=1', () => {
    for (const [given, kept] of [
      ['https://h.example/r.git?&token=S', 'https://h.example/r.git'],
      ['https://h.example/r.git?&token=S#f', 'https://h.example/r.git#f'],
      ['https://h.example/r.git?a=1&&token=S', 'https://h.example/r.git?a=1'],
      ['https://h.example/r.git?token=S&', 'https://h.example/r.git'],
    ] as const) {
      expect(stripGitUrlCredentials(given)).toEqual({
        url: kept,
        stripped: true,
        removed: 'query',
      });
    }
  });
});

describe('a password with no username before it (#247)', () => {
  // An empty login with a password removes the whole userinfo; the note used to call that
  // password an access token standing as the userinfo ("token@").
  for (const url of ['ssh://:pw@h.example/r.git', 'https://:pw@h.example/r.git']) {
    it(url, () => {
      expect(stripGitUrlCredentials(url)).toMatchObject({
        stripped: true,
        removed: 'bare-password',
      });
      const note = strippedCredentialsNoteFor(url);
      expect(note).toMatch(/no username before it \(:token@\)/);
      expect(note).not.toMatch(/\(token@\)/);
    });
  }

  it('a token standing alone as the userinfo is still worded as one', () => {
    expect(strippedCredentialsNoteFor(`https://${TOKEN}@h.example/r.git`)).toMatch(/\(token@\)/);
  });
});

describe('redact (free text): a credential value holding <scheme>:// (#247)', () => {
  it('masks the whole value in a URL glued after the first', () => {
    // The first URL's parse holds the rest in its fragment; the value used to be cut at the
    // embedded head and its tail left showing (`token=***secret://b`).
    expect(redact('fatal: https://h/r#f,https://h/x?token=secret://b failed')).toBe(
      'fatal: https://h/r#f,https://h/x?token=*** failed',
    );
    expect(redact('https://h/r#f,https://h/x?token=sec,https://h/y')).toBe(
      'https://h/r#f,https://h/x?token=***',
    );
  });

  it('is linear past the glued-URL bound', () => {
    const text = `https://h/r#${',a://b'.repeat(30_000)}`;
    const start = performance.now();
    redact(text);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('masks the whole value, not only up to the embedded scheme', () => {
    expect(redact('fatal: https://h.example/r.git?token=xa://b&a=1 failed')).toBe(
      'fatal: https://h.example/r.git?token=***&a=1 failed',
    );
    // Glued after another URL, the value's URL is not the whole run, so only masking it to the
    // end of the run (not up to the embedded `xa://`) masks it whole.
    expect(redact('fatal: https://h/r#f,https://h.example/r.git?token=xa://b&a=1 failed')).toBe(
      'fatal: https://h/r#f,https://h.example/r.git?token=***&a=1 failed',
    );
  });

  it('still masks what the piecewise pass masked when a later URL spoils the value', () => {
    // Masked to the end of the run, `v` absorbs the glued URL behind it, whose `%zz` makes the
    // value undecodable, so its percent-escaped token prefix (`%67hp_` = `ghp_`) went unseen.
    const out = redact(
      'https://h/r#f,https://h/x?v=%67hp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8,https://h2/y?q=%zz',
    );
    expect(out).not.toContain('A1b2C3d4');
    expect(out).toBe('https://h/r#f,https://h/x?v=***https://h2/y?q=%zz');
  });

  it('still masks a credential in a URL glued after the first', () => {
    expect(redact(`https://h/r#f,https://h/x?token=SECRET x https://h/${TOKEN}/r.git`)).toBe(
      'https://h/r#f,https://h/x?token=*** x https://h/***/r.git',
    );
    // A value runs to the end of the run, so a URL glued behind it goes with it.
    expect(redact(`https://h/r#f,https://h/x?token=SECRET,https://h/${TOKEN}/r.git`)).toBe(
      'https://h/r#f,https://h/x?token=***',
    );
  });
});

describe('redact (free text): an https userinfo behind a separator other than // (#247)', () => {
  for (const [text, want] of [
    ['fatal: https:/u:pw@h/r.git', 'fatal: https:/***@h/r.git'],
    ['fatal: https:\\u:pw@h/r.git', 'fatal: https:\\***@h/r.git'],
    ['fatal: https:u:pw@h/r.git', 'fatal: https:***@h/r.git'],
    ['fatal: HTTP:\\\\/u:p@w@h/r.git', 'fatal: HTTP:\\\\/***@h/r.git'],
  ] as const) {
    it(JSON.stringify(text), () => expect(redact(text)).toBe(want));
  }

  it('leaves a URL with no userinfo alone', () => {
    expect(redact('see https:/h/r.git and https:h')).toBe('see https:/h/r.git and https:h');
  });

  // Without the atomic separator and the stop at the next `http(s):`, each of these took about
  // two seconds at this length.
  for (const [name, text] of [
    ['https: repeated', 'https:'.repeat(20_000)],
    ['https:\\ repeated', 'https:\\'.repeat(20_000)],
    ['https: then 100k \\', `https:${'\\'.repeat(100_000)}`],
  ] as const) {
    it(`is linear: ${name}`, () => {
      const start = performance.now();
      redact(text);
      expect(performance.now() - start).toBeLessThan(1000);
    });
  }
});
