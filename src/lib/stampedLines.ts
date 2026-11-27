import { StringDecoder } from 'node:string_decoder';

/**
 * Time stamps on every line a process writes to a stream: `web-latex-mcp serve` stamps its stderr,
 * which is the daemon's log (`<workspace>/.daemon/daemon.log`). That log is read after the fact,
 * beside Claude Code's own time-stamped MCP logs, and lines without times cannot be lined up with
 * them (when a session closed, which session a probe opened). The stdio server's stderr is not
 * stamped: its client stamps what it records.
 */

/**
 * `text` with `stamp` and a space before the start of each line in it. `atLineStart` says whether
 * the previous write ended a line; the result says whether this one did. A line written in
 * several pieces is stamped once.
 */
export function stampText(
  text: string,
  atLineStart: boolean,
  stamp: string,
): { text: string; atLineStart: boolean } {
  let out = '';
  let start = atLineStart;
  // Split after each newline, keeping it: "a\nb" → ["a\n", "b"].
  for (const piece of text.split(/(?<=\n)/)) {
    if (piece === '') continue;
    out += (start ? `${stamp} ` : '') + piece;
    start = piece.endsWith('\n');
  }
  return { text: out, atLineStart: start };
}

type Write = NodeJS.WritableStream['write'];

/**
 * Stamp every line later written to `stream` with `now()` as an ISO time (UTC, like Claude Code's
 * logs). Bytes are decoded as UTF-8 across writes, so a character split between two chunks (a
 * worker's piped stderr) survives. Returns the function that puts the stream's own `write` back.
 */
export function stampLines(
  stream: NodeJS.WritableStream,
  now: () => Date = () => new Date(),
): () => void {
  const original = stream.write;
  const write = original.bind(stream) as (
    chunk: string,
    encoding: BufferEncoding,
    cb?: (err?: Error | null) => void,
  ) => boolean;
  const decoder = new StringDecoder('utf8');
  let atLineStart = true;
  stream.write = ((chunk: unknown, encoding?: unknown, cb?: unknown): boolean => {
    const callback = (typeof encoding === 'function' ? encoding : cb) as
      | ((err?: Error | null) => void)
      | undefined;
    const text =
      typeof chunk === 'string'
        ? typeof encoding === 'string' && !/^utf-?8$/i.test(encoding)
          ? Buffer.from(chunk, encoding as BufferEncoding).toString('utf8')
          : chunk
        : decoder.write(Buffer.from(chunk as Uint8Array));
    const stamped = stampText(text, atLineStart, now().toISOString());
    atLineStart = stamped.atLineStart;
    return write(stamped.text, 'utf8', callback);
  }) as Write;
  return () => {
    stream.write = original;
  };
}
