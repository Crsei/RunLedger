/**
 * 可选文件 watcher 的协调语义（P7）。
 *
 * 重点不是"能监听到变化"，而是：**默认关闭**、**只在 idle 边界请求交换**、
 * 变更在窗口内合并、以及 stop 之后不留订阅与 timer。
 */

import { describe, expect, it } from "vitest";
import { createExtensionReloadWatcher } from "../../src/extensions/plugins/reload-watcher.ts";
import type { ExtensionReloadOutcome } from "../../src/extensions/plugins/reload-watcher.ts";

interface Harness {
	readonly subscriptions: Array<{ readonly roots: readonly string[]; readonly onChange: (path: string) => void }>;
	readonly fire: (path: string) => void;
	readonly timers: Array<{ readonly delayMs: number; readonly run: () => void; readonly cancel: () => void }>;
	readonly advance: () => void;
}

/** 让异步 requestReload 的微任务结算完；不引入固定 sleep。 */
const settle = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); };

function harness(): Harness {
	const subscriptions: Harness["subscriptions"] = [];
	const timers: Harness["timers"] = [];
	return {
		subscriptions,
		fire: (path) => { for (const subscription of subscriptions) subscription.onChange(path); },
		timers,
		advance: () => { const pending = [...timers]; timers.length = 0; for (const timer of pending) timer.run(); },
	};
}

function watcher(input: {
	readonly h: Harness;
	readonly requestReload: () => ExtensionReloadOutcome;
	readonly enabled?: boolean;
	readonly debounceMs?: number;
	readonly roots?: readonly string[];
	readonly audits?: string[];
}) {
	const h = input.h;
	return createExtensionReloadWatcher({
		watch: {
			subscribe: (roots, onChange) => {
				const entry = { roots, onChange };
				h.subscriptions.push(entry);
				return () => { const index = h.subscriptions.indexOf(entry); if (index >= 0) h.subscriptions.splice(index, 1); };
			},
		},
		roots: () => input.roots ?? ["/home/plugins"],
		requestReload: input.requestReload,
		enabled: () => input.enabled ?? true,
		...(input.debounceMs === undefined ? {} : { debounceMs: input.debounceMs }),
		schedule: (callback, delayMs) => {
			const timer = { delayMs, run: callback, cancel: () => { const index = h.timers.indexOf(timer); if (index >= 0) h.timers.splice(index, 1); } };
			h.timers.push(timer);
			return timer.cancel;
		},
		audit: async (event) => { input.audits?.push(event.eventType); },
	});
}

describe("extension reload watcher", () => {
	it("stays inert by default", () => {
		const h = harness();
		const w = watcher({ h, requestReload: () => "ready", enabled: false });
		w.start();
		expect(h.subscriptions).toEqual([]);
		h.fire("/home/plugins/a");
		expect(h.timers).toEqual([]);
		expect(w.queued()).toBe(false);
	});

	it("coalesces changes inside the debounce window into one request", async () => {
		const h = harness();
		let reloads = 0;
		const w = watcher({ h, requestReload: () => { reloads += 1; return "ready"; }, debounceMs: 400 });
		w.start();
		expect(h.subscriptions).toHaveLength(1);
		expect(h.subscriptions[0]?.roots).toEqual(["/home/plugins"]);

		h.fire("/home/plugins/a");
		h.fire("/home/plugins/b");
		h.fire("/home/plugins/c");
		expect(h.timers).toHaveLength(1);
		expect(h.timers[0]?.delayMs).toBe(400);
		expect(w.queued()).toBe(true);
		expect(reloads).toBe(0);

		h.advance();
		await settle();
		expect(reloads).toBe(1);
		expect(w.queued()).toBe(false);
		expect(w.lastOutcome()).toBe("ready");
	});

	it("reports pending instead of swapping a generation that is in use", async () => {
		const h = harness();
		const w = watcher({ h, requestReload: () => "pending" });
		w.start();
		h.fire("/home/plugins/a");
		h.advance();
		await settle();
		// idle 语义由既有 snapshot 决定：watcher 只如实回传 pending。
		expect(w.lastOutcome()).toBe("pending");
	});

	it("opens a fresh window for a change after the previous one flushed", () => {
		const h = harness();
		let reloads = 0;
		const w = watcher({ h, requestReload: () => { reloads += 1; return "ready"; } });
		w.start();
		h.fire("/home/plugins/a");
		h.advance();
		h.fire("/home/plugins/b");
		expect(h.timers).toHaveLength(1);
		h.advance();
		expect(reloads).toBe(2);
	});

	it("stops cleanly: no subscription and no dangling timer", () => {
		const h = harness();
		let reloads = 0;
		const w = watcher({ h, requestReload: () => { reloads += 1; return "ready"; } });
		w.start();
		expect(h.subscriptions).toHaveLength(1);
		h.fire("/home/plugins/a");
		expect(h.timers).toHaveLength(1);
		w.stop();
		expect(h.subscriptions).toHaveLength(0);
		expect(h.timers).toHaveLength(0);
		h.fire("/home/plugins/b");
		expect(reloads).toBe(0);
		expect(w.queued()).toBe(false);
	});

	it("does not subscribe when there are no roots, and start is idempotent", () => {
		const h = harness();
		const empty = watcher({ h, requestReload: () => "ready", roots: [] });
		empty.start();
		expect(h.subscriptions).toEqual([]);

		const w = watcher({ h, requestReload: () => "ready" });
		w.start();
		w.start();
		expect(h.subscriptions).toHaveLength(1);
	});

	it("audits the request with the outcome, not the changed path", async () => {
		const h = harness();
		const audits: string[] = [];
		const w = watcher({ h, requestReload: () => "ready", audits });
		w.start();
		h.fire("/home/plugins/secret-looking-path");
		h.advance();
		await settle();
		expect(audits).toEqual(["extension.watch.reload_requested"]);
	});

	it("rejects an out-of-range debounce", () => {
		const h = harness();
		expect(() => watcher({ h, requestReload: () => "ready", debounceMs: 0 })).toThrow(/out of range/u);
		expect(() => watcher({ h, requestReload: () => "ready", debounceMs: 60_001 })).toThrow(/out of range/u);
	});
});
