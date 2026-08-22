import { describe, expect, it } from "vitest";
import { ComposerShapeSelector } from "../../../src/tui/composer/selector.ts";
import { createComposerShapeRegistry, getComposerShapeOptions } from "../../../src/tui/composer/registry.ts";
import type { ComposerShapeSettingsPort } from "../../../src/tui/composer/types.ts";
import type { SelectListTheme } from "../../../src/tui/primitives.ts";

const theme: SelectListTheme = {
	selectedPrefix: (text) => text,
	selectedText: (text) => text,
	description: (text) => text,
	scrollInfo: (text) => text,
	noMatch: (text) => text,
};

describe("composer shape selector", () => {
	it("previews navigation without saving until Enter", async () => {
		const saved: string[] = [];
		const committed: string[] = [];
		const port: ComposerShapeSettingsPort = {
			save: async (shape) => {
				saved.push(shape);
				return { ok: true };
			},
		};
		const selector = new ComposerShapeSelector({
			registry: createComposerShapeRegistry(),
			options: getComposerShapeOptions(),
			initialShape: "box",
			selectListTheme: theme,
			settingsPort: port,
			onCommitted: (shape) => committed.push(shape),
			onCancel: () => {},
			onSaveFailure: () => {},
		});

		selector.handleInput("down");
		expect(selector.render(60).join("\n")).toContain("Claude");
		expect(saved).toEqual([]);

		selector.handleInput("enter");
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(saved).toEqual(["claude"]);
		expect(committed).toEqual(["claude"]);
	});

	it("cancels without writing when Esc is pressed", () => {
		let cancelled = 0;
		let saved = 0;
		const selector = new ComposerShapeSelector({
			registry: createComposerShapeRegistry(),
			options: getComposerShapeOptions(),
			initialShape: "box",
			selectListTheme: theme,
			settingsPort: { save: async () => { saved += 1; return { ok: true }; } },
			onCommitted: () => {},
			onCancel: () => { cancelled += 1; },
			onSaveFailure: () => {},
		});

		selector.handleInput("escape");
		expect(cancelled).toBe(1);
		expect(saved).toBe(0);
	});

	it("ignores cancel, navigation, and repeated Enter while a save is in flight", async () => {
		let finishSave: ((result: { readonly ok: true }) => void) | undefined;
		const saved: string[] = [];
		const events: string[] = [];
		const selector = new ComposerShapeSelector({
			registry: createComposerShapeRegistry(),
			options: getComposerShapeOptions(),
			initialShape: "box",
			selectListTheme: theme,
			settingsPort: {
				save: (shape) => {
					saved.push(shape);
					return new Promise((resolve) => { finishSave = resolve; });
				},
			},
			onCommitted: (shape) => events.push(`commit:${shape}`),
			onCancel: () => events.push("cancel"),
			onSaveFailure: (code) => events.push(`failure:${code}`),
		});

		selector.handleInput("down");
		selector.handleInput("enter");
		selector.handleInput("escape");
		selector.handleInput("down");
		selector.handleInput("enter");

		expect(saved).toEqual(["claude"]);
		expect(events).toEqual([]);
		expect(selector.render(60).join("\n")).toContain("Preview: Claude Code");

		finishSave?.({ ok: true });
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		expect(events).toEqual(["commit:claude"]);
	});
});
