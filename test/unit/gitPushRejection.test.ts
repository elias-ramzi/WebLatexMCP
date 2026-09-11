import { describe, it, expect } from 'vitest';
import { isNonFastForwardRejection } from '../../src/services/gitService.js';

const OVERLEAF_REJECTION =
  'To https://git.overleaf.com/<p>\n' +
  ' ! refs/heads/main:refs/heads/main [rejected] (fetch first)\n' +
  "error: failed to push some refs to 'https://git.overleaf.com/<p>'\n" +
  'hint: Updates were rejected because the remote contains work that you do not have locally.';

describe('isNonFastForwardRejection', () => {
  it('recognizes the captured Overleaf fetch-first rejection', () => {
    expect(isNonFastForwardRejection(OVERLEAF_REJECTION)).toBe(true);
  });

  it('recognizes a non-fast-forward rejection', () => {
    expect(
      isNonFastForwardRejection('! [rejected]        master -> master (non-fast-forward)'),
    ).toBe(true);
  });

  it('does not match a remote-rejected hook refusal', () => {
    expect(
      isNonFastForwardRejection('! [remote rejected] master -> master (pre-receive hook declined)'),
    ).toBe(false);
  });

  it('does not match an authentication failure', () => {
    expect(isNonFastForwardRejection("fatal: Authentication failed for 'https://…'")).toBe(false);
  });

  it('does not match an empty string', () => {
    expect(isNonFastForwardRejection('')).toBe(false);
  });
});
