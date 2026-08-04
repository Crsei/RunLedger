/** qualified identity、Runtime ResourceIdentity 与安全 runtime name 生成。 */

import { canonicalDigest } from "../runtime/protocol/canonical-json.ts";
import { createRuntimeId } from "../runtime/protocol/ids.ts";
import type { ResourceIdentity, ResourceKind, ResourceProvenance, ResourceSource } from "../runtime/resources/types.ts";
import type { ExtensionKind, ExtensionRuntimeScope } from "./types.ts";

const kindMap: Readonly<Record<ExtensionKind, ResourceKind>> = {
	plugin: "plugin",
	skill: "skill",
	hook: "hook",
	mcp: "mcp-server",
	"mcp-server": "mcp-server",
	"mcp-tool": "mcp-tool",
};

export function qualifiedResourceId(input: {
	readonly kind: ExtensionKind;
	readonly sourceKey: string;
	readonly name: string;
	readonly pluginId?: string;
}): string {
	const owner = input.pluginId ?? input.sourceKey;
	const prefix = input.kind === "mcp" || input.kind === "mcp-server" ? "mcp-server" : input.kind;
	return `${prefix}:${owner}:${input.name}`;
}

export function createExtensionResourceIdentity(input: {
	readonly scope?: ExtensionRuntimeScope;
	readonly kind: ExtensionKind;
	readonly qualifiedId: string;
	readonly version: string;
	readonly source: ResourceSource;
	readonly digest: string;
}): ResourceIdentity {
	return {
		resourceId: createRuntimeId("resource", canonicalDigest({ kind: input.kind, qualifiedId: input.qualifiedId }).slice(0, 32)),
		kind: kindMap[input.kind],
		qualifiedId: input.qualifiedId,
		version: input.version,
		source: input.source,
		digest: { algorithm: "sha256", digest: input.digest as ResourceIdentity["digest"]["digest"] },
	};
}

export function createExtensionResourceProvenance(input: {
	readonly scope?: ExtensionRuntimeScope;
	readonly source: ResourceSource;
	readonly canonicalLocator: string;
	readonly sourceRoot: string;
	readonly parentResourceId?: ResourceIdentity["resourceId"];
}): ResourceProvenance {
	return {
		source: input.source,
		sourceLocatorDigest: { algorithm: "sha256", digest: canonicalDigest({ locator: input.canonicalLocator, root: input.sourceRoot }) as ResourceIdentity["digest"]["digest"] },
		...(input.parentResourceId ? { parentResourceId: input.parentResourceId } : {}),
	};
}

export function sanitizeRuntimeSegment(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9_-]+/gu, "_").replace(/^_+|_+$/gu, "");
	return sanitized.length > 0 && /^[A-Za-z]/u.test(sanitized) ? sanitized.slice(0, 48) : `r_${sanitized.slice(0, 46) || "resource"}`;
}

export function mcpRuntimeName(serverName: string, toolName: string): string {
	return `mcp__${sanitizeRuntimeSegment(serverName)}__${sanitizeRuntimeSegment(toolName)}`.slice(0, 128);
}
