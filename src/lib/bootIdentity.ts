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

/** Wall-clock instant this process started, sampled once at module load. */
export const PROCESS_START_MS: number = Date.now();

/**
 * Whether `heartbeatAt` was written at or after this process's own start — a second, drift-immune
 * way to earn the pid-alive grant `isSameBoot` normally gates.
 *
 * This is a *sound* proof of same-boot, independent of `isSameBoot`'s derived stamps: this process
 * has been running continuously since `PROCESS_START_MS` (that's what "this process" means), so
 * anything written since then was written during *our* boot — a reboot in between would have
 * killed this process, and it could not be the one evaluating the comparison. It needs no derived
 * boot instant at all, so it is immune to the clock-step drift `isSameBoot` is vulnerable to: a
 * clock step changes what `Date.now()` reads *from now on*, not the two already-taken past
 * readings (`PROCESS_START_MS` and the peer's `heartbeatAt`) being compared here.
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
 * the same boot. The stamp is what makes a recorded pid meaningful; without one, pid reuse cannot
 * be told from the original process, which is the whole defect this module exists to close.
 * Concretely: such a record falls back to `SessionRegistry`'s bounded heartbeat clause instead of
 * the unbounded pid-alive one, so a legacy ghost already sitting on disk clears itself in time
 * rather than needing a hand-deleted file.
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
