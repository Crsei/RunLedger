import { describe, expect, spyOn, test } from "bun:test";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import { TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { createOpenTuiComponentRuntimeFromRenderer } from "../../src/tui/opentui/component-runtime.ts";
import { projectComposerFrame } from "../../src/tui/composer/frame.ts";
import { BUILTIN_COMPOSER_SHAPE_IDS, getComposerStyle } from "../../src/tui/composer/registry.ts";
import { editorHeight } from "../../src/tui/editor-height.ts";

function composerFrame(
	shape: string,
	width: number,
	text: string,
	cursorOffset = text.length,
	maxLines = 8,
	scrollbarVisible = true,
) {
	return projectComposerFrame(getComposerStyle(shape), {
		terminalWidth: width,
		input: {
			text,
			placeholder: "Message RunLedger…",
			cursorOffset,
			maxLines,
		},
		status: { identity: "Working · RunLedger", usage: "usage 1.2k · limit 10%" },
		scrollbar: { visible: scrollbarVisible, position: 0.5 },
	});
}

describe("OpenTUI composer shape P5 native matrix", () => {
	test("keeps every builtin within the native frame at every acceptance width", async () => {
		const setup = await createTestRenderer({ width: 20, height: 24 });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {},
			onResize: () => {},
		});
		const text = "中文 emoji 👋 combining e\u0301 and a hard\nline";

		try {
			for (const width of [20, 30, 40, 60, 80, 120, 143]) {
				setup.resize(width, 24);
				for (const shape of BUILTIN_COMPOSER_SHAPE_IDS) {
					const frame = composerFrame(shape, width, text, 7);
					runtime.update({ body: [], editorText: text, editorCursorOffset: 7, composerFrame: frame, footer: ["idle"] });
					await setup.renderOnce();
					const host = setup.renderer.root.findDescendantById("runledger-composer-host");
					const editor = setup.renderer.root.findDescendantById("runledger-editor");
					expect(editor).toBeDefined();
					expect(editor?.screenX).toBe((host?.screenX ?? 0) + frame.inputRect.x);
					expect(editor?.screenY).toBe((host?.screenY ?? 0) + frame.inputRect.y);
					expect(editor?.width).toBe(frame.inputRect.width);
					expect(editor?.height).toBe(frame.inputRect.height);
					expect((editor?.screenX ?? -1) + (editor?.width ?? 0)).toBeLessThanOrEqual(width);
					expect((editor?.screenY ?? -1) + (editor?.height ?? 0)).toBeLessThanOrEqual((host?.screenY ?? 0) + (host?.height ?? 0));
					for (const line of setup.captureCharFrame().split("\n")) {
						expect(stringWidth(stripAnsi(line))).toBeLessThanOrEqual(width);
					}
				}
			}
		} finally {
			runtime.destroy();
		}
	});

	test("captures the exact pure chrome rows for every builtin shape", async () => {
		const setup = await createTestRenderer({ width: 40, height: 16 });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {},
			onResize: () => {},
		});

		try {
			for (const shape of BUILTIN_COMPOSER_SHAPE_IDS) {
				const frame = composerFrame(shape, 40, "draft", 5, 8, false);
				runtime.update({
					body: [],
					editorText: "draft",
					editorCursorOffset: 5,
					composerFrame: frame,
					footer: [],
				});
				await setup.renderOnce();

				const host = setup.renderer.root.findDescendantById("runledger-composer-host");
				expect(host).toBeDefined();
				if (host === undefined) continue;
				const captured = setup.captureCharFrame().split("\n").slice(host.screenY, host.screenY + frame.totalHeight);
				expect(captured, shape).toEqual(frame.rows.map((row) => row.text));
			}
		} finally {
			runtime.destroy();
		}
	});

	test("keeps the same editor through native input, paste, resize, and shape changes", async () => {
		const setup = await createTestRenderer({ width: 40, height: 18 });
		const inputs: string[] = [];
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: (value) => inputs.push(value),
			onResize: () => {},
		});
		const frame = (shape: string, width: number, text: string, cursorOffset = text.length) => composerFrame(shape, width, text, cursorOffset);

		try {
			const initial = frame("box", 40, "draft", 2);
			runtime.update({ body: [], editorText: "draft", editorCursorOffset: 2, composerFrame: initial, footer: [] });
			await setup.renderOnce();
			const editor = setup.renderer.root.findDescendantById("runledger-editor");
			expect(editor).toBeDefined();
			if (editor === undefined) return;
			const editorId = editor.num;
			setup.mockInput.pressKey("x");
			await setup.mockInput.pasteBracketedText("粘贴👋");
			await setup.renderOnce();
			expect(inputs).toContain("x");
			expect(inputs).toContain("粘贴👋");

			setup.resize(20, 18);
			const next = frame("rail", 20, "draft", 2);
			runtime.update({ body: [], editorText: "draft", editorCursorOffset: 2, composerFrame: next, footer: [] });
			await setup.renderOnce();
			expect(setup.renderer.root.findDescendantById("runledger-editor")?.num).toBe(editorId);
			expect(setup.renderer.root.findDescendantById("runledger-editor")?.plainText).toBe("draft");
			expect(setup.renderer.root.findDescendantById("runledger-editor")?.cursorOffset).toBe(2);
			expect(setup.renderer.currentFocusedRenderable?.id).toBe("runledger-editor");
		} finally {
			runtime.destroy();
		}
	});

	test("routes composer-area wheel events to transcript without changing the draft", async () => {
		const setup = await createTestRenderer({ width: 48, height: 16 });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {},
			onResize: () => {},
		});
		try {
			runtime.update({
				body: Array.from({ length: 80 }, (_, index) => ({ id: `history-${index}`, kind: "text" as const, content: `history ${index}` })),
				editorText: "draft",
				editorCursorOffset: 2,
				composerFrame: composerFrame("claude", 48, "draft", 2),
				footer: ["idle"],
			});
			await setup.renderOnce();
			const transcript = setup.renderer.root.findDescendantById("runledger-transcript");
			const editor = setup.renderer.root.findDescendantById("runledger-editor");
			expect(transcript).toBeDefined();
			expect(editor).toBeDefined();
			if (transcript === undefined || editor === undefined) return;
			const before = transcript.scrollTop;
			await setup.mockMouse.scroll(editor.screenX, editor.screenY, "up");
			await setup.renderOnce();
			expect(transcript.scrollTop).toBeLessThan(before);
			expect(editor.plainText).toBe("draft");
		} finally {
			runtime.destroy();
		}
	});

	test("routes wheel events from every rendered composer chrome surface", async () => {
		const setup = await createTestRenderer({ width: 48, height: 16 });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {},
			onResize: () => {},
		});
		try {
			runtime.update({
				body: Array.from({ length: 80 }, (_, index) => ({ id: `chrome-history-${index}`, kind: "text" as const, content: `history ${index}` })),
				editorText: "draft",
				editorCursorOffset: 2,
				composerFrame: composerFrame("box", 48, "draft", 2),
				footer: ["idle"],
			});
			await setup.renderOnce();
			const transcript = setup.renderer.root.findDescendantById("runledger-transcript");
			expect(transcript).toBeDefined();
		if (transcript === undefined) return;
		const targets = [
			setup.renderer.root.findDescendantById("runledger-composer-top"),
			setup.renderer.root.findDescendantById("runledger-composer-gap"),
			setup.renderer.root.findDescendantById("runledger-composer-bottom-bar"),
			setup.renderer.root.findDescendantById("runledger-composer-right-rail"),
		];
		for (const target of targets) {
			expect(target).toBeDefined();
			if (target === undefined || target.height <= 0 || target.width <= 0) continue;
			const initial = transcript.scrollTop;
			transcript.scrollTop = initial;
			await setup.renderOnce();
			await setup.mockMouse.scroll(target.screenX, target.screenY, "up");
			await setup.renderOnce();
			expect(transcript.scrollTop).toBeLessThan(initial);
		}
		const editor = setup.renderer.root.findDescendantById("runledger-editor");
		expect(editor?.plainText).toBe("draft");
		} finally {
			runtime.destroy();
		}
	});

	test("repaints the composer host when the terminal theme changes", async () => {
		const setup = await createTestRenderer({ width: 48, height: 16 });
		let runtime: ReturnType<typeof createOpenTuiComponentRuntimeFromRenderer> | undefined;
		const frame = composerFrame("box", 48, "draft", 2);
		const updateAppearance = (backgroundColor: string): void => {
			runtime?.update({
				body: [],
				editorText: "draft",
				editorCursorOffset: 2,
				composerFrame: frame,
				editorAppearance: { backgroundColor, promptColor: "#7dcfff", placeholderColor: "#666666" },
				footer: [],
			});
		};
		runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {},
			onResize: () => {},
			onThemeMode: (mode) => updateAppearance(mode === "light" ? "#f4f4f4" : "#282a30"),
		});
		try {
			updateAppearance("#282a30");
			await setup.renderOnce();
			const host = setup.renderer.root.findDescendantById("runledger-composer-host");
			expect(host?.backgroundColor.toInts().slice(0, 3)).toEqual([0x28, 0x2a, 0x30]);
			setup.renderer.emit("theme_mode", "light");
			await setup.renderOnce();
			expect(host?.backgroundColor.toInts().slice(0, 3)).toEqual([0xf4, 0xf4, 0xf4]);
			expect(setup.renderer.root.findDescendantById("runledger-editor")?.plainText).toBe("draft");
		} finally {
			runtime.destroy();
		}
	});

	test("keeps the composer draft while native conversation selection uses OSC52", async () => {
		const setup = await createTestRenderer({ width: 48, height: 16 });
		const copy = spyOn(setup.renderer, "copyToClipboardOSC52").mockReturnValue(true);
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {},
			onResize: () => {},
		});
		try {
			runtime.update({
				body: [
					{ id: "selection-user", kind: "text", content: "user: copy this composer-adjacent text" },
					{ id: "selection-assistant", kind: "text", content: "assistant: preserve the draft" },
				],
				editorText: "draft",
				editorCursorOffset: 2,
				composerFrame: composerFrame("rail", 48, "draft", 2),
				footer: [],
			});
			await setup.renderOnce();
			await setup.mockMouse.drag(0, 0, 24, 1);
			const selectedText = setup.renderer.getSelection()?.getSelectedText();
			expect(selectedText).toContain("user: copy this");
			expect(copy).toHaveBeenCalledWith(selectedText);
			expect(setup.renderer.root.findDescendantById("runledger-editor")?.plainText).toBe("draft");
		} finally {
			copy.mockRestore();
			runtime.destroy();
		}
	});

	test("keeps the Textarea and focus through streaming status updates, shape changes, and overlay recovery", async () => {
		const setup = await createTestRenderer({ width: 60, height: 18 });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {},
			onResize: () => {},
		});
		const status = (state: string) => ({
			kind: "status-line" as const,
			segments: [
				{ accent: "state" as const, text: state },
				{ accent: "model" as const, text: "deepseek" },
			],
		});

		try {
			runtime.update({
				body: [{ id: "streaming", kind: "markdown", content: "first token", streaming: true }],
				editorText: "draft",
				editorCursorOffset: 2,
				composerFrame: composerFrame("box", 60, "draft", 2),
				footer: [status("working")],
			});
			await setup.renderOnce();
			const editor = setup.renderer.root.findDescendantById("runledger-editor");
			expect(editor).toBeDefined();
			if (editor === undefined) return;
			const editorId = editor.num;
			expect(setup.renderer.currentFocusedRenderable?.id).toBe("runledger-editor");

			runtime.update({
				body: [{ id: "streaming", kind: "markdown", content: "first token second token", streaming: true }],
				editorText: "draft",
				editorCursorOffset: 2,
				composerFrame: composerFrame("rail", 60, "draft", 2),
				footer: [status("waiting")],
			});
			await setup.renderOnce();
			expect(setup.renderer.root.findDescendantById("runledger-editor")?.num).toBe(editorId);
			expect(setup.renderer.root.findDescendantById("runledger-editor")?.plainText).toBe("draft");
			expect(setup.renderer.root.findDescendantById("runledger-editor")?.cursorOffset).toBe(2);
			expect(setup.renderer.currentFocusedRenderable?.id).toBe("runledger-editor");

			runtime.update({
				body: [{ id: "streaming", kind: "markdown", content: "first token second token", streaming: true }],
				editorText: "draft",
				editorCursorOffset: 2,
				composerFrame: composerFrame("rail", 60, "draft", 2),
				footer: [status("waiting")],
				overlay: [{ id: "shape-overlay", kind: "select", title: "Shape", options: [{ value: "rail", label: "Rail" }], selectedIndex: 0 }],
				overlayAnchor: "bottom-left",
			});
			await setup.renderOnce();
			expect(setup.renderer.currentFocusedRenderable?.id).toContain("runledger-overlay-select-shape-overlay");

			runtime.update({
				body: [{ id: "streaming", kind: "markdown", content: "first token second token", streaming: true }],
				editorText: "draft",
				editorCursorOffset: 2,
				composerFrame: composerFrame("rail", 60, "draft", 2),
				footer: [status("done")],
			});
			await setup.renderOnce();
			expect(setup.renderer.root.findDescendantById("runledger-editor")?.num).toBe(editorId);
			expect(setup.renderer.currentFocusedRenderable?.id).toBe("runledger-editor");
		} finally {
			runtime.destroy();
		}
	});

	test("keeps a toggled composer scrollbar outside the textarea at narrow and wide widths", async () => {
		const setup = await createTestRenderer({ width: 40, height: 16 });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {},
			onResize: () => {},
		});
		const text = "scrollbar draft";
		const update = (visible: boolean, shape: string, width: number) => {
			const frame = composerFrame(shape, width, text, text.length, 8, visible);
			runtime.update({
				body: [],
				editorText: text,
				editorCursorOffset: text.length,
				composerFrame: frame,
				footer: [],
			});
			return frame;
		};

		try {
			const hidden = update(false, "borderless", 40);
			await setup.renderOnce();
			const editor = setup.renderer.root.findDescendantById("runledger-editor");
			const editorId = editor?.num;
			expect(hidden.scrollbarRect).toBeUndefined();
			expect(setup.renderer.root.findDescendantById("runledger-composer-right-rail")?.plainText).toBe("");

			const visible = update(true, "borderless", 40);
			await setup.renderOnce();
			expect(visible.scrollbarRect).toBeDefined();
			if (visible.scrollbarRect === undefined || editor === undefined) return;
			expect(visible.scrollbarRect.x + visible.scrollbarRect.width).toBeLessThanOrEqual(40);
			expect(visible.scrollbarRect.x).toBeGreaterThanOrEqual(visible.inputRect.x + visible.inputRect.width);
			expect(editor.screenX + editor.width).toBeLessThanOrEqual(visible.scrollbarRect.x);
			expect(setup.renderer.root.findDescendantById("runledger-composer-right-rail")?.width).toBe(1);
			expect(setup.renderer.root.findDescendantById("runledger-editor")?.num).toBe(editorId);

			setup.resize(20, 16);
			const narrow = update(true, "borderless", 20);
			await setup.renderOnce();
			expect(narrow.scrollbarRect?.x).toBe(19);
			expect(setup.renderer.root.findDescendantById("runledger-editor")?.num).toBe(editorId);
		} finally {
			runtime.destroy();
		}
	});

	test("projects cursor row boundaries, keeps long drafts scrollable, forwards Enter, and restores overlay focus", async () => {
		const setup = await createTestRenderer({ width: 24, height: 8 });
		const inputs: string[] = [];
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: (value) => inputs.push(value),
			onResize: () => {},
		});
		const text = "ab\n中文👋cd\nend";
		const offsets = [0, 2, 3, 5, 10, text.length];

		try {
			for (const offset of offsets) {
				const frame = composerFrame("field", 24, text, offset);
				runtime.update({
					body: [],
					editorText: text,
					editorCursorOffset: offset,
					composerFrame: frame,
					footer: [],
				});
				await setup.renderOnce();
				const editor = setup.renderer.root.findDescendantById("runledger-editor");
				const cursor = setup.renderer.getCursorState();
				expect(editor?.cursorOffset).toBe(offset);
				expect(cursor.visible).toBe(true);
				expect(cursor.y).toBe((editor?.screenY ?? 0) + (editor?.visualCursor.visualRow ?? 0) + 1);
				expect(cursor.x).toBeGreaterThanOrEqual((editor?.screenX ?? 0) + 1);
				expect(cursor.x).toBeLessThanOrEqual((editor?.screenX ?? 0) + (editor?.width ?? 1) + 1);
				expect(frame.cursorRect.y - frame.inputRect.y).toBeGreaterThanOrEqual(editor?.visualCursor.visualRow ?? 0);
			}

			const longText = Array.from({ length: 16 }, (_, index) => `line ${index}`).join("\n");
			const longFrame = composerFrame("rail", 24, longText, longText.length, 3);
			runtime.update({
				body: [],
				editorText: longText,
				editorCursorOffset: longText.length,
				editorHeight: 3,
				composerFrame: longFrame,
				footer: [],
			});
			await setup.renderOnce();
			const editor = setup.renderer.root.findDescendantById("runledger-editor");
			expect(editor?.scrollY).toBeGreaterThan(0);
			setup.mockInput.pressKey("\r");
			expect(inputs).toContain("enter");

			runtime.update({
				body: [],
				editorText: "draft",
				editorCursorOffset: 5,
				composerFrame: composerFrame("rail", 24, "draft", 5),
				footer: [],
				overlay: [{ id: "focus-check", kind: "select", title: "Focus", options: [{ value: "rail", label: "Rail" }], selectedIndex: 0 }],
			});
			await setup.renderOnce();
			expect(setup.renderer.currentFocusedRenderable?.id).toContain("runledger-overlay-select-focus-check");

			runtime.update({
				body: [],
				editorText: "draft",
				editorCursorOffset: 5,
				composerFrame: composerFrame("rail", 24, "draft", 5),
				footer: [],
			});
			await setup.renderOnce();
			expect(setup.renderer.currentFocusedRenderable?.id).toBe("runledger-editor");
		} finally {
			runtime.destroy();
		}
		expect(setup.renderer.isDestroyed).toBe(true);
	});

	test("clips production-sized composer chrome to the viewport before the footer", async () => {
		const setup = await createTestRenderer({ width: 24, height: 8 });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {},
			onResize: () => {},
		});
		const text = Array.from({ length: 16 }, (_, index) => `line ${index}`).join("\n");
		const productionHeight = editorHeight(text, 24);
		const frame = composerFrame("box", 24, text, text.length, productionHeight, false);

		try {
			runtime.update({
				body: [],
				editorText: text,
				editorCursorOffset: text.length,
				editorHeight: productionHeight,
				composerFrame: frame,
				footer: ["idle"],
			});
			await setup.renderOnce();
			const editor = setup.renderer.root.findDescendantById("runledger-editor");
			const host = setup.renderer.root.findDescendantById("runledger-composer-host");
			const left = setup.renderer.root.findDescendantById("runledger-composer-input-left");
			const underlay = setup.renderer.root.findDescendantById("runledger-composer-input-underlay");
			const right = setup.renderer.root.findDescendantById("runledger-composer-input-right");
			const footer = setup.renderer.root.findDescendantById("runledger-footer");

			expect(frame.inputRows.length).toBeGreaterThan(editor?.height ?? 0);
			expect(left?.height).toBe(editor?.height);
			expect(underlay?.height).toBe(editor?.height);
			expect(right?.height).toBe(editor?.height);
			expect((host?.screenY ?? 0) + (host?.height ?? 0)).toBeLessThanOrEqual(footer?.screenY ?? 0);
			expect(setup.captureCharFrame().split("\n")[footer?.screenY ?? -1]?.trim()).toBe("idle");
		} finally {
			runtime.destroy();
		}
	});

	test("reports composer scrollbar presentation from the native Textarea viewport", async () => {
		const setup = await createTestRenderer({ width: 24, height: 8 });
		const states: Array<{ readonly visible: boolean; readonly position: number }> = [];
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {},
			onResize: () => {},
			onComposerScrollChange: (state: { readonly visible: boolean; readonly position: number }) => states.push(state),
		});
		const text = Array.from({ length: 16 }, (_, index) => `line ${index}`).join("\n");
		const productionHeight = editorHeight(text, 24);
		const frame = composerFrame("borderless", 24, text, text.length, productionHeight, false);

		try {
			runtime.update({
				body: [],
				editorText: text,
				editorCursorOffset: text.length,
				editorHeight: productionHeight,
				composerFrame: frame,
				footer: ["idle"],
			});
			await setup.renderOnce();
			await setup.renderOnce();
			expect(states.at(-1)?.visible).toBe(true);
			expect(states.at(-1)?.position).toBeGreaterThan(0);
		} finally {
			runtime.destroy();
		}
	});

	test("projects structured composer runs to native foreground and background colors", async () => {
		const setup = await createTestRenderer({ width: 40, height: 12 });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {},
			onResize: () => {},
		});
		const frame = projectComposerFrame(getComposerStyle("box"), {
			terminalWidth: 40,
			input: { text: "draft", placeholder: "Message", cursorOffset: 5 },
			status: { identity: "Working", usage: "usage 1k" },
			scrollbar: { visible: false },
			theme: { borderColor: "#112233", accentColor: "#445566", surfaceColor: "#778899" },
		});

		try {
			runtime.update({ body: [], editorText: "draft", composerFrame: frame, footer: [] });
			await setup.renderOnce();
			const top = setup.renderer.root.findDescendantById("runledger-composer-top");
			expect(top).toBeInstanceOf(TextRenderable);
			if (!(top instanceof TextRenderable)) return;
			expect(top.chunks.some((chunk) => chunk.fg?.toInts().slice(0, 3).join(",") === "17,34,51")).toBe(true);
			expect(top.chunks.some((chunk) => chunk.fg?.toInts().slice(0, 3).join(",") === "68,85,102")).toBe(true);
			expect(top.chunks.every((chunk) => chunk.bg?.toInts().slice(0, 3).join(",") === "119,136,153")).toBe(true);
		} finally {
			runtime.destroy();
		}
	});
});
