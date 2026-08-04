/** 扩展配置层的确定性合并与安全策略收紧。 */

import { canonicalDigest } from "../runtime/protocol/canonical-json.ts";

export type ExtensionConfigSource = "builtin" | "managed" | "user" | "project" | "session" | "cli";

export interface ExtensionConfigLayer {
	readonly source: ExtensionConfigSource;
	readonly priority?: number;
	readonly config: Readonly<Record<string, unknown>>;
	readonly digest: string;
}

export interface MergedExtensionConfig {
	readonly config: Readonly<Record<string, unknown>>;
	readonly sources: readonly ExtensionConfigSource[];
	readonly digests: readonly string[];
	readonly digest: string;
}

const defaultPriority: Readonly<Record<ExtensionConfigSource, number>> = {
	builtin: 0,
	user: 10,
	project: 20,
	session: 30,
	cli: 40,
	managed: 100,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeRecord(base: Record<string, unknown>, next: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };
	for (const key of Object.keys(next).sort()) {
		const value = next[key];
		const previous = result[key];
		if (isRecord(value) && isRecord(previous)) result[key] = mergeRecord(previous, value);
		else result[key] = value;
	}
	return result;
}

export function mergeExtensionConfigLayers(layers: readonly ExtensionConfigLayer[]): MergedExtensionConfig {
	const ordered = [...layers].sort((left, right) => {
		const priority = (left.priority ?? defaultPriority[left.source]) - (right.priority ?? defaultPriority[right.source]);
		if (priority !== 0) return priority;
		if (left.source !== right.source) return left.source < right.source ? -1 : 1;
		return left.digest < right.digest ? -1 : left.digest > right.digest ? 1 : 0;
	});
	let config: Record<string, unknown> = {};
	for (const layer of ordered) config = mergeRecord(config, layer.config);
	const sources = ordered.map((layer) => layer.source);
	const digests = ordered.map((layer) => layer.digest);
	return { config: Object.freeze(config), sources, digests, digest: canonicalDigest({ config, sources, digests }) };
}

/** allowed-tools 是现有工具集合的交集，不是新的授权来源。 */
export function intersectAllowedTools(
	currentlyAllowed: readonly string[],
	declared: readonly string[] | undefined,
): readonly string[] {
	if (!declared) return [...currentlyAllowed];
	const declaredSet = new Set(declared);
	return currentlyAllowed.filter((tool) => declaredSet.has(tool));
}
