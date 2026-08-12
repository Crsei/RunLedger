import { describe, expect, it } from "vitest";
import { SyntaxThemeController } from "../../src/tui/highlight/theme-controller.ts";

const themes = ["ansi", "catppuccin-latte", "catppuccin-mocha", "dracula"] as const;

describe("SyntaxThemeController", () => {
	it("selects the Codex adaptive light/dark pair and bumps a monotonic revision", () => {
		const controller = new SyntaxThemeController({ availableThemes: themes, terminalMode: "dark" });
		expect(controller.snapshot()).toMatchObject({ activeName: "catppuccin-mocha", configuredName: undefined, revision: 0 });
		controller.setTerminalMode("light");
		expect(controller.snapshot()).toMatchObject({ activeName: "catppuccin-latte", revision: 1 });
		controller.setTerminalMode("light");
		expect(controller.snapshot().revision).toBe(1);
	});

	it("previews, cancels, and commits without losing configured authority", () => {
		const controller = new SyntaxThemeController({ availableThemes: themes, configuredName: "dracula", terminalMode: "dark" });
		const events: string[] = [];
		const unsubscribe = controller.subscribe((snapshot) => events.push(`${snapshot.activeName}:${snapshot.revision}`));
		expect(controller.preview("ansi")).toEqual({ ok: true });
		expect(controller.snapshot()).toMatchObject({ activeName: "ansi", configuredName: "dracula", previewName: "ansi", revision: 1 });
		controller.cancelPreview();
		expect(controller.snapshot()).toMatchObject({ activeName: "dracula", configuredName: "dracula", previewName: undefined, revision: 2 });
		expect(controller.preview("ansi")).toEqual({ ok: true });
		controller.commitPreview();
		expect(controller.snapshot()).toMatchObject({ activeName: "ansi", configuredName: "ansi", previewName: undefined, revision: 3 });
		unsubscribe();
		// commit 不需再次失效高亮 cache，但 configured/preview 状态变化仍通知订阅者。
		expect(events).toEqual(["ansi:1", "dracula:2", "ansi:3", "ansi:3"]);
	});

	it("rejects unavailable names and maps legacy dark/light settings", () => {
		expect(new SyntaxThemeController({ availableThemes: themes, configuredName: "dark", terminalMode: "light" }).snapshot().activeName).toBe("catppuccin-mocha");
		expect(new SyntaxThemeController({ availableThemes: themes, configuredName: "light", terminalMode: "dark" }).snapshot().activeName).toBe("catppuccin-latte");
		const controller = new SyntaxThemeController({ availableThemes: themes, terminalMode: "dark" });
		expect(controller.preview("missing")).toEqual({ ok: false, reason: "theme_invalid" });
		expect(controller.snapshot().revision).toBe(0);
	});

	it("registers validated custom theme names into the same sorted picker inventory", () => {
		const controller = new SyntaxThemeController({ availableThemes: themes, terminalMode: "dark" });
		expect(controller.addAvailableTheme("Zulu-custom", "custom")).toEqual({ ok: true });
		expect(controller.addAvailableTheme("alpha-custom", "custom")).toEqual({ ok: true });
		expect(controller.addAvailableTheme("../outside")).toEqual({ ok: false, reason: "theme_invalid" });
		expect(controller.addAvailableTheme("bad..name", "custom")).toEqual({ ok: false, reason: "theme_invalid" });
		expect(controller.themeNames().slice(-2)).toEqual(["dracula", "Zulu-custom"]);
		expect(controller.themeNames()).toContain("alpha-custom");
		expect(controller.themeEntries().find((entry) => entry.name === "alpha-custom")).toEqual({
			name: "alpha-custom",
			kind: "custom",
			available: true,
		});
	});

	it("keeps bounded custom load failures visible but unavailable for preview", () => {
		const controller = new SyntaxThemeController({ availableThemes: themes, configuredName: "missing-custom", terminalMode: "dark" });
		expect(controller.snapshot()).toMatchObject({ activeName: "catppuccin-mocha", configuredName: undefined });
		expect(controller.addLoadError("broken-custom", "custom_theme_invalid")).toEqual({ ok: true });
		expect(controller.themeEntries()).toContainEqual({
			name: "broken-custom",
			kind: "custom",
			available: false,
			error: "custom_theme_invalid",
		});
		expect(controller.preview("broken-custom")).toEqual({ ok: false, reason: "theme_invalid" });
	});
});
