/**
 * user/workspace skills provider policy 合并（只允许收窄）。
 *
 * - user `enabled=false` 是总闸；workspace/Session 只能进一步关闭；
 * - workspace `providers[id]=true` 不能反转 user `false`（发 diagnostic，以 user 为准）；
 * - 只接受已知 provider exact ID；未知 ID 保留 diagnostic，不自动运行；
 * - 外部 path 不进入 policy；OS home/repo root 由 composition root 注入。
 */

import { extensionDiagnostic } from "../diagnostics.ts";
import type { ExtensionDiagnostic } from "../diagnostics.ts";
import type { SkillsSettings } from "../../storage/settings-manager.ts";

/** 已知 provider exact IDs；外部兼容 providers 在各 phase 加入后补充。 */
export const KNOWN_SKILL_PROVIDER_IDS: readonly string[] = Object.freeze([
	"runledger-builtin",
	"runledger-user",
	"runledger-workspace",
	"runledger-repo",
	"runledger-session",
	"runledger-plugin",
	"codex-user",
	"codex-project",
	"agents-user",
	"agents-project",
	"claude-user",
	"claude-project",
	"claude-plugins",
]);

export interface SkillsPolicyResult {
	/** user master switch；false 时全部 provider 关闭（零 I/O）。 */
	readonly masterEnabled: boolean;
	/** 显式合并后的 provider 开关（只含已知 ID；缺省 provider 用其 defaultEnabled）。 */
	readonly providerEnabled: ReadonlyMap<string, boolean>;
	readonly diagnostics: readonly ExtensionDiagnostic[];
}

export function resolveSkillsPolicy(
	user: SkillsSettings | undefined,
	workspace: SkillsSettings | undefined,
): SkillsPolicyResult {
	const diagnostics: ExtensionDiagnostic[] = [];
	const masterEnabled = user?.enabled ?? true;
	const explicit = new Map<string, boolean>();
	for (const [id, enabled] of Object.entries(user?.providers ?? {})) explicit.set(id, enabled);
	for (const [id, enabled] of Object.entries(workspace?.providers ?? {})) {
		const userValue = explicit.get(id);
		if (userValue === false && enabled === true) {
			diagnostics.push(extensionDiagnostic("skill.policy_workspace_cannot_reopen", "warning", `workspace cannot re-enable provider ${id} disabled at user scope`, "skill", id));
			continue;
		}
		explicit.set(id, enabled);
	}
	const providerEnabled = new Map<string, boolean>();
	for (const [id, enabled] of explicit) {
		if (!KNOWN_SKILL_PROVIDER_IDS.includes(id)) {
			diagnostics.push(extensionDiagnostic("skill.policy_unknown_provider", "warning", `unknown skill provider id: ${id}`, "skill", id));
			continue;
		}
		providerEnabled.set(id, enabled);
	}
	return { masterEnabled, providerEnabled, diagnostics };
}
