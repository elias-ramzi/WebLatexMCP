import { describe, it, expect, afterEach, vi } from 'vitest';
import os from 'node:os';
import {
  BOOT_STAMP_TOLERANCE_MS,
  PROCESS_START_MS,
  bootStampFrom,
  currentBootStamp,
  isSameBoot,
  writtenSinceProcessStart,
} from '../../src/lib/bootIdentity.js';

describe('BOOT_STAMP_TOLERANCE_MS', () => {
  it('is 5 minutes — the calibrated value the surrounding documentation argues from', () => {
    // Every boundary test below is written relatively (`base + BOOT_STAMP_TOLERANCE_MS`), which is
    // right for pinning the `<=` and the `Math.abs` but leaves the *value* free: silently widening
    // it to 37 minutes keeps all of them green. The value is a calibration decision, not an
    // arbitrary one — CHANGELOG.md and docs/CONCURRENCY.md both reason from a measured 4m32s of
    // real WSL2 drift being "about 90% of the tolerance", and that is the evidence offered for
    // adding `writtenSinceProcessStart` instead of simply raising this number. Changing it is
    // therefore a documentation change too, and this line is what makes the gate say so.
    expect(BOOT_STAMP_TOLERANCE_MS).toBe(5 * 60 * 1000);
  });
});

describe('bootStampFrom', () => {
  it('derives the exact boot instant from a wall-clock time and an uptime', () => {
    const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
    const uptimeSeconds = 3600; // 1 hour up
    expect(bootStampFrom(nowMs, uptimeSeconds)).toBe(
      new Date(Date.UTC(2026, 0, 1, 11, 0, 0)).toISOString(),
    );
  });

  it('handles a zero uptime as booted at the wall-clock instant itself', () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(bootStampFrom(nowMs, 0)).toBe(new Date(nowMs).toISOString());
  });

  it('handles a fractional uptime by subtracting the fractional milliseconds', () => {
    const nowMs = Date.UTC(2026, 0, 1, 0, 0, 0);
    const uptimeSeconds = 1234.56;
    expect(bootStampFrom(nowMs, uptimeSeconds)).toBe(
      new Date(nowMs - 1234.56 * 1000).toISOString(),
    );
  });
});

describe('currentBootStamp', () => {
  // Both spies are on shared globals — a leaked `Date.now` spy would corrupt every later test in
  // this file and in the suite — so they are restored unconditionally.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('subtracts the live uptime, so the same boot derives the same stamp as time passes', () => {
    // `os.uptime()` must actually be consulted. Replacing the call with a constant 0 leaves every
    // other test in this file green — nothing else imports `currentBootStamp`, and in
    // `SessionRegistry` both sides of every comparison come from it, so a wrong derivation cancels
    // out. The failure direction is the unsafe one: the derived stamp collapses to "now", so any
    // record written more than BOOT_STAMP_TOLERANCE_MS ago *in the same boot* stops matching, and
    // a live peer whose heartbeat is merely stale reads dead — `push` with a `message` then runs
    // `git add -A` over its lines and `commit scope: "paths"` stops refusing them.
    //
    // A real boot advances the wall clock and the uptime by the same amount, so the derived boot
    // instant is invariant. Spied values are set before each call rather than queued per call, so
    // an incidental `Date.now()` from the runner cannot shift a queue and make this flaky.
    const bootMs = Date.UTC(2026, 0, 1, 8, 0, 0);
    const uptimeSeconds = 3600; // 1 hour into the boot
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(bootMs + uptimeSeconds * 1000);
    const uptimeSpy = vi.spyOn(os, 'uptime').mockReturnValue(uptimeSeconds);

    const first = currentBootStamp();

    // Ten minutes later in the same boot: +600_000ms of wall clock, +600s of uptime.
    nowSpy.mockReturnValue(bootMs + (uptimeSeconds + 600) * 1000);
    uptimeSpy.mockReturnValue(uptimeSeconds + 600);
    const second = currentBootStamp();

    // The headline claim, asserted first so an uptime-blind derivation fails here and reports the
    // drift itself. The two readings are 10 minutes apart — twice BOOT_STAMP_TOLERANCE_MS — so
    // such a derivation is not merely inaccurate, it is past what `isSameBoot` forgives.
    expect(second).toBe(first);
    expect(isSameBoot(first, second)).toBe(true);
    // ...and the invariant stamp is the real boot instant, not merely some stable string.
    expect(first).toBe(new Date(bootMs).toISOString());
  });

  it('is exactly bootStampFrom(Date.now(), os.uptime())', () => {
    // Pins the composition directly: the pure, test-driven derivation is the one the live reader
    // uses, with both of its inputs read from the system rather than one of them hard-coded.
    const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
    const uptimeSeconds = 7200;
    vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    vi.spyOn(os, 'uptime').mockReturnValue(uptimeSeconds);

    expect(currentBootStamp()).toBe(bootStampFrom(Date.now(), os.uptime()));
  });
});

describe('isSameBoot', () => {
  it('treats two stamps derived from the same boot instant, sampled 3s apart, as the same boot', () => {
    const bootMs = Date.UTC(2026, 0, 1, 9, 0, 0);
    // Same underlying boot instant (bootMs), sampled at two different "now" readings 3s apart —
    // uptimeSeconds grows by exactly as much as nowMs does, so both derive the same boot.
    const recorded = bootStampFrom(bootMs + 10_000, 10);
    const current = bootStampFrom(bootMs + 13_000, 13);
    expect(isSameBoot(recorded, current)).toBe(true);
  });

  it('treats a jittery pair 2s apart as the same boot', () => {
    const base = Date.UTC(2026, 0, 1, 9, 0, 0);
    const recorded = new Date(base).toISOString();
    const current = new Date(base + 2000).toISOString();
    expect(isSameBoot(recorded, current)).toBe(true);
  });

  it('is true at exactly the tolerance boundary (current later than recorded)', () => {
    const base = Date.UTC(2026, 0, 1, 9, 0, 0);
    const recorded = new Date(base).toISOString();
    const current = new Date(base + BOOT_STAMP_TOLERANCE_MS).toISOString();
    expect(isSameBoot(recorded, current)).toBe(true);
  });

  it('is false just past the tolerance boundary (current later than recorded)', () => {
    const base = Date.UTC(2026, 0, 1, 9, 0, 0);
    const recorded = new Date(base).toISOString();
    const current = new Date(base + BOOT_STAMP_TOLERANCE_MS + 1).toISOString();
    expect(isSameBoot(recorded, current)).toBe(false);
  });

  it('is true at exactly the tolerance boundary (recorded later than current) — proves Math.abs is used', () => {
    const base = Date.UTC(2026, 0, 1, 9, 0, 0);
    const current = new Date(base).toISOString();
    const recorded = new Date(base + BOOT_STAMP_TOLERANCE_MS).toISOString();
    expect(isSameBoot(recorded, current)).toBe(true);
  });

  it('is false just past the tolerance boundary (recorded later than current) — proves Math.abs is used', () => {
    const base = Date.UTC(2026, 0, 1, 9, 0, 0);
    const current = new Date(base).toISOString();
    const recorded = new Date(base + BOOT_STAMP_TOLERANCE_MS + 1).toISOString();
    expect(isSameBoot(recorded, current)).toBe(false);
  });

  it('is false for an undefined recorded stamp (a legacy record with no stamp gets no pid grant)', () => {
    const current = new Date(Date.UTC(2026, 0, 1, 9, 0, 0)).toISOString();
    expect(isSameBoot(undefined, current)).toBe(false);
  });

  it('is false when the recorded stamp does not parse as a date', () => {
    const current = new Date(Date.UTC(2026, 0, 1, 9, 0, 0)).toISOString();
    expect(isSameBoot('not a date', current)).toBe(false);
  });

  it('is false when the current stamp does not parse as a date', () => {
    const recorded = new Date(Date.UTC(2026, 0, 1, 9, 0, 0)).toISOString();
    expect(isSameBoot(recorded, 'not a date')).toBe(false);
  });

  it('is false across a realistic reboot a day apart', () => {
    const base = Date.UTC(2026, 0, 1, 9, 0, 0);
    const recorded = new Date(base).toISOString();
    const current = new Date(base + 24 * 60 * 60 * 1000).toISOString();
    expect(isSameBoot(recorded, current)).toBe(false);
  });

  it('honors an explicit toleranceMs argument that overrides the default', () => {
    const base = Date.UTC(2026, 0, 1, 9, 0, 0);
    const recorded = new Date(base).toISOString();
    const current = new Date(base + 3000).toISOString();
    // Within the default tolerance...
    expect(isSameBoot(recorded, current)).toBe(true);
    // ...but not within a tiny explicit tolerance.
    expect(isSameBoot(recorded, current, 1000)).toBe(false);
  });
});

describe('writtenSinceProcessStart', () => {
  it('is true for a heartbeat written after the given start', () => {
    const start = Date.UTC(2026, 0, 1, 9, 0, 0);
    const heartbeat = new Date(start + 1000).toISOString();
    expect(writtenSinceProcessStart(heartbeat, start)).toBe(true);
  });

  it('is false for a heartbeat written before the given start', () => {
    const start = Date.UTC(2026, 0, 1, 9, 0, 0);
    const heartbeat = new Date(start - 1000).toISOString();
    expect(writtenSinceProcessStart(heartbeat, start)).toBe(false);
  });

  it('is true at exactly equal (boundary — the check is >=)', () => {
    const start = Date.UTC(2026, 0, 1, 9, 0, 0);
    const heartbeat = new Date(start).toISOString();
    expect(writtenSinceProcessStart(heartbeat, start)).toBe(true);
  });

  it('is false for an unparseable heartbeat string', () => {
    const start = Date.UTC(2026, 0, 1, 9, 0, 0);
    expect(writtenSinceProcessStart('not a date', start)).toBe(false);
  });

  it('defaults to PROCESS_START_MS when the second argument is omitted', () => {
    const now = new Date().toISOString();
    expect(writtenSinceProcessStart(now)).toBe(true);

    const yearAgo = new Date(PROCESS_START_MS - 365 * 24 * 60 * 60 * 1000).toISOString();
    expect(writtenSinceProcessStart(yearAgo)).toBe(false);
  });
});
