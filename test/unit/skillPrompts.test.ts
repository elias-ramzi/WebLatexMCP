import { describe, it, expect, vi, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServer } from '../../src/server.js';
import { registerSkillPrompts } from '../../src/prompts/skills.js';
import type { AppContext } from '../../src/context.js';
import type { Skill } from '../../src/lib/skills.js';

/** A `session-feedback`-shaped skill: it reports on the server, never on a project. */
const noProject: Skill = {
  name: 'session-feedback',
  description: 'Report on the server.',
  body: 'STEP ONE',
  project: 'none',
};

const takesProject: Skill = {
  name: 'verify-citations',
  description: 'Audit the .bib.',
  body: 'STEP TWO',
  project: 'optional',
};

interface PromptConfig {
  title?: string;
  description?: string;
  argsSchema?: Record<string, unknown>;
}
type PromptCallback = (args: { project?: string }) => {
  messages: { role: string; content: { type: string; text: string } }[];
};
interface Registered {
  name: string;
  config: PromptConfig;
  cb: PromptCallback;
}

/**
 * Capture what `registerSkillPrompts` advertises. The `argsSchema` key is the whole point:
 * a client binding a free-text invocation positionally can only put the first word somewhere
 * a prompt declared an argument.
 */
function captureServer(): { prompts: Registered[]; server: McpServer } {
  const prompts: Registered[] = [];
  const server = {
    registerPrompt(name: string, config: PromptConfig, cb: PromptCallback) {
      prompts.push({ name, config, cb });
    },
  };
  return { prompts, server: server as unknown as McpServer };
}

function render(entry: Registered, args: { project?: string } = {}): string {
  const message = entry.cb(args).messages[0];
  return message?.content.text ?? '';
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('registerSkillPrompts argument schema', () => {
  it('declares no project argument for a skill that takes no project', () => {
    const { prompts, server } = captureServer();
    registerSkillPrompts(server, [noProject]);

    const entry = prompts[0];
    expect(entry?.name).toBe('session-feedback');
    // Nothing for a positional binding to land in.
    expect(entry?.config.argsSchema).toBeUndefined();
  });

  it('never turns free text bound as a project into an instruction (issue #105, finding 6)', () => {
    const { prompts, server } = captureServer();
    registerSkillPrompts(server, [noProject]);

    // What a client that binds "/session-feedback please describe why…" positionally sends.
    const text = render(prompts[0]!, { project: 'please' });
    expect(text).not.toContain('please');
    expect(text).not.toContain('Apply it to the project');
    expect(text).toContain('STEP ONE');
  });

  it('keeps the optional project argument for a skill that acts on a project', () => {
    const { prompts, server } = captureServer();
    registerSkillPrompts(server, [takesProject]);

    expect(Object.keys(prompts[0]?.config.argsSchema ?? {})).toEqual(['project']);
    expect(render(prompts[0]!, { project: 'pictura' })).toContain('Apply it to the project');
    expect(render(prompts[0]!)).toContain('Ask which project');
  });

  it('marks the argument required only for a skill that declares it so', () => {
    const { prompts, server } = captureServer();
    registerSkillPrompts(server, [
      { ...takesProject, name: 'needs-one', project: 'required' },
      takesProject,
    ]);

    const required = prompts[0]?.config.argsSchema?.project;
    const optional = prompts[1]?.config.argsSchema?.project;
    expect(
      (required as { safeParse: (v: unknown) => { success: boolean } }).safeParse(undefined),
    ).toMatchObject({ success: false });
    expect(
      (optional as { safeParse: (v: unknown) => { success: boolean } }).safeParse(undefined),
    ).toMatchObject({ success: true });
  });
});

describe('registerSkillPrompts project lookup', () => {
  it('asserts the project when it is registered', () => {
    const { prompts, server } = captureServer();
    registerSkillPrompts(server, [takesProject], { isRegisteredProject: (id) => id === 'pictura' });

    expect(render(prompts[0]!, { project: 'pictura' })).toContain('Apply it to the project');
  });

  it('asks instead of asserting when the id is not registered', () => {
    const { prompts, server } = captureServer();
    registerSkillPrompts(server, [takesProject], { isRegisteredProject: () => false });

    const text = render(prompts[0]!, { project: 'please' });
    expect(text).toContain('No project named `please` is registered');
    expect(text).not.toContain('Apply it to the project');
  });

  it('renders a question rather than throwing when the lookup itself fails', () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { prompts, server } = captureServer();
    registerSkillPrompts(server, [takesProject], {
      isRegisteredProject: () => {
        throw new Error('registry unreadable');
      },
    });

    const text = render(prompts[0]!, { project: 'pictura' });
    expect(text).toContain('could not be checked');
    // A failed lookup must not become the false claim that the project does not exist.
    expect(text).not.toContain('is registered with this server —');
    expect(stderr).toHaveBeenCalled();
  });

  it('never consults the lookup for a skill that takes no project', () => {
    const lookup = vi.fn(() => false);
    const { prompts, server } = captureServer();
    registerSkillPrompts(server, [noProject], { isRegisteredProject: lookup });

    render(prompts[0]!, { project: 'please' });
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('skill prompts over a live MCP client', () => {
  const fakeCtx = {} as unknown as AppContext;

  async function connect(skills: Skill[]): Promise<Client> {
    const server = createServer(fakeCtx, undefined, undefined, skills);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it('advertises no arguments for a no-project skill and one for the rest', async () => {
    const client = await connect([noProject, takesProject]);
    try {
      const { prompts } = await client.listPrompts();
      const feedback = prompts.find((p) => p.name === 'session-feedback');
      const verify = prompts.find((p) => p.name === 'verify-citations');

      expect(feedback?.arguments ?? []).toEqual([]);
      expect(verify?.arguments?.map((a) => a.name)).toEqual(['project']);
      expect(verify?.arguments?.[0]?.required).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it('drops a project argument a client sends anyway to a no-project skill', async () => {
    const client = await connect([noProject]);
    try {
      const res = await client.getPrompt({
        name: 'session-feedback',
        arguments: { project: 'please' },
      });
      const content = res.messages[0]?.content;
      const text = content && content.type === 'text' ? content.text : '';
      expect(text).toContain('STEP ONE');
      expect(text).not.toContain('please');
    } finally {
      await client.close();
    }
  });
});
