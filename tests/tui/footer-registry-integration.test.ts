import { describe, expect, it } from "vitest";
import type { PresentationBlock } from "../../src/tui/presentation.ts";
import { createContractHarness, settleFrames } from "./fixtures/contract-integration.ts";

describe("InteractiveMode Footer registry", () => {
	it("re-renders one TUI instance when an internal field is registered and unregistered", async () => {
		const harness = createContractHarness({ columns: 100, rows: 16 });
		try {
			await settleFrames();
			const writesBefore = harness.terminal.writes.length;
			const registered = harness.mode.registerFooterField({
				id: "identity.integration",
				row: "identity",
				order: 45,
				accent: "metadata",
				project: () => "integration:on",
			});
			if (!registered.ok) throw new Error("registration failed");
			await settleFrames();

			expect(harness.terminal.writes.length).toBeGreaterThan(writesBefore);
			const refs = (harness.mode as unknown as {
				refs: { footer: { present(width: number): PresentationBlock[] } };
			}).refs;
			expect(refs.footer.present(100).flatMap(statusLineText)).toContain("integration:on");

			expect(registered.unregister()).toBe(true);
			await settleFrames();
			expect(refs.footer.present(100).flatMap(statusLineText)).not.toContain("integration:on");
		} finally {
			await harness.dispose();
		}
	});
});

function statusLineText(block: PresentationBlock): readonly string[] {
	return block.kind === "status-line" ? block.segments.map((segment) => segment.text) : [];
}
