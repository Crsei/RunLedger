import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createComposerShapeRegistry } from "../../src/tui/composer/registry.ts";
import { createCliComposerShapeComposition } from "../../src/cli/composer-shape-composition.ts";

describe("standard CLI composer shape composition", () => {
	it("injects one registry, user-level settings port, and the persisted initial shape", () => {
		const main = readFileSync("src/cli/main.ts", "utf8");

		expect(main).toContain('createComposerShapeRegistry()');
		expect(main).toContain("createCliComposerShapeComposition");
		expect(main).toContain("composerShapeComposition.load()");
		expect(main).toContain("composerShapeComposition.dispose()");
		expect(main).toContain("createCliComposerShapeSettings(layout, composerShapeRegistry)");
		expect(main).toContain("composerShape: composerShapeSettings.composer?.shape");
		expect(main).toContain("composerShapeRegistry");
		expect(main).toContain("composerShapeSettingsPort");
	});

	it("owns the trusted lifecycle locally without importing Runtime or Host state", () => {
		const registry = createComposerShapeRegistry();
		const composition = createCliComposerShapeComposition({ registry });

		expect(composition.load()).toEqual({ ok: true, installed: [] });
		expect(composition.registry).toBe(registry);
		composition.dispose();
		expect(registry.getComposerShapeOptions()).toHaveLength(7);
	});
});
