import { loadWritingGuide, loadExtraWritingGuide, composeWritingGuide } from './writingGuide.js';
import { loadConcurrencyGuide } from './concurrencyGuide.js';
import { loadSkills, type Skill } from './skills.js';

/** What one MCP session is served: its `instructions` text and its prompts. */
export interface SessionGuides {
  writingGuide: string | undefined;
  /** Whether `writingGuide` includes the configured extra guide. */
  writingGuideHasExtra: boolean;
  /** Whether the configured extra guide (`WEB_LATEX_MCP_WRITING_GUIDE_EXTRA`) was read. */
  extraWritingGuideLoaded: boolean;
  concurrencyGuide: string | undefined;
  skills: Skill[];
}

/**
 * Read the guides and skills one MCP session is built with. stdio reads them once, at start; the
 * daemon reads them for every new session (docs/design/shared-server.md §7.3), so a rule
 * `add_writing_convention` writes reaches the next session, as its description promises, without
 * restarting a daemon that lives for days. A few small file reads each.
 */
export async function loadSessionGuides(
  env: NodeJS.ProcessEnv,
  extraWritingGuidePath: string | undefined,
): Promise<SessionGuides> {
  const [base, extra, concurrencyGuide, skills] = await Promise.all([
    loadWritingGuide(env),
    loadExtraWritingGuide(extraWritingGuidePath),
    loadConcurrencyGuide(env),
    loadSkills(env),
  ]);
  const { text, hasExtra } = composeWritingGuide(base, extra);
  return {
    writingGuide: text,
    writingGuideHasExtra: hasExtra,
    extraWritingGuideLoaded: extra !== undefined,
    concurrencyGuide,
    skills,
  };
}
