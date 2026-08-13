/**
 * Codex compatibility providers（默认 off，只读，不读取 Codex enable 配置）。
 * root 由 composition root 显式解析 `<os-user-home>` 与 repo boundary 注入；
 * provider 不调用 homedir()/cwd()。启用后候选仍 untrusted，trust exact Skill
 * 后才 active（02 计划 §6.2）。
 */

import { join } from "node:path";
import type { DiscoveryProvider } from "../../capabilities/types.ts";
import type { SkillDiscoveryObservation } from "../registry.ts";
import { createFixedRootsProvider } from "./shared.ts";

/** codex-user：`<os-user-home>/.codex/skills/`（rank 2000，默认 off）。 */
export function createCodexUserProvider(osUserHome: string): DiscoveryProvider<SkillDiscoveryObservation> {
	return createFixedRootsProvider({
		providerId: "codex-user",
		displayName: "Codex user skills",
		rank: 2000,
		defaultEnabled: false,
		source: "user",
		level: "user",
		priority: 2000,
		roots: [join(osUserHome, ".codex", "skills")],
		scanKind: "skills-directory",
	});
}

/** codex-project：repo boundary 内 `.codex/skills/`（rank 2100，默认 off，只读）。 */
export function createCodexProjectProvider(repoBoundary: string): DiscoveryProvider<SkillDiscoveryObservation> {
	return createFixedRootsProvider({
		providerId: "codex-project",
		displayName: "Codex project skills",
		rank: 2100,
		defaultEnabled: false,
		source: "project",
		level: "project",
		priority: 2100,
		roots: [join(repoBoundary, ".codex", "skills")],
		scanKind: "skills-directory",
	});
}
