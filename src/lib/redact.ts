import { maskUrlPathAndQuery } from './gitUrlCredentials.js';

/**
 * Where a scheme may start in free text: not inside a run of scheme characters
 * (`[A-Za-z0-9+.-]`). Every URL rule below opens with it, so a match starts only at the beginning
 * of such a run and reads the whole run as its head. Without it a long run (`aaaa…`, `a+a+…`) was
 * re-scanned to its end from every position inside it — quadratic, in a function every
 * `errorResult` calls. The head is the whole run, digits and `+.-` included, so `1ssh://u:p@h`
 * matches from the `1` (`maskUrlPathAndQuery` parses from the first letter).
 */
const SCHEME_START = '(?<![A-Za-z0-9+.-])';

/**
 * A URL in free text: a scheme, `://`, and everything up to whitespace or a character that
 * conventionally closes a quoted URL in a message. Only the text this matches is ever touched by
 * the query and path rules, so `token=…` or a bare token in prose outside a URL is left alone
 * (a known token value is scrubbed by the `secrets` list instead).
 */
const URL_IN_TEXT = new RegExp(`${SCHEME_START}[A-Za-z0-9+.-]+:\\/\\/[^\\s'"<>\`]*`, 'g');

/**
 * Where a further URL starts inside a `URL_IN_TEXT` match: the head of a scheme run, read as
 * `URL_IN_TEXT` reads one. A match runs to whitespace, so URLs glued together
 * (`https://h/r#f,https://h/x?token=…`) are one match, and the first URL's parse puts the rest in
 * its fragment or its query, where the path and query rules never look (`maskUrlRun`).
 */
const EMBEDDED_URL_HEAD = new RegExp(`${SCHEME_START}[A-Za-z0-9+.-]+:\\/\\/`, 'g');

/**
 * How many URLs glued into one run `maskUrlRun` masks each to the end of the run (right to left);
 * past it, each is masked only up to the next one's scheme. The suffix pass costs the run's
 * length once per URL, so it is bounded; real messages glue two or three.
 */
const MAX_SUFFIX_MASKED_URLS = 16;

/**
 * `run` (one `URL_IN_TEXT` match) with every URL in it masked by `maskUrlPathAndQuery`. A URL
 * glued after the first sits, for the first URL's parse, in its fragment or query, where the path
 * and query rules never look; so each further URL is masked as its own.
 *
 * Right to left, each to the END of the run, the first URL last — what a run holding one URL
 * always got. A URL's credential value may itself contain a scheme (`?token=sec,https://h/y`,
 * `?token=secret://b`), which reads as a further URL's head: cut at that head, the value's front
 * was masked and its tail left showing (`token=***secret://b`); masked to the end of the run, the
 * value is masked whole by its own URL's query rule. Past `MAX_SUFFIX_MASKED_URLS` heads each URL
 * is masked only up to the next one's scheme (linear, with that residual).
 */
function maskUrlRun(run: string): string {
  const starts: number[] = [];
  EMBEDDED_URL_HEAD.lastIndex = run.indexOf('://') + 3;
  for (let m = EMBEDDED_URL_HEAD.exec(run); m !== null; m = EMBEDDED_URL_HEAD.exec(run)) {
    starts.push(m.index);
  }
  if (starts.length === 0) return maskUrlPathAndQuery(run);
  if (starts.length <= MAX_SUFFIX_MASKED_URLS) {
    // Masking a suffix changes nothing before its start, so the earlier heads stay where they are.
    let out = run;
    for (const start of [0, ...starts].reverse()) {
      out = out.slice(0, start) + maskUrlPathAndQuery(out.slice(start));
    }
    return out;
  }
  const pieces = [run.slice(0, starts[0])];
  for (let i = 0; i < starts.length; i++) {
    pieces.push(maskUrlPathAndQuery(run.slice(starts[i], starts[i + 1] ?? run.length)));
  }
  return maskUrlPathAndQuery(pieces.join(''));
}

/**
 * An http(s) userinfo behind a separator other than `//` — any run of `/` and `\`, or none — as
 * `stripGitUrlCredentials` reads one (`https:/u:pw@h`, `https:\u:pw@h`, `https:u:pw@h`). The
 * separator is taken atomically (lookahead + backreference), so a run of `\` cannot be split
 * between it and the userinfo; and the userinfo never runs across another `http(s):`, so each
 * start scans only to the next one — without both, `https:` repeated or `https:\\…` was
 * quadratic. The cost: a password itself containing `http:` keeps its tail in this shape (the
 * `//` rule above has no such limit).
 */
const LENIENT_HTTP_USERINFO =
  /(https?:(?=([/\\]*))\2)(?:(?!https?:)[^/?#@\s])*(?:@(?:(?!https?:)[^/?#@\s])*)*@/gi;

/**
 * A password in the userinfo of a non-http `<scheme>://` URL: the login runs to the userinfo's
 * first `:` (a raw `@` in it included, as the strip reads `ssh://a@b:pw@h`), and the password from
 * there to the LAST `@` before the authority ends — the greedy run backtracks to it. Without a `:`
 * followed later by an `@` there is no password: `ssh://git@host:22/r` is a port.
 */
const OTHER_PASSWORD = new RegExp(
  `${SCHEME_START}([A-Za-z0-9+.-]+:\\/\\/)([^/?#:\\s]*):[^/?#\\s]*@`,
  'g',
);

/**
 * Scrub secrets from a string before it is logged or returned to a client.
 * Replaces any explicitly known secret values, plus credentials embedded in URLs:
 * - an http(s) userinfo, whole (`https://user:token@host` -> `https://***@host`);
 * - a password in the userinfo of any other `<scheme>://` URL (`ssh://git:pw@host` ->
 *   `ssh://git:***@host`) — a login alone is left, as it is no secret there; a `file:` URL has no
 *   userinfo to judge (`file://C:\Users\me@corp\…` is a path);
 * - a credential query parameter inside a URL (`?private_token=XYZ` -> `?private_token=***`);
 * - a token-like path segment inside a URL (`https://h/ghp_…/r.git` -> the segment as `***`),
 *   split as `redactGitUrlCredentials` splits it (`\` too, on http(s));
 * - the same inside a URL glued onto another with no whitespace between (`maskUrlRun`), which
 *   the first URL's parse would otherwise hold in its fragment or query.
 */
export function redact(text: string, secrets: Array<string | undefined> = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      out = out.split(secret).join('***');
    }
  }
  // Userinfo runs to the LAST "@" before the authority ends (a raw "@" inside a password is
  // common enough), so match "@"-separated runs greedily — never across "/", "?", "#" or
  // whitespace, which end the authority in a URL and the URL itself in free text.
  out = out.replace(/(https?:\/\/)[^/?#@\s]*(?:@[^/?#@\s]*)*@/gi, '$1***@');
  // The other separators the strip reads (`LENIENT_HTTP_USERINFO`): `https:/u:pw@h`,
  // `https:\u:pw@h`, `https:u:pw@h`. A `//` one is already `***@` and is rewritten to itself.
  out = out.replace(LENIENT_HTTP_USERINFO, '$1***@');
  // Any other scheme: only a password is masked (`OTHER_PASSWORD`). The https rule above has
  // already turned its userinfo into "***@", which holds no ":"; a `file:` URL is left alone.
  out = out.replace(OTHER_PASSWORD, (match, head: string, user: string) =>
    /^(?:https?|file):\/\/$/i.test(head) ? match : `${head}${user}:***@`,
  );
  out = out.replace(URL_IN_TEXT, maskUrlRun);
  return out;
}
