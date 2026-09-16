import os from 'node:os';

/**
 * Deciding whether a recorded pid still names the process that recorded it — scoped to the boot
 * that recorded it, not just to the pid number.
 *
 * `SessionRegistry` treats a peer session as `live` when its recorded pid is running
 * (`pidAlive`), with no time bound. Across a reboot on a persisted workspace, pids are reused
 * from a small space, so a dead session's recorded pid can belong to an unrelated live process —
 * and `pidAlive` returns true forever, so the record reports `live` permanently. The fix is to
 * also record *which boot* saw that pid, and refuse the pid-alive claim when the current boot
 * isn't the one that recorded it. This module is the pure "same boot?" decision; nothing here
 * touches `SessionRegistry` or persisted records.
 */

/**
 * Tolerance for comparing two derived boot instants.
 *
 * The bias is deliberately generous, not tight, because the two ways to be wrong are not
 * symmetric. Calling a *different* boot the same one only preserves today's behaviour — the pid
 * keeps its grant and the record stays `live`, a spurious refusal at worst (fail-closed). Calling
 * the *same* boot a different one revokes a genuinely live session's pid grant, and once its
 * heartbeat goes stale its uncommitted work reads as owned by nobody (fail-open) — the direction
 * this codebase refuses to fall in. So ties go to "same boot".
 *
 * `BOOT_STAMP_TOLERANCE_MS` is a **ceiling on total clock drift accumulated across the whole life
 * of a boot**, not slack for sampling jitter at write time (sampling jitter itself is sub-second
 * everywhere `bootStampFrom` is called). The stamp difference between two records has nothing to
 * do with either record's age: it is the clock drift the system has accumulated since boot, and a
 * record written 20 hours into a boot carries 20 hours' worth of that drift, nowhere near
 * `SessionRegistry`'s 30-minute heartbeat window. Exceeding the tolerance is the unsafe direction
 * — it revokes a genuinely live session's pid grant (see the asymmetry note above, which still
 * holds: ties go to "same boot"). Measured on a real WSL2 dev machine, a VM pause plus host
 * timesync had already consumed ~90% of these 5 minutes on one boot — which is why
 * `writtenSinceProcessStart` below exists as a second, drift-immune way to earn the same grant,
 * rather than this constant simply being raised.
 */
export const BOOT_STAMP_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Wall-clock instant this process started, sampled once at module load.
 *
 * Module load is a slightly *later* bound than true process start, and later is the safe
 * direction for the proof `writtenSinceProcessStart` makes on top of it: a later bound only makes
 * that rescue marginally less generous (a peer that heartbeated between real process start and
 * this module's load is not vouched for), never more. Do **not** "improve" this to
 * `Date.now() - process.uptime() * 1000` to recover those milliseconds: that is a *derived* value
 * — the same arithmetic that makes `bootStampFrom` approximate — and so is subject to exactly the
 * clock-step drift this constant exists to be immune to, whereas a module-load reading is an
 * actual past observation that no later clock step can retroactively change.
 *
 * Latent test hazard: `test/unit/sessionRegistry.test.ts` mocks `Date.now` globally inside one
 * `describe`. Nothing loads this module inside such a window today, but a future
 * `vi.resetModules()` plus dynamic import from within one would have `PROCESS_START_MS` silently
 * take the mocked value; every `writtenSinceProcessStart` would then return false and the
 * drift-immune route would go quiet — weakening the suite rather than failing it, which is the
 * worst way for a test to be wrong. Tests that need a controlled start instant pass the explicit
 * `processStartMs` argument instead; that parameter exists for this reason.
 */
export const PROCESS_START_MS: number = Date.now();

/**
 * Whether `heartbeatAt` was written at or after this process's own start — a second, drift-immune
 * way to earn the pid-alive grant `isSameBoot` normally gates.
 *
 * The argument, independent of `isSameBoot`'s derived stamps: this process has been running
 * continuously since `PROCESS_START_MS` (that's what "this process" means), so anything written
 * since then was written during *our* boot — a reboot in between would have killed this process,
 * and it could not be the one evaluating the comparison. It needs no derived boot instant at all,
 * so it is immune to the clock-step drift `isSameBoot` is vulnerable to: a clock step changes what
 * `Date.now()` reads *from now on*, not the two already-taken past readings (`PROCESS_START_MS`
 * and the peer's `heartbeatAt`) being compared here.
 *
 * That argument rests on an assumption, stated here rather than asserted away: both readings are
 * *wall-clock* readings (`touch()` writes `heartbeatAt` as `new Date(now).toISOString()`), so
 * "`heartbeatAt >= PROCESS_START_MS` ⇒ same boot" holds only while the wall clock did not step
 * **backward** between the peer's last heartbeat and our own start. It can: a dual-boot machine
 * with a local-time RTC, or NTP correcting a fast RTC at boot. Concretely — a ghost heartbeats at
 * wall 10:55, the machine reboots, NTP steps the clock back to 09:58, this process starts at
 * 10:00, and `writtenSinceProcessStart('10:55…', 10:00)` returns true: a pre-reboot ghost whose
 * pid has since been reused keeps the unbounded pid grant, which is the original defect
 * reproduced. It is documented rather than closed because the failure is **fail-closed** — a ghost
 * reading `live` costs a spurious refusal, which is exactly the pre-fix behaviour and has the same
 * escape — and never the fail-open direction, where a live peer reads dead and `push` /
 * `commit scope: "paths"` sweep its uncommitted lines. Nobody's work is at risk from it, which is
 * what makes it an assumption to record rather than a blocker.
 *
 * It is a **supplement, never a replacement**, for `isSameBoot`: it can only vouch for a record
 * written after we started, so a peer that has been alive since before us — and has not
 * heartbeated again since — still needs the stamp comparison. It also has an honest residual: if
 * *this* process itself started after a clock step (e.g. launched right after a laptop resumed
 * from sleep) while the peer has been alive since before that step, neither route vouches for the
 * peer — its heartbeat predates our start, so this function returns false, and its stamp may have
 * drifted past `isSameBoot`'s tolerance too. That peer still reads dead until it heartbeats again.
 */
export function writtenSinceProcessStart(
  heartbeatAt: string,
  processStartMs: number = PROCESS_START_MS,
): boolean {
  const parsed = Date.parse(heartbeatAt);
  if (!Number.isFinite(parsed)) {
    return false;
  }
  return parsed >= processStartMs;
}

/**
 * The boot instant implied by a wall-clock reading and a system uptime — pure, no clock reads, so
 * this is what the tests drive.
 *
 * The result is **derived and approximate**, not an exact instant: `os.uptime()` has
 * second resolution and `Date.now()` can be stepped by NTP, so two readings taken moments apart
 * on the very same boot will not derive byte-identical stamps. That drift is the only reason
 * `isSameBoot` needs a tolerance at all.
 */
export function bootStampFrom(nowMs: number, uptimeSeconds: number): string {
  return new Date(nowMs - uptimeSeconds * 1000).toISOString();
}

/**
 * The current boot instant, read from the running system.
 *
 * `os.uptime()` includes time the machine spent suspended on all three supported platforms —
 * Linux reports `CLOCK_BOOTTIME` via `/proc/uptime`, macOS reads `kern.boottime`, and Windows
 * uses `GetTickCount64` — so a laptop that slept for hours does not read as a reboot. This is
 * load-bearing and cross-platform: do not "simplify" this to a monotonic-clock difference or a
 * suspend will start reporting every peer session as belonging to a different boot.
 */
export function currentBootStamp(): string {
  return bootStampFrom(Date.now(), os.uptime());
}

/**
 * Whether a recorded boot stamp names the same boot as `current`, within `toleranceMs`.
 *
 * `recorded === undefined` — a record written before this field existed — is **not** treated as
 * the same boot, and that answer stays: the stamp is what makes a recorded pid meaningful; without
 * one, pid reuse cannot be told from the original process, which is the whole defect this module
 * exists to close.
 *
 * What that costs a stampless record is the *caller's* decision, not this function's, and it is
 * less than it once was: `SessionRegistry` grants the unbounded pid clause on `isSameBoot` **or**
 * `writtenSinceProcessStart`, so a stampless record whose heartbeat landed since the reading
 * process started still earns that clause — which keeps a still-running legacy session from being
 * stranded while it is working. A session quiet for longer than that is covered by
 * `withinLegacyPidGrace` below, which grants a stampless record the same clause on the pid alone
 * for a bounded 24h: the two together are why a stampless record is no longer stranded by this
 * function returning false. A stampless *ghost* therefore reads live for that bounded window too,
 * and then clears itself — where it once did so within the staleness window, and where before any
 * of this it never cleared at all. Either way, what this function returns for `undefined` is
 * unchanged, and that is the point: the caller decides what an absent stamp costs.
 */
export function isSameBoot(
  recorded: string | undefined,
  current: string,
  toleranceMs: number = BOOT_STAMP_TOLERANCE_MS,
): boolean {
  if (recorded === undefined) {
    return false;
  }
  const recordedMs = Date.parse(recorded);
  const currentMs = Date.parse(current);
  if (!Number.isFinite(recordedMs) || !Number.isFinite(currentMs)) {
    return false;
  }
  return Math.abs(recordedMs - currentMs) <= toleranceMs;
}

/**
 * How long a record carrying **no** `bootedAt` keeps its pid grant on the strength of the pid
 * alone.
 *
 * This exists because "no stamp" and "a stamp naming another boot" are not the same evidence, and
 * treating them alike cost a live session its protection. A stamped record that fails `isSameBoot`
 * carries positive evidence *against* itself. A stampless one carries none either way. Usually it
 * was written by a build from before the field existed, and that process — still running, since its
 * pid answers — can never write the field however often it heartbeats, because Node does not
 * hot-reload; the other source is `touch()`'s own degradation, which omits the field when
 * `os.uptime()` throws, and such a process *can* stamp a later heartbeat if uptime recovers. (On
 * that platform the judging side usually fails the same read, and `peers()` then grants the pid
 * clause unbounded via its `boot === null` fallback, so this route rarely decides it.) Denying a
 * stampless record outright made a still-running old-build session read dead the moment it
 * idled past `STALE_MS`, and heartbeats come only from `status`, `commit`, `push` and the mutation
 * recorder, so a session waiting on its user goes quiet for exactly that long. Its peer's
 * `guardPeerWork` then saw no live session at all, and a `push` carrying a `message` (`git add -A`)
 * or a `commit scope: "paths"` could take its uncommitted lines — the fail-open direction, which
 * is the one this module exists to stay out of.
 *
 * So the grant is restored, but **bounded**, which is the whole difference from the defect that
 * started all this. The original bug was an *unbounded* pid clause: a reused pid answered forever
 * and nothing could ever age the record out. Twenty-four hours covers the idle gap this is for — a
 * session left open overnight — while a genuine legacy ghost whose pid has been reused clears
 * itself within a day instead of needing a hand-deleted file. Wrong in this direction costs a
 * spurious refusal that expires on its own; wrong in the other costs someone's uncommitted work.
 *
 * Deliberately **not** extended to a record whose stamp merely drifted past
 * `BOOT_STAMP_TOLERANCE_MS`: that one has a stamp, and the stamp says another boot. Widening the
 * grace to cover it would mean overriding evidence rather than acting in its absence, and the
 * honest fix there is `writtenSinceProcessStart` (which needs no clock) or a larger tolerance.
 * That case stays a documented residual.
 */
export const LEGACY_PID_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a **stampless** record is young enough to keep its pid grant — the bounded fallback for
 * a record written before `bootedAt` existed.
 *
 * Returns false for any record that *has* a stamp, whatever that stamp says: a stamped record is
 * judged by `isSameBoot` and `writtenSinceProcessStart` and never reaches this route. `ageMs` is
 * the same `Date.now() - Date.parse(heartbeatAt)` the caller already computes; a non-finite age (an
 * unparseable heartbeat) earns nothing, as everywhere else in this module.
 */
export function withinLegacyPidGrace(
  recorded: string | undefined,
  ageMs: number,
  graceMs: number = LEGACY_PID_GRACE_MS,
): boolean {
  if (recorded !== undefined) {
    return false;
  }
  return Number.isFinite(ageMs) && ageMs < graceMs;
}
