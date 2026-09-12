/**
 * Agents compatibility providers（默认 on，只读）。`.agents/skills/` 与兼容
 * `.agent/skills/` 两目录分别形成 observation，不按 name 覆盖；越近 ancestor
 * 只改变 rank，不覆盖 identity（02 计划 §6.2）。
 */

import { join } from "node:path";
import type { DiscoveryProvider } from "../../capabilities/types.ts";
import type { SkillDiscoveryObservation } from "../registry.ts";
import { createFixedRootsProvider } from "./shared.ts";

/** agents-user：`<os-user-home>/.agents/skills/` + `.agent/skills/`（rank 2200，默认 on）。 */
export function createAgentsUserProvider(osUserHome: string): DiscoveryProvider<SkillDiscoveryObservation> {
	return createFixedRootsProvider({
		providerId: "agents-user",
		displayName: "Agents user skills",
		rank: 2200,
		defaultEnabled: true,
		source: "user",
		level: "user",
		priority: 2200,
		roots: [join(osUserHome, ".agents", "skills"), join(osUserHome, ".agent", "skills")],
		scanKind: "skills-directory",
	});
}

/** agents-project：repo boundary 内 `.agents/skills/` + `.agent/skills/`（rank 2300，默认 on）。 */
export function createAgentsProjectProvider(repoBoundary: string): DiscoveryProvider<SkillDiscoveryObservation> {
	return createFixedRootsProvider({
		providerId: "agents-project",
		displayName: "Agents project skills",
		rank: 2300,
		defaultEnabled: true,
		source: "project",
		level: "project",
		priority: 2300,
		roots: [join(repoBoundary, ".agents", "skills"), join(repoBoundary, ".agent", "skills")],
		scanKind: "skills-directory",
	});
}
