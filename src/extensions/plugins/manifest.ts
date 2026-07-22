/** .runledger-plugin/plugin.json v1 解析与 unknown-field 诊断。 */

import semver from "semver";
import { DEFAULT_EXTENSION_LIMITS, extensionDiagnostic } from "../diagnostics.ts";
import type { ExtensionDiagnostic } from "../diagnostics.ts";
import { PluginManifestSchema, schemaAccepts } from "../schemas.ts";
import type { PluginManifestV1 } from "./types.ts";

export type PluginManifestParseResult =
	| { ok: true; manifest: PluginManifestV1; diagnostics: readonly ExtensionDiagnostic[] }
	| { ok: false; diagnostics: readonly ExtensionDiagnostic[] };

const known = new Set(["schemaVersion", "name", "version", "description", "author", "keywords", "skills", "hooks", "mcpServers"]);

export function parsePluginManifest(bytes: Uint8Array, path: string): PluginManifestParseResult {
	if (bytes.byteLength > DEFAULT_EXTENSION_LIMITS.maxConfigBytes) return { ok: false, diagnostics: [extensionDiagnostic("plugin.manifest_oversize", "error", "plugin manifest exceeds byte bound", "plugin", path)] };
	let value: unknown;
	try {
		value = JSON.parse(Buffer.from(bytes).toString("utf8"));
	} catch {
		return { ok: false, diagnostics: [extensionDiagnostic("plugin.manifest_json", "error", "plugin manifest is invalid JSON", "plugin", path)] };
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, diagnostics: [extensionDiagnostic("plugin.manifest_shape", "error", "plugin manifest must be an object", "plugin", path)] };
	const raw = value as Record<string, unknown>;
	if (raw.schemaVersion !== 1) return { ok: false, diagnostics: [extensionDiagnostic("plugin.schema_version", "error", "unsupported plugin schemaVersion", "plugin", path)] };
	const diagnostics = Object.keys(raw).filter((key) => !known.has(key)).sort().map((key) => extensionDiagnostic("plugin.unknown_field", "warning", `unknown plugin manifest field: ${key}`, "plugin", path));
	const exactValue = Object.fromEntries(Object.entries(raw).filter(([key]) => known.has(key)));
	if (!schemaAccepts(PluginManifestSchema, exactValue)) return { ok: false, diagnostics: [...diagnostics, extensionDiagnostic("plugin.manifest_schema", "error", "plugin manifest does not match schema v1", "plugin", path)] };
	if (!semver.valid(exactValue.version as string, { loose: false })) return { ok: false, diagnostics: [...diagnostics, extensionDiagnostic("plugin.version_invalid", "error", "plugin version must be strict semver", "plugin", path)] };
	return {
		ok: true,
		manifest: {
			schemaVersion: 1,
			name: exactValue.name as string,
			version: exactValue.version as string,
			description: exactValue.description as string,
			...(exactValue.author ? { author: exactValue.author as { name: string } } : {}),
			keywords: (exactValue.keywords ?? []) as string[],
			skills: (exactValue.skills ?? []) as string[],
			hooks: (exactValue.hooks ?? []) as string[],
			...(typeof exactValue.mcpServers === "string" ? { mcpServers: exactValue.mcpServers } : {}),
		},
		diagnostics,
	};
}
