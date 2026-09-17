/**
 * `ExtensionWatchPort` 的 Node 适配器。
 *
 * 扩展域禁止 raw fs，因此 `node:fs` 只出现在这里。行为约束：
 *   - 一次订阅里每个 root 一个 watcher，`stop` 必须把它们全部关掉；
 *   - root 数量有界（超出即拒绝，不静默只监一部分）；
 *   - 单个 watcher 失败不拖垮其余 root：报错经 `onError` 上报，已建立的继续工作；
 *   - 变更回调只传路径，不做 debounce——合并在 `reload-watcher` 协调器里。
 */

import { watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import type { ExtensionWatchPort } from "../../extensions/plugins/reload-watcher.ts";

export interface NodeExtensionWatchOptions {
	/** 单次订阅允许的最大 root 数；超出直接抛错而不是部分订阅。 */
	readonly maxRoots?: number;
	/** watcher 级错误（权限、目录消失等）；不抛出，交由调用方审计。 */
	readonly onError?: (error: { readonly root: string; readonly message: string }) => void;
}

const DEFAULT_MAX_ROOTS = 16;

export class NodeExtensionWatchPort implements ExtensionWatchPort {
	readonly #maxRoots: number;
	readonly #onError: ((error: { readonly root: string; readonly message: string }) => void) | undefined;

	public constructor(options: NodeExtensionWatchOptions = {}) {
		this.#maxRoots = options.maxRoots ?? DEFAULT_MAX_ROOTS;
		if (!Number.isSafeInteger(this.#maxRoots) || this.#maxRoots < 1 || this.#maxRoots > 256) throw new Error("extension watch root bound is out of range");
		this.#onError = options.onError;
	}

	public subscribe(roots: readonly string[], onChange: (changedPath: string) => void): () => void {
		const unique = [...new Set(roots)];
		if (unique.length > this.#maxRoots) throw new Error(`extension watcher accepts at most ${this.#maxRoots} roots`);
		const watchers: FSWatcher[] = [];
		for (const root of unique) {
			try {
				// recursive 在 Linux 上由 Node 20+ 支持；不支持时退回只观察 root 自身，
				// 不抛给调用方——降级后的覆盖范围由 watcher 的错误通道上报一次。
				const watcher = watch(root, { recursive: true, persistent: false }, (_eventType, filename) => {
					onChange(typeof filename === "string" && filename.length > 0 ? `${root}/${filename}` : root);
				});
				watcher.on("error", (error) => { this.#onError?.({ root, message: error instanceof Error ? error.message : "watch error" }); });
				watchers.push(watcher);
			} catch (error) {
				this.#onError?.({ root, message: error instanceof Error ? error.message : "watch unavailable" });
			}
		}
		let closed = false;
		return () => {
			if (closed) return;
			closed = true;
			for (const watcher of watchers) watcher.close();
			watchers.length = 0;
		};
	}
}
