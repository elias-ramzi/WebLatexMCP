#!/usr/bin/env node
import { runCli } from './cli.js';
import { runStandalone } from './standalone.js';
import { runProxy, standaloneRequested } from './proxy/proxyCommand.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // A command (`serve`, `daemon …`, `migrate-workspace`, `import-env-projects`, `--help`) runs and
  // exits. Checked first, so a command never touches the stdio JSON-RPC channel.
  const status = await runCli(argv, {
    env: process.env,
    cwd: process.cwd(),
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  });
  if (status !== undefined) {
    process.exitCode = status;
    return;
  }
  if (standaloneRequested(argv, process.env)) {
    await runStandalone();
    return;
  }
  // The default: relay this client's stdio to the workspace's shared server, starting it if
  // need be; when that cannot be done, serve this session in-process, as before
  // (docs/design/shared-server.md §9.1).
  const relayed = await runProxy({
    env: process.env,
    cwd: process.cwd(),
    stdin: process.stdin,
    stdout: process.stdout,
    log: (line) => process.stderr.write(`[web-latex-mcp] ${line}\n`),
    // Killed rather than closed: still end the session on the shared server, so it does not read
    // live for its idle timeout and the session id can be taken over at once.
    onStop: (stop) => {
      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(signal, stop);
    },
  });
  if (relayed.kind === 'unavailable') {
    process.stderr.write(
      `[web-latex-mcp] shared server unavailable (${relayed.reason}); serving this session ` +
        'in-process instead\n',
    );
    await runStandalone({ daemonUnavailable: relayed.reason });
    return;
  }
  if (relayed.kind === 'failed') process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error('[web-latex-mcp] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
