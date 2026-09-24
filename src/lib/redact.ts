/**
 * Scrub secrets from a string before it is logged or returned to a client.
 * Replaces any explicitly known secret values, plus credentials embedded in URLs
 * (e.g. https://user:token@host -> https://***@host).
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
  return out;
}
