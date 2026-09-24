import { describe, it, expect, vi } from 'vitest';
import {
  META_ABSENT,
  META_RENDER_CAP,
  PROBE_PREFIX,
  SESSION_PROBE_ENV,
  createSessionProbe,
  extraMeta,
  installConnectionProbe,
  renderMeta,
  sessionProbeEnabled,
} from '../../src/lib/sessionProbe.js';
import type { ProbeConnection } from '../../src/lib/sessionProbe.js';

/** A probe wired to a capturing sink and a frozen clock, so lines can be asserted verbatim. */
function probeWithSink(opts: { secrets?: () => string[]; cap?: number } = {}) {
  const lines: string[] = [];
  const probe = createSessionProbe({
    log: (line) => lines.push(line),
    now: () => new Date('2026-09-21T10:00:00.000Z'),
    pid: 4242,
    ...opts,
  });
  return { probe, lines };
}

describe('sessionProbeEnabled', () => {
  const cases: [string | undefined, boolean][] = [
    [undefined, false],
    ['', false],
    ['   ', false],
    ['0', false],
    ['false', false],
    ['FALSE', false],
    ['no', false],
    ['off', false],
    ['1', true],
    ['true', true],
    ['yes', true],
    ['on', true],
    ['verbose', true],
  ];
  for (const [value, expected] of cases) {
    it(`maps ${JSON.stringify(value)} -> ${expected}`, () => {
      const env = { [SESSION_PROBE_ENV]: value } as NodeJS.ProcessEnv;
      expect(sessionProbeEnabled(env)).toBe(expected);
    });
  }

  it('is off for an env with no probe variable at all', () => {
    expect(sessionProbeEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe('renderMeta', () => {
  it('tells an absent _meta apart from an empty one', () => {
    // This distinction IS the spike's answer: `{}` means the client sent a `_meta` and put nothing
    // identifying in it; absent means it sent none at all.
    expect(renderMeta(undefined)).toBe(META_ABSENT);
    expect(renderMeta({})).toBe('{}');
  });

  it('renders an ordinary conversation-id-shaped object as JSON', () => {
    expect(renderMeta({ 'claude.ai/conversation_id': 'abc-123' })).toBe(
      '{"claude.ai/conversation_id":"abc-123"}',
    );
  });

  it('scrubs a known secret a client echoed into _meta', () => {
    const token = 'ghp_0123456789abcdef';
    const rendered = renderMeta({ auth: `Bearer ${token}` }, [token]);
    expect(rendered).not.toContain(token);
    expect(rendered).toContain('***');
  });

  it('scrubs a secret embedded in a URL even when it is not in the known list', () => {
    const rendered = renderMeta({ remote: 'https://user:s3cret@git.overleaf.com/x' }, []);
    expect(rendered).not.toContain('s3cret');
    expect(rendered).toContain('***@');
  });

  it('scrubs before truncating, so a secret cut by the cap cannot leak its prefix', () => {
    const token = 'tok_abcdefghijklmnop';
    // Put the secret right at the cut point: truncate-then-scrub would leave `tok_abc` visible.
    const cap = 20;
    const rendered = renderMeta({ a: token }, [token], cap);
    expect(rendered).not.toContain('tok_');
    expect(rendered.startsWith('{"a":"***"}')).toBe(true);
  });

  it('caps a long value and says how much was cut', () => {
    const rendered = renderMeta({ blob: 'x'.repeat(5000) }, [], 100);
    expect(rendered.length).toBeLessThan(160);
    expect(rendered).toMatch(/…\(\+\d+ more chars\)$/);
  });

  it('applies the default cap to an oversized _meta', () => {
    const rendered = renderMeta({ blob: 'y'.repeat(META_RENDER_CAP * 4) });
    expect(rendered).toContain('more chars)');
    expect(rendered.length).toBeLessThan(META_RENDER_CAP + 60);
  });

  it('treats a non-finite cap as the default rather than as "no cap"', () => {
    const rendered = renderMeta({ blob: 'z'.repeat(META_RENDER_CAP * 4) }, [], Number.NaN);
    expect(rendered).toContain('more chars)');
    expect(rendered.length).toBeLessThan(META_RENDER_CAP + 60);
  });

  it('survives a circular reference instead of throwing', () => {
    const meta: Record<string, unknown> = { a: 1 };
    meta.self = meta;
    expect(() => renderMeta(meta)).not.toThrow();
    expect(renderMeta(meta)).toContain('unrenderable');
  });

  it('survives a BigInt instead of throwing', () => {
    expect(() => renderMeta({ n: 1n })).not.toThrow();
    expect(renderMeta({ n: 1n })).toContain('unrenderable');
  });

  it('survives a throwing getter instead of throwing', () => {
    const meta = {
      get boom(): string {
        throw new Error('nope');
      },
    };
    expect(() => renderMeta(meta)).not.toThrow();
    expect(renderMeta(meta)).toContain('unrenderable');
  });

  it('reports a value with no JSON representation rather than printing "undefined"', () => {
    expect(renderMeta(() => 0)).toBe('(unrenderable: no JSON representation)');
  });

  it('caps an unrenderable marker too, so a huge thrown message cannot flood stderr', () => {
    const meta = {
      get boom(): string {
        throw new Error('e'.repeat(5000));
      },
    };
    expect(renderMeta(meta, [], 80).length).toBeLessThan(140);
  });
});

describe('extraMeta', () => {
  it('reads _meta off the last callback argument for a tool with an input schema', () => {
    expect(extraMeta([{ project: 'p' }, { _meta: { k: 1 } }])).toEqual({ k: 1 });
  });

  it('reads _meta off the only argument for a tool with no input schema', () => {
    expect(extraMeta([{ _meta: { k: 2 } }])).toEqual({ k: 2 });
  });

  it('returns undefined when there is no _meta, no extra, or no arguments at all', () => {
    expect(extraMeta([{ project: 'p' }, {}])).toBeUndefined();
    expect(extraMeta([null])).toBeUndefined();
    expect(extraMeta(['not-an-object'])).toBeUndefined();
    expect(extraMeta([])).toBeUndefined();
  });
});

describe('createSessionProbe', () => {
  it('counts connections monotonically and reports each clientInfo', () => {
    const { probe, lines } = probeWithSink();
    probe.connectionInitialized({ name: 'claude-ai', version: '0.14.0' });
    probe.connectionInitialized({ name: 'claude-ai', version: '0.14.0' });

    expect(probe.connectionCount()).toBe(2);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      `${PROBE_PREFIX} 2026-09-21T10:00:00.000Z connection #1 initialized — pid 4242, ` +
        `clientInfo name="claude-ai" version="0.14.0"`,
    );
    expect(lines[1]).toContain('connection #2 initialized');
  });

  it('names the missing pieces rather than printing "undefined"', () => {
    const { probe, lines } = probeWithSink();
    probe.connectionInitialized(undefined);
    probe.connectionInitialized({});
    expect(lines[0]).toContain('clientInfo (none reported)');
    expect(lines[1]).toContain('name="(unnamed)" version="(unversioned)"');
  });

  it('labels every tool call with its name and rendered _meta', () => {
    const { probe, lines } = probeWithSink();
    probe.toolCall('status', { 'claude.ai/conversation_id': 'conv-1' });
    probe.toolCall('status', undefined);

    expect(lines[0]).toBe(
      `${PROBE_PREFIX} 2026-09-21T10:00:00.000Z tool call "status" — pid 4242, ` +
        `_meta={"claude.ai/conversation_id":"conv-1"}`,
    );
    expect(lines[1]).toContain(`_meta=${META_ABSENT}`);
  });

  it('reads the secrets list lazily, so a token learned after startup is still scrubbed', () => {
    const secrets: string[] = [];
    const { probe, lines } = probeWithSink({ secrets: () => secrets });
    probe.toolCall('status', { t: 'ghp_latertoken1234' });
    secrets.push('ghp_latertoken1234');
    probe.toolCall('status', { t: 'ghp_latertoken1234' });

    expect(lines[0]).toContain('ghp_latertoken1234');
    expect(lines[1]).not.toContain('ghp_latertoken1234');
    expect(lines[1]).toContain('***');
  });

  it('swallows a secrets provider that throws and still logs the call', () => {
    const { probe, lines } = probeWithSink({
      secrets: () => {
        throw new Error('credential resolver exploded');
      },
    });
    expect(() => probe.toolCall('status', { a: 1 })).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('tool call "status"');
  });

  it('never throws out of a logging call when the sink itself throws', () => {
    const probe = createSessionProbe({
      log: () => {
        throw new Error('stderr is gone');
      },
      pid: 1,
    });
    expect(() => probe.toolCall('status', { a: 1 })).not.toThrow();
    expect(() => probe.connectionInitialized({ name: 'x', version: '1' })).not.toThrow();
    expect(() => probe.startup('s')).not.toThrow();
  });

  it('reports its own failure through the sink rather than silently vanishing', () => {
    const lines: string[] = [];
    let first = true;
    const probe = createSessionProbe({
      log: (line) => {
        // The emit path throws once; the failure report must still land.
        if (first) {
          first = false;
          throw new Error('transient sink failure');
        }
        lines.push(line);
      },
      pid: 1,
    });
    probe.toolCall('status', { a: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('toolCall probe failed: transient sink failure');
  });

  it('defaults to console.error — stdout is the JSON-RPC channel', () => {
    // The single most important rule in this lane: a diagnostic on stdout corrupts the protocol.
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const probe = createSessionProbe({ pid: 9 });
      probe.startup('s');
      probe.connectionInitialized({ name: 'claude-ai', version: '1' });
      probe.toolCall('status', { a: 1 });

      expect(logSpy).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledTimes(3);
      for (const call of errSpy.mock.calls) {
        expect(String(call[0])).toContain(PROBE_PREFIX);
      }
    } finally {
      errSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('stamps every line with the prefix and an ISO timestamp', () => {
    const { probe, lines } = probeWithSink();
    probe.startup('my-session');
    probe.connectionInitialized({ name: 'c', version: '1' });
    probe.toolCall('status', {});

    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(line.startsWith(`${PROBE_PREFIX} 2026-09-21T10:00:00.000Z `)).toBe(true);
    }
    expect(lines[0]).toContain(SESSION_PROBE_ENV);
    expect(lines[0]).toContain('my-session');
    expect(lines[0]).toContain('pid 4242');
  });
});

describe('installConnectionProbe', () => {
  function fakeConnection(client: { name: string; version: string } | undefined): ProbeConnection {
    return { getClientVersion: () => client };
  }

  it('counts a firing and keeps the previously installed handler running', () => {
    const { probe, lines } = probeWithSink();
    const calls: string[] = [];
    const connection = fakeConnection({ name: 'claude-ai', version: '0.14.0' });
    connection.oninitialized = () => calls.push('previous');

    installConnectionProbe(connection, probe);
    connection.oninitialized?.();

    expect(calls).toEqual(['previous']);
    expect(probe.connectionCount()).toBe(1);
    expect(lines[0]).toContain('connection #1 initialized');
  });

  it('still counts the firing when the previously installed handler throws', () => {
    // The count of firings is the whole point of running the spike; it must not be lost to an
    // unrelated handler's failure, which is why the probe runs first in the chain.
    const { probe } = probeWithSink();
    const connection = fakeConnection({ name: 'claude-ai', version: '0.14.0' });
    connection.oninitialized = () => {
      throw new Error('compat logger exploded');
    };

    installConnectionProbe(connection, probe);
    expect(() => connection.oninitialized?.()).toThrow('compat logger exploded');
    expect(probe.connectionCount()).toBe(1);
  });

  it('installs cleanly when there was no previous handler', () => {
    const { probe } = probeWithSink();
    const connection = fakeConnection(undefined);
    installConnectionProbe(connection, probe);
    expect(() => connection.oninitialized?.()).not.toThrow();
    expect(probe.connectionCount()).toBe(1);
  });
});
