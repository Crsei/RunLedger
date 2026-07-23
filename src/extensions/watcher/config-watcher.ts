/** 配置 watcher/debounce 只请求 reload；真正交换仍由 idle boundary 决定。 */

export interface ExtensionWatchPort {
	watch(paths: readonly string[], listener: (path: string) => void): Promise<{ close(): Promise<void> }>;
}

export interface ExtensionDebounceSchedulerPort {
	schedule(key: string, delayMs: number, callback: () => void): void;
	cancel(key: string): void;
}

export class ExtensionConfigWatcher {
	readonly #watcher: ExtensionWatchPort;
	readonly #scheduler: ExtensionDebounceSchedulerPort;
	readonly #onReloadRequested: (changedPaths: readonly string[]) => void;
	readonly #changed = new Set<string>();
	#handle?: { close(): Promise<void> };

	public constructor(options: { watcher: ExtensionWatchPort; scheduler: ExtensionDebounceSchedulerPort; onReloadRequested: (changedPaths: readonly string[]) => void }) {
		this.#watcher = options.watcher;
		this.#scheduler = options.scheduler;
		this.#onReloadRequested = options.onReloadRequested;
	}

	public async start(paths: readonly string[]): Promise<void> {
		await this.close();
		this.#handle = await this.#watcher.watch([...new Set(paths)].sort(), (path) => {
			this.#changed.add(path);
			this.#scheduler.schedule("extensions.reload", 250, () => {
				const changed = [...this.#changed].sort();
				this.#changed.clear();
				this.#onReloadRequested(changed);
			});
		});
	}

	public async close(): Promise<void> {
		this.#scheduler.cancel("extensions.reload");
		this.#changed.clear();
		await this.#handle?.close();
		this.#handle = undefined;
	}
}
