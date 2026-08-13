/**
 * Claude compatibility providers（默认 off，只读）。root 由 composition root
 * 解析注入；不读取/写回 Claude settings 作为 RunLedger authority（02 计划
 * §6.2、§8.1）。
 */

import { join } from "node:path";
import type { DiscoveryProvider } from "../../capabilities/types.ts";
import type { SkillDiscoveryObservation } from "../registry.ts";
import { createFixedRootsProvider } from "./shared.ts";

/** claude-user：`<os-user-home>/.claude/skills/`（rank 2400，默认 off）。 */
export function createClaudeUserProvider(osUserHome: string): DiscoveryProvider<SkillDiscoveryObservation> {
	return createFixedRootsProvider({
		providerId: "claude-user",
		displayName: "Claude user skills",
		rank: 2400,
		defaultEnabled: false,
		source: "user",
		level: "user",
		priority: 2400,
		roots: [join(osUserHome, ".claude", "skills")],
		scanKind: "skills-directory",
	});
}

/** claude-project：repo boundary 内 `.claude/skills/`（rank 2500，默认 off，只读）。 */
export function createClaudeProjectProvider(repoBoundary: string): DiscoveryProvider<SkillDiscoveryObservation> {
	return createFixedRootsProvider({
		providerId: "claude-project",
		displayName: "Claude project skills",
		rank: 2500,
		defaultEnabled: false,
		source: "project",
		level: "project",
		priority: 2500,
		roots: [join(repoBoundary, ".claude", "skills")],
		scanKind: "skills-directory",
	});
}
