import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { createOpenTuiComponentRuntimeFromRenderer } from "../../src/tui/opentui/component-runtime.ts";
import { projectComposerFrame } from "../../src/tui/composer/frame.ts";
import { BUILTIN_COMPOSER_SHAPE_IDS, getComposerStyle } from "../../src/tui/composer/registry.ts";

describe("OpenTUI composer shape P0 RED contract", () => {
	test("exposes shape mutation without replacing the native editor", async () => {
		const setup = await createTestRenderer({ width: 80, height: 16 });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {},
			onResize: () => {},
		});

		try {
			runtime.update({
				body: [],
				editorText: "draft",
				editorCursorOffset: 3,
				footer: [],
			});
			await setup.renderOnce();
			const editorBefore = setup.renderer.root.findDescendantById("runledger-editor")?.num;
			const shapeRuntime = runtime as unknown as { readonly setComposerShape?: unknown };

		expect(typeof shapeRuntime.setComposerShape).toBe("function");
			expect(editorBefore).toBeDefined();
		} finally {
			runtime.destroy();
		}
	});

	test("switches chrome around the same textarea identity and preserves draft/cursor", async () => {
		const setup = await createTestRenderer({ width: 40, height: 16 });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {},
			onResize: () => {},
		});
		const box = projectComposerFrame(getComposerStyle("box"), {
			terminalWidth: 40,
			input: { text: "draft text", placeholder: "Message", cursorOffset: 5 },
			status: { identity: "Working", usage: "usage 1k" },
			scrollbar: { visible: false },
		});
		const pi = projectComposerFrame(getComposerStyle("pi"), {
			terminalWidth: 40,
			input: { text: "draft text", placeholder: "Message", cursorOffset: 5 },
			status: { identity: "Working", usage: "usage 1k" },
			scrollbar: { visible: false },
		});

		try {
			runtime.update({
				body: [],
				editorText: "draft text",
				editorCursorOffset: 5,
				footer: [],
			});
			await setup.renderOnce();
			const editorBefore = setup.renderer.root.findDescendantById("runledger-editor");
			expect(editorBefore).toBeDefined();

			runtime.setComposerShape(box);
			await setup.renderOnce();
			const topBefore = setup.renderer.root.findDescendantById("runledger-composer-top");
			expect(topBefore).toBeDefined();
			expect(topBefore?.plainText).toContain("Working");

			runtime.setComposerShape(pi);
			await setup.renderOnce();
			const editorAfter = setup.renderer.root.findDescendantById("runledger-editor");
			expect(editorAfter?.num).toBe(editorBefore?.num);
			expect(editorAfter?.plainText).toBe("draft text");
			expect(editorAfter?.cursorOffset).toBe(5);
			expect(setup.renderer.root.findDescendantById("runledger-composer-top")?.plainText).toContain("─");
		} finally {
			runtime.destroy();
		}
	});

	test("projects the pure input rectangle and scrollbar cell into native geometry", async () => {
		const setup = await createTestRenderer({ width: 32, height: 16 });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {},
			onResize: () => {},
		});
		const frame = projectComposerFrame(getComposerStyle("box"), {
			terminalWidth: 32,
			input: { text: "draft", placeholder: "Message", cursorOffset: 2, maxLines: 4 },
			status: { identity: "Working", usage: "usage 1k" },
			scrollbar: { visible: true, position: 1 },
		});

		try {
			runtime.update({
				body: [],
				editorText: "draft",
				editorCursorOffset: 2,
				composerFrame: frame,
				footer: [],
			});
			await setup.renderOnce();
			const host = setup.renderer.root.findDescendantById("runledger-composer-host");
			const editor = setup.renderer.root.findDescendantById("runledger-editor");
			expect(editor).toBeDefined();
			expect(editor?.screenX).toBe((host?.screenX ?? 0) + frame.inputRect.x);
			expect(editor?.width).toBe(frame.inputRect.width);
			expect(editor?.height).toBe(frame.inputRect.height);
			expect(editor?.screenY).toBe((host?.screenY ?? 0) + frame.inputRect.y);
			const lines = setup.captureCharFrame().split("\n");
			const scrollbarY = (host?.screenY ?? 0) + (frame.scrollbarRect?.thumbY ?? 0);
			const scrollbarX = (host?.screenX ?? 0) + (frame.scrollbarRect?.x ?? 0);
			expect(lines[scrollbarY]?.[scrollbarX]).toBe("█");
		} finally {
			runtime.destroy();
		}
	});

	test("keeps focus, selection, cursor, and textarea identity across a resized shape frame", async () => {
		const setup = await createTestRenderer({ width: 40, height: 18 });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {},
			onResize: () => {},
		});
		const makeFrame = (terminalWidth: number) => projectComposerFrame(getComposerStyle("rail"), {
			terminalWidth,
			input: { text: "draft 中文", placeholder: "Message", cursorOffset: 3, maxLines: 5 },
			status: { identity: "", usage: "" },
			scrollbar: { visible: false },
		});

		try {
			runtime.update({
				body: [],
				editorText: "draft 中文",
				editorCursorOffset: 3,
				composerFrame: makeFrame(40),
				footer: [],
			});
			await setup.renderOnce();
			const editor = setup.renderer.root.findDescendantById("runledger-editor");
			expect(editor).toBeDefined();
			if (!editor) return;
			editor.setSelection(1, 5);
			expect(setup.renderer.currentFocusedRenderable?.id).toBe("runledger-editor");
			const identity = editor.num;

			setup.resize(20, 18);
			runtime.update({
				body: [],
				editorText: "draft 中文",
				editorCursorOffset: 3,
				composerFrame: makeFrame(20),
				footer: [],
			});
			await setup.renderOnce();
			const resized = setup.renderer.root.findDescendantById("runledger-editor");
			expect(resized?.num).toBe(identity);
			expect(resized?.plainText).toBe("draft 中文");
			expect(resized?.cursorOffset).toBe(3);
			expect(resized?.getSelection()).toEqual({ start: 1, end: 5 });
			expect(setup.renderer.currentFocusedRenderable?.id).toBe("runledger-editor");
		} finally {
			runtime.destroy();
		}
	});

	test("projects all builtin chrome attachments through the one native composer host", async () => {
		const setup = await createTestRenderer({ width: 48, height: 20 });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {},
			onResize: () => {},
		});

		try {
			for (const shape of BUILTIN_COMPOSER_SHAPE_IDS) {
				const frame = projectComposerFrame(getComposerStyle(shape), {
					terminalWidth: 48,
					input: { text: "draft", placeholder: "Message", cursorOffset: 2, maxLines: 3 },
					status: { identity: "Working", usage: "usage 1k" },
					scrollbar: { visible: true, position: 0.5 },
				});
				runtime.update({
					body: [],
					editorText: "draft",
					editorCursorOffset: 2,
					composerFrame: frame,
					footer: [],
				});
				await setup.renderOnce();

				const host = setup.renderer.root.findDescendantById("runledger-composer-host");
				const editor = setup.renderer.root.findDescendantById("runledger-editor");
				expect(editor?.num).toBeDefined();
				expect(editor?.screenX).toBe((host?.screenX ?? 0) + frame.inputRect.x);
				expect(editor?.screenY).toBe((host?.screenY ?? 0) + frame.inputRect.y);
				expect(editor?.plainText).toBe("draft");
				expect(setup.renderer.root.findDescendantById("runledger-composer-top")?.plainText)
					.toBe(frame.topRows[0]?.text ?? "");
				expect(setup.renderer.root.findDescendantById("runledger-composer-bottom")?.plainText)
					.toBe(frame.bottomRows[0]?.text ?? "");
				expect(setup.renderer.root.findDescendantById("runledger-composer-bottom-bar")?.plainText)
					.toBe(frame.bottomBarRows[0]?.text ?? "");
			}
		} finally {
			runtime.destroy();
		}
	});

	test("uses the pure frame's cell wrapping for long Unicode drafts", async () => {
		const setup = await createTestRenderer({ width: 40, height: 40 });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {},
			onResize: () => {},
		});
		const text = "这是很长的中文文本 👋 ".repeat(16);
		const frame = projectComposerFrame(getComposerStyle("box"), {
			terminalWidth: 40,
			input: { text, placeholder: "Message", cursorOffset: text.length, maxLines: 100 },
			status: { identity: "Working", usage: "usage" },
			scrollbar: { visible: true, position: 1 },
		});

		try {
			runtime.update({ body: [], editorText: text, editorCursorOffset: text.length, composerFrame: frame, footer: [] });
			await setup.renderOnce();
			const editor = setup.renderer.root.findDescendantById("runledger-editor");
			expect(editor?.wrapMode).toBe("char");
			expect(editor?.height).toBe(frame.inputRect.height);
		} finally {
			runtime.destroy();
		}
	});

	test("restores the baseline editor adapter when the composer frame is removed", async () => {
		const setup = await createTestRenderer({ width: 40, height: 20 });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {},
			onResize: () => {},
		});
		const frame = projectComposerFrame(getComposerStyle("box"), {
			terminalWidth: 40,
			input: { text: "draft", placeholder: "Message", cursorOffset: 5 },
			status: { identity: "Working", usage: "" },
			scrollbar: { visible: false },
		});

		try {
			runtime.update({ body: [], editorText: "draft", editorCursorOffset: 5, composerFrame: frame, footer: [] });
			await setup.renderOnce();
			expect(setup.renderer.root.findDescendantById("runledger-editor")?.wrapMode).toBe("char");

			runtime.update({ body: [], editorText: "draft", editorCursorOffset: 5, footer: [] });
			await setup.renderOnce();
			expect(setup.renderer.root.findDescendantById("runledger-editor")?.wrapMode).toBe("word");
		} finally {
			runtime.destroy();
		}
	});

	test("does not steal a capturing overlay focus when the composer shape changes", async () => {
		const setup = await createTestRenderer({ width: 48, height: 20 });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {},
			onResize: () => {},
		});
		const frame = (shape: string) => projectComposerFrame(getComposerStyle(shape), {
			terminalWidth: 48,
			input: { text: "draft", placeholder: "Message", cursorOffset: 2 },
			status: { identity: "Working", usage: "" },
			scrollbar: { visible: false },
		});
		const overlay = {
			kind: "select" as const,
			id: "shape-selector",
			title: "Composer Shape",
			options: [{ label: "Box", value: "box" }, { label: "Rail", value: "rail" }],
			selectedIndex: 0,
		};

		try {
			runtime.update({
				body: [],
				editorText: "draft",
				composerFrame: frame("box"),
				footer: [],
				overlay: [overlay],
			});
			await setup.renderOnce();
			const focusedBefore = setup.renderer.currentFocusedRenderable?.id;
			expect(focusedBefore).toContain("select-shape-selector");

			runtime.setComposerShape(frame("rail"));
			runtime.update({
				body: [],
				editorText: "draft",
				composerFrame: frame("rail"),
				footer: [],
				overlay: [overlay],
			});
			await setup.renderOnce();
			expect(setup.renderer.currentFocusedRenderable?.id).toBe(focusedBefore);
		} finally {
			runtime.destroy();
		}
	});
});
