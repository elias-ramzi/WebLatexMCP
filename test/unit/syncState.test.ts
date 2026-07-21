import { describe, it, expect } from 'vitest';
import { syncState, syncSummary } from '../../src/lib/syncState.js';

describe('syncState', () => {
  it('classifies the four states from ahead/behind', () => {
    expect(syncState(0, 0)).toBe('in-sync');
    expect(syncState(2, 0)).toBe('ahead');
    expect(syncState(0, 3)).toBe('behind');
    expect(syncState(1, 1)).toBe('diverged');
  });
});

describe('syncSummary', () => {
  it('leads with divergence and the push-may-conflict consequence when ahead and behind', () => {
    const s = syncSummary('main', 1, 2);
    expect(s).toMatch(/diverged/);
    expect(s).toMatch(/1 ahead/);
    expect(s).toMatch(/2 behind/);
    expect(s).toMatch(/may conflict/);
  });

  it('flags a moved remote when only behind', () => {
    const s = syncSummary('main', 0, 4);
    expect(s).toMatch(/behind 4/);
    expect(s).toMatch(/origin\/main moved/);
    expect(s).toMatch(/before pushing/);
  });

  it('flags unpushed commits when only ahead', () => {
    expect(syncSummary('master', 3, 0)).toMatch(/ahead 3.*unpushed/);
  });

  it('reports in-sync when neither ahead nor behind', () => {
    expect(syncSummary('main', 0, 0)).toBe('in sync with origin/main');
  });
});
