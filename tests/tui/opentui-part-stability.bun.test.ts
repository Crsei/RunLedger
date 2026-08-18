import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createOpenTuiComponentRuntimeFromRenderer } from "../../src/tui/opentui/component-runtime.ts";

describe("OpenTUI streaming part stability", () => {
	test("keeps the finalized sibling renderable and content stable across active deltas", async () => {
		const setup = await createTestRenderer({ width: 60, height: 12 });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {},
			onResize: () => {},
		});
		const history = {
			id: "history",
			entryId: "assistant:history",
			partId: "assistant:history/text",
			contentGeneration: 2,
			finalized: true,
			kind: "text" as const,
			content: "settled history",
		};
		const frame = (activeContent: string) => ({
			body: [history, {
				id: "active",
				entryId: "assistant:active",
				partId: "assistant:active/text",
				contentGeneration: 3,
				finalized: false,
				kind: "text" as const,
				content: activeContent,
			}],
			editorText: "",
			footer: [],
		});

		try {
			runtime.update(frame("draft"));
			await setup.renderOnce();
			expect(runtime.getLastDirtyPartIds()).toEqual(["assistant:history/text", "assistant:active/text"]);
			const firstHistory = setup.renderer.root.findDescendantById("runledger-block-history");
			const firstHistoryText = firstHistory?.plainText;
			const firstActive = setup.renderer.root.findDescendantById("runledger-block-active");

			runtime.update(frame("draft grew"));
			await setup.renderOnce();
			expect(runtime.getLastDirtyPartIds()).toEqual(["assistant:active/text"]);
			const secondHistory = setup.renderer.root.findDescendantById("runledger-block-history");
			const secondActive = setup.renderer.root.findDescendantById("runledger-block-active");

			expect(secondHistory?.num).toBe(firstHistory?.num);
			expect(secondHistory?.plainText).toBe(firstHistoryText);
			expect(secondActive?.num).toBe(firstActive?.num);
			expect(secondActive?.plainText).toContain("draft grew");
		} finally {
			runtime.destroy();
		}
	});
});
