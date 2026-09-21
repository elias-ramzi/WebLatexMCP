import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../../src/server.js';
import { createSessionProbe, installToolCallProbe } from '../../src/lib/sessionProbe.js';
import type { SessionProbe } from '../../src/lib/sessionProbe.js';
import type { AppContext } from '../../src/context.js';

// Same stand-in as test/unit/server.test.ts: registration reads the bag lazily.
const fakeCtx = {} as unknown as AppContext;

/** Record every tool-call observation instead of writing to stderr. */
function recordingProbe(): { probe: SessionProbe; seen: { tool: string; meta: unknown }[] } {
  const seen: { tool: string; meta: unknown }[] = [];
  const probe = createSessionProbe({ log: () => {}, pid: 1 });
  return {
    seen,
    probe: {
      ...probe,
      toolCall(tool: string, meta: unknown) {
        seen.push({ tool, meta });
        probe.toolCall(tool, meta);
      },
    },
  };
}

/**
 * A one-tool server, optionally probed, driven through a real client over the in-memory
 * transport — so `_meta` travels the same path it would from Claude Desktop.
 */
async function callEcho(
  probe: SessionProbe | undefined,
  meta: Record<string, unknown> | undefined,
  cb?: () => CallToolResult,
): Promise<CallToolResult> {
  const server = new McpServer({ name: 'probe-test', version: '0.0.0' });
  if (probe) installToolCallProbe(server, probe);
  server.registerTool(
    'echo',
    { description: 'echo', inputSchema: { msg: z.string() } },
    ({ msg }) => cb?.() ?? { content: [{ type: 'text', text: `echo:${msg}` }] },
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = (await client.callTool({
    name: 'echo',
    arguments: { msg: 'hi' },
    ...(meta ? { _meta: meta } : {}),
  })) as CallToolResult;
  await client.close();
  return result;
}

describe('installToolCallProbe', () => {
  it('reports the tool name and the _meta a real client attached to the call', async () => {
    const { probe, seen } = recordingProbe();
    const result = await callEcho(probe, { 'claude.ai/conversation_id': 'conv-7' });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.tool).toBe('echo');
    expect(seen[0]?.meta).toMatchObject({ 'claude.ai/conversation_id': 'conv-7' });
    // And the call itself is untouched.
    expect(result.content).toEqual([{ type: 'text', text: 'echo:hi' }]);
  });

  it('reports an absent _meta as undefined rather than inventing one', async () => {
    const { probe, seen } = recordingProbe();
    await callEcho(probe, undefined);
    expect(seen).toHaveLength(1);
    // The SDK may attach transport-level keys (e.g. a progress token) but must not have a
    // conversation id here — this is the "nothing distinguishing" reading the spike looks for.
    const meta = seen[0]?.meta as Record<string, unknown> | undefined;
    expect(meta === undefined || Object.keys(meta).length === 0).toBe(true);
  });

  it('does not fail the call when the probe throws', async () => {
    const exploding: SessionProbe = {
      startup: () => {},
      connectionInitialized: () => {},
      connectionCount: () => 0,
      toolCall: () => {
        throw new Error('probe exploded');
      },
    };
    const result = await callEcho(exploding, { a: 1 });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: 'echo:hi' }]);
  });

  it('leaves the tool result byte-identical to the unprobed one', async () => {
    // The `filterLog`/`keepWarning` shape: not "the probe is harmless" but "the output is the
    // same object". A probed call and an unprobed call must be indistinguishable to the client.
    const { probe } = recordingProbe();
    const withProbe = await callEcho(probe, { 'claude.ai/conversation_id': 'conv-7' });
    const without = await callEcho(undefined, { 'claude.ai/conversation_id': 'conv-7' });
    expect(withProbe).toEqual(without);
  });

  it('propagates a handler error unchanged, probed or not', async () => {
    const boom = (): CallToolResult => {
      throw new Error('handler exploded');
    };
    const { probe } = recordingProbe();
    const withProbe = await callEcho(probe, { a: 1 }, boom);
    const without = await callEcho(undefined, { a: 1 }, boom);
    expect(withProbe.isError).toBe(true);
    expect(withProbe).toEqual(without);
  });
});

describe('createServer probe wiring', () => {
  it('installs nothing at all when no probe is passed', () => {
    // Inertness, stated as strongly as it can be: `registerTool` is still the prototype's own
    // method, so there is no wrapper in the hot path to measure, fail, or write a line from.
    const server = createServer(fakeCtx);
    expect(server.registerTool).toBe(McpServer.prototype.registerTool);
  });

  it('wraps registerTool once a probe is passed', () => {
    const { probe } = recordingProbe();
    const server = createServer(fakeCtx, undefined, undefined, [], false, probe);
    expect(server.registerTool).not.toBe(McpServer.prototype.registerTool);
  });

  it('covers every registered tool with one wiring point and registers the same set', async () => {
    const { probe } = recordingProbe();
    const probedTools = await listTools(
      createServer(fakeCtx, undefined, undefined, [], false, probe),
    );
    const plainTools = await listTools(createServer(fakeCtx));

    // Minimum size, so this cannot pass vacuously against an empty registration list.
    expect(probedTools.length).toBeGreaterThanOrEqual(30);
    expect(probedTools).toEqual(plainTools);
  });

  it('logs a real tool call only when a probe is passed', async () => {
    // Both halves matter: the probed run proves the capture mechanism works (so the unprobed
    // run's empty result is not a vacuous green), and the unprobed run is the inertness claim.
    const off = await callListSkills(false);
    const on = await callListSkills(true);

    expect(off.logged).toEqual([]);
    expect(on.logged.length).toBeGreaterThanOrEqual(1);
    expect(on.logged.join('\n')).toContain('tool call "list_skills"');
    expect(on.logged.join('\n')).toContain('"claude.ai/conversation_id":"conv-9"');
    // And the result the client sees is the same either way.
    expect(on.result).toEqual(off.result);
  });
});

/**
 * Drive one real `list_skills` call through `createServer`, capturing what the probe emitted.
 * `list_skills` is the one tool that needs nothing from the context bag when no skills are
 * bundled, so it can be called against the empty stand-in above.
 */
async function callListSkills(
  probed: boolean,
): Promise<{ result: CallToolResult; logged: string[] }> {
  const logged: string[] = [];
  const probe = createSessionProbe({ log: (line) => logged.push(line), pid: 1 });
  const server = createServer(fakeCtx, undefined, undefined, [], false, probed ? probe : undefined);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const result = (await client.callTool({
    name: 'list_skills',
    arguments: {},
    _meta: { 'claude.ai/conversation_id': 'conv-9' },
  })) as CallToolResult;
  await client.close();
  return { result, logged };
}

async function listTools(server: McpServer): Promise<string[]> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools.map((t) => t.name).sort();
}
