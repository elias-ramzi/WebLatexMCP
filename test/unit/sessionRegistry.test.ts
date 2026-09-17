import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { SessionRegistry } from '../../src/services/sessionRegistry.js';
import type { SessionRecord } from '../../src/services/sessionRegistry.js';
import { sessionDir, sessionStateDir } from '../../src/lib/sessionPaths.js';
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

  describe('release()', () => {
    it('removes only session.json, leaving the rest of the session directory byte-identical (invariants 3 and 4)', async () => {
      // `commit scope: "paths"` and `push` refuse on a live peer's session.json *and* shadow.json
      // together, and CLAUDE.md is explicit that release() removes "only the record", leaving the
      // directory standing. Assert bytes, not merely "the directory still exists" — a directory-only
      // check would pass even if release() were regressed to a recursive rm of the whole session
      // directory, which would silently eat the shadow index alongside the heartbeat record.
      const registry = new SessionRegistry(root, 'me');
      await registry.touch(PROJECT);

      const dir = sessionDir(root, PROJECT, 'me');
      const shadowJson = JSON.stringify({ 'main.tex': { conflicted: false } }, null, 2);
      const shadowTex = '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n';
      await mkdir(path.join(dir, 'shadow'), { recursive: true });
      await writeFile(path.join(dir, 'shadow.json'), shadowJson, 'utf8');
      await writeFile(path.join(dir, 'shadow', 'main.tex'), shadowTex, 'utf8');

      await registry.release(PROJECT);

      await expect(readFile(path.join(dir, 'session.json'), 'utf8')).rejects.toThrow();
      expect(await readFile(path.join(dir, 'shadow.json'), 'utf8')).toBe(shadowJson);
      expect(await readFile(path.join(dir, 'shadow', 'main.tex'), 'utf8')).toBe(shadowTex);
    });

    it('resolves for a project this session never touched, rather than rejecting', async () => {
      // src/index.ts:72 runs `for (const id of ctx.sessions.trackedProjects()) void
      // ctx.sessions.release(id).catch(() => {})` on shutdown, and `force: true` is what makes a
      // *missing record* a no-op there. This pins the case one layer further out than that: no
      // session directory at all, not merely a directory with the record already gone.
      const registry = new SessionRegistry(root, 'never-touched');
      await expect(registry.release(PROJECT)).resolves.toBeUndefined();
    });

    it("removes only this session's record, leaving a live peer's session.json intact", async () => {
      const registry = new SessionRegistry(root, 'me');
      await registry.touch(PROJECT);

      const peerRecord: SessionRecord = {
        sessionId: 'peer',
        pid: process.pid,
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        bootedAt: currentBootStamp(),
      };
      await writePeerRecord('peer', peerRecord);

      await registry.release(PROJECT);

      expect(
        JSON.parse(
          await readFile(path.join(sessionDir(root, PROJECT, 'peer'), 'session.json'), 'utf8'),
        ),
      ).toEqual(peerRecord);

      const peers = await registry.peers(PROJECT);
      expect(peers.map((p) => p.sessionId)).toEqual(['peer']);
    });
  });

  describe('trackedProjects()', () => {
    it('is empty before any touch(), and gains each project exactly once thereafter', async () => {
      // Shutdown releases exactly what this returns (src/index.ts:72) — a missing key here leaks a
      // session record forever (a dead session reads live to its peers until STALE_MS), and a
      // duplicate would mean release() is asked to remove the same project's record twice for no
      // reason.
      const registry = new SessionRegistry(root, 'me');
      expect(registry.trackedProjects()).toEqual([]);

      await registry.touch('paper');
      await registry.touch('thesis');
      // `lastHeartbeat.set` runs *before* the write inside touch(), and the very first call is what
      // registers the key. A second, immediate touch('paper') is swallowed by the
      // HEARTBEAT_THROTTLE_MS early-return before it ever reaches the map again, so it must be a
      // pure no-op here — neither dropping the key nor adding a duplicate.
      await registry.touch('paper');

      const tracked = registry.trackedProjects();
      expect(tracked.filter((id) => id === 'paper')).toHaveLength(1);
      expect(tracked.filter((id) => id === 'thesis')).toHaveLength(1);
      expect(tracked).toHaveLength(2);
    });

    it('throttles the heartbeat per project, not globally', async () => {
      // A shared throttle would starve one project's heartbeat whenever a session touches several
      // projects in quick succession, and a starved heartbeat is the fail-open direction this whole
      // module exists to avoid: a live session's heartbeatAt goes stale and it reads dead to its
      // peers well before it actually stopped working.
      const registry = new SessionRegistry(root, 'me');

      await registry.touch('paper');
      const paperFile = path.join(sessionDir(root, 'paper', 'me'), 'session.json');
      const firstPaper = JSON.parse(await readFile(paperFile, 'utf8')) as SessionRecord;

      await registry.touch('thesis');
      const thesisFile = path.join(sessionDir(root, 'thesis', 'me'), 'session.json');
      const thesisRecord = JSON.parse(await readFile(thesisFile, 'utf8')) as SessionRecord;
      expect(thesisRecord.sessionId).toBe('me');

      // Immediately re-touch 'paper' — still well within HEARTBEAT_THROTTLE_MS of the first paper
      // write. The intervening 'thesis' touch must not have reset paper's own throttle.
      await registry.touch('paper');
      const secondPaper = JSON.parse(await readFile(paperFile, 'utf8')) as SessionRecord;
      expect(secondPaper.heartbeatAt).toBe(firstPaper.heartbeatAt);
    });
  });

  describe('touch() under concurrency', () => {
    it('dedupes concurrent touch() calls on one registry, rather than colliding in writeAtomic', async () => {
      // The synchronous `lastHeartbeat.set` *before* the first `await` inside touch() is what makes
      // the throttle dedupe **concurrent** callers, not merely sequential ones — and that is
      // load-bearing, because `writeAtomic`'s temp name is `${target}.${process.pid}.tmp`, which is
      // unique per *process*, not per *call*. Let two concurrent touches past the throttle and they
      // race for one shared temp file: the first rename consumes it and every other one rejects
      // with ENOENT. touch() is not wrapped in a catch at three of its four call sites
      // (src/tools/status.ts, src/tools/commit.ts, src/tools/push.ts; only
      // src/lib/mutationRecorder.ts swallows), so that surfaces as a hard tool failure out of a
      // registry whose stated contract is that "a missing or stale registry only ever costs
      // visibility" — invariant 1, in the worst direction.
      //
      // Concurrency here is realistic rather than contrived: `status` is read-only and takes no
      // runExclusive lock, so a status in flight against a commit or push on the same project
      // shares one SessionRegistry instance in one process.
      //
      // Deterministic on correct code — the `set` happens before any await, so the first caller
      // always wins the throttle and the other seven return early without writing.
      const registry = new SessionRegistry(root, 'me');

      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => registry.touch(PROJECT)),
      );
      expect(
        results
          .filter((r) => r.status === 'rejected')
          .map((r) => String((r as PromiseRejectedResult).reason)),
      ).toEqual([]);

      // Exactly one record, and no `.tmp` file left behind by a lost race.
      const dir = sessionDir(root, PROJECT, 'me');
      expect((await readdir(dir)).sort()).toEqual(['session.json']);
      const record = JSON.parse(
        await readFile(path.join(dir, 'session.json'), 'utf8'),
      ) as SessionRecord;
      expect(record.sessionId).toBe('me');
    });
  });

  describe('corrupt and unreadable records', () => {
    it('skips a session directory with invalid JSON in session.json, rather than throwing (invariant 1)', async () => {
      // peers() must never throw: it feeds livePeers() feeds guardPeerWork
      // (src/lib/peerRefusal.ts), and a throw there hard-fails status, commit and push for every
      // session sharing the project — not just the one with the bad record.
      const registry = new SessionRegistry(root, 'me');
      const badDir = sessionDir(root, PROJECT, 'truncated');
      await mkdir(badDir, { recursive: true });
      await writeFile(path.join(badDir, 'session.json'), '{"sessionId": "trunc"', 'utf8');

      await writePeerRecord('good', {
        sessionId: 'good',
        pid: process.pid,
        startedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        bootedAt: currentBootStamp(),
      });

      const peers = await registry.peers(PROJECT);
      expect(peers.map((p) => p.sessionId)).toEqual(['good']);
    });

    it('skips a session directory with no session.json at all — precisely what release() leaves behind', async () => {
      const registry = new SessionRegistry(root, 'me');
      await registry.touch(PROJECT);
      await registry.release(PROJECT);

      const peers = await registry.peers(PROJECT);
      expect(peers).toEqual([]);
    });

    it('collectGarbage() must not reap a corrupt-record directory (invariant 2)', async () => {
      // The fail-closed reading `attributePeers`/`isStalePeer` (src/lib/peerSummary.ts) use for a
      // null shadow index: a record that cannot be read is UNREADABLE, never "owns nothing". If
      // collectGarbage ever treated an unreadable record as dead, it would delete a shadow index
      // that `commit scope: "paths"` and `push` refuse on — silently turning an unattributable peer
      // into vanished evidence instead of a visible refusal the user can work around.
      const registry = new SessionRegistry(root, 'me');
      const boot = currentBootStamp();
      const priorBoot = bootStampFrom(Date.parse(boot) - 24 * 60 * 60 * 1000, 0);
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      // A genuinely dead ghost — same shape as the "collectGarbage reaps a boot-reused-pid ghost"
      // test above — must still be reaped.
      await writePeerRecord('ghost', {
        sessionId: 'ghost',
        pid: process.pid,
        startedAt: twoHoursAgo,
        heartbeatAt: twoHoursAgo,
        bootedAt: priorBoot,
      });

      // A directory holding an unreadable record and a shadow index, and nothing else.
      const unreadableDir = sessionDir(root, PROJECT, 'unreadable');
      await mkdir(unreadableDir, { recursive: true });
      await writeFile(path.join(unreadableDir, 'session.json'), '{not json', 'utf8');
      const shadowJson = JSON.stringify({ 'main.tex': {} }, null, 2);
      await writeFile(path.join(unreadableDir, 'shadow.json'), shadowJson, 'utf8');

      const reaped = await registry.collectGarbage(PROJECT);
      expect(reaped).toEqual(['ghost']);

      await expect(
        readFile(path.join(sessionDir(root, PROJECT, 'ghost'), 'session.json'), 'utf8'),
      ).rejects.toThrow();
      // The unreadable directory's shadow.json must survive untouched.
      expect(await readFile(path.join(unreadableDir, 'shadow.json'), 'utf8')).toBe(shadowJson);
    });

    it('touch() over an existing corrupt session.json (our own) re-seeds it rather than rejecting', async () => {
      // `existing` inside touch() comes from the same readRecord() that treats unparseable JSON as
      // null everywhere else. A throw here would fail every future heartbeat for this session after
      // one crash mid-write — status/commit/push would hard-fail forever, not just miss one beat.
      const dir = sessionDir(root, PROJECT, 'crashed');
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, 'session.json'),
        '{"sessionId": "crashed", "startedAt": "unparse',
        'utf8',
      );

      const registry = new SessionRegistry(root, 'crashed');
      await expect(registry.touch(PROJECT)).resolves.toBeUndefined();

      const written = JSON.parse(
        await readFile(path.join(dir, 'session.json'), 'utf8'),
      ) as SessionRecord;
      expect(written.sessionId).toBe('crashed');
      // A fresh startedAt, not anything carried forward from the unparseable bytes — there was
      // nothing valid in them to carry.
      expect(typeof written.startedAt).toBe('string');
      expect(Date.parse(written.startedAt)).toBeGreaterThan(Date.now() - 5_000);
    });
  });

  describe('peers() ordering', () => {
    it('sorts peers by heartbeatAt, most recent first, regardless of write order', async () => {
      // status presents peers in this order, and a reader takes the head of the list as "most
      // likely still around". A reversed comparator would make the *least* recently seen peer look
      // like the most active — exactly backwards.
      const registry = new SessionRegistry(root, 'me');
      const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      // Written in an order that does not match the expected sorted order (3h, then 10m, then 1h),
      // so a test that merely preserved write/readdir order could not pass by accident.
      await writePeerRecord('oldest', {
        sessionId: 'oldest',
        pid: process.pid,
        startedAt: threeHoursAgo,
        heartbeatAt: threeHoursAgo,
        bootedAt: currentBootStamp(),
      });
      await writePeerRecord('newest', {
        sessionId: 'newest',
        pid: process.pid,
        startedAt: tenMinutesAgo,
        heartbeatAt: tenMinutesAgo,
        bootedAt: currentBootStamp(),
      });
      await writePeerRecord('middle', {
        sessionId: 'middle',
        pid: process.pid,
        startedAt: oneHourAgo,
        heartbeatAt: oneHourAgo,
        bootedAt: currentBootStamp(),
      });

      const peers = await registry.peers(PROJECT);
      expect(peers.map((p) => p.sessionId)).toEqual(['newest', 'middle', 'oldest']);
    });

    it('an unparseable heartbeatAt does not throw, does not evict the other peers, and does not disturb their order', async () => {
      // Honesty about what this pins: `age` is `NaN` for the bad record, and `NaN < STALE_MS` is
      // already `false` in JS, so the `Number.isFinite(age)` conjunct in the liveness expression is
      // belt-and-braces here — deleting *that specific guard* does not turn this test red. What
      // this test actually pins is the outcome around it: peers() must not throw on an unparseable
      // heartbeatAt, the malformed record must not evict the other, well-formed peers from the
      // result, their relative order must survive, and — given a DEFINITELY_DEAD_PID and a
      // previous-boot bootedAt so no other clause can grant it a live verdict — the bad record
      // itself must read live: false.
      const registry = new SessionRegistry(root, 'me');
      const boot = currentBootStamp();
      const priorBoot = bootStampFrom(Date.parse(boot) - 24 * 60 * 60 * 1000, 0);
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

      await writePeerRecord('newest', {
        sessionId: 'newest',
        pid: process.pid,
        startedAt: tenMinutesAgo,
        heartbeatAt: tenMinutesAgo,
        bootedAt: boot,
      });
      await writePeerRecord('bad-heartbeat', {
        sessionId: 'bad-heartbeat',
        pid: DEFINITELY_DEAD_PID,
        startedAt: oneHourAgo,
        heartbeatAt: 'not a date',
        bootedAt: priorBoot,
      });
      await writePeerRecord('oldest', {
        sessionId: 'oldest',
        pid: process.pid,
        startedAt: oneHourAgo,
        heartbeatAt: oneHourAgo,
        bootedAt: boot,
      });

      const peers = await registry.peers(PROJECT);
      const ids = peers.map((p) => p.sessionId);
      expect(ids).toContain('newest');
      expect(ids).toContain('oldest');
      expect(ids).toContain('bad-heartbeat');

      // The relative order of the two well-formed peers is unaffected by the malformed one sitting
      // among them — deliberately not asserting where 'bad-heartbeat' itself lands, since NaN's
      // position under Array.prototype.sort's comparator is not something this module specifies.
      const wellFormedOrder = peers
        .filter((p) => p.sessionId !== 'bad-heartbeat')
        .map((p) => p.sessionId);
      expect(wellFormedOrder).toEqual(['newest', 'oldest']);

      expect(peers.find((p) => p.sessionId === 'bad-heartbeat')?.live).toBe(false);
    });
  });

  describe('collectGarbage()', () => {
    it('spares a live peer and self, reaping only a demonstrably dead ghost (invariants 3 and 5)', async () => {
      const registry = new SessionRegistry(root, 'self-session');
      const boot = currentBootStamp();
      const priorBoot = bootStampFrom(Date.parse(boot) - 24 * 60 * 60 * 1000, 0);
      const now = new Date().toISOString();
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      // A genuinely live peer, with a shadow index that must survive — commit scope: "paths" and
      // push refuse on exactly this file for a live peer.
      await writePeerRecord('live-peer', {
        sessionId: 'live-peer',
        pid: process.pid,
        startedAt: now,
        heartbeatAt: now,
        bootedAt: boot,
      });
      const livePeerDir = sessionDir(root, PROJECT, 'live-peer');
      const liveShadow = JSON.stringify({ 'notes.tex': {} }, null, 2);
      await writeFile(path.join(livePeerDir, 'shadow.json'), liveShadow, 'utf8');

      // The boot-reused-pid ghost shape used by the earlier "collectGarbage reaps a boot-reused-pid
      // ghost" test — genuinely dead, and the only one that should be reaped.
      await writePeerRecord('ghost', {
        sessionId: 'ghost',
        pid: process.pid,
        startedAt: twoHoursAgo,
        heartbeatAt: twoHoursAgo,
        bootedAt: priorBoot,
      });
      // The ghost gets a shadow index too, so this pins that collectGarbage removes the *whole*
      // session directory and not merely its session.json. Narrowing that rm to the record alone
      // fails closed — it leaks a dead session's shadow bytes on disk forever rather than
      // destroying a live peer's proof — but it leaks silently: peers() would keep returning
      // nothing for the directory, so nothing downstream would ever notice it was still there.
      const ghostDir = sessionDir(root, PROJECT, 'ghost');
      const ghostShadow = JSON.stringify({ 'dead.tex': {} }, null, 2);
      await writeFile(path.join(ghostDir, 'shadow.json'), ghostShadow, 'utf8');

      // Our own record, written under the registry's own sessionId and deliberately made to look
      // dead (a definitely-dead pid, a stale heartbeat, no bootedAt) — self must never be reaped,
      // whatever its own on-disk record looks like, because `live` for self is derived (`self ||
      // ...`), never read off the record's own shape.
      await writePeerRecord('self-session', {
        sessionId: 'self-session',
        pid: DEFINITELY_DEAD_PID,
        startedAt: twoHoursAgo,
        heartbeatAt: twoHoursAgo,
      });

      const reaped = await registry.collectGarbage(PROJECT);
      expect(reaped).toEqual(['ghost']);

      await expect(readFile(path.join(ghostDir, 'session.json'), 'utf8')).rejects.toThrow();
      // The whole directory went, shadow index included.
      await expect(readFile(path.join(ghostDir, 'shadow.json'), 'utf8')).rejects.toThrow();

      // Both files of the live peer's ownership proof survive.
      expect(
        await readFile(path.join(livePeerDir, 'session.json'), 'utf8').then(
          () => true,
          () => false,
        ),
      ).toBe(true);
      expect(await readFile(path.join(livePeerDir, 'shadow.json'), 'utf8')).toBe(liveShadow);

      // Self's own record survives too.
      expect(
        await readFile(
          path.join(sessionDir(root, PROJECT, 'self-session'), 'session.json'),
          'utf8',
        ).then(
          () => true,
          () => false,
        ),
      ).toBe(true);
    });

    it('on a project with no session state at all, returns [] without throwing or creating anything', async () => {
      const registry = new SessionRegistry(root, 'me');
      const reaped = await registry.collectGarbage(PROJECT);
      expect(reaped).toEqual([]);

      // Nothing on disk as a side effect of a read-then-maybe-write call with no state to touch.
      await expect(readdir(sessionStateDir(root, PROJECT))).rejects.toThrow();
    });
  });
});
