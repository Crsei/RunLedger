import type { RunledgerLayout } from "../runtime/contracts/storage-layout.ts";
import { loadProjectSettings, saveProjectSettings } from "../storage/settings-manager.ts";
import { BUILTIN_SYNTAX_THEME_NAMES } from "../tui/highlight/theme-controller.ts";
import type { SyntaxThemeSettingsPort } from "../tui/interactive-mode.ts";

/** TUI 只提交 safe theme name；composition port 合并 canonical user settings。 */
export function createCliSyntaxThemeSettings(
	layout: RunledgerLayout,
	customThemeNames: readonly string[] = [],
): SyntaxThemeSettingsPort {
	const allowedNames = new Set<string>([...BUILTIN_SYNTAX_THEME_NAMES, ...customThemeNames]);
	return {
		save: async (name) => {
			if (!allowedNames.has(name)) {
				return { ok: false, code: "syntax_theme_invalid" };
			}
			try {
				const current = await loadProjectSettings({ layout });
				await saveProjectSettings({ layout }, { ...current, theme: name });
				return { ok: true };
			} catch {
				return { ok: false, code: "syntax_theme_save_failed" };
			}
		},
	};
}
