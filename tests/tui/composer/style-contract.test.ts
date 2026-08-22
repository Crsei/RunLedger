import { describe, expect, it } from "vitest";
import { displayWidth } from "../../../src/tui/mermaid/display-width.ts";
import { BUILTIN_COMPOSER_SHAPE_IDS, getComposerStyle } from "../../../src/tui/composer/registry.ts";
import { composerFrameSignature, projectComposerFrame } from "../../../src/tui/composer/frame.ts";

const WIDTHS = [1, 2, 3, 20, 40, 80, 143];

function frameFor(shape: string, terminalWidth: number) {
	return projectComposerFrame(getComposerStyle(shape), {
		terminalWidth,
		input: {
			text: "你好 👋 composer-shape with a very long word and\nsecond line",
			placeholder: "Message RunLedger…",
			cursorOffset: 8,
			maxLines: 4,
		},
		status: {
			identity: "Working · RunLedger",
			usage: "usage 2.4k · limit 10%",
		},
		scrollbar: { visible: true, position: 0.5 },
	});
}

describe("composer style contract", () => {
	it("keeps seven builtin styles structurally distinct", () => {
		const signatures = BUILTIN_COMPOSER_SHAPE_IDS.map((id) => {
			const style = getComposerStyle(id);
			return [
				style.id,
				style.sideBorders,
				style.verticalChrome,
				style.statusAttachment,
				style.bottomBar,
				style.defaultPromptGutter,
			].join(":");
		});

		expect(new Set(signatures).size).toBe(BUILTIN_COMPOSER_SHAPE_IDS.length);
	});

	it("matches the feature-bearing reference chrome semantics for every builtin", () => {
		const expected = [
			["box", true, 2, "top-border", "none", 0, 0],
			["claude", false, 2, "top-rule-chip", "left", 0, 2],
			["pi", false, 2, "none", "full", 0, 0],
			["borderless", false, 0, "none", "full", 0, 2],
			["rule", false, 1, "top-rule-chip", "left", 1, 2],
			["field", true, 0, "none", "full", 1, 0],
			["rail", true, 0, "none", "full", 1, 0],
		] as const;

		for (const [id, sideBorders, verticalChrome, statusAttachment, bottomBar, bottomBarGap, promptGutter] of expected) {
			const style = getComposerStyle(id);
			expect({
				id: style.id,
				sideBorders: style.sideBorders,
				verticalChrome: style.verticalChrome,
				statusAttachment: style.statusAttachment,
				bottomBar: style.bottomBar,
				bottomBarGap: style.bottomBarGap,
				promptGutter: style.defaultPromptGutter,
			}).toEqual({ id, sideBorders, verticalChrome, statusAttachment, bottomBar, bottomBarGap, promptGutter });
		}
	});

	it("keeps each reference shape's top, bottom, gap, and standalone-bar rows distinct", () => {
		const expectedRows = {
			box: [1, 0, 0, 0],
			claude: [1, 1, 1, 0],
			pi: [1, 1, 1, 0],
			borderless: [0, 0, 1, 0],
			rule: [1, 0, 1, 1],
			field: [0, 0, 1, 1],
			rail: [0, 0, 1, 1],
		} as const;

		for (const id of BUILTIN_COMPOSER_SHAPE_IDS) {
			const frame = projectComposerFrame(getComposerStyle(id), {
				terminalWidth: 80,
				input: { text: "draft", placeholder: "Message", cursorOffset: 5 },
				status: { identity: "Working", usage: "usage 1k" },
				scrollbar: { visible: false },
			});
			expect([
				frame.topRows.length,
				frame.bottomRows.length,
				frame.bottomBarRows.length,
				frame.bottomBarGap,
			]).toEqual(expectedRows[id]);
		}
	});

	it("projects bounded frames for narrow, wide, Unicode, cursor, and scrollbar inputs", () => {
		for (const shape of BUILTIN_COMPOSER_SHAPE_IDS) {
			for (const width of WIDTHS) {
				const frame = frameFor(shape, width);
				expect(frame.styleId).toBe(shape);
				expect(frame.totalHeight).toBeGreaterThanOrEqual(1);
				expect(Number.isFinite(frame.inputRect.x)).toBe(true);
				expect(Number.isFinite(frame.inputRect.width)).toBe(true);
				expect(frame.inputRect.width).toBeGreaterThanOrEqual(0);
				expect(frame.cursorRect.x).toBeGreaterThanOrEqual(0);
				expect(frame.cursorRect.x).toBeLessThanOrEqual(width);
				for (const row of frame.rows) expect(displayWidth(row.text)).toBeLessThanOrEqual(width);
				expect(composerFrameSignature(frame)).toContain(`shape=${shape}`);
			}
		}
	});

	it("keeps preview and production on the same pure frame signature", () => {
		const production = frameFor("box", 80);
		const preview = frameFor("box", 80);

		expect(composerFrameSignature(preview)).toBe(composerFrameSignature(production));
	});

	it("preserves border, accent, and surface semantics as structured runs", () => {
		const colors = {
			borderColor: "#112233",
			accentColor: "#445566",
			surfaceColor: "#778899",
		};
		const box = projectComposerFrame(getComposerStyle("box"), {
			terminalWidth: 40,
			input: { text: "draft", placeholder: "Message", cursorOffset: 5 },
			status: { identity: "Working", usage: "usage 1k" },
			scrollbar: { visible: false },
			theme: colors,
		});
		const rail = projectComposerFrame(getComposerStyle("rail"), {
			terminalWidth: 40,
			input: { text: "draft", placeholder: "Message", cursorOffset: 5 },
			status: { identity: "Working", usage: "usage 1k" },
			scrollbar: { visible: true, position: 0.5 },
			theme: colors,
		});

		expect(box.topRows[0]?.runs).toEqual(expect.arrayContaining([
			expect.objectContaining({ role: "chrome", foregroundColor: colors.borderColor, backgroundColor: colors.surfaceColor }),
			expect.objectContaining({ role: "status", foregroundColor: colors.accentColor, backgroundColor: colors.surfaceColor }),
		]));
		expect(rail.inputRows[0]?.runs[0]).toEqual(expect.objectContaining({
			text: "▎",
			role: "chrome",
			foregroundColor: colors.accentColor,
			backgroundColor: colors.surfaceColor,
		}));
		expect(rail.inputRows[0]?.runs.some((run) => run.role === "scrollbar" && run.foregroundColor === colors.accentColor)).toBe(true);
	});
});
