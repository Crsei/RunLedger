import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const runtimeDir = fileURLToPath(new URL("../../src/tui/opentui/component-runtime/", import.meta.url));

describe("OpenTUI frame runtime structure", () => {
	it("delegates node lifecycle to narrow body and overlay owners", () => {
		const frameRuntime = readFileSync(`${runtimeDir}/frame-runtime.ts`, "utf8");

		expect(existsSync(`${runtimeDir}/renderable-registry.ts`)).toBe(true);
		expect(existsSync(`${runtimeDir}/overlay-controller.ts`)).toBe(true);
		expect(frameRuntime).toContain("new RenderableRegistry");
		expect(frameRuntime).toContain("new OverlayController");
		expect(frameRuntime).not.toMatch(/new (?:Markdown|Exec|Diff|PlanUpdate|Notice)Renderable/u);
	});

	it("keeps frame orchestration below the module guardrail", () => {
		const frameRuntime = readFileSync(`${runtimeDir}/frame-runtime.ts`, "utf8");
		expect(frameRuntime.split(/\r?\n/u).length).toBeLessThanOrEqual(320);
	});
});
