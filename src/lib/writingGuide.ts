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
 * with `WEB_LATEX_MCP_WRITING_GUIDE` to point at a project-specific guide. Returns
 * `undefined` (and logs to stderr) when the file is absent or empty, so a missing
 * guide never prevents the server from starting.
 */
export async function loadWritingGuide(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const override = env.WEB_LATEX_MCP_WRITING_GUIDE?.trim();
  const path = override ? resolve(override) : bundledGuidePath();
  try {
    const text = (await readFile(path, 'utf8')).trim();
    return text.length > 0 ? text : undefined;
  } catch (err) {
    console.error(
      `[web-latex-mcp] writing guide not loaded from ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}

/**
 * Wrap each available guide in a short framing sentence so the client knows what it
 * is and when to apply it, then join them into one `instructions` string. Returns
 * `undefined` when no guide is present, so the server advertises no instructions in
 * that case.
 */
export function buildInstructions(
  writingGuide?: string,
  concurrencyGuide?: string,
): string | undefined {
  const sections: string[] = [];
  if (writingGuide) {
    sections.push(
      'When reading, writing, editing, or reviewing LaTeX (.tex) files through this ' +
        "server, follow the project's LaTeX writing guide below.\n\n" +
        writingGuide,
    );
  }
  if (concurrencyGuide) {
    sections.push(
      'When committing or pushing changes through this server, follow the concurrency ' +
        'and safe-push rules below.\n\n' +
        concurrencyGuide,
    );
  }
  return sections.length > 0 ? sections.join('\n\n---\n\n') : undefined;
}
