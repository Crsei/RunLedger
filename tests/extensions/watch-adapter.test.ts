/**
 * Node watch 适配器的生命周期与边界（P7）。
 *
 * 不对"变更一定能送达"做时序断言——那是 fs.watch 的实现细节，容易在 CI 上
 * 变成 flaky。这里固定的是适配器自己的契约：订阅数量边界、stop 幂等且关闭
 * 全部 watcher、坏 root 不影响好 root、错误经通道上报而不抛出。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NodeExtensionWatchPort } from "../../src/storage/extensions/watch-adapter.ts";

function tempRoot(): string {
	return mkdtempSync(join(tmpdir(), "rl-watch-"));
}

describe("node extension watch port", () => {
	it("subscribes a directory and closes cleanly and idempotently", () => {
		const root = tempRoot();
		try {
			const port = new NodeExtensionWatchPort();
			const unsubscribe = port.subscribe([root], () => undefined);
			expect(typeof unsubscribe).toBe("function");
			unsubscribe();
			expect(() => unsubscribe()).not.toThrow();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects more roots than the bound instead of subscribing a subset", () => {
		const roots = [tempRoot(), tempRoot(), tempRoot()];
		try {
			const port = new NodeExtensionWatchPort({ maxRoots: 2 });
			expect(() => port.subscribe(roots, () => undefined)).toThrow(/at most 2 roots/u);
		} finally {
			for (const root of roots) rmSync(root, { recursive: true, force: true });
		}
	});

	it("validates the root bound at construction", () => {
		expect(() => new NodeExtensionWatchPort({ maxRoots: 0 })).toThrow(/out of range/u);
		expect(() => new NodeExtensionWatchPort({ maxRoots: 257 })).toThrow(/out of range/u);
	});

	it("reports an unavailable root through the error channel and keeps the others", () => {
		const good = tempRoot();
		const missing = join(tmpdir(), `rl-watch-missing-${Date.now()}`);
		const errors: Array<{ readonly root: string; readonly message: string }> = [];
		try {
			const port = new NodeExtensionWatchPort({ onError: (error) => { errors.push(error); } });
			// 坏 root 与好 root 一起订阅：坏的那个不抛给调用方，好的仍然建立。
			const unsubscribe = port.subscribe([missing, good], () => undefined);
			expect(errors.map((error) => error.root)).toContain(missing);
			expect(errors.every((error) => error.message.length > 0)).toBe(true);
			expect(() => unsubscribe()).not.toThrow();
		} finally {
			rmSync(good, { recursive: true, force: true });
		}
	});

	it("deduplicates repeated roots before applying the bound", () => {
		const root = tempRoot();
		try {
			const port = new NodeExtensionWatchPort({ maxRoots: 1 });
			// 同一个 root 传三次不应触发"超过上限"。
			expect(() => port.subscribe([root, root, root], () => undefined)).not.toThrow();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
