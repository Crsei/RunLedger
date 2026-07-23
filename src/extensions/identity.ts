/** qualified identity、Runtime ResourceIdentity 与 MCP tool name 生成。 */

import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../runtime/protocol/v3/ids.ts";
import {
	createResourceLocatorReceipt,
	createResourceProvenance,
} from "../runtime/resources/schemas.ts";
import type {
	ResourceIdentity,
	ResourceKind,
	ResourceProvenance,
	ResourceSource,
} from "../runtime/resources/types.ts";
import type { ExtensionKind, ExtensionRuntimeScope } from "./types.ts";

const extensionKindToResourceKind: Readonly<Record<ExtensionKind, ResourceKind>> = {
	plugin: "plugin",
	skill: "skill",
	hook: "hook",
	"mcp-server": "mcp-server",
	"mcp-tool": "mcp-tool",
};

export function qualifiedResourceId(input: {
	kind: ExtensionKind;
	sourceKey: string;
	name: string;
	pluginId?: string;
}): string {
	const owner = input.pluginId ?? input.sourceKey;
	const prefix = input.kind === "mcp-server" ? "mcp-server" : input.kind === "mcp-tool" ? "mcp-tool" : input.kind;
	return `${prefix}:${owner}:${input.name}`;
}

export function createExtensionResourceIdentity(input: {
	scope: ExtensionRuntimeScope;
	kind: ExtensionKind;
	qualifiedId: string;
	version: string;
	source: ResourceSource;
	digest: string;
}): ResourceIdentity {
	return {
		schemaVersion: 2,
		authorityId: input.scope.authorityId,
		tenantId: input.scope.tenantId,
		resourceId: createRuntimeId("resource", canonicalDigest({ kind: input.kind, qualifiedId: input.qualifiedId }).slice(0, 32)),
		kind: extensionKindToResourceKind[input.kind],
		qualifiedId: input.qualifiedId,
		version: input.version,
		source: input.source,
		digest: input.digest,
	};
}

export function createExtensionResourceProvenance(input: {
	scope: ExtensionRuntimeScope;
	source: ResourceSource;
	canonicalLocator: string;
	sourceRoot: string;
	parentPlugin?: ResourceIdentity;
}): ResourceProvenance {
	const locatorReceipt = createResourceLocatorReceipt({
		authorityId: input.scope.authorityId,
		tenantId: input.scope.tenantId,
		canonicalLocator: input.canonicalLocator,
		sourceRoot: input.sourceRoot,
	});
	return createResourceProvenance({
		authorityId: input.scope.authorityId,
		tenantId: input.scope.tenantId,
		source: input.source,
		canonicalLocator: input.canonicalLocator,
		locatorReceipt,
		...(input.parentPlugin ? { parentPlugin: input.parentPlugin } : {}),
	});
}

export function sanitizeRuntimeSegment(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9_-]+/gu, "_").replace(/^_+|_+$/gu, "");
	return sanitized.length > 0 && /^[A-Za-z]/u.test(sanitized) ? sanitized.slice(0, 48) : `r_${sanitized.slice(0, 46) || "resource"}`;
}

export function mcpRuntimeName(serverName: string, toolName: string): string {
	return `mcp__${sanitizeRuntimeSegment(serverName)}__${sanitizeRuntimeSegment(toolName)}`.slice(0, 128);
}
