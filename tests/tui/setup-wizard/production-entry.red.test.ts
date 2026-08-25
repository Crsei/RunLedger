import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findCommand } from "../../../src/tui/commands/registry.ts";

describe("composer setup wizard production entry", () => {
	it("has a real slash command and InteractiveMode overlay composition", () => {
		const command = findCommand("setup");
		expect(command?.actionType).toBe("config.setup-wizard");
		expect(command?.canonicalName).toBe("setup");

		const interactiveMode = readFileSync("src/tui/interactive-mode.ts", "utf8");
		expect(interactiveMode).toContain("ComposerSetupWizard");
		expect(interactiveMode).toContain("openComposerSetupWizard");
	});
});
