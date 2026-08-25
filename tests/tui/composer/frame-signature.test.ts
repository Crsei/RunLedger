import { describe, expect, it } from "vitest";
import { getComposerStyle } from "../../../src/tui/composer/registry.ts";
import {
	composerFrameSignature,
	projectComposerFrame,
} from "../../../src/tui/composer/frame.ts";

describe("composer frame signature P0 RED contract", () => {
	it("provides one pure frame signature for preview and production", () => {
		const frame = projectComposerFrame(getComposerStyle("box"), {
			terminalWidth: 80,
			input: {
				text: "hello",
				placeholder: "Message RunLedger…",
				cursorOffset: 5,
			},
			status: {
				identity: "RunLedger",
				usage: "",
			},
			scrollbar: { visible: false },
		});

		expect(composerFrameSignature(frame)).toContain("shape=box");
	});

	it("includes logical/chrome row content so distinct frames cannot share a signature", () => {
		const input = {
			terminalWidth: 40,
			input: { text: "hello", placeholder: "Message", cursorOffset: 5 },
			status: { identity: "RunLedger", usage: "usage 1k" },
			scrollbar: { visible: false },
		} as const;
		const standard = projectComposerFrame(getComposerStyle("box"), input);
		const alternateGlyphs = projectComposerFrame(getComposerStyle("box"), {
			...input,
			glyphs: { horizontal: "=", vertical: "!" },
		});

		expect(composerFrameSignature(alternateGlyphs)).not.toBe(composerFrameSignature(standard));
	});

	it("maps a middle cursor and scrollbar to bounded display-cell rectangles", () => {
		const frame = projectComposerFrame(getComposerStyle("pi"), {
			terminalWidth: 5,
			input: {
				text: "abcdefghi",
				placeholder: "Message",
				cursorOffset: 4,
			},
			status: { identity: "Working", usage: "usage 1k" },
			scrollbar: { visible: true, position: 1 },
		});

		// Reference `pi` reserves one padding cell on each side and one more for
		// the visible scrollbar, leaving a two-cell input width at terminal width 5.
		expect(frame.cursorRect).toEqual({ x: 1, y: 3, width: 1, height: 1 });
		expect(frame.scrollbarRect).toMatchObject({ x: 4, width: 1, thumbHeight: 2 });
		expect(frame.scrollbarRect?.thumbY).toBeGreaterThanOrEqual(frame.scrollbarRect?.y ?? 0);
	});

	it("reserves a scrollbar cell when a borderless style has no right chrome", () => {
		const frame = projectComposerFrame(getComposerStyle("pi"), {
			terminalWidth: 5,
			input: {
				text: "abcdefghi",
				placeholder: "Message",
				cursorOffset: 4,
			},
			status: { identity: "", usage: "" },
			scrollbar: { visible: true, position: 0 },
		});

		expect(frame.scrollbarRect).toBeDefined();
		expect(frame.inputRect.x + frame.inputRect.width).toBeLessThanOrEqual(frame.scrollbarRect?.x ?? 0);
		expect(frame.cursorRect.x).toBeLessThan(frame.scrollbarRect?.x ?? 0);
	});
});
