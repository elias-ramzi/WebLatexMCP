import { describe, it, expect } from 'vitest';
import { planSyncRegistration, syncRegistration } from '../../src/lib/syncRegistration.js';
import { droppedRegistrationFields, registrationDroppedNote } from '../../src/lib/registration.js';
import type { ProjectConfig } from '../../src/types.js';

const URL = 'https://github.com/acme/paper.git';
const full: ProjectConfig = {
  id: 'paper',
  gitUrl: URL,
  rootFile: 'paper.tex',
  branch: 'master',
  username: 'alice',
  tokenEnv: 'PAPER_TOKEN',
};
const carried = {
  rootFile: 'paper.tex',
  branch: 'master',
  username: 'alice',
  tokenEnv: 'PAPER_TOKEN',
};

describe('syncRegistration', () => {
  it('a first registration is just the id and the url', () => {
    expect(syncRegistration('paper', URL, undefined)).toEqual({ id: 'paper', gitUrl: URL });
  });

  it('the same remote carries rootFile, branch, username and tokenEnv forward', () => {
    expect(syncRegistration('paper', URL, full)).toEqual({ id: 'paper', gitUrl: URL, ...carried });
  });

  it('a token pasted into the new url is the same remote; the url is returned as given', () => {
    const tokenUrl = 'https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/acme/paper.git';
    expect(syncRegistration('paper', tokenUrl, full)).toEqual({
      id: 'paper',
      gitUrl: tokenUrl,
      ...carried,
    });
  });

  it('an env-configured url still carrying a secret is compared stripped too', () => {
    const previous = {
      ...full,
      gitUrl: 'https://alice:s3cretS3cretS3cret99@github.com/acme/paper.git',
    };
    const next = syncRegistration('paper', 'https://alice@github.com/acme/paper.git', previous);
    expect(next).toMatchObject(carried);
  });

  it('a different remote is a re-point: nothing is carried', () => {
    expect(syncRegistration('paper', 'https://github.com/acme/other.git', full)).toEqual({
      id: 'paper',
      gitUrl: 'https://github.com/acme/other.git',
    });
  });

  it('a local previous registration is never carried into a git one', () => {
    const local: ProjectConfig = {
      id: 'paper',
      mode: 'local',
      path: '/home/alice/paper',
      rootFile: 'paper.tex',
      followSymlinks: true,
    };
    expect(syncRegistration('paper', URL, local)).toEqual({ id: 'paper', gitUrl: URL });
  });

  it('sets no key a previous registration left unset', () => {
    const next = syncRegistration('paper', URL, { id: 'paper', gitUrl: URL, branch: 'main' });
    expect(Object.keys(next).sort()).toEqual(['branch', 'gitUrl', 'id']);
  });
});

describe('syncDroppedNote / planSyncRegistration', () => {
  it('a git previous: the gitUrl differs, and the remedy is register_project', () => {
    const { next, note } = planSyncRegistration('paper', 'https://github.com/acme/other.git', full);
    expect(next).toEqual({ id: 'paper', gitUrl: 'https://github.com/acme/other.git' });
    expect(note).toBe(
      '\nThis gitUrl differs from the one "paper" was registered with, so its previous ' +
        'configuration was replaced, dropping its rootFile="paper.tex", branch="master", ' +
        'username="alice", tokenEnv="PAPER_TOKEN" — to keep them, call register_project with this ' +
        'gitUrl and those fields.',
    );
  });

  it('a sync that then failed is not sent back to the URL that may be why it failed', () => {
    const { failedNote } = planSyncRegistration('paper', 'https://github.com/acme/othr.git', full);
    expect(failedNote).toMatch(/dropping its rootFile="paper\.tex", branch="master"/);
    expect(failedNote).toMatch(
      / — to keep them, once the gitUrl is right, call register_project with it and those fields\.$/,
    );
    const local: ProjectConfig = { id: 'paper', mode: 'local', path: '/p', rootFile: 'a.tex' };
    expect(planSyncRegistration('paper', URL, local).failedNote).toMatch(
      /To give the git project fields of its own, once the gitUrl is right, call register_project with it and them\.$/,
    );
    expect(planSyncRegistration('paper', URL, full).failedNote).toBe('');
  });

  it('a url differing only by a login name is a re-point, worded as a differing gitUrl', () => {
    const { note } = planSyncRegistration('paper', 'https://bob@github.com/acme/paper.git', full);
    expect(note).toMatch(/^\nThis gitUrl differs from the one "paper" was registered with/);
    expect(note).not.toMatch(/remote/);
  });

  it('a local previous is worded as a local project replaced, not as another remote', () => {
    const local: ProjectConfig = {
      id: 'paper',
      mode: 'local',
      path: '/home/alice/paper',
      rootFile: 'paper.tex',
      followSymlinks: true,
    };
    const { note } = planSyncRegistration('paper', URL, local);
    expect(note).toMatch(/^\n"paper" was a local project; syncing it as a git project replaced/);
    expect(note).toContain('rootFile="paper.tex", followSymlinks=true');
    expect(note).toContain('register_project');
    expect(note).not.toMatch(/gitUrl differs|remote/);
  });
});

describe('the two dropped-fields notes render a held value alike', () => {
  /** Both notes for a git `previous` whose rootFile is `rootFile`, re-pointed to another URL. */
  function notes(rootFile: string): { register: string; sync: string } {
    const previous: ProjectConfig = { id: 'paper', gitUrl: URL, rootFile };
    const other = 'https://github.com/acme/other.git';
    const next: ProjectConfig = { id: 'paper', gitUrl: other };
    return {
      register: registrationDroppedNote('paper', droppedRegistrationFields(previous, next)),
      sync: planSyncRegistration('paper', other, previous).note,
    };
  }

  it('a bidi override or a newline in a held value reaches neither note raw', () => {
    const { register, sync } = notes('a\u202Eb\nc.tex');
    for (const note of [register, sync]) {
      expect(note).not.toContain('\u202E');
      // The sync note opens on its own line by design; nothing after that may break a line.
      expect(note.replace(/^\n/, '')).not.toContain('\n');
      expect(note).toContain('rootFile="a\\u{202E}b\\u{A}c.tex"');
    }
  });

  it('a backslash shows the same in both tools', () => {
    const { register, sync } = notes('sub\\main.tex');
    expect(register).toContain('rootFile="sub\\\\main.tex"');
    expect(sync).toContain('rootFile="sub\\\\main.tex"');
  });
});
