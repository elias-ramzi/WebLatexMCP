import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Skill, SkillProjectUse } from '../lib/skills.js';
import { escapeInvisibleChars, quoteId } from '../lib/projectId.js';

/**
 * `id` as a Markdown code span nothing in it can break out of. A registered id holds no backtick
 * (`src/lib/projectId.ts` refuses one), but an `unknown`/`unverified` id is whatever the client
 * sent: a backtick in it closed the span early, and a newline forged a line of the instruction.
 * So invisible and line-breaking characters are written as `\u{…}` (`escapeInvisibleChars`), and
 * the fence is one backtick longer than the longest run inside, padded with a space where the
 * text itself starts or ends with one (CommonMark strips exactly one such space).
 */
function idCodeSpan(id: string): string {
  const text = escapeInvisibleChars(id);
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * What the caller found out about the `project` argument it was handed, so
 * `buildSkillMessage` can stay pure and synchronous: the lookup happens at the call site and
 * only its verdict comes in here.
 *
 * - `known` — the id names a registered project (also the default, for a caller with no way
 *   to check: face value, exactly as before this guard existed).
 * - `unknown` — the server was asked and the id is not registered.
 * - `unverified` — the lookup itself failed. Distinct from `unknown` on purpose: saying "no
 *   such project" when we simply could not look is a different, and false, claim.
 */
export type ProjectVerdict = 'known' | 'unknown' | 'unverified';

/** Can this id be checked against the registered projects? Narrow by design — see below. */
export type ProjectLookup = (id: string) => boolean;

export interface SkillPromptOptions {
  /**
   * Asks whether an id names a project registered with this server. Optional: with nothing
   * wired, a supplied id is taken at face value, as it always was.
   */
  isRegisteredProject?: ProjectLookup;
}

/** Optional scoping argument, so the skill starts on a known project instead of asking. */
function projectArgsSchema(use: Exclude<SkillProjectUse, 'none'>) {
  const project = z
    .string()
    .describe('Project id to apply the skill to (omit to be asked, or to pick later).');
  return { project: use === 'required' ? project : project.optional() };
}

/**
 * Ask the server whether the id resolves, without ever letting that question break the
 * prompt. A prompt that errors is worse than one that asks a question, so a throwing lookup
 * becomes `unverified` (and a stderr line), never an exception out of prompt rendering.
 */
export function judgeProject(id: string, isRegisteredProject?: ProjectLookup): ProjectVerdict {
  if (!isRegisteredProject) return 'known';
  try {
    return isRegisteredProject(id) ? 'known' : 'unknown';
  } catch (err) {
    console.error(
      `[web-latex-mcp] could not check whether ${quoteId(id)} is a registered project: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return 'unverified';
  }
}

/**
 * Frame the skill body as an instruction the model is receiving now, rather than a
 * document it happens to be reading. Prompts arrive as an ordinary user message, so
 * without this the model can mistake a procedure for reference material.
 *
 * Two things the scope sentence must never do, both of which turn a client's guess into an
 * instruction the model then follows:
 *
 * 1. A `project: none` skill gets no scope sentence at all — not even when an id is passed.
 *    Its procedure does not act on a project, so any id it receives is at best context and
 *    at worst a mis-bound word of free text; either way `Apply it to the project X` would be
 *    an instruction nobody gave.
 * 2. An id the server does not recognise is reported as unrecognised, not asserted. A
 *    confident instruction naming a project that does not exist is the silently-wrong target
 *    this guard exists to prevent.
 */
export function buildSkillMessage(
  skill: Skill,
  project?: string,
  verdict: ProjectVerdict = 'known',
): string {
  const header = `Follow the "${skill.name}" procedure below, using this server's tools.`;
  const body = `---\n\n${skill.body}`;
  if (skill.project === 'none') return `${header}\n\n${body}`;

  const id = project?.trim();
  let scope: string;
  if (!id) {
    scope = 'Ask which project to apply it to if that is not already clear from the conversation.';
  } else if (verdict === 'unknown') {
    scope =
      `No project named ${idCodeSpan(id)} is registered with this server — do not assume it ` +
      'exists or act on it. Ask which project to use; `list_projects` shows what is registered.';
  } else if (verdict === 'unverified') {
    scope =
      `${idCodeSpan(id)} was supplied as the project, but the registered projects could not be ` +
      'checked just now — confirm it with `list_projects` before acting on it.';
  } else {
    scope = `Apply it to the project ${idCodeSpan(id)}.`;
  }
  return `${header} ${scope}\n\n${body}`;
}

/**
 * Expose each bundled skill as an MCP prompt. `.claude/skills` is a Claude Code–only
 * mechanism, so this is how the same procedures reach every other MCP client (Claude
 * Desktop, Cursor, …) — they ship with the server rather than being uploaded per user.
 *
 * Unlike a real skill these are user-invoked, not model-invoked: the client lists them
 * and the user picks one. Keep the prompt name equal to the skill slug so it reads the
 * same in every client.
 *
 * The argument list is built **per skill** from its `project:` declaration, and that is the
 * root-cause half of the fix: a client that binds a prompt's free-text invocation
 * positionally puts the first whitespace-delimited word into the first declared argument, so
 * `/session-feedback please describe why…` arrived as `project: "please"`. A skill that acts
 * on no project now advertises no argument, leaving nothing to mis-bind; `isRegisteredProject`
 * is the second half, for the skills that do take one.
 */
export function registerSkillPrompts(
  server: McpServer,
  skills: Skill[],
  { isRegisteredProject }: SkillPromptOptions = {},
): void {
  for (const skill of skills) {
    if (skill.project === 'none') {
      server.registerPrompt(
        skill.name,
        { title: skill.name, description: skill.description },
        () => ({
          messages: [
            {
              role: 'user' as const,
              content: { type: 'text' as const, text: buildSkillMessage(skill) },
            },
          ],
        }),
      );
      continue;
    }
    server.registerPrompt(
      skill.name,
      {
        title: skill.name,
        description: skill.description,
        argsSchema: projectArgsSchema(skill.project),
      },
      ({ project }) => ({
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: buildSkillMessage(
                skill,
                project,
                project?.trim() ? judgeProject(project.trim(), isRegisteredProject) : 'known',
              ),
            },
          },
        ],
      }),
    );
  }
}
