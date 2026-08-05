/** Resident Host-owned Skill tool bridge：catalog → trust/digest 复核 → agent tool loader。 */

import type { SkillLoader } from "../runtime/tools/skill.ts";
import { SkillCatalog } from "../extensions/skills/catalog.ts";
import { SkillToolResolver } from "../extensions/skills/skill-tool.ts";
import type { SkillDescriptor } from "../extensions/skills/types.ts";
import type { TrustStore } from "../extensions/trust/trust-store.ts";
import type { ExtensionStoragePort } from "../extensions/storage-port.ts";
import type { PrincipalId } from "../runtime/protocol/ids.ts";

/**
 * 组装渐进披露 Skill loader：每次模型调用都重新走 catalog resolve →
 * trust 复核 → 文件 digest 复核 → 重新解析 frontmatter，正文读取不授予
 * 脚本执行权限（assets/script 需要独立 approval）。
 *
 * `currentTools` 提供当前模型可见工具名，用于把 SKILL.md frontmatter 的
 * allowedTools 收窄到实际可用工具。
 */
export function createHostSkillLoader(options: {
	readonly skills: () => readonly SkillDescriptor[];
	readonly trustStore: TrustStore;
	readonly principalId: PrincipalId;
	readonly storage: ExtensionStoragePort;
	readonly currentTools: () => readonly string[];
}): SkillLoader {
	return async (name, args) => {
		// 每次调用重建 catalog/resolver：extension snapshot 可能在 turn 间
		// reload，正文与 trust 状态以“当前发现”为准。
		// 不传显式 trigger：让 catalog 解析 $/slash 前缀；裸 name 即
		// model-tool 触发（受 disableModelInvocation 约束）。
		const resolver = new SkillToolResolver({
			catalog: new SkillCatalog(options.skills()),
			trustStore: options.trustStore,
			principalId: options.principalId,
			storage: options.storage,
			currentTools: options.currentTools,
		});
		const loaded = await resolver.load(name);
		if (!loaded.ok) {
			return { ok: false, code: loaded.code, message: loaded.message };
		}
		return {
			ok: true,
			body: loaded.value.body,
			allowedTools: loaded.value.allowedTools,
		};
	};
}
