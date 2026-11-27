import path from 'node:path';
import { loadConfig as loadConfigFromDisk } from '../../src/config.js';
import {
  readProjectRegistry,
  readProjectRegistryDefault,
  readProjectRegistrySkipped,
} from '../../src/services/projectRegistry.js';
import { homeWorkspaceRoot } from '../../src/lib/workspaceNote.js';

/*
 * `loadConfig` for tests, kept off the developer's own files (#292).
 *
 * An unset `WEB_LATEX_MCP_WORKSPACE` resolves to the one shared workspace,
 * `~/.web-latex-mcp/projects`, and the default registry readers then read the real
 * `registry.json` of whoever runs the suite: a test expecting "no projects" passes on a CI runner
 * and fails on every machine that uses the server. This wrapper keeps `loadConfig`'s resolution
 * exactly as it is (a test can still assert that the workspace IS the home one) but answers every
 * registry read of that home workspace as an empty registry. A workspace the test points at
 * (a temp dir) is read from disk as before, and readers a test passes itself always win.
 *
 * Likewise the launch dir: a test that names no `cwd` gets `process.cwd()`, the checkout, whose
 * leftover `.web_latex_mcp` (if any) is the developer's too, so no legacy workspace is looked for
 * there. A test that names a launch dir keeps the real lookup, which is what the legacy-workspace
 * tests exercise.
 */

const isHome = (workspaceRoot: string): boolean =>
  path.resolve(workspaceRoot) === path.resolve(homeWorkspaceRoot());

type LoadConfigArgs = Parameters<typeof loadConfigFromDisk>;

export function loadConfig(
  env: LoadConfigArgs[0] = {},
  cwd?: LoadConfigArgs[1],
  readRegistry: LoadConfigArgs[2] = (root) => (isHome(root) ? [] : readProjectRegistry(root)),
  readRegistryDefault: LoadConfigArgs[3] = (root) =>
    isHome(root) ? undefined : readProjectRegistryDefault(root),
  readRegistrySkipped: LoadConfigArgs[4] = (root) =>
    isHome(root) ? [] : readProjectRegistrySkipped(root),
  findLegacyWorkspace?: LoadConfigArgs[5],
): ReturnType<typeof loadConfigFromDisk> {
  return loadConfigFromDisk(
    env,
    cwd ?? process.cwd(),
    readRegistry,
    readRegistryDefault,
    readRegistrySkipped,
    findLegacyWorkspace ?? (cwd === undefined ? () => undefined : undefined),
  );
}
