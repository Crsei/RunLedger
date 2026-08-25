import { describe, expect, it } from "vitest";
import { SettingsPanel, type SettingsPanelResult } from "../../src/tui/components/settings-panel.ts";
import { makeSelectListTheme } from "../../src/tui/theme/factories.ts";
import { loadTheme } from "../../src/tui/theme/theme.ts";

const theme = makeSelectListTheme(loadTheme("dark"));

const items = [
	{ path: "display.showTokenUsage" as const, value: true, defaultValue: true, apply: "live" as const, scope: ["user" as const] },
	{ path: "retry.maxRetries" as const, value: 2, defaultValue: 0, apply: "next-turn" as const, scope: ["user" as const] },
];

describe("SettingsPanel", () => {
	it("navigates group, setting and typed value views, then reports a canonical write", async () => {
		const writes: Array<{ path: string; value: string }> = [];
		let result: SettingsPanelResult | undefined;
		const panel = new SettingsPanel({
			items,
			selectListTheme: theme,
			onSet: async (path, value) => {
				writes.push({ path, value });
				return { ok: true, value: value === "false" ? false : true };
			},
			onReset: async () => ({ ok: true }),
			onCancel: () => undefined,
			onResult: (next) => { result = next; },
		});

		panel.handleInput("\r"); // display group
		panel.handleInput("\r"); // showTokenUsage
		panel.handleInput("down"); // false
		panel.handleInput("\r");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(writes).toEqual([{ path: "display.showTokenUsage", value: "false" }]);
		expect(result).toMatchObject({ ok: true, path: "display.showTokenUsage" });
		expect(panel.render(100).join("\n")).toContain("showTokenUsage");
	});

	it("opens an editable input for numeric settings and preserves the next-turn boundary", async () => {
		const writes: string[] = [];
		const panel = new SettingsPanel({
			items,
			selectListTheme: theme,
			onSet: async (_path, value) => {
				writes.push(value);
				return { ok: true, value: 3 };
			},
			onReset: async () => ({ ok: true }),
			onCancel: () => undefined,
		});

		panel.handleInput("down"); // retry group
		panel.handleInput("\r");
		panel.handleInput("\r"); // numeric setting -> input
		panel.handleInput("ctrl+u");
		panel.handleInput("3");
		panel.handleInput("\r");
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(writes).toEqual(["3"]);
		expect(panel.render(100).join("\n")).toContain("next-turn");
	});
});
