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
  LEGACY_PID_GRACE_MS,
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

  /**
   * Writes a hand-built session record for any session — usually a peer, but deliberately also
   * `registry`'s own sessionId, which is how the `self` case and the `touch()` re-stamping case
   * seed a record that was already on disk before the registry under test was constructed.
   */
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

  it('legacy record with no bootedAt, idle past the legacy grace -> not live', async () => {
    // The bounded end of `withinLegacyPidGrace`. A stampless record keeps its pid grant while it
    // is young enough to be a still-running old-build session, but the grant expires — that bound
    // is the whole difference from the unbounded pid clause this module was written to fix, so a
    // legacy ghost whose pid has been reused clears itself within a day rather than blocking
    // `push` forever with no cure but a hand-deleted file.
    const registry = new SessionRegistry(root, 'me');
    const pastGrace = new Date(Date.now() - (LEGACY_PID_GRACE_MS + 60 * 60 * 1000)).toISOString();

    await writePeerRecord('legacy-stale', {
      sessionId: 'legacy-stale',
      pid: process.pid, // alive, and deliberately so: only the age may decide this one
      startedAt: pastGrace,
      heartbeatAt: pastGrace,
      // no bootedAt: predates the field
    });

    const peers = await registry.peers(PROJECT);
    const peer = peers.find((p) => p.sessionId === 'legacy-stale');
    expect(peer?.live).toBe(false);
  });

  it('legacy record with no bootedAt, idle past STALE_MS but inside the legacy grace -> live', async () => {
    // The fail-open this grace closes. A still-running old-build session (its pid answers, and it
    // can never write `bootedAt` — Node does not hot-reload) that has simply been waiting on its
    // user: heartbeats come only from `status`, `commit`, `push` and the mutation recorder, so two
    // hours of thinking puts it well past `STALE_MS`. Before the grace it read dead, its peer's
    // `guardPeerWork` saw no live session, and a `push` carrying a `message` (`git add -A`) or a
    // `commit scope: "paths"` took its uncommitted lines.
    //
    // `writtenSinceProcessStart` must not be what grants this, or the test would pin the wrong
    // route. Anchoring the heartbeat to `PROCESS_START_MS - 1000` makes that provable rather than
    // incidental: written *before* this process started, so that route is false by construction.
    // A plain `Date.now() - 2h` would instead be true whenever the vitest worker happened to be
    // older than two hours — passing for the wrong reason rather than failing, which is the way a
    // test goes quiet without anyone noticing (the block below this one exists for the same
    // hazard). The `Date.now` spy then puts "now" two hours past that heartbeat: comfortably
    // beyond `STALE_MS`, comfortably inside `LEGACY_PID_GRACE_MS`, leaving the grace as the only
    // clause that can grant.
    const registry = new SessionRegistry(root, 'me');
    const heartbeatBeforeStart = new Date(PROCESS_START_MS - 1000).toISOString();
    const nowSpy = vi
      .spyOn(Date, 'now')
      .mockReturnValue(PROCESS_START_MS - 1000 + 2 * 60 * 60 * 1000);

    try {
      await writePeerRecord('legacy-idle', {
        sessionId: 'legacy-idle',
        pid: process.pid, // guaranteed alive: the old-build process is genuinely still running
        startedAt: heartbeatBeforeStart,
        heartbeatAt: heartbeatBeforeStart,
        // no bootedAt: predates the field, and that process will never write one
      });

      const peers = await registry.peers(PROJECT);
      const peer = peers.find((p) => p.sessionId === 'legacy-idle');
      expect(peer?.live).toBe(true);

      // And it is protected where it counts: `livePeers` is what `guardPeerWork` consults.
      const live = await registry.livePeers(PROJECT);
      expect(live.find((p) => p.sessionId === 'legacy-idle')).toBeDefined();
    } finally {
      nowSpy.mockRestore();
    }
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

  it('touch() re-stamps a record left behind by a previous boot, rather than carrying its bootedAt forward', async () => {
    // The asymmetry in `touch()` — `startedAt` carried forward from `existing`, `bootedAt`
    // re-derived on every write — is the whole point of this test. `startedAt` describes the
    // session and stays true for its life; a process cannot outlive the boot that started it, so
    // a carried-forward `bootedAt` is stale *by construction* the moment the record survives a
    // reboot. This is that record: the same session id found again on disk by a new process,
    // stamped with the boot before last.
    //
    // The failure direction is **fail-open**, which is why it is worth a test of its own: a
    // carried stamp names a previous boot, so `isSameBoot` refuses a session that is genuinely
    // running right now, it loses its pid grant, and once it idles past `STALE_MS` it reads dead
    // to its peers — `push` (`git add -A` when given a `message`) and `commit scope: "paths"` are
    // then free to take its uncommitted lines. It could never reintroduce the ghost, since a
    // stale stamp only ever revokes a grant.
    //
    // Not a duplicate of the neighbouring `touch() stamps bootedAt...` test, which cannot see
    // this: every record it writes is stamped by `touch()` itself, so its "first" stamp is
    // already the current boot and carry-forward is indistinguishable from re-stamping. Only a
    // *hand-seeded* prior-boot stamp separates the two. The `heartbeatAt` pair does its own,
    // separate work: it pins that `heartbeatAt` is re-stamped rather than carried forward the way
    // `startedAt` is. (It is not what catches a `touch()` that returns early on an existing
    // record — the `bootedAt` assertion below throws first under that mutation, since nothing is
    // written and the seeded stamp survives.)
    const priorBoot = bootStampFrom(Date.parse(currentBootStamp()) - 24 * 60 * 60 * 1000, 0);
    const oldStartedAt = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString();
    // Seeded in the past rather than at "now": `touch()` stamps `heartbeatAt` from the wall clock,
    // so a same-millisecond seed would make "rewrote" and "never wrote" look alike again.
    const oldHeartbeatAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    // `writePeerRecord` writes any session's file; here, deliberately, the registry's **own**
    // sessionId — the pre-reboot record `touch()` is about to find as `existing`.
    await writePeerRecord('survivor', {
      sessionId: 'survivor',
      pid: DEFINITELY_DEAD_PID, // the pre-reboot process; its pid means nothing now
      startedAt: oldStartedAt,
      heartbeatAt: oldHeartbeatAt,
      bootedAt: priorBoot,
    });

    // A fresh instance has never written, and HEARTBEAT_THROTTLE_MS is per-instance, so this
    // `touch()` is not throttled by the seeded record's age.
    const registry = new SessionRegistry(root, 'survivor');
    await registry.touch(PROJECT);

    const file = path.join(sessionDir(root, PROJECT, 'survivor'), 'session.json');
    const written = JSON.parse(await readFile(file, 'utf8')) as SessionRecord;

    // `startedAt` is still carried forward — pinned here so this test cannot be satisfied by
    // making the *opposite* mutation and re-stamping both fields.
    expect(written.startedAt).toBe(oldStartedAt);

    // `bootedAt` is re-derived, not carried.
    expect(written.bootedAt).not.toBe(priorBoot);
    expect(isSameBoot(written.bootedAt, currentBootStamp())).toBe(true);

    // And a write actually landed, rather than `touch()` short-circuiting on `existing`.
    expect(written.heartbeatAt).not.toBe(oldHeartbeatAt);
    expect(Date.parse(written.heartbeatAt)).toBeGreaterThanOrEqual(Date.parse(oldHeartbeatAt));
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
  describe('with the judging clock advanced past STALE_MS and the legacy grace', () => {
    let nowSpy: ReturnType<typeof vi.spyOn>;
    const heartbeatAfterStart = new Date(PROCESS_START_MS + 1000).toISOString();

    beforeEach(() => {
      // Advanced past `LEGACY_PID_GRACE_MS`, not merely past `STALE_MS`, so that neither bounded
      // clause can be the reason these records read live: the stampless case below would otherwise
      // be granted by `withinLegacyPidGrace` and stop isolating `writtenSinceProcessStart`, which
      // is the only route either test is here to pin. `writtenSinceProcessStart` compares the
      // heartbeat against `PROCESS_START_MS` and never against "now", so advancing the clock
      // leaves it granting while both age-bounded routes die.
      nowSpy = vi
        .spyOn(Date, 'now')
        .mockReturnValue(PROCESS_START_MS + 1000 + LEGACY_PID_GRACE_MS + 2 * 60 * 60 * 1000);
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

  // The two degradation paths for an unreadable boot stamp. `currentBootStamp()` reads
  // `os.uptime()`, which libuv fails where neither `/proc/uptime` nor `CLOCK_BOOTTIME` is
  // available (a containerised case libuv itself calls out), so both of them are reachable code,
  // not defensive decoration. `os.uptime()` is a property access made at call time inside
  // `bootIdentity`, so a spy on the shared `node:os` namespace object intercepts it.
  it('touch() still writes the record, with bootedAt absent, when the boot stamp is unreadable', async () => {
    // This registry is advisory — "a missing or stale registry only ever costs visibility" — so a
    // heartbeat must never fail merely because the boot stamp could not be read. `touch()` goes
    // through `readBootStamp()`, which degrades to `undefined`, and `JSON.stringify` then drops
    // the key. Regressing this to a bare `currentBootStamp()` would reject the heartbeat promise
    // and take `status` / `commit` / `push` down with it on exactly the platform the degradation
    // exists for — a hard failure, which is worse than either liveness-verdict direction.
    const uptimeSpy = vi.spyOn(os, 'uptime').mockImplementation(() => {
      throw new Error('uptime unavailable');
    });
    try {
      const registry = new SessionRegistry(root, 'stampless-writer');
      await expect(registry.touch(PROJECT)).resolves.toBeUndefined();

      const file = path.join(sessionDir(root, PROJECT, 'stampless-writer'), 'session.json');
      const parsed = JSON.parse(await readFile(file, 'utf8')) as SessionRecord;
      expect(parsed.sessionId).toBe('stampless-writer');
      expect(parsed.pid).toBe(process.pid);
      expect(typeof parsed.startedAt).toBe('string');
      expect(typeof parsed.heartbeatAt).toBe('string');
      // Stronger than `toBeUndefined()`: it pins that the key is *omitted*, not written as `null`
      // or the string "undefined" — only a genuinely absent key reads back as the legacy,
      // stampless record that `isSameBoot` and the peers below are written to handle.
      expect('bootedAt' in parsed).toBe(false);
    } finally {
      uptimeSpy.mockRestore();
    }
  });

  it('peers() grants the pid clause on pidAlive alone when the boot stamp is unreadable', async () => {
    // The same record, judged twice, with the only variable being whether `currentBootStamp()`
    // can be read. It is built to read **dead** under a working stamp: a live pid, a `bootedAt`
    // from a previous boot (so `isSameBoot` refuses), and a two-hour-old heartbeat (so neither
    // `writtenSinceProcessStart` nor the bounded `age < STALE_MS` clause can be the reason it
    // reads live). The first test in this file pins that verdict; the assertion below re-pins it
    // here so the contrast is visible in one place.
    //
    // With the stamp unreadable, `peers()` sets `boot = null` and the whole stamp check
    // short-circuits to true, so the pid clause grants on `pidAlive` alone — the pre-boot-scoping
    // behaviour, deliberately fail-closed: it can grant a spurious `live` (a refusal the user can
    // work around) but can never sweep a live peer's uncommitted work. Regressing it the other
    // way — denying the pid clause when the stamp cannot be read — is the fail-open direction, on
    // exactly the platform this fallback exists for: a genuinely live peer would read dead, and
    // `push` (`git add -A`) or `commit scope: "paths"` would take its uncommitted lines with
    // nothing failing.
    const registry = new SessionRegistry(root, 'me');
    // Computed before the spy is installed: `currentBootStamp()` throws under it.
    const priorBoot = bootStampFrom(Date.parse(currentBootStamp()) - 24 * 60 * 60 * 1000, 0);
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    await writePeerRecord('stampless-judge', {
      sessionId: 'stampless-judge',
      pid: process.pid, // guaranteed alive
      startedAt: twoHoursAgo,
      heartbeatAt: twoHoursAgo,
      bootedAt: priorBoot,
    });

    const withStamp = await registry.peers(PROJECT);
    expect(withStamp.find((p) => p.sessionId === 'stampless-judge')?.live).toBe(false);

    const uptimeSpy = vi.spyOn(os, 'uptime').mockImplementation(() => {
      throw new Error('uptime unavailable');
    });
    try {
      const withoutStamp = await registry.peers(PROJECT);
      expect(withoutStamp.find((p) => p.sessionId === 'stampless-judge')?.live).toBe(true);
    } finally {
      uptimeSpy.mockRestore();
    }
  });
});
