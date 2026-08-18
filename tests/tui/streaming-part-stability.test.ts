import { describe, expect, test } from "vitest";
import { ChatContainer } from "../../src/tui/components/chat-container.ts";
import {
	BodySignatureTracker,
	type BodySignatureInput,
} from "../../src/tui/opentui/body-signature.ts";
import {
	comparePartGeneration,
	settled,
	type PresentationPart,
} from "../../src/tui/timeline/part-stability.ts";

function part(overrides: Partial<PresentationPart> = {}): PresentationPart {
	return {
		entryId: "assistant:1",
		partId: "assistant:1/text",
		contentGeneration: 4,
		finalized: true,
		...overrides,
	};
}

function signatureInput(overrides: Partial<BodySignatureInput> = {}): BodySignatureInput {
	return {
		key: "assistant:1/text",
		kind: "markdown",
		streaming: false,
		contentGeneration: 4,
		finalized: true,
		contentKey: "history",
		...overrides,
	};
}

describe("streaming part stability", () => {
	test("settles only finalized parts at the same content generation", () => {
		const first = part();
		expect(settled(first)).toBe(true);
		expect(settled(part({ finalized: false }))).toBe(false);
		expect(settled(part({ contentGeneration: 5 }), first)).toBe(false);
		expect(settled(first, part({ finalized: false }))).toBe(false);
	});

	test("treats generation rewind as a new lineage", () => {
		expect(comparePartGeneration(4, 4)).toBe("same");
		expect(comparePartGeneration(4, 5)).toBe("advanced");
		expect(comparePartGeneration(5, 4)).toBe("rewound");
	});

	test("marks only the active part dirty when a settled sibling remains unchanged", () => {
		const tracker = new BodySignatureTracker();
		const first = tracker.update([
			signatureInput(),
			signatureInput({ key: "assistant:1/active", contentGeneration: 7, finalized: false, streaming: true, contentKey: "draft" }),
		]);
		const second = tracker.update([
			signatureInput(),
			signatureInput({ key: "assistant:1/active", contentGeneration: 7, finalized: false, streaming: true, contentKey: "draft grew" }),
		]);

		expect(first.changedKeys).toEqual(["assistant:1/text", "assistant:1/active"]);
		expect(second.changedKeys).toEqual(["assistant:1/active"]);
	});

	test("reuses a finalized timeline part while only the active part changes", () => {
		const chat = new ChatContainer();
		const history = {
			id: "history",
			entryId: "assistant:history",
			partId: "assistant:history/text",
			contentGeneration: 2,
			finalized: true,
			kind: "markdown" as const,
			content: "history",
			streaming: false,
		};
		const active = (content: string) => ({
			id: "active",
			entryId: "assistant:active",
			partId: "assistant:active/text",
			contentGeneration: 3,
			finalized: false,
			kind: "markdown" as const,
			content,
			streaming: true,
		});

		chat.setTimelineBlocks([history, active("draft")], 1);
		const first = chat.present(80);
		chat.setTimelineBlocks([history, active("draft grew")], 2);
		const second = chat.present(80);

		expect(second[0]).toBe(first[0]);
		expect(second[1]).not.toBe(first[1]);
	});

	test("invalidates old settled projection data when a part generation rewinds", () => {
		const chat = new ChatContainer();
		const block = (content: string, contentGeneration: number) => ({
			id: "history",
			entryId: "assistant:history",
			partId: "assistant:history/text",
			contentGeneration,
			finalized: true,
			kind: "text" as const,
			content,
		});

		chat.setTimelineBlocks([block("old lineage", 5)], 5);
		chat.present(80);
		chat.setTimelineBlocks([block("new lineage", 4)], 4);
		const current = chat.present(80);

		expect(current[0]?.content).toBe("new lineage");
		expect(chat.getPresentationCacheSnapshot()).toMatchObject({ entries: 1, misses: 2 });
	});

	test("includes theme generation in settled cache identity", () => {
		const chat = new ChatContainer();
		const block = {
			id: "history",
			entryId: "assistant:history",
			partId: "assistant:history/text",
			contentGeneration: 1,
			finalized: true,
			kind: "text" as const,
			content: "history",
		};

		chat.setTimelineBlocks([block], 1);
		const first = chat.present(80)[0];
		chat.setThemeGeneration(1);
		chat.setTimelineBlocks([block], 1);
		const second = chat.present(80)[0];

		expect(second).not.toBe(first);
		expect(chat.getPresentationCacheSnapshot()).toMatchObject({ entries: 2, misses: 2 });
	});
});
