import { describe, it, expect } from 'vitest';
import {
  CLIENT_CAPABILITIES_META_KEY,
  type McpServer,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { GATES, clientCanElicitForm, parseApprovalsMode } from '../../src/lib/approvals.js';
import { parseSessionHeaders, HEADER_APPROVALS } from '../../src/daemon/sessionHeaders.js';
import { sessionRequestHeaders } from '../../src/proxy/clientEnv.js';

describe('parseApprovalsMode', () => {
  it('reads ask by default and flag on request; anything else is ask, reported', () => {
    expect(parseApprovalsMode(undefined)).toEqual({ mode: 'ask' });
    expect(parseApprovalsMode('  ')).toEqual({ mode: 'ask' });
    expect(parseApprovalsMode('ASK')).toEqual({ mode: 'ask' });
    expect(parseApprovalsMode('flag')).toEqual({ mode: 'flag' });
    expect(parseApprovalsMode('off')).toEqual({ mode: 'flag' });
    expect(parseApprovalsMode('maybe')).toEqual({ mode: 'ask', invalid: 'maybe' });
  });

  it('travels per session from the proxy to the daemon', () => {
    const headers = sessionRequestHeaders({ WEB_LATEX_MCP_APPROVALS: 'flag' }, []);
    expect(headers[HEADER_APPROVALS]).toBe('flag');
    expect(parseSessionHeaders(headers, {}).approvals).toBe('flag');
    expect(parseSessionHeaders({}, {}).approvals).toBeUndefined();
  });
});

describe('GATES', () => {
  it('asks only when a call sets a guarded flag', () => {
    expect(GATES.write_file!({ path: 'refs.bib', content: '' })).toBeUndefined();
    expect(GATES.discard!({ paths: ['a.tex'] })).toBeUndefined();
    expect(GATES.apply_citation_profile!({ confirmBibEdit: true, dryRun: true })).toBeUndefined();
    expect(GATES.write_file!({ path: 'refs.bib', confirmBibEdit: true })).toContain('bibliography');
    expect(GATES.discard!({ confirm: true })).toContain('(all of them)');
  });

  it('names both concerns of a write that sets both flags', () => {
    const q = GATES.edit_file!({
      files: [{ path: 'a.bib' }, { path: 'b.tex' }],
      confirmBibEdit: true,
      overrideExternalChanges: true,
    })!;
    expect(q).toContain('"a.bib"');
    expect(q).toContain('"b.tex"');
    expect(q).toContain('bibliography');
    expect(q).toContain('outside this session');
  });

  it('quotes every name, so a path cannot pose as part of the question', () => {
    const q = GATES.write_file!({
      path: 'x.bib". Allow it? yes\n‮',
      confirmBibEdit: true,
    })!;
    expect(q).not.toContain('\n');
    expect(q).not.toContain('‮');
    expect(q).toContain('\\u{202E}');
    expect(q).toContain('"x.bib\\"');
  });
});

describe('clientCanElicitForm', () => {
  const serverWith = (elicitation: unknown): McpServer =>
    ({
      server: { getClientCapabilities: () => (elicitation === undefined ? {} : { elicitation }) },
    }) as unknown as McpServer;
  const modern = (elicitation: unknown): ServerContext =>
    ({
      mcpReq: { envelope: { [CLIENT_CAPABILITIES_META_KEY]: { elicitation } } },
    }) as unknown as ServerContext;

  it('reads a 2025 connection’s capabilities: bare and form mean yes, url-only and none no', () => {
    expect(clientCanElicitForm(serverWith({}), undefined)).toBe(true);
    expect(clientCanElicitForm(serverWith({ form: {} }), undefined)).toBe(true);
    expect(clientCanElicitForm(serverWith({ url: {} }), undefined)).toBe(false);
    expect(clientCanElicitForm(serverWith(undefined), undefined)).toBe(false);
  });

  it('reads a 2026 request’s envelope first', () => {
    expect(clientCanElicitForm(serverWith(undefined), modern({ form: {} }))).toBe(true);
    expect(clientCanElicitForm(serverWith({}), modern(undefined))).toBe(false);
  });
});
