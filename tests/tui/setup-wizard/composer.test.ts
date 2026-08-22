import { describe, expect, it } from "vitest";
import { ComposerSetupWizard } from "../../../src/tui/setup-wizard/composer.ts";
import { createComposerShapeRegistry } from "../../../src/tui/composer/registry.ts";
import type { SelectListTheme } from "../../../src/tui/primitives.ts";

const theme: SelectListTheme = {
	selectedPrefix: (text) => text,
	selectedText: (text) => text,
	description: (text) => text,
	scrollInfo: (text) => text,
	noMatch: (text) => text,
};

describe("composer setup wizard", () => {
	it("uses registry options and shared preview without saving during navigation", async () => {
		const saved: string[] = [];
		const committed: string[] = [];
		const wizard = new ComposerSetupWizard({
			registry: createComposerShapeRegistry(),
			initialShape: "box",
			selectListTheme: theme,
			settingsPort: {
				save: async (shape) => {
					saved.push(shape);
					return { ok: true };
				},
			},
			onCommitted: (shape) => committed.push(shape),
			onCancel: () => {},
			onSaveFailure: () => {},
		});

		wizard.handleInput("down");
		expect(wizard.render(80).join("\n")).toContain("Preview: Claude Code");
		expect(saved).toEqual([]);

		wizard.handleInput("enter");
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(saved).toEqual(["claude"]);
		expect(committed).toEqual(["claude"]);
	});

	it("keeps the wizard open and the old selection on save failure, while Esc cancels", async () => {
		let failures = 0;
		let cancelled = 0;
		const wizard = new ComposerSetupWizard({
			registry: createComposerShapeRegistry(),
			initialShape: "box",
			selectListTheme: theme,
			settingsPort: { save: async () => ({ ok: false as const, code: "settings_write_failed" }) },
			onCommitted: () => {},
			onCancel: () => { cancelled += 1; },
			onSaveFailure: () => { failures += 1; },
		});

		wizard.handleInput("down");
		wizard.handleInput("enter");
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(failures).toBe(1);
		expect(wizard.render(80).join("\n")).toContain("Preview: Claude Code");

		wizard.handleInput("escape");
		expect(cancelled).toBe(1);
	});
});
