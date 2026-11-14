import { resolveWorkspace } from './config.js';
import { quoteId } from './lib/projectId.js';
import { toPosix } from './lib/paths.js';
import { MigrationRefusedError, migrateWorkspace } from './services/workspaceMigration.js';
import { importEnvProjects } from './services/envProjectImport.js';
import { SERVE_USAGE, runServe } from './daemon/serveCommand.js';
import { DAEMON_USAGE, runDaemonCommand } from './daemon/daemonCommand.js';
import { readCallLog, renderCallStats, summarizeCalls } from './lib/callStats.js';

/**
 * The one-shot commands `web-latex-mcp` runs instead of the MCP server. With no argument the
 * process is the server (stdio); with a known command it runs that command, prints to stdout —
 * there is no JSON-RPC stream to protect in that case — and exits with its status.
 */

export const USAGE =
  'Usage:\n' +
  '  npx web-latex-mcp                                relay stdio to the shared server,\n' +
  "      starting it if none answers (or serve in-process when it can't be reached)\n" +
  '  npx web-latex-mcp --standalone                   serve this one session in-process\n' +
  '      (also WEB_LATEX_MCP_STANDALONE=1)\n' +
  SERVE_USAGE +
  DAEMON_USAGE +
  '  npx web-latex-mcp migrate-workspace <from> [--to <workspace>]\n' +
  "      move an older version's workspace-local folder (<repo>/.web_latex_mcp) into the\n" +
  '      workspace in use (WEB_LATEX_MCP_WORKSPACE, default ~/.web-latex-mcp/projects)\n' +
  '  npx web-latex-mcp import-env-projects [--to <workspace>]\n' +
  '      register the projects in WEB_LATEX_MCP_PROJECTS in the workspace registry\n' +
  '  npx web-latex-mcp call-stats [--days <n>] [--json] [--to <workspace>]\n' +
  '      summarise the tool-call log (<workspace>/.logs/tool-calls.jsonl): tokens and time\n' +
  '      per tool, waits, repeated calls and back-to-back pairs\n';

export interface CliIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  out: (text: string) => void;
  err: (text: string) => void;
}

/** Split `[positional..., --to <dir>]`; undefined when the arguments do not parse. */
function parseArgs(args: string[]): { positional: string[]; to?: string } | undefined {
  const positional: string[] = [];
  let to: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === '--to') {
      const value = args[i + 1];
      if (value === undefined || to !== undefined) return undefined;
      to = value;
      i++;
    } else if (arg.startsWith('-')) {
      return undefined;
    } else {
      positional.push(arg);
    }
  }
  return { positional, to };
}

function list(items: readonly string[]): string {
  return items.length === 0 ? '(none)' : items.map((i) => quoteId(i)).join(', ');
}

/**
 * Run a command from `argv` (without the node and script paths). Returns the exit status, or
 * `undefined` meaning "start the server": `argv` is empty, or starts with an option other than
 * `--help`/`-h`.
 */
export async function runCli(argv: string[], io: CliIo): Promise<number | undefined> {
  if (argv.length === 0) return undefined;
  const [command, ...rest] = argv;
  if (command === '--help' || command === '-h' || command === 'help') {
    io.out(USAGE);
    return 0;
  }
  // An option the server never took (a wrapper's `"$@"`, a leftover `--stdio`) used to be ignored;
  // it still is, so such a config keeps starting the server. Only a bare word is a command.
  // `--standalone` is the server's own option (src/index.ts), never ignored.
  if (command === '--standalone') return undefined;
  if (command !== undefined && command.startsWith('-')) {
    io.err(
      `[web-latex-mcp] ignoring ${argv.map((x) => quoteId(x)).join(' ')}; starting the server\n`,
    );
    return undefined;
  }
  if (command === 'serve') return runServe(rest, io);
  if (command === 'daemon') return runDaemonCommand(rest, io);
  if (command === 'call-stats') return runCallStats(rest, io);
  const parsed = parseArgs(rest);
  try {
    if (command === 'migrate-workspace' && parsed && parsed.positional.length === 1) {
      const to = parsed.to ?? resolveWorkspace(io.env.WEB_LATEX_MCP_WORKSPACE, io.cwd);
      const report = await migrateWorkspace({ from: parsed.positional[0] as string, to });
      if (report.moved.length === 0 && report.registered.length === 0) {
        io.out(`Nothing to move from ${quoteId(report.from)}; it is already migrated.\n`);
        return 0;
      }
      io.out(
        `Moved from ${quoteId(report.from)} to ${quoteId(report.to)}:\n` +
          `  entries moved: ${list(report.moved)}\n` +
          `  projects registered: ${list(report.registered)}\n` +
          (report.alreadyRegistered.length > 0
            ? `  already registered there: ${list(report.alreadyRegistered)}\n`
            : '') +
          (report.defaultDropped !== undefined
            ? `  ${quoteId(report.defaultDropped)} was the default project there; the new ` +
              'workspace already has one, which stays the default\n'
            : '') +
          'Restart your MCP clients so they pick up the moved projects. Each project builds ' +
          'from scratch on its first compile.\n',
      );
      return 0;
    }
    if (command === 'import-env-projects' && parsed && parsed.positional.length === 0) {
      const to = parsed.to ?? resolveWorkspace(io.env.WEB_LATEX_MCP_WORKSPACE, io.cwd);
      const report = await importEnvProjects(io.env, io.cwd, to);
      io.out(
        `Workspace ${quoteId(toPosix(report.workspace))}:\n` +
          `  imported: ${list(report.imported)}\n` +
          `  already registered: ${list(report.unchanged)}\n`,
      );
      if (report.credentialsStripped.length > 0) {
        io.out(
          `  credentials removed from the URL of ${list(report.credentialsStripped)} before it ` +
            'was saved; give the token through tokenEnv, the environment or credential_portal\n',
        );
      }
      for (const r of report.refused) io.err(`  not imported ${quoteId(r.id)}: ${r.reason}\n`);
      return report.refused.length > 0 ? 1 : 0;
    }
  } catch (err) {
    io.err(
      `${err instanceof MigrationRefusedError ? '' : 'web-latex-mcp: '}${(err as Error).message}\n`,
    );
    return 1;
  }
  io.err(`Unknown command or arguments: ${argv.map((a) => quoteId(a)).join(' ')}\n\n${USAGE}`);
  return 2;
}

/** `call-stats [--days <n>] [--json] [--to <workspace>]`. */
async function runCallStats(args: string[], io: CliIo): Promise<number> {
  let days: number | undefined;
  let json = false;
  let to: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = args[i + 1];
    if (arg === '--json') json = true;
    else if (arg === '--days' && value !== undefined && /^[0-9]+(\.[0-9]+)?$/.test(value)) {
      days = Number(value);
      i++;
    } else if (arg === '--to' && value !== undefined) {
      to = value;
      i++;
    } else {
      io.err(`Unknown call-stats argument: ${quoteId(String(arg))}\n\n${USAGE}`);
      return 2;
    }
  }
  const workspace = to ?? resolveWorkspace(io.env.WEB_LATEX_MCP_WORKSPACE, io.cwd);
  const since = days === undefined ? 0 : Date.now() - days * 86_400_000;
  try {
    const stats = summarizeCalls(await readCallLog(workspace, since));
    io.out(json ? `${JSON.stringify(stats, null, 2)}\n` : renderCallStats(stats));
    return 0;
  } catch (err) {
    io.err(`web-latex-mcp: ${(err as Error).message}\n`);
    return 1;
  }
}
