import { describe, expect, it } from "vitest";
import { applyColorBlindMode, loadTheme } from "../../src/tui/theme/theme.ts";

describe("TUI accessibility settings", () => {
	it("remaps semantic colors for color-blind mode while preserving neutral colors", () => {
		const theme = loadTheme("dark");
		const accessible = applyColorBlindMode(theme, true);

		expect(accessible.success).not.toBe(theme.success);
		expect(accessible.error).not.toBe(theme.error);
		expect(accessible.toolResult).toBe(accessible.success);
		expect(accessible.toolError).toBe(accessible.error);
		expect(accessible.primary).toBe(theme.primary);
		expect(applyColorBlindMode(theme, false)).toEqual(theme);
	});
});
