/**
 * claude-plugins provider：读取 `~/.claude/plugins/installed_plugins.json`
 * 的已安装 plugin entries（有界、版本化兼容 parser），把 enabled 且 containment
 * 通过的 installPath 转成 skills observation。
 *
 * 语义（02 计划 §6.2）：`enabled:false` 抑制该外部 entry；true/缺失不授
 * RunLedger trust；installPath 必须 absolute、realpath 可解析、在 plugin cache
 * root 内，registry/path escape 只产生 blocked diagnostic。只读，不修改外部
 * registry；不读取 Claude settings 作为 authority。
 */

import { isAbsolute, join } from "node:path";
import { extensionDiagnostic, type ExtensionDiagnostic } from "../../diagnostics.ts";
import { resolveContainedPath } from "../../paths.ts";
import type { DiscoveryContext, DiscoveryProvider, DiscoveryProviderResult } from "../../capabilities/types.ts";
import type { SkillDiscoveryObservation } from "../registry.ts";
import { canonicalDigest } from "../../../runtime/protocol/canonical-json.ts";

const MAX_REGISTRY_ENTRIES = 128;
const MAX_REGISTRY_BYTES = 256 * 1024;
const MAX_ENTRY_ID = 128;
const MAX_VERSION = 128;
const MAX_INSTALL_PATH = 2048;

export interface ClaudePluginRegistryEntry {
	readonly entryId: string;
	readonly version: string;
	readonly installPath: string;
	readonly declaredEnabled?: boolean;
}

export interface InstalledPluginsRegistryResult {
	readonly entries: readonly ClaudePluginRegistryEntry[];
	readonly diagnostics: readonly ExtensionDiagnostic[];
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
}

/** 有界、版本化兼容 parser：只读取 identity/version/installPath/enabled，忽略未知字段。 */
export function parseInstalledPluginsRegistry(value: unknown, sourcePath: string): InstalledPluginsRegistryResult {
	const diagnostics: ExtensionDiagnostic[] = [];
	if (!record(value)) {
		diagnostics.push(extensionDiagnostic("claude_plugins.registry_invalid", "error", "installed plugins registry must be a JSON object", "claude-plugins", sourcePath));
		return { entries: [], diagnostics };
	}
	const keys = Object.keys(value);
	if (keys.length > MAX_REGISTRY_ENTRIES) {
		diagnostics.push(extensionDiagnostic("claude_plugins.registry_bound", "error", "installed plugins registry exceeds the entry bound", "claude-plugins", sourcePath));
		return { entries: [], diagnostics };
	}
	const entries: ClaudePluginRegistryEntry[] = [];
	for (const entryId of keys.sort()) {
		const raw = value[entryId];
		if (!record(raw)) {
			diagnostics.push(extensionDiagnostic("claude_plugins.entry_invalid", "error", `plugin registry entry is not an object: ${entryId}`, "claude-plugins", `${sourcePath}#/${entryId}`));
			continue;
		}
		if (!boundedText(entryId, MAX_ENTRY_ID)) {
			diagnostics.push(extensionDiagnostic("claude_plugins.entry_id_invalid", "error", "plugin registry entry id is invalid", "claude-plugins", sourcePath));
			continue;
		}
		const version = raw.version;
		const installPath = raw.installPath;
		const enabled = raw.enabled;
		if (!boundedText(version, MAX_VERSION)) {
			diagnostics.push(extensionDiagnostic("claude_plugins.entry_version_invalid", "error", `plugin registry entry version is invalid: ${entryId}`, "claude-plugins", `${sourcePath}#/${entryId}`));
			continue;
		}
		if (!boundedText(installPath, MAX_INSTALL_PATH) || !isAbsolute(installPath)) {
			diagnostics.push(extensionDiagnostic("claude_plugins.entry_path_invalid", "error", `plugin install path must be an absolute path: ${entryId}`, "claude-plugins", `${sourcePath}#/${entryId}`));
			continue;
		}
		if (enabled !== undefined && typeof enabled !== "boolean") {
			diagnostics.push(extensionDiagnostic("claude_plugins.entry_enabled_invalid", "error", `plugin enabled flag must be a boolean: ${entryId}`, "claude-plugins", `${sourcePath}#/${entryId}`));
			continue;
		}
		entries.push({
			entryId,
			version,
			installPath,
			...(enabled === undefined ? {} : { declaredEnabled: enabled as boolean }),
		});
	}
	return { entries, diagnostics };
}

export interface ClaudePluginsProviderOptions {
	/** `~/.claude/plugins/installed_plugins.json`（composition root 解析）。 */
	readonly registryPath: string;
	/** `~/.claude/plugins/`（installPath containment 的允许 root）。 */
	readonly pluginCacheRoot: string;
}

export function createClaudePluginsProvider(options: ClaudePluginsProviderOptions): DiscoveryProvider<SkillDiscoveryObservation> {
	return {
		id: "claude-plugins",
		displayName: "Claude installed plugins",
		capabilityId: "skills",
		rank: 2600,
		defaultEnabled: false,
		load: async (context: DiscoveryContext): Promise<DiscoveryProviderResult<SkillDiscoveryObservation>> => {
			if (context.storage === undefined) return { ok: false, providerId: "claude-plugins", code: "failed", message: "storage is unavailable" };
			const read = await context.storage.readFile(options.registryPath, MAX_REGISTRY_BYTES);
			if (!read.ok) return { ok: false, providerId: "claude-plugins", code: "unavailable", message: `installed plugins registry is missing: ${options.registryPath}` };
			let document: unknown;
			try {
				document = JSON.parse(Buffer.from(read.value).toString("utf8")) as unknown;
			} catch {
				return { ok: false, providerId: "claude-plugins", code: "failed", message: "installed plugins registry is not valid JSON" };
			}
			const parsed = parseInstalledPluginsRegistry(document, options.registryPath);
			const diagnostics = [...parsed.diagnostics];
			const observations: SkillDiscoveryObservation[] = [];
			for (const entry of parsed.entries) {
				if (entry.declaredEnabled === false) continue;
				const contained = await resolveContainedPath(context.storage, options.pluginCacheRoot, entry.installPath);
				if (!contained.ok) {
					diagnostics.push(extensionDiagnostic("claude_plugins.path_escape", "error", `plugin install path escapes the allowed plugin cache: ${entry.entryId}`, "claude-plugins", entry.entryId));
					continue;
				}
				const skillsRoot = join(contained.path, "skills");
				const info = await context.storage.stat(skillsRoot);
				if (!info.ok || info.value.kind !== "directory") continue;
				observations.push({
					providerId: "claude-plugins",
					source: "user",
					level: "user",
					canonicalRoot: skillsRoot,
					scanKind: "skills-directory",
					priority: 2600,
					sourceRegistry: {
						locatorDigest: canonicalDigest({ installPath: entry.installPath }).slice(0, 32),
						entryId: entry.entryId,
						...(entry.declaredEnabled === undefined ? {} : { declaredEnabled: entry.declaredEnabled }),
					},
				});
			}
			return { ok: true, providerId: "claude-plugins", observations, diagnostics };
		},
	};
}
