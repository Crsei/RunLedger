import { requireNode, TextRenderable } from "./fixtures/opentui-nodes.ts";
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
			const firstHistory = requireNode(setup.renderer.root, "runledger-block-history", TextRenderable);
			const firstHistoryText = firstHistory?.plainText;
			const firstActive = requireNode(setup.renderer.root, "runledger-block-active", TextRenderable);

			runtime.update(frame("draft grew"));
			await setup.renderOnce();
			expect(runtime.getLastDirtyPartIds()).toEqual(["assistant:active/text"]);
			const secondHistory = requireNode(setup.renderer.root, "runledger-block-history", TextRenderable);
			const secondActive = requireNode(setup.renderer.root, "runledger-block-active", TextRenderable);

			expect(secondHistory?.num).toBe(firstHistory?.num);
			expect(secondHistory?.plainText).toBe(firstHistoryText);
			expect(secondActive?.num).toBe(firstActive?.num);
			expect(secondActive?.plainText).toContain("draft grew");
		} finally {
			runtime.destroy();
		}
	});
});
