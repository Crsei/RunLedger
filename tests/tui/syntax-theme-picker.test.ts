import { describe, expect, it, vi } from "vitest";
import stripAnsi from "strip-ansi";
import { Agent } from "../../src/runtime/agent.ts";
import { mockModel, mockStreamFn } from "../../src/runtime/providers/mock-stream.ts";
import { InteractiveMode, type SyntaxThemeSettingsPort } from "../../src/tui/interactive-mode.ts";
import { SyntaxThemeController } from "../../src/tui/highlight/theme-controller.ts";
import type { Component, Terminal } from "../../src/tui/primitives.ts";

class FakeTerminal implements Terminal {
	readonly columns = 100;
	readonly rows = 30;
	readonly kittyProtocolActive = false;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
}

function modeWith(port: SyntaxThemeSettingsPort) {
	const controller = new SyntaxThemeController({
		availableThemes: ["ansi", "catppuccin-mocha", "dracula"],
		configuredName: "dracula",
	});
	const mode = new InteractiveMode({
		agent: new Agent({ initialState: { systemPrompt: "test", model: mockModel }, streamFn: mockStreamFn }),
		terminal: new FakeTerminal(),
		syntaxThemeController: controller,
		syntaxThemeSettingsPort: port,
	});
	return { mode, controller };
}

function overlay(mode: InteractiveMode): Component {
	const value = (mode as unknown as { ui: { getOverlay(): Component | undefined } }).ui.getOverlay();
	if (value === undefined) throw new Error("theme overlay missing");
	return value;
}

describe("/theme picker", () => {
	it("projects startup theme diagnostics exactly once without exposing backend details", () => {
		const controller = new SyntaxThemeController({ availableThemes: ["catppuccin-mocha"] });
		const mode = new InteractiveMode({
			agent: new Agent({ initialState: { systemPrompt: "test", model: mockModel }, streamFn: mockStreamFn }),
			terminal: new FakeTerminal(),
			syntaxThemeController: controller,
			syntaxThemeWarnings: ["One or more custom syntax themes could not be loaded; using an available theme. Open /theme to review."],
		});
		const notices = mode.getTuiState().timeline.committedRows.filter((row) => row.kind === "notice");
		expect(notices.map((row) => row.message.text)).toEqual([
			"One or more custom syntax themes could not be loaded; using an available theme. Open /theme to review.",
		]);
	});

	it("labels custom themes and visible load errors without making failed themes selectable", () => {
		const { mode, controller } = modeWith({ save: async () => ({ ok: true }) });
		controller.addAvailableTheme("company-audit", "custom");
		controller.addLoadError("broken-audit", "custom_theme_invalid");
		mode.openSyntaxThemePicker();
		const text = stripAnsi(overlay(mode).render(100).join("\n"));
		expect(text).toContain("company-audit");
		expect(text).toContain("custom");
		expect(text).toContain("broken-audit");
		expect(text).toContain("load error");
	});

	it("previews on cursor movement and restores the opening theme on cancel", () => {
		const { mode, controller } = modeWith({ save: async () => ({ ok: true }) });
		mode.openSyntaxThemePicker();
		overlay(mode).handleInput?.("up");
		expect(controller.snapshot()).toMatchObject({ activeName: "catppuccin-mocha", configuredName: "dracula", previewName: "catppuccin-mocha" });
		overlay(mode).handleInput?.("escape");
		expect(controller.snapshot()).toMatchObject({ activeName: "dracula", configuredName: "dracula", previewName: undefined });
	});

	it("persists before committing the preview", async () => {
		const saved: string[] = [];
		const { mode, controller } = modeWith({ save: async (name) => {
			saved.push(name);
			expect(controller.snapshot().configuredName).toBe("dracula");
			return { ok: true };
		} });
		mode.openSyntaxThemePicker();
		overlay(mode).handleInput?.("up");
		overlay(mode).handleInput?.("enter");
		await vi.waitFor(() => expect(saved).toEqual(["catppuccin-mocha"]));
		expect(controller.snapshot()).toMatchObject({ activeName: "catppuccin-mocha", configuredName: "catppuccin-mocha", previewName: undefined });
	});

	it("restores the prior theme and shows a bounded notice when persistence fails", async () => {
		const { mode, controller } = modeWith({ save: async () => ({ ok: false, code: "do-not-leak-secret" }) });
		mode.openSyntaxThemePicker();
		overlay(mode).handleInput?.("up");
		overlay(mode).handleInput?.("enter");
		await vi.waitFor(() => expect(controller.snapshot().activeName).toBe("dracula"));
		const notices = mode.getTuiState().timeline.committedRows
			.filter((row) => row.kind === "notice")
			.map((row) => row.message.text)
			.join("\n");
		expect(notices).toContain("Syntax theme could not be saved");
		expect(notices).not.toContain("do-not-leak-secret");
	});
});
