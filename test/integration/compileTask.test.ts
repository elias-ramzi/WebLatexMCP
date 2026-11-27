import { describe, it, expect, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createServer } from '../../src/server.js';
import { createContext, type AppContext } from '../../src/context.js';
import { CredentialResolver } from '../../src/services/auth.js';
import { CompilerResolver } from '../../src/services/compilerResolver.js';
import { ProjectRegistry } from '../../src/services/projectRegistry.js';
import {
  buildPdfPath,
  logBaseDir,
  type CompileOutcome,
  type CompileRequest,
} from '../../src/services/compiler.js';
import { TASKS_EXTENSION } from '../../src/lib/tasks.js';
import type { ServerConfig } from '../../src/types.js';

/**
 * `compile` as an MCP task (#290), over raw protocol 2026-07-28 requests to the serving entry
 * itself (`createMcpHandler`, in-process): the SDK's own client refuses a `task` result, which is
 * the point — only a client that declares the Tasks extension may get one. The backend is a
 * stand-in that builds when released and stops when its signal aborts.
 */

const IDENTITY = { name: 'Test', email: 'test@example.com' };

interface Gate {
  requests: CompileRequest[];
  release: () => void;
}

describe('compile as an MCP task', () => {
  const cleanups: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c().catch(() => {});
  });

  async function setup(): Promise<{ ctx: AppContext; gate: Gate; post: Post }> {
    const workspace = await mkdtemp(path.join(os.tmpdir(), 'wlm-task-ws-'));
    const dir = await mkdtemp(path.join(os.tmpdir(), 'wlm-task-dir-'));
    cleanups.push(
      () => rm(workspace, { recursive: true, force: true }),
      () => rm(dir, { recursive: true, force: true }),
    );
    await writeFile(path.join(dir, 'main.tex'), '\\documentclass{article}\n');
    const pdfPath = buildPdfPath(dir, 'main.tex');
    await mkdir(path.dirname(pdfPath), { recursive: true });
    await writeFile(pdfPath, '%PDF-1.4\n');
    cleanups.push(() => rm(path.dirname(pdfPath), { recursive: true, force: true }));
    const config: ServerConfig = {
      workspaceRoot: workspace,
      sessionId: 'tasks',
      projects: [{ id: 'doc', mode: 'local', path: dir }],
      defaultProject: 'doc',
    };
    const ctx = createContext(
      config,
      new CredentialResolver({}),
      IDENTITY,
      new ProjectRegistry(workspace),
    );
    let release!: () => void;
    let released = new Promise<void>((r) => (release = r));
    const gate: Gate = { requests: [], release: () => release() };
    ctx.compiler = new CompilerResolver('latexmk', false, () => ({
      isAvailable: async () => true,
      compile: async (req: CompileRequest): Promise<CompileOutcome> => {
        gate.requests.push(req);
        req.onProgress?.('latexmk: run 1 of pdflatex');
        await Promise.race([
          released,
          new Promise<void>((r) => req.signal?.addEventListener('abort', () => r())),
        ]);
        released = new Promise<void>((r) => (release = r));
        return {
          success: !req.signal?.aborted,
          pdfPath,
          durationSec: 0.1,
          log: 'Output written on main.pdf (1 page).',
          timedOut: false,
          logBaseDir: logBaseDir(req.rootFile),
          rebuilt: true,
        };
      },
    }));
    const handler = createMcpHandler(() => createServer(ctx), { legacy: 'reject' });
    cleanups.push(() => handler.close());
    const post: Post = async (method, params, opts = {}) => {
      const envelope = {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'claude-code', version: '1' },
        'io.modelcontextprotocol/clientCapabilities':
          opts.tasks === false ? {} : { extensions: { [TASKS_EXTENSION]: {} } },
      };
      const name = (params.name ?? params.taskId) as string | undefined;
      const res = await handler.fetch(
        new Request('http://test.local/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2026-07-28',
            'mcp-method': method,
            ...(name !== undefined ? { 'mcp-name': name } : {}),
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method,
            params: { ...params, _meta: envelope },
          }),
        }),
      );
      const text = await res.text();
      // An SSE answer carries the JSON-RPC message on its `data:` line.
      const json = text.startsWith('{') ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? '{}');
      return JSON.parse(json) as { result?: Record<string, unknown>; error?: { message: string } };
    };
    return { ctx, gate, post };
  }

  type Post = (
    method: string,
    params: Record<string, unknown>,
    opts?: { tasks?: boolean },
  ) => Promise<{ result?: Record<string, unknown>; error?: { message: string } }>;

  const until = async (
    post: Post,
    taskId: string,
    status: string,
  ): Promise<Record<string, unknown>> => {
    for (let i = 0; i < 200; i++) {
      const got = (await post('tasks/get', { taskId })).result!;
      if (got.status === status) return got;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`task ${taskId} never reached ${status}`);
  };

  it('advertises the Tasks extension', async () => {
    const { post } = await setup();
    const discover = await post('server/discover', {});
    const caps = discover.result!.capabilities as { extensions?: Record<string, unknown> };
    expect(caps.extensions?.[TASKS_EXTENSION]).toEqual({});
  });

  it('answers with a task, reports its passes, and completes with the compile result', async () => {
    const { ctx, gate, post } = await setup();
    const call = await post('tools/call', { name: 'compile', arguments: {} });
    const task = call.result!;
    expect(task.resultType).toBe('task');
    expect(task.status).toBe('working');
    expect(typeof task.taskId).toBe('string');
    const taskId = task.taskId as string;

    // While it runs, the project lock is held and the status follows the build.
    await expect.poll(() => gate.requests.length).toBe(1);
    expect(ctx.projectManager.isBusy()).toBe(true);
    const working = (await post('tasks/get', { taskId })).result!;
    expect(working).toMatchObject({ taskId, status: 'working', resultType: 'complete' });
    expect(working.statusMessage).toBe('latexmk: run 1 of pdflatex');

    gate.release();
    const done = await until(post, taskId, 'completed');
    const result = done.result as { structuredContent?: { success?: boolean } };
    expect(result.structuredContent?.success).toBe(true);
    expect(ctx.projectManager.isBusy()).toBe(false);
  });

  it('stops the build on tasks/cancel: the backend sees its signal abort', async () => {
    const { gate, post } = await setup();
    const taskId = (await post('tools/call', { name: 'compile', arguments: {} })).result!
      .taskId as string;
    await expect.poll(() => gate.requests.length).toBe(1);
    const ack = await post('tasks/cancel', { taskId });
    expect(ack.error).toBeUndefined();
    await until(post, taskId, 'cancelled');
    expect(gate.requests[0]!.signal?.aborted).toBe(true);
  });

  it('keeps the blocking call for a client that does not declare the extension', async () => {
    const { gate, post } = await setup();
    const pending = post('tools/call', { name: 'compile', arguments: {} }, { tasks: false });
    await expect.poll(() => gate.requests.length).toBe(1);
    gate.release();
    const plain = (await pending).result!;
    expect(plain.resultType).toBe('complete');
    expect((plain.structuredContent as { success?: boolean }).success).toBe(true);
  });

  it('refuses an unknown task id', async () => {
    const { post } = await setup();
    expect((await post('tasks/get', { taskId: 'nope' })).error?.message).toMatch(/No task/);
    expect((await post('tasks/cancel', { taskId: 'nope' })).error?.message).toMatch(/No task/);
  });
});
