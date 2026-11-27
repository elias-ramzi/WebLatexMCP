import { z } from 'zod';
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import {
  CLIENT_CAPABILITIES_META_KEY,
  ProtocolError,
  ProtocolErrorCode,
} from '@modelcontextprotocol/server';
import type { AppContext } from '../context.js';
import { inputSchema as compileInputSchema, runCompile } from '../tools/compile.js';
import type { CompileArgs } from '../tools/compile.js';
import { quoteId } from './projectId.js';

/**
 * `compile` as an MCP task (#290): the Tasks extension (`io.modelcontextprotocol/tasks`, SEP-2663,
 * protocol revision 2026-07-28), so a long build runs in the background instead of holding the
 * call — and the conversation — for minutes.
 *
 * A `compile` call becomes a task only when its request declares the extension in its own
 * `_meta` envelope (`clientCapabilities.extensions`): SEP-2663 forbids a task to any other
 * request, so every 2025-era client, and a 2026 one that does not declare it, gets the blocking
 * call unchanged. The task runs `runCompile` itself — the same budgets, the same `outputSchema`,
 * the project lock held from its start to its end, so a peer waits exactly as for a blocking
 * build — and `tasks/cancel` aborts it, killing the backend and every process it started
 * (`execCapture`'s `signal`). Its status message follows the build's passes.
 *
 * **Where it hooks in.** SDK 2.4 has no task support (v1's experimental tasks were removed) and
 * no request middleware, and `McpServer` validates a tool's result against its `outputSchema`
 * before anything else sees it — a task handle carries no `structuredContent`, so a tool callback
 * cannot return one. So `installTasks` wraps the low-level `tools/call` handler `McpServer`
 * installs (the protocol's `_requestHandlers` entry), answering a task-eligible `compile` itself
 * and passing every other call through untouched. That is a private field: a test pins that a
 * 2026 client declaring the extension gets a task, so an SDK upgrade that moves it fails there
 * rather than silently serving blocking builds. Without the field, tasks are simply off.
 */

export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';

/** Whether this request's client declared the Tasks extension (2026-07-28 envelope only). */
export function clientDeclaresTasks(ctx: ServerContext | undefined): boolean {
  const envelope = ctx?.mcpReq.envelope as Record<string, unknown> | undefined;
  const caps = envelope?.[CLIENT_CAPABILITIES_META_KEY] as { extensions?: unknown } | undefined;
  const extensions = caps?.extensions;
  return (
    extensions !== null &&
    typeof extensions === 'object' &&
    Object.hasOwn(extensions as object, TASKS_EXTENSION)
  );
}

const compileArgs = z.object(compileInputSchema);
const taskIdParams = z.object({ taskId: z.string().min(1).max(200) }).passthrough();
const anyResult = z.object({}).passthrough();

type RawHandler = (request: { params?: unknown }, ctx: ServerContext) => Promise<unknown>;

/** A task id the session does not know: a JSON-RPC error, as SEP-2663 asks. */
function unknownTask(taskId: string): ProtocolError {
  return new ProtocolError(
    ProtocolErrorCode.InvalidParams,
    `No task ${quoteId(taskId)} in this session (finished tasks are kept for an hour).`,
  );
}

/** A tool result with `structuredContent` left out, for a server built without output schemas. */
function withoutStructuredContent(result: Record<string, unknown>): Record<string, unknown> {
  const { structuredContent: _omitted, ...rest } = result;
  return rest;
}

/**
 * Serve the Tasks extension on `server` for `ctx`'s session: advertise it, answer `tasks/get`,
 * `tasks/update` and `tasks/cancel`, and turn a task-eligible `compile` call into a task. Call
 * once every tool is registered. A context without a task store (a test's) installs nothing.
 */
export function installTasks(
  server: McpServer,
  ctx: AppContext,
  shape: { stripOutputSchema?: boolean } = {},
): void {
  const tasks = ctx.tasks;
  if (!tasks) return;
  const protocol = server.server as unknown as { _requestHandlers?: Map<string, RawHandler> };
  const original = protocol._requestHandlers?.get('tools/call');
  if (!original) return;

  server.server.registerCapabilities({
    extensions: { [TASKS_EXTENSION]: {} },
  } as Parameters<typeof server.server.registerCapabilities>[0]);

  server.server.setRequestHandler(
    'tasks/get',
    { params: taskIdParams, result: anyResult },
    ({ taskId }) => {
      const task = tasks.get(taskId);
      if (!task) throw unknownTask(taskId);
      return { ...task };
    },
  );
  // No task here ever asks the client for input, so there is never an outstanding request to
  // answer: a known task acknowledges (and ignores) responses, as SEP-2663 lets it.
  server.server.setRequestHandler(
    'tasks/update',
    {
      params: z
        .object({ taskId: z.string().min(1).max(200), inputResponses: z.unknown().optional() })
        .passthrough(),
      result: anyResult,
    },
    ({ taskId }) => {
      if (!tasks.get(taskId)) throw unknownTask(taskId);
      return {};
    },
  );
  server.server.setRequestHandler(
    'tasks/cancel',
    { params: taskIdParams, result: anyResult },
    ({ taskId }) => {
      if (!tasks.cancel(taskId)) throw unknownTask(taskId);
      return {};
    },
  );

  protocol._requestHandlers!.set('tools/call', async (request, rctx) => {
    const params = request.params as { name?: unknown; arguments?: unknown } | undefined;
    if (params?.name !== 'compile' || !clientDeclaresTasks(rctx)) return original(request, rctx);
    const parsed = compileArgs.safeParse(params.arguments ?? {});
    // Arguments the tool would refuse are refused the usual way, by the usual path.
    if (!parsed.success) return original(request, rctx);
    const args = parsed.data as CompileArgs;
    const task = tasks.start(async (run) => {
      const result = (await runCompile(ctx, args, {
        signal: run.signal,
        onProgress: run.progress,
      })) as unknown as Record<string, unknown>;
      return shape.stripOutputSchema ? withoutStructuredContent(result) : result;
    }, 'Starting the build.');
    return { resultType: 'task', ...task };
  });
}
