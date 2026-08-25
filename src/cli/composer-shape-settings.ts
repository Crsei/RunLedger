import type { RunledgerLayout } from "../runtime/contracts/storage-layout.ts";
import { updateProjectSettings } from "../storage/settings-manager.ts";
import type { ComposerShapeSettingsPort } from "../tui/composer/types.ts";
import type { ComposerShapeRegistry } from "../tui/composer/registry.ts";

/** TUI 只提交 shape id；CLI composition root 负责 user settings 的 read-modify-write。 */
export function createCliComposerShapeSettings(
	layout: RunledgerLayout,
	registry: ComposerShapeRegistry,
): ComposerShapeSettingsPort {
	return {
		save: async (shape) => {
			const known = registry.getComposerShapeOptions().some((option) => option.id === shape);
			if (!known) return { ok: false, code: "unknown_composer_shape" };
			try {
				await updateProjectSettings({ layout }, (current) => ({ ...current, composer: { shape } }));
				return { ok: true };
			} catch {
				return { ok: false, code: "composer_shape_settings_save_failed" };
			}
		},
	};
}
