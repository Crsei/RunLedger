import type { ExtensionDiagnostic } from "../diagnostics.ts";
import type { ExtensionResourceDescriptor } from "../types.ts";
import type { HookDescriptor } from "../hooks/types.ts";
import type { McpServerDescriptor } from "../mcp/types.ts";
import type { SkillDescriptor } from "../skills/types.ts";

export interface PluginManifestV1 {
	schemaVersion: 1;
	name: string;
	version: string;
	description: string;
	author?: { name: string };
	keywords: readonly string[];
	skills: readonly string[];
	hooks: readonly string[];
	mcpServers?: string;
}

export interface PluginDescriptor {
	descriptor: ExtensionResourceDescriptor;
	manifest: PluginManifestV1;
	rootPath: string;
	manifestPath: string;
	dataRoot: string;
	skillRoots: readonly string[];
	hookConfigs: readonly string[];
	mcpConfig?: string;
	blockedComponentCount: number;
}

export interface PluginDiscoveryResult {
	plugins: readonly PluginDescriptor[];
	diagnostics: readonly ExtensionDiagnostic[];
}

export interface PluginContributions {
	plugin: PluginDescriptor;
	skills: readonly SkillDescriptor[];
	hooks: readonly HookDescriptor[];
	mcpServers: readonly McpServerDescriptor[];
	diagnostics: readonly ExtensionDiagnostic[];
}
