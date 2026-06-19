import { describe, it, expect } from 'vitest';
import { execCapture } from '../../src/lib/exec.js';

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

  it('resolves (does not reject) on a non-zero exit code', async () => {
    const res = await execCapture(process.execPath, ['-e', 'process.exit(3)']);
    expect(res.code).toBe(3);
  });

  it('rejects when the binary cannot be spawned', async () => {
    await expect(execCapture('definitely-not-a-real-binary-xyz', [])).rejects.toBeTruthy();
  });
});
