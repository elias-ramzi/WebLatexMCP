import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

interface UserConfigField {
  type: string;
  default?: unknown;
  required?: boolean;
}

interface Manifest {
  server: { mcp_config: { env: Record<string, string> } };
  user_config: Record<string, UserConfigField>;
}

const manifest = JSON.parse(
  readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'),
) as Manifest;

/**
 * Claude Desktop held the extension back until a workspace folder was picked, although the field
 * was optional and the server has its own fallback. A default prefills the form, so the extension
 * enables untouched, and the folder stays changeable from the extension's settings.
 */
describe('Desktop extension workspace field', () => {
  const field = manifest.user_config.workspace!;

  it('is an optional directory prefilled with ~/latex-workspace', () => {
    expect(field.type).toBe('directory');
    expect(field.required).toBe(false);
    expect(field.default).toBe('${HOME}/latex-workspace');
  });

  it('reaches the server as WEB_LATEX_MCP_WORKSPACE', () => {
    expect(manifest.server.mcp_config.env.WEB_LATEX_MCP_WORKSPACE).toBe('${user_config.workspace}');
  });
});
