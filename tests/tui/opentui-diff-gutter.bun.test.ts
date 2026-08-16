import { describe, expect, test } from "bun:test";
import { TextAttributes } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import type { HighlightResult } from "../../src/tui/highlight/contracts.ts";
import type { NativeSyntaxAddon } from "../../src/tui/highlight/native-loader.ts";
import { SyntaxHighlightService } from "../../src/tui/highlight/service.ts";
import { SyntaxThemeController } from "../../src/tui/highlight/theme-controller.ts";
import { createOpenTuiComponentRuntimeFromRenderer } from "../../src/tui/opentui/component-runtime.ts";
import { DiffRenderable } from "../../src/tui/opentui/diff-renderable.ts";
import type { PresentationBlock } from "../../src/tui/presentation.ts";

const themes = ["catppuccin-mocha"] as const;

function bounded(text: string) {
	return { text, truncated: false, byteLength: new TextEncoder().encode(text).byteLength };
}

function documentFor(path: string, lines: readonly string[], start = 1) {
	return {
		kind: "document" as const,
		path: bounded(path),
		hunks: [{
			oldStart: start,
			newStart: start,
			lines: lines.map((text, index) => ({
				kind: index % 3 === 1 ? "delete" as const : index % 3 === 2 ? "add" as const : "context" as const,
				...(index % 3 === 1 ? { oldLine: start + index } : {}),
				...(index % 3 === 2 ? { newLine: start + index } : {}),
				...(index % 3 === 0 ? { oldLine: start + index, newLine: start + index } : {}),
				text: bounded(text),
			})),
		}],
		addedLines: { state: "known" as const, value: lines.filter((_, index) => index % 3 === 2).length },
		removedLines: { state: "known" as const, value: lines.filter((_, index) => index % 3 === 1).length },
		truncated: false,
	};
}

function diffBlock(id: string, path: string, lines: readonly string[], options: Partial<Extract<PresentationBlock, { kind: "diff" }>> = {}): Extract<PresentationBlock, { kind: "diff" }> {
	return { id, kind: "diff", document: documentFor(path, lines), ...options };
}

function highlighted(source: string): HighlightResult {
	return {
		ok: true,
		lines: source.split("\n").map((text) => ({ spans: [{ text, foreground: { kind: "indexed", index: 5 }, bold: text.includes("added") }] })),
		themeRevision: 0,
	};
}

function fixture(): {
	readonly addon: NativeSyntaxAddon;
	readonly calls: Array<{ readonly source: string; readonly language: string; readonly theme: string }>;
} {
	const calls: Array<{ readonly source: string; readonly language: string; readonly theme: string }> = [];
	return {
		calls,
		addon: {
			engineInfo: () => ({ addon: "runledger-syntax-highlighter", apiVersion: 1, engineBuildId: "syntax-highlighter@0.0.1:diff-test" }),
			builtinThemes: () => themes,
			foregroundForScopes: () => undefined,
			diffScopeBackgrounds: () => ({ inserted: { kind: "indexed", index: 22 }, deleted: { kind: "indexed", index: 52 } }),
			registerCustomTheme: () => ({ ok: true }),
			highlightAsync: async (source, language, theme) => {
				calls.push({ source, language, theme });
				return highlighted(source);
			},
		},
	};
}

function findDiffBlocks(root: { getChildren(): Array<unknown> }): DiffRenderable[] {
	const found: DiffRenderable[] = [];
	const visit = (node: unknown): void => {
		if (node instanceof DiffRenderable) found.push(node);
		if (!node || typeof node !== "object" || !("getChildren" in node) || typeof node.getChildren !== "function") return;
		for (const child of node.getChildren()) visit(child);
	};
	visit(root);
	return found;
}

async function settle(renderOnce: () => Promise<void>): Promise<void> {
	for (let index = 0; index < 5; index += 1) {
		await Promise.resolve();
		await renderOnce();
	}
}

describe("OpenTUI Codex-style diff gutter", () => {
	test("highlights each hunk as one source and dims delete content", async () => {
		const setup = await createTestRenderer({ width: 90, height: 16 });
		const native = fixture();
		const service = new SyntaxHighlightService({ addon: native.addon });
		const controller = new SyntaxThemeController({ availableThemes: themes, terminalMode: "dark" });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {}, onResize: () => {}, syntaxHighlightService: service, syntaxThemeController: controller,
		});
		try {
			runtime.update({
				body: [diffBlock("diff", "src/example.ts", ["const before = 1;", "const removed = 1;", "const added = 2;"])],
				editorText: "", footer: [],
			});
			await settle(setup.renderOnce);
			expect(native.calls).toEqual([{
				source: "const before = 1;\nconst removed = 1;\nconst added = 2;",
				language: "typescript",
				theme: "catppuccin-mocha",
			}]);
			const diff = findDiffBlocks(setup.renderer.root)[0];
			expect(diff).toBeDefined();
			expect(diff?.plainText).toContain("1  const before = 1;");
			expect(diff?.plainText).toContain("2 -const removed = 1;");
			expect(diff?.plainText).toContain("3 +const added = 2;");
			const deleted = diff?.content.chunks.find((chunk) => chunk.text === "const removed = 1;");
			const added = diff?.content.chunks.find((chunk) => chunk.text === "const added = 2;");
			expect((deleted?.attributes ?? 0) & TextAttributes.DIM).toBe(TextAttributes.DIM);
			expect((added?.attributes ?? 0) & TextAttributes.DIM).toBe(0);
		} finally {
			runtime.destroy();
			service.destroy();
		}
	});

	test("keeps the gutter and plaintext when highlighting exceeds service limits", async () => {
		const setup = await createTestRenderer({ width: 80, height: 12 });
		const native = fixture();
		const service = new SyntaxHighlightService({ addon: native.addon });
		const controller = new SyntaxThemeController({ availableThemes: themes, terminalMode: "dark" });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {}, onResize: () => {}, syntaxHighlightService: service, syntaxThemeController: controller,
		});
		try {
			const oversized = "x".repeat(512 * 1024 + 1);
			runtime.update({ body: [diffBlock("oversized", "src/large.ts", [oversized])], editorText: "", footer: [] });
			await settle(setup.renderOnce);
			expect(native.calls).toHaveLength(0);
			const diff = findDiffBlocks(setup.renderer.root)[0];
			expect(diff?.plainText.startsWith("diff src/large.ts")).toBe(true);
			expect(diff?.plainText).toContain("1  ");
		} finally {
			runtime.destroy();
			service.destroy();
		}
	});

	test("admits only closed diff lines while the final line is still streaming", async () => {
		const setup = await createTestRenderer({ width: 80, height: 16 });
		const native = fixture();
		const service = new SyntaxHighlightService({ addon: native.addon });
		const controller = new SyntaxThemeController({ availableThemes: themes, terminalMode: "dark" });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {}, onResize: () => {}, syntaxHighlightService: service, syntaxThemeController: controller,
		});
		try {
			const streamingBlock = {
				...diffBlock("streaming", "src/example.ts", ["const closed = 1;", "const stillGrowing = 2;"]),
				streaming: true,
			} as Extract<PresentationBlock, { kind: "diff" }> & { readonly streaming: boolean };
			runtime.update({ body: [streamingBlock as PresentationBlock], editorText: "", footer: [] });
			await settle(setup.renderOnce);

			expect(native.calls).toEqual([{
				source: "const closed = 1;",
				language: "typescript",
				theme: "catppuccin-mocha",
			}]);
			expect(findDiffBlocks(setup.renderer.root)[0]?.plainText).toContain("stillGrowing");

			runtime.update({ body: [{ ...streamingBlock, streaming: false } as PresentationBlock], editorText: "", footer: [] });
			await settle(setup.renderOnce);
			expect(native.calls.at(-1)?.source).toBe("const closed = 1;\nconst stillGrowing = 2;");
			expect(findDiffBlocks(setup.renderer.root)[0]?.plainText).toContain("stillGrowing");
		} finally {
			runtime.destroy();
			service.destroy();
		}
	});

	test("does not let an aborted diff generation write highlights into the replacement", async () => {
		const setup = await createTestRenderer({ width: 80, height: 16 });
		const native = fixture();
		const deferredCalls: Array<{ readonly source: string; readonly resolve: (result: HighlightResult) => void }> = [];
		const deferredAddon: NativeSyntaxAddon = {
			...native.addon,
			highlightAsync: (source) => new Promise((resolve) => deferredCalls.push({ source, resolve })),
		};
		const service = new SyntaxHighlightService({ addon: deferredAddon, maxConcurrency: 1 });
		const controller = new SyntaxThemeController({ availableThemes: themes, terminalMode: "dark" });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {}, onResize: () => {}, syntaxHighlightService: service, syntaxThemeController: controller,
		});
		try {
			runtime.update({ body: [diffBlock("generation", "src/old.ts", ["old line"])], editorText: "", footer: [] });
			await setup.renderOnce();
			expect(deferredCalls.map((call) => call.source)).toEqual(["old line"]);

			runtime.update({ body: [diffBlock("generation", "src/new.ts", ["new line"])], editorText: "", footer: [] });
			deferredCalls[0]?.resolve(highlighted("old line"));
			for (let turn = 0; turn < 8 && deferredCalls.length < 2; turn += 1) {
				await Promise.resolve();
				await setup.renderOnce();
			}
			expect(deferredCalls.map((call) => call.source)).toEqual(["old line", "new line"]);
			deferredCalls[1]?.resolve(highlighted("new line"));
			await settle(setup.renderOnce);

			const diff = findDiffBlocks(setup.renderer.root)[0];
			expect(diff?.plainText).toContain("new line");
			expect(diff?.plainText).not.toContain("old line");
		} finally {
			runtime.destroy();
			service.destroy();
		}
	});

	test("wraps long deleted lines under a styled blank gutter", async () => {
		const setup = await createTestRenderer({ width: 24, height: 12 });
		const native = fixture();
		const service = new SyntaxHighlightService({ addon: native.addon });
		const controller = new SyntaxThemeController({ availableThemes: themes, terminalMode: "dark" });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {}, onResize: () => {}, syntaxHighlightService: service, syntaxThemeController: controller,
		});
		try {
			runtime.update({ body: [diffBlock("wrapped", "src/x.ts", ["context", "abcdefghijklmnopqrstuvwxyz0123456789"])], editorText: "", footer: [] });
			await settle(setup.renderOnce);
			const diff = findDiffBlocks(setup.renderer.root)[0];
			const continuation = diff?.content.chunks.find((chunk) => chunk.text === "   " && chunk.bg !== undefined);
			expect(continuation).toBeDefined();
			expect((continuation?.attributes ?? 0) & TextAttributes.DIM).toBe(TextAttributes.DIM);
			expect(setup.captureCharFrame()).toContain("   vwxyz0123456789");
		} finally {
			runtime.destroy();
			service.destroy();
		}
	});

	test("does not schedule offscreen diff highlighting", async () => {
		const setup = await createTestRenderer({ width: 80, height: 12 });
		const native = fixture();
		const service = new SyntaxHighlightService({ addon: native.addon, maxConcurrency: 4 });
		const controller = new SyntaxThemeController({ availableThemes: themes, terminalMode: "dark" });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {}, onResize: () => {}, syntaxHighlightService: service, syntaxThemeController: controller,
		});
		try {
			const linesFor = (label: string) => Array.from({ length: 14 }, (_, index) => `${label}-${index}`);
			const firstLines = linesFor("first");
			const secondLines = linesFor("second");
			const thirdLines = linesFor("third");
			runtime.update({
				body: [
					diffBlock("first", "src/first.ts", firstLines),
					diffBlock("second", "src/second.ts", secondLines),
					diffBlock("third", "src/third.ts", thirdLines),
				],
				editorText: "", footer: [],
			});
			await settle(setup.renderOnce);
			expect(native.calls.some((call) => call.source === thirdLines.join("\n") && call.language === "typescript")).toBe(true);
			expect(native.calls.some((call) => call.source === firstLines.join("\n"))).toBe(false);
		} finally {
			runtime.destroy();
			service.destroy();
		}
	});
});
