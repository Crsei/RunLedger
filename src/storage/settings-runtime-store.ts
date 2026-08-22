/** Runtime-owned settings snapshot with explicit reload and turn boundaries. */

import type { RunledgerLayout } from "../runtime/contracts/storage-layout.ts";
import { runtimeDigest } from "../runtime/protocol/foundation.ts";
import {
	loadProjectSettingsDocument,
	type ProjectSettings,
} from "./settings-manager.ts";
import {
	SETTINGS_SCHEMA,
	type SettingPath,
} from "./settings-schema.ts";
import {
	SettingsResolver,
	type EffectiveRuntimeSettingsSnapshot,
	type SettingsResolverOptions,
} from "./settings-resolver.ts";
import {
	SettingsService,
	type SettingListItem,
	type SettingValueResult,
} from "./settings-service.ts";

export interface SettingsRuntimeStoreOptions {
	readonly layout: RunledgerLayout;
	readonly workspaceKey?: string;
	readonly overrides?: ProjectSettings;
	readonly overrideScope?: SettingsResolverOptions["overrideScope"];
}

export interface SettingsRuntimeChange {
	readonly reason: "reload" | "next-turn";
	readonly previous: EffectiveRuntimeSettingsSnapshot;
	readonly current: EffectiveRuntimeSettingsSnapshot;
	readonly changedPaths: readonly SettingPath[];
	/** 本次边界真正改变的 effective path。 */
	readonly appliedPaths: readonly SettingPath[];
	/** candidate 已有值但仍等待后续边界的 path。 */
	readonly pendingPaths: readonly SettingPath[];
}

export type SettingsRuntimeSubscriber = (change: SettingsRuntimeChange) => void;

export interface SettingsRuntimeReloadResult {
	readonly snapshot: EffectiveRuntimeSettingsSnapshot;
	readonly pendingSnapshot: EffectiveRuntimeSettingsSnapshot;
	readonly changedPaths: readonly SettingPath[];
	readonly appliedPaths: readonly SettingPath[];
	readonly pendingPaths: readonly SettingPath[];
}

/** TUI/CLI settings editor 的 typed port；写操作必须经过 RuntimeStore 边界。 */
export interface SettingsRuntimeEditorPort {
	list(): Promise<readonly SettingListItem[]>;
	get(path: string): Promise<SettingValueResult>;
	set(path: string, value: unknown): Promise<SettingValueResult>;
	reset(path: string): Promise<SettingValueResult>;
}

function valueDigest(value: unknown): string {
	return value === undefined ? "undefined" : runtimeDigest({ value }).digest;
}

function changedPaths(left: SettingsResolver, right: SettingsResolver): SettingPath[] {
	const changed: SettingPath[] = [];
	for (const path of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
		if (valueDigest(left.get(path)) !== valueDigest(right.get(path))) changed.push(path);
	}
	return changed;
}

export class SettingsRuntimeStore {
	readonly #options: SettingsRuntimeStoreOptions;
	readonly #service: SettingsService;
	readonly #subscribers = new Set<SettingsRuntimeSubscriber>();
	#currentResolver: SettingsResolver | undefined;
	#pendingResolver: SettingsResolver | undefined;

	public constructor(options: SettingsRuntimeStoreOptions) {
		this.#options = options;
		this.#service = new SettingsService({
			layout: options.layout,
			...(options.workspaceKey === undefined ? {} : { workspaceKey: options.workspaceKey }),
		});
	}

	public service(): SettingsService {
		return this.#service;
	}

	public editorPort(): SettingsRuntimeEditorPort {
		return {
			list: () => this.#service.list(),
			get: (path) => this.#service.get(path),
			set: (path, value) => this.set(path, value),
			reset: (path) => this.reset(path),
		};
	}

	public async load(): Promise<EffectiveRuntimeSettingsSnapshot> {
		if (this.#currentResolver !== undefined) return this.current();
		const resolver = await this.#resolve();
		this.#currentResolver = resolver;
		this.#pendingResolver = resolver;
		return this.current();
	}

	public current(): EffectiveRuntimeSettingsSnapshot {
		if (this.#currentResolver === undefined) throw new Error("settings runtime store is not loaded");
		return this.#currentResolver.effectiveRuntimeSnapshot();
	}

	/** 最近一次 reload 解析出的全量 candidate，包含仍等待 startup/turn 边界的值。 */
	public pending(): EffectiveRuntimeSettingsSnapshot {
		if (this.#pendingResolver === undefined) throw new Error("settings runtime store is not loaded");
		return this.#pendingResolver.effectiveRuntimeSnapshot();
	}

	/** 当前 turn 只捕获一次 immutable snapshot；写 settings 不会修改该返回值。 */
	public beginTurn(): EffectiveRuntimeSettingsSnapshot {
		if (this.#currentResolver === undefined || this.#pendingResolver === undefined) {
			throw new Error("settings runtime store is not loaded");
		}
		const previous = this.#currentResolver.effectiveRuntimeSnapshot();
		const next = this.#currentResolver.selectFrom(
			this.#pendingResolver,
			(definition) => definition.apply !== "startup",
		);
		const current = next.effectiveRuntimeSnapshot();
		const changed = changedPaths(this.#currentResolver, this.#pendingResolver);
		const applied = changedPaths(this.#currentResolver, next);
		const pending = changedPaths(next, this.#pendingResolver);
		this.#currentResolver = next;
		this.#emit({ reason: "next-turn", previous, current, changedPaths: changed, appliedPaths: applied, pendingPaths: pending });
		return current;
	}

	/** Observe external writers and then freeze exactly one next-turn snapshot. */
	public async admitTurn(): Promise<EffectiveRuntimeSettingsSnapshot> {
		await this.reload();
		return this.beginTurn();
	}

	public async reload(): Promise<SettingsRuntimeReloadResult> {
		const candidate = await this.#resolve();
		if (this.#currentResolver === undefined) {
			this.#currentResolver = candidate;
			this.#pendingResolver = candidate;
			const snapshot = candidate.effectiveRuntimeSnapshot();
			return { snapshot, pendingSnapshot: snapshot, changedPaths: [], appliedPaths: [], pendingPaths: [] };
		}
		const previous = this.#currentResolver.effectiveRuntimeSnapshot();
		const currentResolver = this.#currentResolver.selectFrom(candidate, (definition) => definition.apply === "live");
		const current = currentResolver.effectiveRuntimeSnapshot();
		const changed = changedPaths(this.#currentResolver, candidate);
		const applied = changedPaths(this.#currentResolver, currentResolver);
		const pending = changedPaths(currentResolver, candidate);
		this.#currentResolver = currentResolver;
		this.#pendingResolver = candidate;
		this.#emit({ reason: "reload", previous, current, changedPaths: changed, appliedPaths: applied, pendingPaths: pending });
		return {
			snapshot: current,
			pendingSnapshot: candidate.effectiveRuntimeSnapshot(),
			changedPaths: changed,
			appliedPaths: applied,
			pendingPaths: pending,
		};
	}

	public subscribe(subscriber: SettingsRuntimeSubscriber): () => void {
		this.#subscribers.add(subscriber);
		return () => this.#subscribers.delete(subscriber);
	}

	public async set(path: string, value: unknown): Promise<SettingValueResult> {
		const result = await this.#service.set(path, value);
		await this.reload();
		return result;
	}

	public async reset(path: string): Promise<SettingValueResult> {
		const result = await this.#service.reset(path);
		await this.reload();
		return result;
	}

	async #resolve(): Promise<SettingsResolver> {
		const user = await loadProjectSettingsDocument({ layout: this.#options.layout });
		const workspace = this.#options.workspaceKey === undefined
			? undefined
			: await loadProjectSettingsDocument({ layout: this.#options.layout, workspaceKey: this.#options.workspaceKey });
		return new SettingsResolver({
			user: user.source,
			...(workspace === undefined ? {} : { workspace: workspace.source }),
			...(this.#options.overrides === undefined ? {} : {
				overrides: this.#options.overrides,
				overrideScope: this.#options.overrideScope,
			}),
		});
	}

	#emit(change: SettingsRuntimeChange): void {
		if (change.changedPaths.length === 0 && change.appliedPaths.length === 0 && change.pendingPaths.length === 0) return;
		for (const subscriber of this.#subscribers) subscriber(change);
	}
}
