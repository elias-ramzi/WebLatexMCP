import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/** Path to the bundled guide, relative to this module (works from src/ and dist/). */
function bundledGuidePath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/writing-guide.md');
}

/**
 * Read the LaTeX writing guide that is surfaced to MCP clients as the server's
 * `instructions` hint. Defaults to the bundled `docs/writing-guide.md`; override
 * with `GIT_MCP_WRITING_GUIDE` to point at a project-specific guide. Returns
 * `undefined` (and logs to stderr) when the file is absent or empty, so a missing
 * guide never prevents the server from starting.
 */
export async function loadWritingGuide(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const override = env.GIT_MCP_WRITING_GUIDE?.trim();
  const path = override ? resolve(override) : bundledGuidePath();
  try {
    const text = (await readFile(path, 'utf8')).trim();
    return text.length > 0 ? text : undefined;
  } catch (err) {
    console.error(
      `[latex-git-mcp] writing guide not loaded from ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/**
 * Wrap the guide in a short framing sentence so the client knows what it is and
 * when to apply it. Returns `undefined` when there is no guide, so the server
 * advertises no instructions in that case.
 */
export function buildInstructions(guide: string | undefined): string | undefined {
  if (!guide) return undefined;
  return (
    'When reading, writing, editing, or reviewing LaTeX (.tex) files through this ' +
    "server, follow the project's LaTeX writing guide below.\n\n" +
    guide
  );
}
