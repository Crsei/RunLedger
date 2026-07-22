/** 扩展配置层的确定性合并与安全策略收紧。 */

import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";

export const EXTENSION_CONFIG_SOURCES = ["builtin", "user", "project", "session", "cli", "managed"] as const;
export type ExtensionConfigSource = (typeof EXTENSION_CONFIG_SOURCES)[number];

export interface ExtensionConfigLayer {
	source: ExtensionConfigSource;
	priority?: number;
	config: Readonly<Record<string, unknown>>;
	digest: string;
}

export interface MergedExtensionConfig {
	config: Readonly<Record<string, unknown>>;
	sources: readonly ExtensionConfigSource[];
	digests: readonly string[];
	digest: string;
}

const defaultPriority: Readonly<Record<ExtensionConfigSource, number>> = {
	builtin: 0,
	user: 10,
	project: 20,
	session: 30,
	cli: 40,
	managed: 100,
};

function mergeRecord(base: Record<string, unknown>, next: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };
	for (const key of Object.keys(next).sort()) {
		const value = next[key];
		const previous = result[key];
		if (
			typeof value === "object" && value !== null && !Array.isArray(value) &&
			typeof previous === "object" && previous !== null && !Array.isArray(previous)
		) {
			result[key] = mergeRecord(previous as Record<string, unknown>, value as Readonly<Record<string, unknown>>);
		} else {
			result[key] = value;
		}
	}
	return result;
}

export function mergeExtensionConfigLayers(layers: readonly ExtensionConfigLayer[]): MergedExtensionConfig {
	const ordered = [...layers].sort((left, right) => {
		const priority = (left.priority ?? defaultPriority[left.source]) - (right.priority ?? defaultPriority[right.source]);
		return priority || left.source.localeCompare(right.source) || left.digest.localeCompare(right.digest);
	});
	let config: Record<string, unknown> = {};
	for (const layer of ordered) config = mergeRecord(config, layer.config);
	const sources = ordered.map((layer) => layer.source);
	const digests = ordered.map((layer) => layer.digest);
	return { config: Object.freeze(config), sources, digests, digest: canonicalDigest({ config, sources, digests }) };
}

export function intersectAllowedTools(
	currentlyAllowed: readonly string[],
	declared: readonly string[] | undefined,
): readonly string[] {
	if (!declared) return [...currentlyAllowed];
	const declaredSet = new Set(declared);
	return currentlyAllowed.filter((tool) => declaredSet.has(tool));
}
