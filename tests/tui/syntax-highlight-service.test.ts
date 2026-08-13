import { describe, expect, it, vi } from "vitest";
import type { HighlightResult } from "../../src/tui/highlight/contracts.ts";
import type { NativeSyntaxAddon } from "../../src/tui/highlight/native-loader.ts";
import { SyntaxHighlightService } from "../../src/tui/highlight/service.ts";
import { TuiPerformanceObserver } from "../../src/tui/opentui/performance-observer.ts";

interface DeferredCall {
	readonly source: string;
	readonly resolve: (result: HighlightResult) => void;
}

function deferredAddon(): { readonly addon: NativeSyntaxAddon; readonly calls: DeferredCall[] } {
	const calls: DeferredCall[] = [];
	return {
		calls,
		addon: {
			engineInfo: () => ({
				addon: "runledger-syntax-highlighter",
				apiVersion: 1,
				engineBuildId: "syntax-highlighter@0.0.1:test:0123456789abcdef",
			}),
			builtinThemes: () => ["catppuccin-latte", "catppuccin-mocha"],
			foregroundForScopes: () => undefined,
			diffScopeBackgrounds: () => undefined,
			registerCustomTheme: () => ({ ok: true }),
			highlightAsync: (source) => new Promise((resolve) => calls.push({ source, resolve })),
		},
	};
}

function success(text: string): HighlightResult {
	return {
		ok: true,
		lines: [{ spans: [{ text, foreground: { kind: "default" }, bold: false }] }],
		themeRevision: 0,
	};
}

describe("SyntaxHighlightService", () => {
	it("runs at most the configured number of native jobs", async () => {
		const native = deferredAddon();
		const service = new SyntaxHighlightService({ addon: native.addon, maxConcurrency: 2 });
		const first = service.highlight({ key: "a", source: "one", language: "rust", themeName: "catppuccin-mocha", themeRevision: 1 });
		const second = service.highlight({ key: "b", source: "two", language: "rust", themeName: "catppuccin-mocha", themeRevision: 1 });
		const third = service.highlight({ key: "c", source: "three", language: "rust", themeName: "catppuccin-mocha", themeRevision: 1 });
		expect(native.calls.map((call) => call.source)).toEqual(["one", "two"]);
		native.calls[0]!.resolve(success("one"));
		await first;
		await Promise.resolve();
		expect(native.calls.map((call) => call.source)).toEqual(["one", "two", "three"]);
		native.calls[1]!.resolve(success("two"));
		native.calls[2]!.resolve(success("three"));
		expect((await second).ok).toBe(true);
		expect((await third).ok).toBe(true);
		service.destroy();
	});

	it("keeps one active and only the latest queued request per stable key", async () => {
		const native = deferredAddon();
		const service = new SyntaxHighlightService({ addon: native.addon, maxConcurrency: 1 });
		const active = service.highlight({ key: "same", source: "first", language: "rust", themeName: "catppuccin-mocha", themeRevision: 1 });
		const replaced = service.highlight({ key: "same", source: "middle", language: "rust", themeName: "catppuccin-mocha", themeRevision: 1 });
		const latest = service.highlight({ key: "same", source: "latest", language: "rust", themeName: "catppuccin-mocha", themeRevision: 1 });
		expect(await replaced).toEqual({ ok: false, reason: "stale_generation" });
		expect(native.calls.map((call) => call.source)).toEqual(["first"]);
		native.calls[0]!.resolve(success("first"));
		await active;
		await Promise.resolve();
		expect(native.calls.map((call) => call.source)).toEqual(["first", "latest"]);
		native.calls[1]!.resolve(success("latest"));
		const result = await latest;
		expect(result).toMatchObject({ ok: true, themeRevision: 1 });
		service.destroy();
	});

	it("drains visible work before overscan and background work", async () => {
		const native = deferredAddon();
		const service = new SyntaxHighlightService({ addon: native.addon, maxConcurrency: 1 });
		const active = service.highlight({ key: "active", source: "active", language: "rust", themeName: "catppuccin-mocha", themeRevision: 1, priority: "visible" });
		const background = service.highlight({ key: "background", source: "background", language: "rust", themeName: "catppuccin-mocha", themeRevision: 1, priority: "background" });
		const overscan = service.highlight({ key: "overscan", source: "overscan", language: "rust", themeName: "catppuccin-mocha", themeRevision: 1, priority: "overscan" });
		const visible = service.highlight({ key: "visible", source: "visible", language: "rust", themeName: "catppuccin-mocha", themeRevision: 1, priority: "visible" });
		native.calls[0]!.resolve(success("active"));
		await active;
		await Promise.resolve();
		expect(native.calls.map((call) => call.source)).toEqual(["active", "visible"]);
		native.calls[1]!.resolve(success("visible"));
		await visible;
		await Promise.resolve();
		expect(native.calls.map((call) => call.source)).toEqual(["active", "visible", "overscan"]);
		native.calls[2]!.resolve(success("overscan"));
		await overscan;
		await Promise.resolve();
		native.calls[3]!.resolve(success("background"));
		await background;
		service.destroy();
	});

	it("cancels queued offscreen work without pretending to cancel an active worker", async () => {
		const native = deferredAddon();
		const service = new SyntaxHighlightService({ addon: native.addon, maxConcurrency: 1 });
		const active = service.highlight({ key: "active", source: "active", language: "rust", themeName: "catppuccin-mocha", themeRevision: 1, priority: "visible" });
		const queued = service.highlight({ key: "queued", source: "queued", language: "rust", themeName: "catppuccin-mocha", themeRevision: 1, priority: "overscan" });
		expect(service.cancel("queued")).toBe(true);
		expect(await queued).toEqual({ ok: false, reason: "stale_generation" });
		expect(service.cancel("active")).toBe(false);
		native.calls[0]!.resolve(success("active"));
		await active;
		expect(native.calls).toHaveLength(1);
		service.destroy();
	});

	it("returns typed guards before native work and bounds queue bytes", async () => {
		const native = deferredAddon();
		const service = new SyntaxHighlightService({ addon: native.addon, maxConcurrency: 1, maxQueuedBytes: 4 });
		expect(await service.highlight({ key: "empty", source: "", language: "rust", themeName: "catppuccin-mocha", themeRevision: 1 })).toEqual({ ok: false, reason: "empty" });
		expect(await service.highlight({ key: "bytes", source: "x".repeat(512 * 1024 + 1), language: "rust", themeName: "catppuccin-mocha", themeRevision: 1 })).toEqual({ ok: false, reason: "oversize_bytes" });
		expect(await service.highlight({ key: "lines", source: "x\n".repeat(10_001), language: "rust", themeName: "catppuccin-mocha", themeRevision: 1 })).toEqual({ ok: false, reason: "oversize_lines" });
		const active = service.highlight({ key: "active", source: "hold", language: "rust", themeName: "catppuccin-mocha", themeRevision: 1 });
		expect(await service.highlight({ key: "queued", source: "12345", language: "rust", themeName: "catppuccin-mocha", themeRevision: 1 })).toEqual({ ok: false, reason: "queue_pressure" });
		expect(native.calls).toHaveLength(1);
		native.calls[0]!.resolve(success("hold"));
		await active;
		service.destroy();
	});

	it("caches derived spans by source/language/theme revision without retaining duplicate work", async () => {
		const native = deferredAddon();
		const service = new SyntaxHighlightService({ addon: native.addon, maxConcurrency: 1 });
		const request = { key: "block", source: "cached", language: "rust", themeName: "catppuccin-mocha", themeRevision: 2 } as const;
		const first = service.highlight(request);
		native.calls[0]!.resolve(success("cached"));
		await first;
		const cached = await service.highlight({ ...request, key: "another-view" });
		expect(cached).toMatchObject({ ok: true, themeRevision: 2 });
		expect(native.calls).toHaveLength(1);
		expect(service.snapshot().cacheHits).toBe(1);
		service.destroy();
	});

	it("drops queued work and completions after destroy", async () => {
		const native = deferredAddon();
		const service = new SyntaxHighlightService({ addon: native.addon, maxConcurrency: 1 });
		const active = service.highlight({ key: "a", source: "one", language: "rust", themeName: "catppuccin-mocha", themeRevision: 1 });
		const queued = service.highlight({ key: "b", source: "two", language: "rust", themeName: "catppuccin-mocha", themeRevision: 1 });
		service.destroy();
		expect(await queued).toEqual({ ok: false, reason: "stale_generation" });
		native.calls[0]!.resolve(success("one"));
		expect(await active).toEqual({ ok: false, reason: "stale_generation" });
		expect(native.calls).toHaveLength(1);
	});

	it("evicts by span count in addition to entry and estimated byte limits", async () => {
		const addon: NativeSyntaxAddon = {
			...deferredAddon().addon,
			highlightAsync: async (source) => ({
				ok: true,
				lines: [{ spans: Array.from({ length: Number(source) }, (_, index) => ({ text: String(index), foreground: { kind: "default" }, bold: false })) }],
				themeRevision: 0,
			}),
		};
		const service = new SyntaxHighlightService({ addon, maxCacheEntries: 10, maxCacheBytes: 1_000_000, maxCacheSpans: 3 });
		await service.highlight({ key: "one", source: "2", language: "rust", themeName: "catppuccin-mocha", themeRevision: 1 });
		await service.highlight({ key: "two", source: "2", language: "bash", themeName: "catppuccin-mocha", themeRevision: 1 });
		expect(service.snapshot()).toMatchObject({ cacheEntries: 1, cacheSpans: 2, cacheEvictions: 1 });
		service.destroy();
	});

	it("reports aggregate outcomes and cache/queue state without recording source text", async () => {
		const native = deferredAddon();
		const observer = new TuiPerformanceObserver();
		const service = new SyntaxHighlightService({ addon: native.addon, performanceObserver: observer, maxConcurrency: 1, maxQueuedBytes: 2 });
		const active = service.highlight({ key: "active", source: "secret-source", language: "rust", themeName: "catppuccin-mocha", themeRevision: 4 });
		expect(await service.highlight({ key: "pressure", source: "123", language: "rust", themeName: "catppuccin-mocha", themeRevision: 4 }))
			.toEqual({ ok: false, reason: "queue_pressure" });
		native.calls[0]!.resolve(success("highlighted"));
		await active;
		await service.highlight({ key: "cache", source: "secret-source", language: "rust", themeName: "catppuccin-mocha", themeRevision: 4 });
		const snapshot = observer.snapshot();
		expect(snapshot).toMatchObject({
			highlightRequests: 3,
			highlightOk: 2,
			highlightFallbacks: 1,
			highlightCacheHits: 1,
			highlightThemeRevision: 4,
			highlightEngineBuildId: "syntax-highlighter@0.0.1:test:0123456789abcdef",
			highlightFallbackReasons: {
				queue_pressure: 1,
			},
		});
		expect(JSON.stringify(snapshot)).not.toContain("secret-source");
		service.destroy();
	});

	it("separates queue wait, native work, and adapter time with a monotonic clock", async () => {
		const native = deferredAddon();
		const observer = new TuiPerformanceObserver();
		let now = 0;
		const service = new SyntaxHighlightService({
			addon: native.addon,
			performanceObserver: observer,
			maxConcurrency: 1,
			now: () => now,
		});
		const active = service.highlight({ key: "active", source: "one", language: "rust", themeName: "catppuccin-mocha", themeRevision: 1 });
		now = 5;
		const queued = service.highlight({ key: "queued", source: "two", language: "rust", themeName: "catppuccin-mocha", themeRevision: 1 });
		now = 12;
		native.calls[0]!.resolve(success("one"));
		await active;
		for (let turn = 0; turn < 10 && native.calls.length < 2; turn += 1) await Promise.resolve();
		now = 20;
		native.calls[1]!.resolve(success("two"));
		await queued;
		expect(observer.snapshot()).toMatchObject({
			highlightQueueWaitMs: 7,
			highlightNativeDurationMs: 20,
			highlightAdapterDurationMs: 0,
		});
		service.destroy();
	});

	it("returns timeout without releasing the real native concurrency slot before settlement", async () => {
		const native = deferredAddon();
		const service = new SyntaxHighlightService({ addon: native.addon, maxConcurrency: 1, timeoutMs: 25 });
		const timedOut = service.highlight({ key: "slow", source: "slow", language: "rust", themeName: "catppuccin-mocha", themeRevision: 1 });
		const next = service.highlight({ key: "next", source: "next", language: "rust", themeName: "catppuccin-mocha", themeRevision: 1 });
		expect(await timedOut).toEqual({ ok: false, reason: "timeout" });
		expect(native.calls).toHaveLength(1);
		native.calls[0]!.resolve(success("late"));
		for (let turn = 0; turn < 10 && native.calls.length < 2; turn += 1) await Promise.resolve();
		expect(native.calls).toHaveLength(2);
		native.calls[1]!.resolve(success("next"));
		expect(await next).toMatchObject({ ok: true });
		service.destroy();
	});
});
