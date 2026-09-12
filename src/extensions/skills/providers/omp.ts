/** OMP 固定 Skill 目录；只发现候选，不继承 OMP 的启用或信任状态。 */

import { join } from "node:path";
import type { DiscoveryProvider } from "../../capabilities/types.ts";
import type { SkillDiscoveryObservation } from "../registry.ts";
import { createFixedRootsProvider } from "./shared.ts";

export function createOmpUserProvider(osUserHome: string): DiscoveryProvider<SkillDiscoveryObservation> {
	return createFixedRootsProvider({
		providerId: "omp-user", displayName: "OMP user skills", rank: 1800, priority: 1800,
		defaultEnabled: true, source: "user", level: "user", scanKind: "skills-directory",
		roots: [join(osUserHome, ".omp", "agent", "skills")],
	});
}

export function createOmpProjectProvider(projectBoundary: string): DiscoveryProvider<SkillDiscoveryObservation> {
	return createFixedRootsProvider({
		providerId: "omp-project", displayName: "OMP project skills", rank: 1900, priority: 1900,
		defaultEnabled: true, source: "project", level: "project", scanKind: "skills-directory",
		roots: [join(projectBoundary, ".omp", "skills")],
	});
}
