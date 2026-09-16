import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { SessionRegistry } from '../../src/services/sessionRegistry.js';
import type { SessionRecord } from '../../src/services/sessionRegistry.js';
import { sessionDir } from '../../src/lib/sessionPaths.js';
import {
  bootStampFrom,
  currentBootStamp,
  isSameBoot,
  PROCESS_START_MS,
} from '../../src/lib/bootIdentity.js';

const PROJECT = 'paper';

/** A pid guaranteed not to name a live process, for the "definitely dead" cases. */
const DEFINITELY_DEAD_PID = 2 ** 30;

describe('SessionRegistry', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'wlm-sessions-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Writes a hand-built session record for a peer (never `registry`'s own sessionId). */
  async function writePeerRecord(peerSessionId: string, record: SessionRecord): Promise<void> {
    const dir = sessionDir(root, PROJECT, peerSessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'session.json'), JSON.stringify(record, null, 2), 'utf8');
  }

  it('boot-reused pid, stale heartbeat, previous-boot bootedAt -> not live (the fix)', async () => {
    const registry = new SessionRegistry(root, 'me');
    const boot = currentBootStamp();
    const priorBoot = bootStampFrom(Date.parse(boot) - 24 * 60 * 60 * 1000, 0);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    await writePeerRecord('ghost', {
      sessionId: 'ghost',
      pid: process.pid, // guaranteed alive: it's us, just not our sessionId
      startedAt: twoHoursAgo,
      heartbeatAt: twoHoursAgo,
      bootedAt: priorBoot,
    });

    const peers = await registry.peers(PROJECT);
    const ghost = peers.find((p) => p.sessionId === 'ghost');
    expect(ghost?.live).toBe(false);

    const live = await registry.livePeers(PROJECT);
    expect(live.find((p) => p.sessionId === 'ghost')).toBeUndefined();
  });

  it('same-boot bootedAt with a live pid and stale heartbeat -> live (the pid clause still grants within its own boot)', async () => {
    const registry = new SessionRegistry(root, 'me');
    const boot = currentBootStamp();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    await writePeerRecord('current-boot-peer', {
      sessionId: 'current-boot-peer',
      pid: process.pid,
      startedAt: twoHoursAgo,
      heartbeatAt: twoHoursAgo,
      bootedAt: boot,
    });

    const peers = await registry.peers(PROJECT);
    const peer = peers.find((p) => p.sessionId === 'current-boot-peer');
    expect(peer?.live).toBe(true);

    const live = await registry.livePeers(PROJECT);
    expect(live.find((p) => p.sessionId === 'current-boot-peer')).toBeDefined();
  });

  it('legacy record with no bootedAt and a stale heartbeat -> not live', async () => {
    const registry = new SessionRegistry(root, 'me');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    await writePeerRecord('legacy-stale', {
      sessionId: 'legacy-stale',
      pid: process.pid,
      startedAt: twoHoursAgo,
      heartbeatAt: twoHoursAgo,
      // no bootedAt: predates the field
    });

    const peers = await registry.peers(PROJECT);
    const peer = peers.find((p) => p.sessionId === 'legacy-stale');
    expect(peer?.live).toBe(false);
  });

  it('legacy record with no bootedAt and a fresh heartbeat -> live via the bounded heartbeat clause', async () => {
    const registry = new SessionRegistry(root, 'me');
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();

    await writePeerRecord('legacy-fresh', {
      sessionId: 'legacy-fresh',
      pid: process.pid,
      startedAt: oneMinuteAgo,
      heartbeatAt: oneMinuteAgo,
      // no bootedAt
    });

    const peers = await registry.peers(PROJECT);
    const peer = peers.find((p) => p.sessionId === 'legacy-fresh');
    expect(peer?.live).toBe(true);
  });

  it('definitely-dead pid, different-boot bootedAt, fresh heartbeat -> live via the untouched heartbeat clause', async () => {
    const registry = new SessionRegistry(root, 'me');
    const boot = currentBootStamp();
    const priorBoot = bootStampFrom(Date.parse(boot) - 24 * 60 * 60 * 1000, 0);
    const oneMinuteAgo = new Date(Date.now() - 60 * 1000).toISOString();

    await writePeerRecord('dead-pid-fresh-heartbeat', {
      sessionId: 'dead-pid-fresh-heartbeat',
      pid: DEFINITELY_DEAD_PID,
      startedAt: oneMinuteAgo,
      heartbeatAt: oneMinuteAgo,
      bootedAt: priorBoot,
    });

    const peers = await registry.peers(PROJECT);
    const peer = peers.find((p) => p.sessionId === 'dead-pid-fresh-heartbeat');
    expect(peer?.live).toBe(true);
  });

  it('self is always live regardless of boot or heartbeat age, and livePeers excludes it', async () => {
    const registry = new SessionRegistry(root, 'me');
    const boot = currentBootStamp();
    const priorBoot = bootStampFrom(Date.parse(boot) - 24 * 60 * 60 * 1000, 0);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    await writePeerRecord('me', {
      sessionId: 'me',
      pid: process.pid,
      startedAt: dayAgo,
      heartbeatAt: dayAgo,
      bootedAt: priorBoot,
    });

    const peers = await registry.peers(PROJECT);
    const self = peers.find((p) => p.sessionId === 'me');
    expect(self?.live).toBe(true);
    expect(self?.self).toBe(true);

    const live = await registry.livePeers(PROJECT);
    expect(live.find((p) => p.sessionId === 'me')).toBeUndefined();
  });

  it('touch() stamps bootedAt, and preserves startedAt while re-stamping bootedAt on a later write', async () => {
    const registryA = new SessionRegistry(root, 'writer');
    await registryA.touch(PROJECT);

    const file = path.join(sessionDir(root, PROJECT, 'writer'), 'session.json');
    const first = JSON.parse(await readFile(file, 'utf8')) as SessionRecord;
    expect(first.bootedAt).toBeDefined();
    expect(isSameBoot(first.bootedAt, currentBootStamp())).toBe(true);

    // HEARTBEAT_THROTTLE_MS is per-instance, so a second SessionRegistry with the same
    // sessionId forces a second write instead of waiting out the throttle.
    const registryB = new SessionRegistry(root, 'writer');
    await registryB.touch(PROJECT);

    const second = JSON.parse(await readFile(file, 'utf8')) as SessionRecord;
    expect(second.startedAt).toBe(first.startedAt);
    expect(second.bootedAt).toBeDefined();
    expect(isSameBoot(second.bootedAt, currentBootStamp())).toBe(true);
  });

  it('collectGarbage reaps a boot-reused-pid ghost', async () => {
    const registry = new SessionRegistry(root, 'me');
    const boot = currentBootStamp();
    const priorBoot = bootStampFrom(Date.parse(boot) - 24 * 60 * 60 * 1000, 0);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    await writePeerRecord('ghost', {
      sessionId: 'ghost',
      pid: process.pid,
      startedAt: twoHoursAgo,
      heartbeatAt: twoHoursAgo,
      bootedAt: priorBoot,
    });

    const dir = sessionDir(root, PROJECT, 'ghost');
    const reaped = await registry.collectGarbage(PROJECT);
    expect(reaped).toEqual(['ghost']);
    await expect(readFile(path.join(dir, 'session.json'), 'utf8')).rejects.toThrow();
  });

  it('dead pid, current-boot bootedAt, stale heartbeat -> not live (pins that pidAlive is still consulted)', async () => {
    // Finding E: mutation-tested — deleting the `pidAlive(record.pid)` conjunct while keeping
    // `isSameBoot` left every other test in this file green. This is the combination that catches
    // it: a same-boot stamp and a fresh-enough-looking record are not enough on their own, the pid
    // itself must still be checked.
    const registry = new SessionRegistry(root, 'me');
    const boot = currentBootStamp();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    await writePeerRecord('dead-pid-current-boot', {
      sessionId: 'dead-pid-current-boot',
      pid: DEFINITELY_DEAD_PID,
      startedAt: twoHoursAgo,
      heartbeatAt: twoHoursAgo,
      bootedAt: boot,
    });

    const peers = await registry.peers(PROJECT);
    const peer = peers.find((p) => p.sessionId === 'dead-pid-current-boot');
    expect(peer?.live).toBe(false);
  });

  // Tests 10 and 11 need a heartbeat that is simultaneously (a) at or after `PROCESS_START_MS` —
  // to exercise `writtenSinceProcessStart` — and (b) at least `STALE_MS` old relative to the
  // instant `peers()` judges it, so the pre-existing, unconditional "heartbeat is merely fresh"
  // fallback (`age < STALE_MS`, which doesn't consult pid or boot at all) cannot be the reason the
  // record reads live. `PROCESS_START_MS` is captured once at real module load, which is
  // essentially "now" for a synchronous test run — so a heartbeat placed shortly after it is also,
  // unavoidably, within `STALE_MS` of real wall-clock "now" (proven below: with the naive
  // `new Date(PROCESS_START_MS + 1000)` construction and no clock control, both tests below pass
  // even against the pre-Finding-A code, because that fallback alone already grants `live: true`
  // — not a real regression test). A `Date.now()` spy moves only the "now" that `peers()` reads
  // forward by 2 hours; `PROCESS_START_MS` and the heartbeat stay at their real, unmodified values.
  describe('with the judging clock advanced past STALE_MS', () => {
    let nowSpy: ReturnType<typeof vi.spyOn>;
    const heartbeatAfterStart = new Date(PROCESS_START_MS + 1000).toISOString();

    beforeEach(() => {
      nowSpy = vi.spyOn(Date, 'now').mockReturnValue(PROCESS_START_MS + 1000 + 2 * 60 * 60 * 1000);
    });

    afterEach(() => {
      nowSpy.mockRestore();
    });

    it('drifted bootedAt, stale heartbeat, but heartbeat after this process started -> live (Finding A)', async () => {
      // The clock-drift case `writtenSinceProcessStart` exists for: `bootedAt` has drifted 8 hours
      // outside `BOOT_STAMP_TOLERANCE_MS` (simulating accumulated wall-clock drift on a long-lived
      // boot), and the heartbeat is stale relative to STALE_MS — but it was written after this
      // process started, which is a drift-immune proof the record was written during our boot.
      // Without Finding A this peer is stranded: `isSameBoot` rejects the drifted stamp and the
      // heartbeat is too old for the bounded clause, so it reads dead even though it is a live peer
      // (pid: process.pid) that would lose its uncommitted work to a peer's `commit scope: "paths"`.
      const registry = new SessionRegistry(root, 'me');
      const boot = currentBootStamp(); // reads the spied "now" too, so this lines up with peers()
      const driftedBoot = bootStampFrom(Date.parse(boot) - 8 * 60 * 60 * 1000, 0);

      await writePeerRecord('drifted', {
        sessionId: 'drifted',
        pid: process.pid,
        startedAt: heartbeatAfterStart,
        heartbeatAt: heartbeatAfterStart,
        bootedAt: driftedBoot,
      });

      const peers = await registry.peers(PROJECT);
      const peer = peers.find((p) => p.sessionId === 'drifted');
      expect(peer?.live).toBe(true);
    });

    it('legacy record with no bootedAt, heartbeat after this process started -> live (Finding B)', async () => {
      // A record with no `bootedAt` at all exists precisely because its owning process runs the
      // old build — Node does not hot-reload, so it will never write the field, however often it
      // heartbeats. Before Finding A such a record got no pid grant whatsoever and depended solely
      // on the bounded heartbeat clause, stranding a still-running old-build session once its
      // heartbeat aged past STALE_MS. `writtenSinceProcessStart` rescues it with no stamp needed.
      const registry = new SessionRegistry(root, 'me');

      await writePeerRecord('legacy-alive', {
        sessionId: 'legacy-alive',
        pid: process.pid,
        startedAt: heartbeatAfterStart,
        heartbeatAt: heartbeatAfterStart,
        // no bootedAt: predates the field, and always will for this (old-build) process
      });

      const peers = await registry.peers(PROJECT);
      const peer = peers.find((p) => p.sessionId === 'legacy-alive');
      expect(peer?.live).toBe(true);
    });
  });
});
