import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import type { HighlightResult } from "../../src/tui/highlight/contracts.ts";
import type { NativeSyntaxAddon } from "../../src/tui/highlight/native-loader.ts";
import { SyntaxHighlightService } from "../../src/tui/highlight/service.ts";
import { SyntaxThemeController } from "../../src/tui/highlight/theme-controller.ts";
import { createOpenTuiComponentRuntimeFromRenderer } from "../../src/tui/opentui/component-runtime.ts";
import { SyntectCodeBlockRenderable } from "../../src/tui/opentui/syntect-code-block-renderable.ts";
import { ExecRenderable } from "../../src/tui/opentui/exec-renderable.ts";
import { DiffRenderable } from "../../src/tui/opentui/diff-renderable.ts";
import { TuiPerformanceObserver } from "../../src/tui/opentui/performance-observer.ts";
import { runSessionTransitionLoop } from "../../src/cli/session-transition-loop.ts";

const themes = ["ansi", "catppuccin-latte", "catppuccin-mocha"] as const;

function highlighted(source: string, theme: string): HighlightResult {
	const color = theme === "catppuccin-latte"
		? { kind: "rgb" as const, r: 10, g: 20, b: 30 }
		: { kind: "indexed" as const, index: 5 };
	return {
		ok: true,
		lines: source.split("\n").map((text) => ({ spans: [{ text, foreground: color, bold: text.startsWith("fn") }] })),
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
			engineInfo: () => ({ addon: "runledger-syntax-highlighter", apiVersion: 1, engineBuildId: "syntax-highlighter@0.0.1:test" }),
			builtinThemes: () => themes,
			foregroundForScopes: () => undefined,
			diffScopeBackgrounds: () => undefined,
			registerCustomTheme: () => ({ ok: true }),
			highlightAsync: async (source, language, theme) => {
				calls.push({ source, language, theme });
				return language === "unknown-lang" ? { ok: false, reason: "unknown_language" } : highlighted(source, theme);
			},
		},
	};
}

function deferredFixture(): {
	readonly addon: NativeSyntaxAddon;
	readonly calls: Array<{ readonly theme: string; readonly resolve: (result: HighlightResult) => void }>;
} {
	const calls: Array<{ readonly theme: string; readonly resolve: (result: HighlightResult) => void }> = [];
	return {
		calls,
		addon: {
			...fixture().addon,
			highlightAsync: (_source, _language, theme) => new Promise((resolve) => calls.push({ theme, resolve })),
		},
	};
}

function findDiffBlock(root: { getChildren(): Array<unknown> }): DiffRenderable | undefined {
	const visit = (node: unknown): DiffRenderable | undefined => {
		if (node instanceof DiffRenderable) return node;
		if (!node || typeof node !== "object" || !("getChildren" in node) || typeof node.getChildren !== "function") return undefined;
		for (const child of node.getChildren()) {
			const found = visit(child);
			if (found) return found;
		}
		return undefined;
	};
	return visit(root);
}

function findSyntectBlock(root: { getChildren(): Array<unknown> }): SyntectCodeBlockRenderable | undefined {
	const visit = (node: unknown): SyntectCodeBlockRenderable | undefined => {
		if (node instanceof SyntectCodeBlockRenderable) return node;
		if (!node || typeof node !== "object" || !("getChildren" in node) || typeof node.getChildren !== "function") return undefined;
		for (const child of node.getChildren()) {
			const found = visit(child);
			if (found) return found;
		}
		return undefined;
	};
	return visit(root);
}

function findExecBlock(root: { getChildren(): Array<unknown> }): ExecRenderable | undefined {
	const visit = (node: unknown): ExecRenderable | undefined => {
		if (node instanceof ExecRenderable) return node;
		if (!node || typeof node !== "object" || !("getChildren" in node) || typeof node.getChildren !== "function") return undefined;
		for (const child of node.getChildren()) {
			const found = visit(child);
			if (found) return found;
		}
		return undefined;
	};
	return visit(root);
}

async function settle(renderOnce: () => Promise<void>): Promise<void> {
	for (let index = 0; index < 4; index += 1) {
		await Promise.resolve();
		await renderOnce();
	}
}

describe("OpenTUI syntect Markdown seam", () => {
	test("admits only viewport code and submits an offscreen block after scroll", async () => {
		const setup = await createTestRenderer({ width: 80, height: 12 });
		const native = fixture();
		const service = new SyntaxHighlightService({ addon: native.addon, maxConcurrency: 4 });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {}, onResize: () => {}, syntaxHighlightService: service,
		});
		const code = (id: string) => ({
			id,
			kind: "markdown" as const,
			content: `\`\`\`rust\n${id}\n\`\`\`\n${Array.from({ length: 14 }, (_, index) => `${id} filler ${index}`).join("\n")}`,
			streaming: false,
		});
		try {
			runtime.update({ body: [code("first"), code("second"), code("third")], editorText: "", footer: [] });
			await settle(setup.renderOnce);
			expect(native.calls.map((call) => call.source)).toEqual(["third"]);
			const transcript = setup.renderer.root.findDescendantById("runledger-transcript");
			expect(transcript).toBeDefined();
			if (!transcript || !("scrollTop" in transcript)) return;
			transcript.scrollTop = 0;
			await settle(setup.renderOnce);
			expect(native.calls.map((call) => call.source)).toEqual(["third", "first"]);
		} finally {
			runtime.destroy();
			service.destroy();
		}
	});

	test("extracts the Codex info token and preserves indexed color/bold intent", async () => {
		const setup = await createTestRenderer({ width: 80, height: 20 });
		const native = fixture();
		const service = new SyntaxHighlightService({ addon: native.addon });
		const controller = new SyntaxThemeController({ availableThemes: themes, terminalMode: "dark" });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {}, onResize: () => {}, syntaxHighlightService: service, syntaxThemeController: controller,
		});
		try {
			runtime.update({
				body: [{ id: "rust", kind: "markdown", content: "```rust,no_run\nfn main() {}\n```", streaming: false }],
				editorText: "",
				footer: [],
			});
			await settle(setup.renderOnce);
			expect(native.calls).toEqual([{ source: "fn main() {}", language: "rust", theme: "catppuccin-mocha" }]);
			const span = setup.captureSpans().lines.flatMap((line) => line.spans).find((candidate) => candidate.text.includes("fn main"));
			expect(span?.fg.intent).toBe("indexed");
			expect(span?.fg.slot).toBe(5);
			expect(span?.attributes).not.toBe(0);
		} finally {
			runtime.destroy();
			service.destroy();
		}
	});

	test("keeps selectable plaintext for unknown languages", async () => {
		const setup = await createTestRenderer({ width: 80, height: 20 });
		const native = fixture();
		const service = new SyntaxHighlightService({ addon: native.addon });
		const controller = new SyntaxThemeController({ availableThemes: themes, terminalMode: "dark" });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {}, onResize: () => {}, syntaxHighlightService: service, syntaxThemeController: controller,
		});
		try {
			runtime.update({ body: [{ id: "unknown", kind: "markdown", content: "```unknown-lang\nraw <source>\n```", streaming: false }], editorText: "", footer: [] });
			await settle(setup.renderOnce);
			expect(setup.captureCharFrame()).toContain("raw <source>");
			expect(findSyntectBlock(setup.renderer.root)?.plainText).toBe("raw <source>");
		} finally {
			runtime.destroy();
			service.destroy();
		}
	});

	test("keeps Mermaid first and never submits valid diagrams to syntect", async () => {
		const setup = await createTestRenderer({ width: 80, height: 20 });
		const native = fixture();
		const service = new SyntaxHighlightService({ addon: native.addon });
		const controller = new SyntaxThemeController({ availableThemes: themes, terminalMode: "dark" });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {}, onResize: () => {}, syntaxHighlightService: service, syntaxThemeController: controller,
		});
		try {
			runtime.update({ body: [{ id: "diagram", kind: "markdown", content: "```mermaid\nflowchart LR\nA --> B\n```", streaming: false }], editorText: "", footer: [] });
			await settle(setup.renderOnce);
			expect(setup.captureCharFrame()).toContain("A");
			expect(native.calls).toEqual([]);
			expect(findSyntectBlock(setup.renderer.root)).toBeUndefined();
		} finally {
			runtime.destroy();
			service.destroy();
		}
	});

	test("keeps block identity while theme revision fences and recolors it", async () => {
		const setup = await createTestRenderer({ width: 80, height: 20 });
		const native = fixture();
		const service = new SyntaxHighlightService({ addon: native.addon });
		const controller = new SyntaxThemeController({ availableThemes: themes, terminalMode: "dark" });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {}, onResize: () => {}, syntaxHighlightService: service, syntaxThemeController: controller,
		});
		try {
			runtime.update({ body: [{ id: "switch", kind: "markdown", content: "```rust\nfn main() {}\n```", streaming: false }], editorText: "", footer: [] });
			await settle(setup.renderOnce);
			const before = findSyntectBlock(setup.renderer.root);
			expect(before?.content.chunks[0]?.fg?.intent).toBe("indexed");
			expect(controller.preview("catppuccin-latte")).toEqual({ ok: true });
			await settle(setup.renderOnce);
			const after = findSyntectBlock(setup.renderer.root);
			expect(after?.num).toBe(before?.num);
			expect(after?.content.chunks[0]?.fg?.intent).toBe("rgb");
			expect(after?.content.chunks[0]?.fg?.toInts().slice(0, 3)).toEqual([10, 20, 30]);
		} finally {
			runtime.destroy();
			service.destroy();
		}
	});

	test("rapid theme scrubbing, resize storms, and destroy keep only the latest derived completion", async () => {
		const setup = await createTestRenderer({ width: 80, height: 20 });
		const native = deferredFixture();
		const service = new SyntaxHighlightService({ addon: native.addon, maxConcurrency: 1 });
		const controller = new SyntaxThemeController({ availableThemes: themes, terminalMode: "dark" });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {}, onResize: () => {}, syntaxHighlightService: service, syntaxThemeController: controller,
		});
		try {
			runtime.update({ body: [{ id: "storm", kind: "markdown", content: "```rust\nfn main() {}\n```", streaming: false }], editorText: "", footer: [] });
			await setup.renderOnce();
			const block = findSyntectBlock(setup.renderer.root);
			expect(block?.plainText).toBe("fn main() {}");
			controller.preview("catppuccin-latte");
			controller.preview("ansi");
			for (const width of [60, 143, 80, 60, 80]) {
				setup.resize(width, 20);
				await setup.renderOnce();
			}
			expect(native.calls).toHaveLength(1);
			native.calls[0]!.resolve(highlighted("fn main() {}", "catppuccin-mocha"));
			await settle(setup.renderOnce);
			expect(native.calls.at(-1)?.theme).toBe("ansi");
			native.calls.at(-1)!.resolve(highlighted("fn main() {}", "ansi"));
			await settle(setup.renderOnce);
			expect(findSyntectBlock(setup.renderer.root)?.content.chunks[0]?.fg?.slot).toBe(5);

			controller.preview("catppuccin-latte");
			await Promise.resolve();
			runtime.destroy();
			native.calls.at(-1)?.resolve(highlighted("fn main() {}", "catppuccin-latte"));
			await Promise.resolve();
			expect(service.snapshot()).toMatchObject({ queuedJobs: 0 });
		} finally {
			service.destroy();
		}
	});

	test("session switch destroys the old owned highlighter before opening the next view", async () => {
		interface SyntaxSessionView {
			readonly sessionId: string;
			readonly setup: Awaited<ReturnType<typeof createTestRenderer>>;
			readonly runtime: ReturnType<typeof createOpenTuiComponentRuntimeFromRenderer>;
			readonly native: ReturnType<typeof deferredFixture>;
			readonly observer: TuiPerformanceObserver;
		}
		const opened: SyntaxSessionView[] = [];
		await runSessionTransitionLoop<SyntaxSessionView>({
			initialSessionId: "session-a",
			open: async (sessionId) => {
				const setup = await createTestRenderer({ width: 80, height: 12 });
				const native = deferredFixture();
				const observer = new TuiPerformanceObserver();
				const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
					onInput: () => {},
					onResize: () => {},
					performanceObserver: observer,
					createSyntaxHighlightService: () => new SyntaxHighlightService({
						addon: native.addon,
						performanceObserver: observer,
					}),
				});
				runtime.update({
					body: [{ id: `code-${sessionId}`, kind: "markdown", content: `\`\`\`rust\n${sessionId}\n\`\`\``, streaming: false }],
					editorText: "",
					footer: [],
				});
				await setup.renderOnce();
				const view = { sessionId, setup, runtime, native, observer };
				opened.push(view);
				return view;
			},
			run: async (view) => {
				if (view.sessionId === "session-a") {
					return { kind: "switch", action: "resume", target: { sessionId: "session-b" } };
				}
				const oldView = opened[0]!;
				expect(oldView.native.calls).toHaveLength(1);
				expect(view.native.calls).toHaveLength(1);
				oldView.native.calls[0]!.resolve(highlighted("session-a-late", "catppuccin-mocha"));
				for (let turn = 0; turn < 10 && oldView.observer.snapshot().highlightFallbackReasons.stale_generation === 0; turn += 1) {
					await Promise.resolve();
				}
				const oldObservation = oldView.observer.snapshot();
				expect(oldObservation.highlightFallbackReasons.stale_generation).toBe(oldObservation.highlightRequests);
				expect(oldObservation.highlightOk).toBe(0);
				expect(findSyntectBlock(view.setup.renderer.root)?.plainText).toBe("session-b");
				view.native.calls[0]!.resolve(highlighted("session-b", "catppuccin-mocha"));
				await settle(view.setup.renderOnce);
				expect(findSyntectBlock(view.setup.renderer.root)?.content.chunks[0]?.fg?.slot).toBe(5);
				return { kind: "quit" };
			},
			detach: async (view) => view.runtime.destroy(),
		});
	});
});

describe("OpenTUI exec highlighting", () => {
	test("colors the Ran header semantically, highlights Bash, and dims safe output", async () => {
		const setup = await createTestRenderer({ width: 80, height: 20 });
		const native = fixture();
		const service = new SyntaxHighlightService({ addon: native.addon });
		const controller = new SyntaxThemeController({ availableThemes: themes, terminalMode: "dark" });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {}, onResize: () => {}, syntaxHighlightService: service, syntaxThemeController: controller,
		});
		try {
			runtime.update({
				body: [{
					id: "exec",
					kind: "exec",
					command: "bash -lc 'echo hello'",
					status: "succeeded",
					exitCode: 0,
					durationMs: 42,
					output: [{ channel: "stdout", text: "\x1b[38;5;196mhello\x1b[0m" }],
				}],
				editorText: "",
				footer: [],
			});
			await settle(setup.renderOnce);
			const exec = findExecBlock(setup.renderer.root);
			expect(exec).toBeDefined();
			expect(native.calls).toContainEqual({ source: "echo hello", language: "bash", theme: "catppuccin-mocha" });
			const chunks = exec?.content.chunks ?? [];
			expect(chunks.find((chunk) => chunk.text === "• Ran ")?.fg?.intent).toBe("indexed");
			expect(chunks.find((chunk) => chunk.text === "• Ran ")?.fg?.slot).toBe(2);
			expect(chunks.find((chunk) => chunk.text.includes("hello") && chunk.fg?.slot === 196)?.attributes).not.toBe(0);
			expect(setup.captureCharFrame()).toContain("• Ran echo hello");
			expect(setup.captureCharFrame()).not.toContain("42ms");
		} finally {
			runtime.destroy();
			service.destroy();
		}
	});

	test("reuses the Bash command renderable inside approval overlays", async () => {
		const setup = await createTestRenderer({ width: 80, height: 20 });
		const native = fixture();
		const service = new SyntaxHighlightService({ addon: native.addon });
		const controller = new SyntaxThemeController({ availableThemes: themes, terminalMode: "dark" });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {}, onResize: () => {}, syntaxHighlightService: service, syntaxThemeController: controller,
		});
		try {
			runtime.update({
				body: [], editorText: "", footer: [],
				overlay: [
					{ id: "approval-command", kind: "command", command: "bash -lc 'npm test'" },
					{ id: "approval-choices", kind: "select", title: "Approval", options: [{ value: "deny", label: "Deny" }], selectedIndex: 0 },
				],
			});
			await settle(setup.renderOnce);
			const command = findExecBlock(setup.renderer.root);
			expect(command).toBeDefined();
			expect(native.calls).toContainEqual({ source: "npm test", language: "bash", theme: "catppuccin-mocha" });
			expect(command?.content.chunks.find((chunk) => chunk.text === "$ ")?.fg?.slot).toBe(5);
			expect(command?.plainText).toBe("$ npm test");
		} finally {
			runtime.destroy();
			service.destroy();
		}
	});
});

describe("OpenTUI syntax-theme status line", () => {
	test("styles path/model/state segments through theme scopes and dims only separators", async () => {
		const setup = await createTestRenderer({ width: 80, height: 12 });
		const native = fixture();
		const scopedAddon: NativeSyntaxAddon = {
			...native.addon,
			foregroundForScopes: (_theme, scopes) => scopes[0] === "string"
				? { kind: "rgb", r: 255, g: 0, b: 0 }
				: undefined,
		};
		const service = new SyntaxHighlightService({ addon: scopedAddon });
		const controller = new SyntaxThemeController({ availableThemes: themes, terminalMode: "dark" });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {}, onResize: () => {}, syntaxHighlightService: service, syntaxThemeController: controller,
		});
		try {
			runtime.update({
				body: [], editorText: "",
				footer: [{ kind: "status-line", segments: [
					{ accent: "state", text: "idle" },
					{ accent: "path", text: "~/RunLedger" },
					{ accent: "model", text: "deepseek" },
				] }],
			});
			await setup.renderOnce();
			const footer = setup.renderer.root.findDescendantById("runledger-footer");
			const chunks = footer?.content.chunks ?? [];
			expect(chunks.map((chunk) => chunk.text).join("")).toBe("idle · ~/RunLedger · deepseek");
			expect(chunks.find((chunk) => chunk.text === "~/RunLedger")?.fg?.toInts().slice(0, 3)).toEqual([228, 11, 11]);
			expect(chunks.filter((chunk) => chunk.text === " · ").every((chunk) => (chunk.attributes ?? 0) !== 0)).toBe(true);
		} finally {
			runtime.destroy();
			service.destroy();
		}
	});
});

describe("OpenTUI syntax-theme diff", () => {
	test("uses active theme backgrounds, preserves plaintext, and recolors the stable renderable", async () => {
		const setup = await createTestRenderer({ width: 80, height: 16 });
		const native = fixture();
		const scopedAddon: NativeSyntaxAddon = {
			...native.addon,
			diffScopeBackgrounds: (theme) => theme === "catppuccin-latte"
				? { inserted: { kind: "rgb", r: 1, g: 2, b: 3 }, deleted: { kind: "rgb", r: 4, g: 5, b: 6 } }
				: { inserted: { kind: "indexed", index: 22 }, deleted: { kind: "indexed", index: 52 } },
		};
		const service = new SyntaxHighlightService({ addon: scopedAddon });
		const controller = new SyntaxThemeController({ availableThemes: themes, terminalMode: "dark" });
		const runtime = createOpenTuiComponentRuntimeFromRenderer(setup.renderer, {
			onInput: () => {}, onResize: () => {}, syntaxHighlightService: service, syntaxThemeController: controller,
		});
		const document = {
			kind: "document" as const,
			path: { text: "src/a.ts", truncated: false, byteLength: 8 },
			hunks: [{ oldStart: 1, newStart: 1, lines: [
				{ kind: "delete" as const, oldLine: 1, text: { text: "before", truncated: false, byteLength: 6 } },
				{ kind: "add" as const, newLine: 1, text: { text: "after", truncated: false, byteLength: 5 } },
			] }],
			addedLines: { state: "known" as const, value: 1 },
			removedLines: { state: "known" as const, value: 1 },
			truncated: false,
		};
		try {
			runtime.update({ body: [{ id: "diff", kind: "diff", document }], editorText: "", footer: [] });
			await setup.renderOnce();
			const before = findDiffBlock(setup.renderer.root);
			expect(before?.plainText).toContain("-before");
			expect(before?.plainText).toContain("+after");
			expect(before?.content.chunks.find((chunk) => chunk.text === "after")?.bg?.slot).toBe(22);
			expect(before?.content.chunks.find((chunk) => chunk.text === "before")?.bg?.slot).toBe(52);

			controller.preview("catppuccin-latte");
			await setup.renderOnce();
			const after = findDiffBlock(setup.renderer.root);
			expect(after?.num).toBe(before?.num);
			expect(after?.content.chunks.find((chunk) => chunk.text === "after")?.bg?.toInts().slice(0, 3)).toEqual([1, 2, 3]);
			expect(setup.captureCharFrame()).toContain("before");
			expect(setup.captureCharFrame()).toContain("after");
		} finally {
			runtime.destroy();
			service.destroy();
		}
	});
});
