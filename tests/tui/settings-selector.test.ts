import { describe, expect, it } from "vitest";
import { groupSettings, settingValueChoices } from "../../src/tui/settings-selector.ts";

describe("TUI settings selector projection", () => {
	it("groups canonical settings by schema group without creating a second authority", () => {
		const groups = groupSettings([
			{ path: "display.showTokenUsage", value: true, defaultValue: true, apply: "live", scope: ["user"] },
			{ path: "retry.maxRetries", value: 2, defaultValue: 0, apply: "next-turn", scope: ["user"] },
			{ path: "display.cacheMissMarker", value: false, defaultValue: false, apply: "live", scope: ["user"] },
		]);

		expect(groups.map((group) => group.name)).toEqual(["display", "retry"]);
		expect(groups[0]?.items.map((item) => item.path)).toEqual([
			"display.cacheMissMarker",
			"display.showTokenUsage",
		]);
		expect(groups[1]?.items[0]).toMatchObject({ path: "retry.maxRetries", value: 2 });
	});

	it("offers typed choices for boolean and enum settings and leaves numeric values editable", () => {
		expect(settingValueChoices("display.showTokenUsage", true)).toEqual(["true", "false"]);
		expect(settingValueChoices("statusLine.preset", "default")).toEqual(["default", "compact", "minimal"]);
		expect(settingValueChoices("symbolPreset", "unicode")).toEqual(["unicode", "nerd", "ascii"]);
		expect(settingValueChoices("retry.maxRetries", 2)).toBeUndefined();
	});
});
