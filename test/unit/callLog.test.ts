import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import {
  CallLogSink,
  argShape,
  callLogPath,
  installCallLog,
  noteLockWait,
  parseCallLog,
  resultSizes,
  timedPhase,
  type CallRecord,
} from '../../src/lib/callLog.js';
import { WorkGate } from '../../src/lib/workGate.js';
import { gatedCompiler } from '../../src/services/gatedWork.js';
import { readCallLog, renderCallStats, summarizeCalls } from '../../src/lib/callStats.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const d = await mkdtemp(path.join(os.tmpdir(), 'calllog-'));
  dirs.push(d);
  return d;
}

describe('argShape', () => {
  it('keeps booleans, numbers and enum options, and only the length of other strings', () => {
    expect(
      argShape({
        project: 'thesis',
        path: 'sec/secret-plan.tex',
        compile: true,
        startLine: 4,
        filter: 'tex',
        scope: 'a value with spaces',
        edits: [{}, {}],
        overlay: { x: 1 },
      }),
    ).toEqual({
      path: 'str(19)',
      compile: true,
      startLine: 4,
      filter: 'tex',
      scope: 'str(19)',
      edits: 'arr(2)',
      overlay: 'obj',
    });
  });

  it('never writes a token-like value, even under an enum key', () => {
    const shape = argShape({ source: 'ghp_' + 'x'.repeat(36), token: 'ghp_abc' });
    expect(JSON.stringify(shape)).not.toContain('ghp_');
  });
});

describe('resultSizes', () => {
  it('counts text, structured content and images', () => {
    expect(
      resultSizes({
        isError: false,
        content: [
          { type: 'text', text: 'x'.repeat(10) },
          { type: 'image', data: 'AAAA' },
        ],
        structuredContent: { a: 1 },
      }),
    ).toEqual({
      error: false,
      outTextChars: 10,
      outStructChars: 7,
      images: 1,
      imageChars: 4,
      estTokens: 3,
    });
  });
});

describe('parseCallLog', () => {
  it('is on unless switched off', () => {
    expect(parseCallLog(undefined)).toEqual({ enabled: true });
    expect(parseCallLog(' OFF ')).toEqual({ enabled: false });
    expect(parseCallLog('0')).toEqual({ enabled: false });
    expect(parseCallLog('yes')).toEqual({ enabled: true });
    expect(parseCallLog('maybe')).toEqual({ enabled: true, invalid: 'maybe' });
  });
});

describe('installCallLog', () => {
  async function connect(
    register: (server: McpServer) => void,
  ): Promise<{ client: Client; records: CallRecord[] }> {
    const records: CallRecord[] = [];
    const server = new McpServer({ name: 't', version: '0' });
    installCallLog(server, {
      sink: { write: (r) => records.push(r) },
      session: 's1',
      mode: 'daemon',
      defaultProject: () => 'paper',
    });
    register(server);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'c', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    return { client, records };
  }

  it('logs each call with its timings, waits and sizes, but no argument content', async () => {
    const gate = new WorkGate(1);
    const compiler = gatedCompiler(
      {
        isAvailable: async () => true,
        compile: async () => ({}) as never,
      },
      gate,
    );
    const { client, records } = await connect((server) => {
      server.registerTool(
        'work',
        { inputSchema: { path: z.string(), project: z.string().optional() } },
        async () => {
          noteLockWait(30);
          await compiler.compile({} as never);
          await timedPhase('git-remote', async () => {});
          return { content: [{ type: 'text', text: 'done!!!!' }] };
        },
      );
    });
    await client.callTool({ name: 'work', arguments: { path: 'private/notes.tex' } });
    await client.callTool({ name: 'work', arguments: { path: 'a', project: 'other' } });
    expect(records).toHaveLength(2);
    const [first, second] = records as [CallRecord, CallRecord];
    expect(first).toMatchObject({
      v: 1,
      tool: 'work',
      session: 's1',
      mode: 'daemon',
      project: 'paper',
      error: false,
      argShape: { path: 'str(17)' },
      outTextChars: 8,
      estTokens: 2,
      lockWaitMs: 30,
    });
    expect(first.phases).toHaveProperty('compile');
    expect(first.phases).toHaveProperty('git-remote');
    expect(JSON.stringify(first)).not.toContain('private/notes');
    expect(second.project).toBe('other');
  });

  it('logs a thrown handler as an error and still throws', async () => {
    const { client, records } = await connect((server) => {
      server.registerTool('boom', { inputSchema: {} }, async () => {
        throw new Error('nope');
      });
    });
    const res = await client.callTool({ name: 'boom', arguments: {} });
    expect(res.isError).toBe(true);
    expect(records[0]).toMatchObject({ tool: 'boom', error: true, threw: true });
  });
});

describe('CallLogSink and call-stats', () => {
  const rec = (over: Partial<CallRecord>): CallRecord => ({
    v: 1,
    ts: '2026-11-14T10:00:00.000Z',
    tool: 'read_file',
    session: 'a',
    mode: 'daemon',
    ms: 10,
    error: false,
    argShape: {},
    inChars: 0,
    outTextChars: 400,
    outStructChars: 0,
    images: 0,
    imageChars: 0,
    estTokens: 100,
    ...over,
  });

  it('appends JSON lines that readCallLog reads back, skipping a torn line', async () => {
    const ws = await tmp();
    const sink = new CallLogSink(callLogPath(ws));
    sink.write(rec({}));
    sink.write(rec({ tool: 'compile', ts: '2026-11-14T10:01:00.000Z' }));
    await sink.flush();
    await writeFile(callLogPath(ws), '{"v":1,"tool":"cut', { flag: 'a' });
    const back = await readCallLog(ws);
    expect(back.map((r) => r.tool)).toEqual(['read_file', 'compile']);
    expect(await readCallLog(ws, Date.parse('2026-11-14T10:00:30Z'))).toHaveLength(1);
  });

  it('reads the rotated file too, oldest first', async () => {
    const ws = await tmp();
    await mkdir(path.dirname(callLogPath(ws)), { recursive: true });
    await writeFile(`${callLogPath(ws)}.1`, `${JSON.stringify(rec({ tool: 'old' }))}\n`);
    await writeFile(callLogPath(ws), `${JSON.stringify(rec({ tool: 'new' }))}\n`);
    expect((await readCallLog(ws)).map((r) => r.tool)).toEqual(['old', 'new']);
  });

  it('disables itself after a write error instead of failing calls', async () => {
    const ws = await tmp();
    await writeFile(path.join(ws, '.logs'), 'a file where the directory should be');
    const sink = new CallLogSink(callLogPath(ws));
    sink.write(rec({}));
    await sink.flush();
    sink.write(rec({}));
    await sink.flush();
    expect(await readFile(path.join(ws, '.logs'), 'utf8')).toMatch(/^a file/);
  });

  it('summarises tokens, latency, runs and pairs', () => {
    const t = (s: number): string =>
      new Date(Date.parse('2026-11-14T10:00:00Z') + s * 1000).toISOString();
    const records = [
      rec({ ts: t(0), tool: 'read_file', estTokens: 100 }),
      rec({ ts: t(1), tool: 'read_file', estTokens: 300 }),
      rec({ ts: t(2), tool: 'read_file', estTokens: 200 }),
      rec({ ts: t(3), tool: 'edit_file', estTokens: 10 }),
      rec({
        ts: t(4),
        tool: 'compile',
        ms: 9000,
        estTokens: 50,
        lockWaitMs: 1000,
        phases: { compile: 8000 },
      }),
      rec({ ts: t(5), tool: 'edit_file', estTokens: 10, session: 'b' }),
      rec({
        ts: t(6),
        tool: 'compile',
        ms: 3000,
        estTokens: 50,
        session: 'b',
        phases: { compile: 2000 },
      }),
    ];
    const stats = summarizeCalls(records);
    expect(stats).toMatchObject({ calls: 7, sessions: 2 });
    expect(stats.tools[0]).toMatchObject({
      tool: 'read_file',
      calls: 3,
      totalTokens: 600,
      maxTokens: 300,
    });
    const compile = stats.tools.find((x) => x.tool === 'compile');
    expect(compile).toMatchObject({ maxMs: 9000, meanLockWaitMs: 500, phases: { compile: 5000 } });
    expect(stats.runs).toEqual([{ tool: 'read_file', runs: 1, longest: 3, calls: 3 }]);
    expect(stats.pairs[0]).toEqual({ from: 'edit_file', to: 'compile', count: 2 });
    expect(stats.slowest[0]).toMatchObject({ tool: 'compile', ms: 9000, lockWaitMs: 1000 });
    const text = renderCallStats(stats);
    expect(text).toContain('7 tool calls from 2 session(s)');
    expect(text).toContain('edit_file → compile');
    expect(renderCallStats(summarizeCalls([]))).toBe('No tool calls logged yet.\n');
  });
});
