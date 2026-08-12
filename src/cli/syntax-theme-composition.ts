import type { RunledgerLayout } from "../runtime/contracts/storage-layout.ts";
import { loadCustomSyntaxThemes } from "../storage/custom-syntax-themes.ts";
import { loadNativeSyntaxAddon, type NativeSyntaxAddonAvailability } from "../tui/highlight/native-loader.ts";
import { BUILTIN_SYNTAX_THEME_NAMES, SyntaxThemeController } from "../tui/highlight/theme-controller.ts";

export interface CliSyntaxThemeComposition {
	readonly controller: SyntaxThemeController;
	readonly customThemeNames: readonly string[];
	takeWarnings(): readonly string[];
}

/** composition root 唯一负责 storage bytes -> native registration -> controller inventory。 */
export async function composeCliSyntaxThemes(
	layout: RunledgerLayout,
	configuredName: string | undefined,
	loadAddon: () => NativeSyntaxAddonAvailability = loadNativeSyntaxAddon,
): Promise<CliSyntaxThemeComposition> {
	const loaded = await loadCustomSyntaxThemes(layout);
	const availability = loadAddon();
	const customThemeNames: string[] = [];
	const failures = new Map<string, string>();
	for (const error of loaded.errors) failures.set(error.name, error.code);
	if (availability.ok) {
		for (const theme of loaded.themes) {
			const registered = availability.addon.registerCustomTheme(theme.name, theme.bytes);
			if (registered.ok) customThemeNames.push(theme.name);
			else failures.set(theme.name, "custom_theme_invalid");
		}
	} else {
		for (const theme of loaded.themes) failures.set(theme.name, "native_unavailable");
	}
	const controller = new SyntaxThemeController({
		availableThemes: [...BUILTIN_SYNTAX_THEME_NAMES, ...customThemeNames],
		configuredName,
		terminalMode: "unknown",
	});
	for (const name of customThemeNames) controller.addAvailableTheme(name, "custom");
	for (const [name, error] of failures) controller.addLoadError(name, error);
	const configuredAvailable = configuredName === undefined || configuredName === "dark" || configuredName === "light" ||
		controller.themeNames().includes(configuredName);
	if (!configuredAvailable) controller.addLoadError(configuredName, "custom_theme_missing");
	const needsWarning = failures.size > 0 || !configuredAvailable;
	let warnings = needsWarning
		? ["One or more custom syntax themes could not be loaded; using an available theme. Open /theme to review."]
		: [];
	return {
		controller,
		customThemeNames,
		takeWarnings: () => {
			const current = warnings;
			warnings = [];
			return current;
		},
	};
}
