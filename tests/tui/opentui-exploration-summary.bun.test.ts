import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { ExplorationRenderable } from "../../src/tui/opentui/exploration-renderable.ts";
import type { ExplorationBlock } from "../../src/tui/presentation.ts";

const bounded = (text: string) => ({ text, truncated: false, byteLength: new TextEncoder().encode(text).byteLength });

const block: ExplorationBlock = {
	id: "exploration-tool:read-1",
	kind: "exploration",
	state: "completed",
	actions: [
		{ id: "read-1", kind: "read", label: bounded("Read"), target: bounded("src/超长文件名.ts"), status: "succeeded" },
		{ id: "read-2", kind: "read", label: bounded("Read"), target: bounded("src/second.ts"), status: "succeeded" },
		{ id: "grep-1", kind: "search", label: bounded("Search"), target: bounded("src/tui"), query: bounded("projectToolEnd"), status: "succeeded", result: {
			kind: "exploration",
			resultCount: { state: "known", value: 6 },
			resultUnit: "matches",
			sourceTruncated: false,
			presentationTruncated: false,
			outputLines: { state: "unknown", reason: "not-reported" },
			totalLines: { state: "unknown", reason: "not-reported" },
		} },
	],
};

describe("OpenTUI exploration summary", () => {
	test("renders bounded Codex-style summaries without a tool body", async () => {
		const setup = await createTestRenderer({ width: 30, height: 12 });
		const renderable = new ExplorationRenderable(setup.renderer, {
			id: "exploration-summary",
			width: "100%",
			block,
		});
		setup.renderer.root.add(renderable);
		try {
			await setup.renderOnce();
			await setup.renderOnce();
			const frame = setup.captureCharFrame();
			expect(frame).toContain("• Explored");
			const copyText = renderable.plainText.replaceAll(/\s+/gu, "");
			expect(copyText).toContain("Readsrc/超长文件名.ts,src/second.ts");
			expect(copyText).toContain('Search"projectToolEnd"insrc/tui·6matches');
			expect(renderable.plainText).not.toContain("privateFileBody");
		} finally {
			renderable.destroyRecursively();
		}
	});
});
