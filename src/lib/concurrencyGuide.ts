import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/** Path to the bundled guide, relative to this module (works from src/ and dist/). */
function bundledGuidePath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/CONCURRENCY.md');
}

/**
 * Read the concurrency / safe-push guide surfaced to MCP clients (as part of the
 * `instructions` hint and as a fetchable resource). Defaults to the bundled
 * `docs/CONCURRENCY.md`; override with `GIT_MCP_CONCURRENCY_GUIDE`. Returns
 * `undefined` (and logs to stderr) when the file is absent or empty, so a missing
 * guide never prevents the server from starting. Mirrors {@link ./writingGuide}.
 */
export async function loadConcurrencyGuide(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const override = env.GIT_MCP_CONCURRENCY_GUIDE?.trim();
  const path = override ? resolve(override) : bundledGuidePath();
  try {
    const text = (await readFile(path, 'utf8')).trim();
    return text.length > 0 ? text : undefined;
  } catch (err) {
    console.error(
      `[latex-git-mcp] concurrency guide not loaded from ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
}
