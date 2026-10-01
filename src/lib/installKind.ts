/**
 * How this server was installed: the Claude Desktop extension (`.mcpb`), an npm package, or a git
 * checkout. One list, shared by the env parser (`parseInstallKind` in `src/config.ts`), the
 * updater and `update_server`'s output schema, so none of them can accept a kind another rejects.
 *
 * It lives here rather than in `src/services/updater.ts` so `src/types.ts` and `src/config.ts`
 * can name it without importing a service.
 */
export const INSTALL_KINDS = ['desktop-extension', 'npm', 'source'] as const;

export type InstallKind = (typeof INSTALL_KINDS)[number];
