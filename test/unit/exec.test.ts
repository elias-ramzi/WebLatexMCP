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

  it('agrees with execCaptureBytes on code, stderr, and decoded stdout for the same child', async () => {
    const script =
      'process.stdout.write("out-line\\n"); process.stderr.write("err-line\\n"); process.exit(7)';
    const [viaCapture, viaBytes] = await Promise.all([
      execCapture(process.execPath, ['-e', script]),
      execCaptureBytes(process.execPath, ['-e', script]),
    ]);
    expect(viaCapture.code).toBe(viaBytes.code);
    expect(viaCapture.stderr).toBe(viaBytes.stderr);
    expect(viaCapture.stdout).toBe(viaBytes.stdout.toString('utf8'));
    expect(viaCapture.stdout).toBe('out-line\n');
  });

  it('decodes a multi-byte UTF-8 character split across two stdout chunks', async () => {
    // 'é' (U+00E9) as UTF-8 is the two bytes 0xC3 0xA9. Write them in two separate
    // process.stdout.write calls with a delay between them, so the OS pipe delivers them as
    // two distinct `data` chunks instead of coalescing them into one. Decoding each chunk on
    // its own (the old `stdout += d.toString()` accumulation) turns each lone byte into a
    // replacement character (U+FFFD) since neither half is valid UTF-8 by itself; decoding
    // the concatenated bytes once, as execCaptureBytes does, recovers 'é'.
    const script = [
      'process.stdout.write(Buffer.from([0xc3]));',
      'setTimeout(() => {',
      '  process.stdout.write(Buffer.from([0xa9]));',
      '  process.exit(0);',
      '}, 20);',
    ].join(' ');
    const res = await execCapture(process.execPath, ['-e', script]);
    expect(res.code).toBe(0);
    expect(res.stdout).toBe('é');
  });

  // Same hazard as the stdout test above, on the other stream: stderr was decoded one `data`
  // chunk at a time, and `PathBeyondSymlinkError` rebuilds paths from git's stderr, so a
  // non-ASCII path split across two chunks came back with U+FFFD in place of its character.
  it('decodes a multi-byte UTF-8 character split across two stderr chunks', async () => {
    const script = [
      'process.stderr.write(Buffer.from([0xc3]));',
      'setTimeout(() => {',
      '  process.stderr.write(Buffer.from([0xa9]));',
      '  process.exit(0);',
      '}, 20);',
    ].join(' ');
    const [viaCapture, viaBytes] = await Promise.all([
      execCapture(process.execPath, ['-e', script]),
      execCaptureBytes(process.execPath, ['-e', script]),
    ]);
    expect(viaCapture.stderr).toBe('é');
    expect(viaBytes.stderr).toBe('é');
  });

  it('kills the child and sets timedOut on timeout', async () => {
    const res = await execCapture(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'], // never exits on its own
      { timeoutMs: 50 },
    );
    expect(res.timedOut).toBe(true);
    expect(res.code).not.toBe(0);
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
