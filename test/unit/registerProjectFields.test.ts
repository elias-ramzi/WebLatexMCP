import { describe, it, expect } from 'vitest';
import { droppedRegistrationFields } from '../../src/tools/registerProject.js';
import type { ProjectConfig } from '../../src/types.js';

/**
 * Unit coverage for the pure helper behind `register_project`'s "dropping its ..." note.
 * `ProjectRegistry.upsert` replaces the whole stored entry on a re-registration (documented,
 * intentional — see docs/configuration.md); this helper only computes what got silently lost, it
 * never changes what gets persisted.
 */
describe('droppedRegistrationFields', () => {
  it('returns nothing for a first-time registration (no previous entry)', () => {
    const next: ProjectConfig = { id: 'paper', gitUrl: 'https://git.overleaf.com/def' };
    expect(droppedRegistrationFields(undefined, next)).toEqual([]);
  });

  it('lists a git entry’s stored optional fields the new registration does not carry, in order', () => {
    const previous: ProjectConfig = {
      id: 'paper',
      gitUrl: 'https://git.overleaf.com/def',
      rootFile: 'main.tex',
      branch: 'master',
      username: 'alice',
      tokenEnv: 'PAPER_TOKEN',
    };
    const next: ProjectConfig = { id: 'paper', gitUrl: 'https://git.overleaf.com/def' };
    expect(droppedRegistrationFields(previous, next)).toEqual([
      'rootFile=main.tex',
      'branch=master',
      'username=alice',
      'tokenEnv=PAPER_TOKEN',
    ]);
  });

  it('does not report a field the new registration also carries, even if the value changed', () => {
    const previous: ProjectConfig = {
      id: 'paper',
      gitUrl: 'https://git.overleaf.com/def',
      rootFile: 'main.tex',
      branch: 'master',
    };
    const next: ProjectConfig = {
      id: 'paper',
      gitUrl: 'https://git.overleaf.com/def',
      rootFile: 'other.tex',
      branch: 'master',
    };
    expect(droppedRegistrationFields(previous, next)).toEqual([]);
  });

  it('lists a local entry’s stored optional fields the new registration does not carry', () => {
    const previous: ProjectConfig = {
      id: 'draft',
      mode: 'local',
      path: '/home/user/draft',
      rootFile: 'main.tex',
      followSymlinks: true,
    };
    const next: ProjectConfig = { id: 'draft', mode: 'local', path: '/home/user/draft' };
    expect(droppedRegistrationFields(previous, next)).toEqual([
      'rootFile=main.tex',
      'followSymlinks=true',
    ]);
  });

  it('lists every optional field of the old entry when the kind changed from git to local', () => {
    const previous: ProjectConfig = {
      id: 'paper',
      gitUrl: 'https://git.overleaf.com/def',
      rootFile: 'main.tex',
      branch: 'master',
      username: 'alice',
      tokenEnv: 'PAPER_TOKEN',
    };
    const next: ProjectConfig = { id: 'paper', mode: 'local', path: '/home/user/paper' };
    expect(droppedRegistrationFields(previous, next)).toEqual([
      'rootFile=main.tex',
      'branch=master',
      'username=alice',
      'tokenEnv=PAPER_TOKEN',
    ]);
  });

  it('lists every optional field of the old entry when the kind changed from local to git', () => {
    const previous: ProjectConfig = {
      id: 'draft',
      mode: 'local',
      path: '/home/user/draft',
      rootFile: 'main.tex',
      followSymlinks: true,
    };
    const next: ProjectConfig = { id: 'draft', gitUrl: 'https://git.overleaf.com/draft' };
    expect(droppedRegistrationFields(previous, next)).toEqual([
      'rootFile=main.tex',
      'followSymlinks=true',
    ]);
  });

  it('returns nothing when the previous entry had no optional fields set', () => {
    const previous: ProjectConfig = { id: 'paper', gitUrl: 'https://git.overleaf.com/def' };
    const next: ProjectConfig = { id: 'paper', gitUrl: 'https://git.overleaf.com/def' };
    expect(droppedRegistrationFields(previous, next)).toEqual([]);
  });

  it('does not report rootFile on a kind change when the new registration repeats it', () => {
    // Regression: the kind-change branch used to report every one of previous's optional fields
    // unconditionally, including rootFile even when `next` set the identical value — so
    // converting "paper" from git to local while repeating rootFile: 'main.tex' still claimed it
    // was being dropped. rootFile is shared by both kinds and should survive the conversion.
    const previous: ProjectConfig = {
      id: 'paper',
      gitUrl: 'https://git.overleaf.com/def',
      rootFile: 'main.tex',
      branch: 'master',
    };
    const next: ProjectConfig = {
      id: 'paper',
      mode: 'local',
      path: '/home/user/paper',
      rootFile: 'main.tex',
    };
    // branch is git-only and cannot be carried onto a local config, so it is still dropped —
    // only rootFile (repeated) must be absent from the list.
    expect(droppedRegistrationFields(previous, next)).toEqual(['branch=master']);
  });

  it('does not report followSymlinks=false when the new registration omits it', () => {
    // followSymlinks defaults to false, so a previous entry that stored it as false explicitly
    // and a next that omits it entirely are the same effective value — nothing was lost.
    const previous: ProjectConfig = {
      id: 'draft',
      mode: 'local',
      path: '/home/user/draft',
      followSymlinks: false,
    };
    const next: ProjectConfig = { id: 'draft', mode: 'local', path: '/home/user/draft' };
    expect(droppedRegistrationFields(previous, next)).toEqual([]);
  });
});
