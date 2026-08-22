import type { RunledgerLayout } from "../runtime/contracts/storage-layout.ts";
import { updateProjectSettings } from "../storage/settings-manager.ts";
import type { HideThinkingSettingsPort } from "../tui/interactive-mode.ts";

/** CLI 显式 flag 只会开启；未提供时回退 canonical settings，最后默认显示。 */
export function resolveHideThinkingBlock(
	cliValue: boolean | undefined,
	settingsValue: boolean | undefined,
): boolean {
	return cliValue ?? settingsValue ?? false;
}

/** TUI 只提交布尔展示偏好；composition root 合并 canonical user settings。 */
export function createCliHideThinkingSettings(layout: RunledgerLayout): HideThinkingSettingsPort {
	return {
		save: async (hidden) => {
			try {
				await updateProjectSettings({ layout }, (current) => ({ ...current, hideThinkingBlock: hidden }));
				return { ok: true };
			} catch {
				return { ok: false, code: "hide_thinking_settings_save_failed" };
			}
		},
	};
}
