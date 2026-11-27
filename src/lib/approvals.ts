import { z } from 'zod';
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import {
  CLIENT_CAPABILITIES_META_KEY,
  acceptedContent,
  inputRequired,
  inputResponse,
} from '@modelcontextprotocol/server';
import { listIds, quoteId } from './projectId.js';

/**
 * Asking the user, not trusting the model, before a guarded change (#289).
 *
 * Several guards exist so that the **user** decides — `confirmBibEdit` (a `.bib` change),
 * `confirmGuideEdit` (a rule every later session reads), `overrideExternalChanges` (throwing away
 * the user's own hand edits), `confirm: true` on `discard` and `reset_to_remote` (losing work) —
 * yet the model satisfies each by setting a boolean, and the server cannot tell a flag the user
 * asked for from one the model set on its own. When the client can show a form (MCP elicitation),
 * a call setting one of those flags now asks the user directly and proceeds only on their yes.
 *
 * - **The flag is still required.** It is the model's statement that it means to make a guarded
 *   change; without it the tool refuses exactly as before, so nothing new is ever asked of the
 *   user for a call the model did not mean to make. With it, the flag is no longer sufficient.
 * - **A client without form elicitation keeps today's behaviour** (the flag alone), and so does a
 *   session with `WEB_LATEX_MCP_APPROVALS=flag`: some clients declare elicitation and still answer
 *   every request without asking anyone (Claude Code in `-p` and SDK runs), where a form would make
 *   the guarded change impossible. The decline message says so.
 * - **Both protocol eras, one code path.** The gate returns `inputRequired(...)`: on 2026-07-28
 *   the client answers and retries the call; on a 2025 connection the SDK's legacy shim sends a
 *   real `elicitation/create` and re-enters the handler. Either way the tool runs once, after the
 *   answer, with the call's own arguments — the approval is bound to that call.
 * - The question names what will change, every name quoted (`quoteId`), so a path or rule cannot
 *   pose as part of the question.
 *
 * Installed by `createServer` as a `registerTool` wrapper (`installApprovalGates`), like the call
 * log: each tool's handler stays as it was, and a gate is one entry in {@link GATES}.
 */

export type ApprovalsMode = 'ask' | 'flag';

/** `WEB_LATEX_MCP_APPROVALS`: `flag` (or off/no/0/false) relies on the flags alone; else `ask`. */
export function parseApprovalsMode(raw: string | undefined): {
  mode: ApprovalsMode;
  invalid?: string;
} {
  const v = raw?.trim().toLowerCase();
  if (!v || v === 'ask' || /^(1|true|yes|on)$/.test(v)) return { mode: 'ask' };
  if (v === 'flag' || /^(0|false|no|off)$/.test(v)) return { mode: 'flag' };
  return { mode: 'ask', invalid: raw };
}

/** The one key every gate's question is asked under. */
export const APPROVAL_KEY = 'approval';

const approvalSchema = z.object({
  approve: z.boolean().meta({ title: 'Allow it', description: 'Tick to allow this change.' }),
});

/** What one call asks the user to approve, or `undefined` when it sets no guarded flag. */
type Gate = (args: Record<string, unknown>) => string | undefined;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const projectOf = (args: Record<string, unknown>): string =>
  str(args.project) !== undefined ? ` in project ${quoteId(str(args.project)!)}` : '';

/** The files an `edit_file` call names: its `path`, or every entry of `files`. */
const editedPaths = (args: Record<string, unknown>): string[] => {
  const files = Array.isArray(args.files) ? args.files : [];
  const named = files
    .map((f) => (f && typeof f === 'object' ? str((f as { path?: unknown }).path) : undefined))
    .filter((p): p is string => p !== undefined);
  const one = str(args.path);
  return one !== undefined ? [one, ...named] : named;
};

/** The concerns a write tool's flags raise, joined into one question. */
function writeQuestion(verb: string, paths: string[], args: Record<string, unknown>) {
  const concerns: string[] = [];
  if (args.confirmBibEdit === true) concerns.push('it changes the bibliography (.bib) by hand');
  if (args.overrideExternalChanges === true) {
    concerns.push('it overwrites any change made to the file outside this session');
  }
  if (concerns.length === 0) return undefined;
  return `Claude asks to ${verb} ${listIds(paths)}${projectOf(args)}: ${concerns.join(', and ')}. Allow it?`;
}

/**
 * The guarded tools. Each reads the call's own arguments; a tool whose call sets none of its
 * guarded flags runs untouched.
 */
export const GATES: Readonly<Record<string, Gate>> = {
  write_file: (a) => writeQuestion('write', [str(a.path) ?? '?'], a),
  edit_file: (a) => writeQuestion('edit', editedPaths(a), a),
  delete_file: (a) => writeQuestion('delete', [str(a.path) ?? '?'], a),
  add_asset: (a) =>
    a.overrideExternalChanges === true
      ? `Claude asks to overwrite ${quoteId(str(a.path) ?? '?')}${projectOf(a)} with a copy of ` +
        `${quoteId(str(a.source) ?? '?')}, replacing any change made to it outside this session. ` +
        'Allow it?'
      : undefined,
  apply_citation_profile: (a) =>
    a.confirmBibEdit === true && a.dryRun !== true
      ? `Claude asks to remove, from the bibliography ${quoteId(str(a.bibFile) ?? '(the project .bib)')}` +
        `${projectOf(a)}, every field the citation profile leaves out. Allow it?`
      : undefined,
  revert: (a) =>
    a.confirmBibEdit === true
      ? `Claude asks to revert ${listIds(strings(a.commits))}${projectOf(a)}, which changes the ` +
        'bibliography (.bib). Allow it?'
      : undefined,
  shelve: (a) =>
    a.confirmBibEdit === true
      ? `Claude asks to set aside uncommitted work${projectOf(a)}, including changes to the ` +
        'bibliography (.bib). Allow it?'
      : undefined,
  unshelve: (a) =>
    a.confirmBibEdit === true
      ? `Claude asks to put back the shelf ${quoteId(str(a.id) ?? '?')}${projectOf(a)}, which ` +
        'changes the bibliography (.bib). Allow it?'
      : undefined,
  push: (a) =>
    a.confirmBibEdit === true
      ? `Claude asks to push${projectOf(a)} with a conflict resolution that changes the ` +
        'bibliography (.bib). Allow it?'
      : undefined,
  add_writing_convention: (a) =>
    a.confirmGuideEdit === true
      ? `Claude asks to add this rule to your writing guide, which every later session reads: ` +
        `${quoteId((str(a.rule) ?? '').slice(0, 500))}. Allow it?`
      : undefined,
  discard: (a) =>
    a.confirm === true
      ? `Claude asks to discard uncommitted changes${projectOf(a)}` +
        `${strings(a.paths).length > 0 ? ` to ${listIds(strings(a.paths))}` : ' (all of them)'}; ` +
        'they cannot be recovered. Allow it?'
      : undefined,
  reset_to_remote: (a) =>
    a.confirm === true
      ? `Claude asks to reset${projectOf(a)} to the remote, discarding local commits and ` +
        'uncommitted changes. Allow it?'
      : undefined,
};

/**
 * The client's declared elicitation modes, in whichever era this request came: a 2026-07-28
 * request's envelope first, else what the 2025 `initialize` declared. `undefined` when none.
 */
function elicitationModes(
  server: McpServer,
  ctx: ServerContext | undefined,
): { form?: unknown; url?: unknown } | undefined {
  const envelope = ctx?.mcpReq.envelope as Record<string, unknown> | undefined;
  const fromEnvelope = envelope?.[CLIENT_CAPABILITIES_META_KEY] as
    | { elicitation?: unknown }
    | undefined;
  const elicitation =
    fromEnvelope !== undefined
      ? fromEnvelope.elicitation
      : server.server.getClientCapabilities()?.elicitation;
  if (elicitation === null || typeof elicitation !== 'object') return undefined;
  return elicitation as { form?: unknown; url?: unknown };
}

/** Whether the client can answer a form elicitation, in whichever era this request came. */
export function clientCanElicitForm(server: McpServer, ctx: ServerContext | undefined): boolean {
  const modes = elicitationModes(server, ctx);
  if (modes === undefined) return false;
  // A bare `elicitation: {}` predates modes and means form.
  return modes.form !== undefined || modes.url === undefined;
}

/** Whether the client can send the user to a URL (URL-mode elicitation), in either era. */
export function clientCanElicitUrl(server: McpServer, ctx: ServerContext | undefined): boolean {
  return elicitationModes(server, ctx)?.url !== undefined;
}

/** The refusal a declined (or unanswered) question becomes. */
export const DECLINED_MESSAGE =
  'The user did not approve this change, so nothing was done. Ask them what they want instead. ' +
  '(If no question was shown to them, their MCP client declines such questions on its own — ' +
  'some do in non-interactive runs; WEB_LATEX_MCP_APPROVALS=flag in the server config makes the ' +
  'confirmation flag enough again.)';

type AnyRegisterTool = (
  name: string,
  config: unknown,
  cb: (...cbArgs: unknown[]) => unknown,
) => unknown;

/**
 * Wrap `server.registerTool` so every gated tool registered afterwards asks the user before a
 * call that sets one of its guarded flags (see the module comment). `mode` is read per call, so a
 * session's setting applies however the server was built.
 */
export function installApprovalGates(server: McpServer, mode: () => ApprovalsMode): void {
  const target = server as unknown as { registerTool: AnyRegisterTool };
  const original = target.registerTool.bind(server);
  target.registerTool = (name, config, cb) => {
    const gate = Object.hasOwn(GATES, name) ? GATES[name] : undefined;
    if (gate === undefined) return original(name, config, cb);
    return original(name, config, (...cbArgs: unknown[]) => {
      // A tool with an input schema gets (args, ctx); every gated tool has one.
      const args = (cbArgs.length >= 2 ? cbArgs[0] : {}) as Record<string, unknown>;
      const ctx = cbArgs[cbArgs.length - 1] as ServerContext | undefined;
      const question = gate(args ?? {});
      if (question === undefined || mode() === 'flag' || !clientCanElicitForm(server, ctx)) {
        return cb(...cbArgs);
      }
      const responses = ctx?.mcpReq.inputResponses;
      const answer = inputResponse(responses, APPROVAL_KEY);
      if (answer.kind === 'missing') {
        return inputRequired({
          inputRequests: {
            [APPROVAL_KEY]: inputRequired.elicit({
              message: question,
              requestedSchema: {
                type: 'object',
                properties: {
                  approve: {
                    type: 'boolean',
                    title: 'Allow it',
                    description: 'Tick to allow this change.',
                    default: false,
                  },
                },
                required: ['approve'],
              },
            }),
          },
        });
      }
      const accepted = acceptedContent(responses, APPROVAL_KEY, approvalSchema);
      if (accepted?.approve !== true) {
        return { content: [{ type: 'text', text: DECLINED_MESSAGE }], isError: true };
      }
      return cb(...cbArgs);
    });
  };
}
