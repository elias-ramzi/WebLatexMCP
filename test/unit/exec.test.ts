import { describe, it, expect } from 'vitest';
import { execCapture, execCaptureBytes } from '../../src/lib/exec.js';

// Drive `node` itself so these are cross-platform (no reliance on shell builtins).
describe('execCapture', () => {
  it('writes input to the child stdin', async () => {
    const res = await execCapture(
      process.execPath,
      ['-e', 'process.stdin.on("data", (d) => process.stdout.write(d))'],
      { input: 'hello-stdin' },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('hello-stdin');
  });

  it('writes a Buffer input to the child stdin and round-trips it', async () => {
    const input = Buffer.from('hello-buffer-stdin', 'utf8');
    const res = await execCapture(
      process.execPath,
      ['-e', 'process.stdin.on("data", (d) => process.stdout.write(d))'],
      { input },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('hello-buffer-stdin');
  });

  it('resolves (does not reject) on a non-zero exit code', async () => {
    const res = await execCapture(process.execPath, ['-e', 'process.exit(3)']);
    expect(res.code).toBe(3);
  });

  it('rejects when the binary cannot be spawned', async () => {
    await expect(execCapture('definitely-not-a-real-binary-xyz', [])).rejects.toBeTruthy();
  });
});

describe('execCaptureBytes', () => {
  const NOT_UTF8 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);

  it('returns stdout as a Buffer preserving bytes that are not valid UTF-8', async () => {
    const res = await execCaptureBytes(process.execPath, [
      '-e',
      `process.stdout.write(Buffer.from([${[...NOT_UTF8].join(',')}]))`,
    ]);
    expect(res.code).toBe(0);
    expect(Buffer.isBuffer(res.stdout)).toBe(true);
    expect(Buffer.compare(res.stdout, NOT_UTF8)).toBe(0);
  });

  it('mangles the same bytes when read through execCapture, as the contrast', async () => {
    const viaCapture = await execCapture(process.execPath, [
      '-e',
      `process.stdout.write(Buffer.from([${[...NOT_UTF8].join(',')}]))`,
    ]);
    // Round-tripping through .toString() replaces invalid UTF-8 sequences with U+FFFD, so
    // re-encoding does not reproduce the original bytes.
    const roundTripped = Buffer.from(viaCapture.stdout, 'utf8');
    expect(Buffer.compare(roundTripped, NOT_UTF8)).not.toBe(0);
  });

  it('resolves (does not reject) on a non-zero exit code', async () => {
    const res = await execCaptureBytes(process.execPath, ['-e', 'process.exit(3)']);
    expect(res.code).toBe(3);
  });
});
