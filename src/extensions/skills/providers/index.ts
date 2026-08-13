/** 显式 provider factory；不依赖 import side effects。 */

export { createRunledgerBuiltinProvider, createRunledgerRepoProvider, createRunledgerSessionProvider, createRunledgerUserProvider, createRunledgerWorkspaceProvider } from "./runledger.ts";
export { createPluginContributionsProvider } from "./plugin-contributions.ts";
export { createCodexProjectProvider, createCodexUserProvider } from "./codex.ts";
export { createAgentsProjectProvider, createAgentsUserProvider } from "./agents.ts";
export { createClaudeProjectProvider, createClaudeUserProvider } from "./claude.ts";
export { createClaudePluginsProvider, parseInstalledPluginsRegistry } from "./claude-plugins.ts";
