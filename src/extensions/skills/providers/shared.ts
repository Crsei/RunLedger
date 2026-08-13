/**
 * 共享 fixed-roots provider：多个固定 root 各形成一个 observation；全部缺失
 * → unavailable。root 由 composition root 注入（provider 不调用 homedir/cwd）。
 */

import type { DiscoveryContext, DiscoveryProvider, DiscoveryProviderResult } from "../../capabilities/types.ts";
import type { SkillDiscoveryLevel, SkillDiscoveryObservation } from "../registry.ts";
import type { ExtensionSource } from "../../types.ts";

export interface FixedRootsProviderOptions {
	readonly providerId: string;
	readonly displayName: string;
	readonly rank: number;
	readonly defaultEnabled: boolean;
	readonly source: ExtensionSource;
	readonly level: SkillDiscoveryLevel;
	readonly priority: number;
	readonly roots: readonly string[];
	readonly scanKind: "skills-directory" | "single-skill-directory";
}

export function createFixedRootsProvider(options: FixedRootsProviderOptions): DiscoveryProvider<SkillDiscoveryObservation> {
	return {
		id: options.providerId,
		displayName: options.displayName,
		capabilityId: "skills",
		rank: options.rank,
		defaultEnabled: options.defaultEnabled,
		load: async (context: DiscoveryContext): Promise<DiscoveryProviderResult<SkillDiscoveryObservation>> => {
			if (context.storage === undefined) return { ok: false, providerId: options.providerId, code: "failed", message: "storage is unavailable" };
			const observations: SkillDiscoveryObservation[] = [];
			for (const root of options.roots) {
				const resolved = await context.storage.realpath(root);
				if (!resolved.ok) continue;
				const info = await context.storage.stat(resolved.value);
				if (!info.ok || info.value.kind !== "directory") continue;
				observations.push({
					providerId: options.providerId,
					source: options.source,
					level: options.level,
					canonicalRoot: resolved.value,
					scanKind: options.scanKind,
					priority: options.priority,
				});
			}
			if (observations.length === 0) return { ok: false, providerId: options.providerId, code: "unavailable", message: "no compatible skill directory is available" };
			return { ok: true, providerId: options.providerId, observations };
		},
	};
}
