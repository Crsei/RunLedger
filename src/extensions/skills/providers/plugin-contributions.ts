/**
 * runledger-plugin provider：把 PluginManager 的被动 Skill contributions
 * 转成 observations（纯变换，零 I/O）。plugin 已 trust+enabled 的 contribution
 * 携带 parent binding；untrusted/disabled 不产生 contribution（候选不激活）。
 */

import type { DiscoveryProvider } from "../../capabilities/types.ts";
import type { PluginSkillContribution } from "../../plugins/manager.ts";
import type { SkillDiscoveryObservation } from "../registry.ts";

export function createPluginContributionsProvider(input: {
	readonly contributions: () => readonly PluginSkillContribution[];
}): DiscoveryProvider<SkillDiscoveryObservation> {
	return {
		id: "runledger-plugin",
		displayName: "RunLedger plugin skill contributions",
		capabilityId: "skills",
		rank: 400,
		defaultEnabled: true,
		load: async (context) => ({
			ok: true,
			providerId: "runledger-plugin",
			observations: ((context.inputs?.get("runledger-plugin") as readonly PluginSkillContribution[] | undefined) ?? input.contributions()).map((contribution): SkillDiscoveryObservation => ({
				providerId: "runledger-plugin",
				source: contribution.source,
				level: "plugin",
				// 与旧 discoverSkills({skillsPath}) 等价：声明的路径是 skills root，
				// 其 immediate-child 目录才是 skill 条目。
				canonicalRoot: contribution.skillRoot,
				scanKind: "skills-directory",
				priority: contribution.priority,
				...(contribution.pluginId === undefined ? {} : { pluginId: contribution.pluginId }),
				...(contribution.inheritedTrustBinding === undefined ? {} : { inheritedTrustBinding: contribution.inheritedTrustBinding }),
			})),
		}),
	};
}
