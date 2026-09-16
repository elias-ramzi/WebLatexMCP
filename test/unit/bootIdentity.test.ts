import { describe, it, expect } from 'vitest';
import {
  BOOT_STAMP_TOLERANCE_MS,
  PROCESS_START_MS,
  bootStampFrom,
  isSameBoot,
  writtenSinceProcessStart,
} from '../../src/lib/bootIdentity.js';

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
