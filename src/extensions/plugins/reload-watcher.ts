/**
 * 可选的文件变更 → 扩展 reload 协调器（P7）。
 *
 * 纪律：
 *   - **默认关闭**。只有调用方的 `enabled()` 为真时才订阅；关闭状态下 `start()`
 *     不订阅任何根，也不留 timer。
 *   - **只在 idle 边界交换**：本模块只调用注入的 `requestReload()`，它的返回值
 *     与 `ExtensionSnapshotStore.requestReload()` 同语义（`ready` / `pending`）。
 *     运行中的 turn 是否允许交换由既有 snapshot 决定，本模块不自己判断、也不
 *     绕过——"watch 到变化"永远不等于"立刻换掉正在用的 generation"（D11）。
 *   - **不 import `node:fs`**：订阅由注入的 `ExtensionWatchPort` 提供，Node 实现
 *     留在 storage 适配层（工具/扩展执行边界禁止扩展域直接持有 raw fs）。
 *   - 变更在 debounce 窗口内合并成一次请求；窗口结束后若又有变更会重新开窗，
 *     但**不会**并发发起第二次未完成的请求。
 */

export interface ExtensionWatchPort {
	/** 订阅一组根的变更；返回取消订阅函数。 */
	subscribe(roots: readonly string[], onChange: (changedPath: string) => void): () => void;
}

export type ExtensionReloadOutcome = "ready" | "pending";

export interface ExtensionReloadWatcherOptions {
	readonly watch: ExtensionWatchPort;
	/** 需要观察的根；每次开窗时重新读取，便于 root 变化后生效。 */
	readonly roots: () => readonly string[];
	/** 与 `ExtensionSnapshotStore.requestReload()` 同语义。 */
	readonly requestReload: () => ExtensionReloadOutcome;
	/** 默认关闭；返回 false 时不订阅任何东西。 */
	readonly enabled?: () => boolean;
	readonly debounceMs?: number;
	readonly now?: () => number;
	/** 便于测试注入；缺省用 `setTimeout`。 */
	readonly schedule?: (callback: () => void, delayMs: number) => () => void;
	readonly audit?: (event: { readonly eventType: string; readonly payload: Record<string, unknown> }) => Promise<void>;
}

export interface ExtensionReloadWatcher {
	/** 幂等：已在运行时不重复订阅。 */
	start(): void;
	/** 取消订阅并清掉未触发的 timer；幂等。 */
	stop(): void;
	/** 是否有已排队的变更等待窗口结束。 */
	queued(): boolean;
	/** 最近一次请求的返回值；未请求过为 undefined。 */
	lastOutcome(): ExtensionReloadOutcome | undefined;
}

const DEFAULT_DEBOUNCE_MS = 500;

export function createExtensionReloadWatcher(options: ExtensionReloadWatcherOptions): ExtensionReloadWatcher {
	const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
	if (!Number.isSafeInteger(debounceMs) || debounceMs < 1 || debounceMs > 60_000) throw new Error("extension watch debounce is out of range");
	const schedule = options.schedule ?? ((callback, delayMs) => {
		const timer = setTimeout(callback, delayMs);
		// 不阻止进程退出：watcher 是可选加固，不应延长 session 生命周期。
		timer.unref?.();
		return () => { clearTimeout(timer); };
	});
	const enabled = options.enabled ?? (() => false);

	let unsubscribe: (() => void) | undefined;
	let cancelTimer: (() => void) | undefined;
	let queuedPath: string | undefined;
	let outcome: ExtensionReloadOutcome | undefined;

	const flush = (): void => {
		cancelTimer = undefined;
		const changedPath = queuedPath;
		queuedPath = undefined;
		if (changedPath === undefined) return;
		outcome = options.requestReload();
		void options.audit?.({
			eventType: "extension.watch.reload_requested",
			payload: { outcome, debounceMs },
		});
	};

	const onChange = (changedPath: string): void => {
		queuedPath = changedPath;
		// 已有窗口在等：合并进同一个窗口，不叠加 timer。
		if (cancelTimer !== undefined) return;
		cancelTimer = schedule(flush, debounceMs);
	};

	return {
		start: () => {
			if (unsubscribe !== undefined) return;
			if (!enabled()) return;
			const roots = options.roots();
			if (roots.length === 0) return;
			unsubscribe = options.watch.subscribe(roots, onChange);
		},
		stop: () => {
			cancelTimer?.();
			cancelTimer = undefined;
			queuedPath = undefined;
			unsubscribe?.();
			unsubscribe = undefined;
		},
		queued: () => queuedPath !== undefined,
		lastOutcome: () => outcome,
	};
}
