import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import type { FakeRemote } from './bareRepo.js';

/**
 * A local smart-HTTP git remote that REQUIRES Basic auth: a Node `http` server in front of
 * `git http-backend` (a CGI shipped with every git install — Linux, macOS and Git for Windows
 * alike), serving one {@link FakeRemote}'s bare repo. No network beyond loopback, no secrets
 * beyond the throwaway pair the test picks.
 *
 * It exists because a `file://` remote never asks for a credential, so nothing about how the
 * server hands git its token can be observed through one. Here a request without the right
 * `Authorization` header gets a 401 challenge, so a clone/fetch/push that succeeds proves the
 * credential actually reached git.
 *
 * `onRequest` runs at the START of every request, before the backend is spawned — i.e. while
 * the client's git command is in flight. A test uses it to look at the client's on-disk state
 * mid-operation, which is the window a crash would freeze.
 */
export interface AuthHttpRemote {
  url: string;
  close: () => Promise<void>;
  /** Requests that carried the expected credential, and those that were refused with 401. */
  counts: { authorized: number; refused: number };
}

export async function serveWithAuth(
  remote: FakeRemote,
  cred: { username: string; password: string },
  onRequest: () => void | Promise<void> = () => undefined,
): Promise<AuthHttpRemote> {
  const expected = `Basic ${Buffer.from(`${cred.username}:${cred.password}`).toString('base64')}`;
  const root = path.dirname(remote.bareDir);
  const repoName = path.basename(remote.bareDir);
  const counts = { authorized: 0, refused: 0 };

  const server = http.createServer((req, res) => {
    void (async () => {
      await onRequest();
      if (req.headers.authorization !== expected) {
        counts.refused++;
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' });
        res.end('auth required');
        return;
      }
      counts.authorized++;
      const url = new URL(req.url ?? '/', 'http://localhost');
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.replace(/^\?/, ''),
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        // http-backend enables receive-pack (push) only for an authenticated user.
        REMOTE_USER: cred.username,
        REMOTE_ADDR: '127.0.0.1',
        HTTP_CONTENT_ENCODING: String(req.headers['content-encoding'] ?? ''),
        GIT_PROTOCOL: String(req.headers['git-protocol'] ?? ''),
      };
      const backend = spawn('git', ['http-backend'], { env, windowsHide: true });
      const out: Buffer[] = [];
      backend.stdout.on('data', (b: Buffer) => out.push(b));
      backend.stderr.on('data', () => undefined);
      req.pipe(backend.stdin);
      backend.on('close', () => {
        const raw = Buffer.concat(out);
        let sep = raw.indexOf('\r\n\r\n');
        let sepLen = 4;
        if (sep < 0) {
          sep = raw.indexOf('\n\n');
          sepLen = 2;
        }
        const head = sep < 0 ? '' : raw.subarray(0, sep).toString('latin1');
        const body = sep < 0 ? raw : raw.subarray(sep + sepLen);
        let status = 200;
        const headers: Record<string, string> = {};
        for (const line of head.split(/\r?\n/)) {
          const colon = line.indexOf(':');
          if (colon < 0) continue;
          const key = line.slice(0, colon).trim();
          const value = line.slice(colon + 1).trim();
          if (key.toLowerCase() === 'status') status = Number(value.split(' ')[0]) || 200;
          else headers[key] = value;
        }
        res.writeHead(status, headers);
        res.end(body);
      });
    })().catch(() => {
      res.statusCode = 500;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/${repoName}`,
    counts,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
