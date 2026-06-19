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
  out = out.replace(/(https?:\/\/)[^/@\s]+@/gi, '$1***@');
  return out;
}
