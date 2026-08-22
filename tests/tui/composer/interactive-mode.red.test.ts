import { describe, expect, it, vi } from "vitest";
import { Agent } from "../../../src/runtime/agent.ts";
import { mockModel } from "../../../src/runtime/providers/mock-stream.ts";
import { InteractiveMode } from "../../../src/tui/interactive-mode.ts";
import { TUI, type Terminal } from "../../../src/tui/primitives.ts";
import { ComposerShapeSelector } from "../../../src/tui/composer/selector.ts";
import { ComposerSetupWizard } from "../../../src/tui/setup-wizard/composer.ts";
import { createComposerShapeRegistry } from "../../../src/tui/composer/registry.ts";
import { findCommand } from "../../../src/tui/commands/registry.ts";
import type { ComposerShapeSettingsPort } from "../../../src/tui/composer/types.ts";

class FakeTerminal implements Terminal {
	private input: ((data: string) => void) | undefined;

	get columns(): number { return 80; }
	get rows(): number { return 24; }
	get kittyProtocolActive(): boolean { return false; }
	start(onInput: (data: string) => void): void { this.input = onInput; }
	stop(): void { this.input = undefined; }
	async drainInput(): Promise<void> {}
	write(_data: string): void {}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

function makeMode(settingsPort: ComposerShapeSettingsPort): InteractiveMode {
	return new InteractiveMode({
		agent: new Agent({
			initialState: { systemPrompt: "test", model: mockModel },
			streamFn: () => { throw new Error("stream not called"); },
		}),
		terminal: new FakeTerminal(),
		composerShape: "box",
		composerShapeRegistry: createComposerShapeRegistry(),
		composerShapeSettingsPort: settingsPort,
	});
}

function openShapeSelector(mode: InteractiveMode): TUI {
	const command = findCommand("shape");
	if (command === undefined) throw new Error("shape command is not registered");
	const internals = mode as unknown as {
		dispatchCommand(command: typeof command, arg: string): void;
		ui: TUI;
	};
	internals.dispatchCommand(command, "");
	return internals.ui;
}

describe("InteractiveMode composer shape command", () => {
	it("uses the default Box adapter when the user setting is absent", () => {
		const mode = new InteractiveMode({
			agent: new Agent({
				initialState: { systemPrompt: "test", model: mockModel },
				streamFn: () => { throw new Error("stream not called"); },
			}),
			terminal: new FakeTerminal(),
			composerShapeRegistry: createComposerShapeRegistry(),
			composerShapeSettingsPort: { save: async () => ({ ok: true }) },
		});
		const ui = (mode as unknown as { ui: TUI }).ui;

		expect((ui as unknown as { composerStyle?: { id: string } }).composerStyle?.id).toBe("box");
	});

	it("falls back to Box for an unknown startup shape and emits only a bounded diagnostic", () => {
		const mode = new InteractiveMode({
			agent: new Agent({
				initialState: { systemPrompt: "test", model: mockModel },
				streamFn: () => { throw new Error("stream not called"); },
			}),
			terminal: new FakeTerminal(),
			composerShape: "invalid-shape-from-settings",
			composerShapeRegistry: createComposerShapeRegistry(),
			composerShapeSettingsPort: { save: async () => ({ ok: true }) },
		});
		const ui = (mode as unknown as { ui: TUI }).ui;
		const notices = mode.getTuiState().timeline.committedRows
			.filter((row) => row.kind === "notice")
			.map((row) => row.message.text)
			.join("\n");

		expect((ui as unknown as { composerStyle?: { id: string } }).composerStyle?.id).toBe("box");
		expect(notices).toContain("Unknown composer shape; using the Box shape.");
		expect(notices).not.toContain("invalid-shape-from-settings");
	});

	it("opens /shape, previews navigation, then applies only after a successful save", async () => {
		const saved: string[] = [];
		const mode = makeMode({
			save: async (shape) => {
				saved.push(shape);
				return { ok: true };
			},
		});
		const ui = openShapeSelector(mode);
		const selector = ui.getOverlay();
		expect(selector).toBeInstanceOf(ComposerShapeSelector);
		if (!(selector instanceof ComposerShapeSelector)) return;

		selector.handleInput("down");
		expect(selector.render(80).join("\n")).toContain("Preview: Claude");
		expect(saved).toEqual([]);

		selector.handleInput("enter");
		await vi.waitFor(() => expect(saved).toEqual(["claude"]));
		expect(ui.hasOverlay()).toBe(false);
		expect((ui as unknown as { composerStyle?: { id: string } }).composerStyle?.id).toBe("claude");
	});

	it("keeps the committed shape and selector open when persistence fails", async () => {
		let attempts = 0;
		const mode = makeMode({
			save: async () => {
				attempts += 1;
				return { ok: false, code: "settings_write_failed" };
			},
		});
		const ui = openShapeSelector(mode);
		const selector = ui.getOverlay();
		expect(selector).toBeInstanceOf(ComposerShapeSelector);
		if (!(selector instanceof ComposerShapeSelector)) return;

		selector.handleInput("down");
		selector.handleInput("enter");
		await vi.waitFor(() => expect(attempts).toBe(1));
		expect(ui.hasOverlay()).toBe(true);
		expect((ui as unknown as { composerStyle?: { id: string } }).composerStyle?.id).toBe("box");
	});

	it("opens the production setup scene and commits through the same sync path", async () => {
		const saved: string[] = [];
		const mode = makeMode({
			save: async (shape) => {
				saved.push(shape);
				return { ok: true };
			},
		});
		const command = findCommand("setup");
		if (command === undefined) throw new Error("setup command is not registered");
		const internals = mode as unknown as {
			dispatchCommand(command: typeof command, arg: string): void;
			ui: TUI;
		};
		internals.dispatchCommand(command, "");
		const wizard = internals.ui.getOverlay();
		expect(wizard).toBeInstanceOf(ComposerSetupWizard);
		if (!(wizard instanceof ComposerSetupWizard)) return;

		wizard.handleInput("down");
		expect(wizard.render(80).join("\n")).toContain("Preview: Claude Code");
		wizard.handleInput("enter");
		await vi.waitFor(() => expect(saved).toEqual(["claude"]));
		expect(internals.ui.hasOverlay()).toBe(false);
		expect((internals.ui as unknown as { composerStyle?: { id: string } }).composerStyle?.id).toBe("claude");
	});
});
