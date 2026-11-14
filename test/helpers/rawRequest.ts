import http from 'node:http';

/**
 * One HTTP request with headers `fetch` will not let a test set (`Host`, and `Origin` from a
 * non-browser client), for the loopback listeners' `Host`/`Origin` checks.
 */
export function rawRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: opts.method ?? 'GET', headers: opts.headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}
