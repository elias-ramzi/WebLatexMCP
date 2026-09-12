import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSessionRecorder } from '../../src/lib/mutationRecorder.js';
import { ShadowStore } from '../../src/services/shadowStore.js';
import { peerOwnership } from '../../src/lib/commitPaths.js';
import { FileService } from '../../src/services/fileService.js';

/**
 * `FileService.notify` never fails a write when the mutation recorder throws — it logs to stderr
 * and moves on (the file is already on disk). That is correct, but it used to leave a real gap:
 * the session had an edit in the working tree and *no* shadow index entry for it at all, so a
 * peer's `commit scope: "paths"` saw the path as owned by nobody and would sweep it up, and the
 * session's own `commit` silently omitted it. These tests drive `createSessionRecorder` against a
 * real `ShadowStore` (a real temp-dir index, no mocks) whose `readHead` is made to fail, the way a
 * clone with an unreadable HEAD or an unwritable `.sessions/` dir would, and check the fail-closed
 * fix: the path ends up flagged `conflicted` (which is what actually excludes/stickies it) even
 * though its shadow record failed.
 */
describe('createSessionRecorder', () => {
  const PROJECT = 'demo';
  const SESSION = 'me';
  const DIR = '/clone';
  const REL = 'sections/method.tex';

  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-mutrec-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  const throwingHeadReader = (): Promise<Buffer | null> =>
    Promise.reject(new Error('git HEAD unreadable (simulated)'));

  it('rethrows when record() fails, and marks the path conflicted so a peer sees it owned', async () => {
    const shadows = new ShadowStore(workspace, SESSION, throwingHeadReader);
    const recorder = createSessionRecorder({
      idForDir: (dir) => (dir === DIR ? PROJECT : undefined),
      isLocal: () => false,
      touch: async () => {},
      record: (id, dir, rel, before, after) => shadows.record(id, dir, rel, before, after),
      markUnrecorded: (id, rel) => shadows.markUnrecorded(id, rel),
      warn: () => {},
    });

    await expect(recorder.record(DIR, REL, null, 'hello\n')).rejects.toThrow('git HEAD unreadable');

    const entries = await shadows.peerEntries(PROJECT, SESSION);
    expect(entries).toEqual([
      { path: REL, deleted: false, conflicted: true, touchedAt: expect.any(String) },
    ]);

    // The fail-closed proof: peerOwnership (what commit scope "paths" actually consults) reports
    // this path as owned by the session, not as free to sweep up.
    const { owned, unreadable } = peerOwnership(
      [REL],
      [{ sessionId: SESSION }],
      new Map([[SESSION, entries]]),
    );
    expect(unreadable).toEqual([]);
    expect(owned).toEqual([{ path: REL, sessionId: SESSION }]);
  });

  it('a touch() failure alone does not mark the path — record still runs, and the touch error still rethrows', async () => {
    // touch() is only a liveness heartbeat; it says nothing about whether the shadow itself could
    // be updated. Its failure must never mark a path conflicted/unrecorded on its own — only
    // record() failing does that. record() here is wired to a real, working ShadowStore (HEAD
    // readable), so it succeeds normally despite touch() throwing.
    const shadows = new ShadowStore(workspace, SESSION, () => Promise.resolve(null));
    let recordCalled = false;
    const recorder = createSessionRecorder({
      idForDir: () => PROJECT,
      isLocal: () => false,
      touch: async () => {
        throw new Error('touch failed (simulated)');
      },
      record: async (id, dir, rel, before, after) => {
        recordCalled = true;
        await shadows.record(id, dir, rel, before, after);
      },
      markUnrecorded: (id, rel) => shadows.markUnrecorded(id, rel),
      warn: () => {},
    });

    // The touch error is still real and still worth logging — FileService.notify logs whatever
    // this rejects with — so it is rethrown once record() has run.
    await expect(recorder.record(DIR, REL, null, 'hello\n')).rejects.toThrow(
      'touch failed (simulated)',
    );
    expect(recordCalled).toBe(true);

    // Not marked: the shadow holds a normal, unflagged entry for the write that actually
    // succeeded, exactly as if touch() had never been wired to fail at all.
    const entries = await shadows.peerEntries(PROJECT, SESSION);
    expect(entries).toEqual([
      { path: REL, deleted: false, conflicted: false, touchedAt: expect.any(String) },
    ]);
  });

  it('rethrows and marks the path when record() fails even though touch() also failed', async () => {
    // Both fail: record()'s failure is what marks the path (touch's failure is incidental here),
    // and the record error — not the touch error — is what gets rethrown, since markUnrecorded
    // fires on record()'s failure path.
    const recorder = createSessionRecorder({
      idForDir: () => PROJECT,
      isLocal: () => false,
      touch: async () => {
        throw new Error('touch failed (simulated)');
      },
      record: async () => {
        throw new Error('git HEAD unreadable (simulated)');
      },
      markUnrecorded: async () => {},
      warn: () => {},
    });

    await expect(recorder.record(DIR, REL, null, 'hello\n')).rejects.toThrow('git HEAD unreadable');
  });

  it('does nothing for a local project — no touch, no record, no marking', async () => {
    let touched = false;
    let recorded = false;
    let marked = false;
    const recorder = createSessionRecorder({
      idForDir: () => PROJECT,
      isLocal: () => true,
      touch: async () => {
        touched = true;
      },
      record: async () => {
        recorded = true;
      },
      markUnrecorded: async () => {
        marked = true;
      },
    });

    await expect(recorder.record(DIR, REL, null, 'hello\n')).resolves.toBeUndefined();
    expect(touched).toBe(false);
    expect(recorded).toBe(false);
    expect(marked).toBe(false);
  });

  it('does nothing for a dir that maps to no known project', async () => {
    let called = false;
    const recorder = createSessionRecorder({
      idForDir: () => undefined,
      isLocal: () => false,
      touch: async () => {
        called = true;
      },
      record: async () => {
        called = true;
      },
      markUnrecorded: async () => {
        called = true;
      },
    });

    await expect(recorder.record('/somewhere-else', REL, null, 'x')).resolves.toBeUndefined();
    expect(called).toBe(false);
  });

  it('warns, and still rethrows the original error, when markUnrecorded itself throws', async () => {
    const warnings: string[] = [];
    const recorder = createSessionRecorder({
      idForDir: () => PROJECT,
      isLocal: () => false,
      touch: async () => {},
      record: async () => {
        throw new Error('original record failure');
      },
      markUnrecorded: async () => {
        throw new Error('marking failed too');
      },
      warn: (msg) => warnings.push(msg),
    });

    await expect(recorder.record(DIR, REL, null, 'x')).rejects.toThrow('original record failure');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('marking failed too');
  });

  it('through a real FileService: the write still resolves even though the index gets marked', async () => {
    const clone = await mkdtemp(path.join(os.tmpdir(), 'wlm-mutrec-clone-'));
    try {
      const shadows = new ShadowStore(workspace, SESSION, throwingHeadReader);
      const files = new FileService();
      files.setMutationRecorder(
        createSessionRecorder({
          idForDir: (dir) => (dir === clone ? PROJECT : undefined),
          isLocal: () => false,
          touch: async () => {},
          record: (id, dir, rel, before, after) => shadows.record(id, dir, rel, before, after),
          markUnrecorded: (id, rel) => shadows.markUnrecorded(id, rel),
          warn: () => {}, // FileService.notify also logs the original failure to stderr itself
        }),
      );

      // FileService.notify swallows whatever the recorder throws — the write must still succeed.
      await expect(
        files.write(clone, { path: REL, content: 'hello\n', createDirs: true }),
      ).resolves.toMatchObject({ path: REL });

      const entries = await shadows.peerEntries(PROJECT, SESSION);
      expect(entries).toEqual([
        { path: REL, deleted: false, conflicted: true, touchedAt: expect.any(String) },
      ]);
    } finally {
      await rm(clone, { recursive: true, force: true });
    }
  });

  describe('pre-fix proof', () => {
    it('the gap was real: the OLD inline recorder from context.ts left peerEntries empty on failure', async () => {
      // Before this task, `src/context.ts` built the mutation recorder inline, with no
      // `markUnrecorded` and no try/catch — these are literally its 6 lines, reproduced here so
      // the difference is visible directly rather than asserted about code nobody can see. This
      // ran with a live ShadowStore against the exact same failing `readHead` used above.
      const shadows = new ShadowStore(workspace, SESSION, throwingHeadReader);
      const oldInlineRecorder = {
        record: async (
          projectDir: string,
          relPath: string,
          before: string | Buffer | null,
          after: string | Buffer | null,
        ): Promise<void> => {
          const id = projectDir === DIR ? PROJECT : undefined;
          if (!id) return; // not one of our clones
          // (isLocal check omitted here — irrelevant to this project)
          await shadows.record(id, projectDir, relPath, before, after);
        },
      };

      await expect(oldInlineRecorder.record(DIR, REL, null, 'hello\n')).rejects.toThrow(
        'git HEAD unreadable',
      );

      // The gap, made concrete: nothing at all is left in the session's index, so a peer reading
      // it (exactly as `commit scope: "paths"` does via `peerOwnership`) sees the path as owned
      // by nobody and would happily sweep up this session's in-flight edit.
      const entries = await shadows.peerEntries(PROJECT, SESSION);
      expect(entries).toEqual([]);
    });
  });
});
