/** User/workspace/session/CLI settings 的 effective snapshot resolver。 */

import { runtimeDigest, type RuntimeDigest } from "../runtime/protocol/foundation.ts";
import { resolveCompactionPolicy, type CompactionPolicy } from "../runtime/context/compaction/cut-planner.ts";
import { resolveRetryPolicy, type RetryPolicy } from "../runtime/retry/policy.ts";
import {
	resolveGitPolicy,
	resolvePlanPolicy,
	resolveProviderPolicy,
	resolveTaskPolicy,
	resolveToolPolicy,
	type GitPolicyProjection,
	type PlanPolicyProjection,
	type ProviderPolicyProjection,
	type TaskPolicyProjection,
	type ToolPolicyProjection,
} from "./settings-policies.ts";
import { resolveDisplaySettings, resolveStartupSettings, type DisplaySettingsProjection, type StartupSettingsProjection } from "./settings-policies.ts";
import {
	getSettingDefinition,
	normalizeSettingValue,
	SETTINGS_SCHEMA,
	type SettingDiagnostic,
	type SettingApplyMode,
	type SettingDefinition,
	type SettingGroupName,
	type SettingPath,
	type SettingScope,
	type SettingValue,
} from "./settings-schema.ts";

export type SettingsRecord = object;

export interface SettingsResolverOptions {
	readonly user?: SettingsRecord;
	readonly workspace?: SettingsRecord;
	readonly overrides?: SettingsRecord;
	/** overrides 默认来自当前 Session；CLI composition 可显式标记为 cli。 */
	readonly overrideScope?: "session" | "cli";
}

export type SettingsSnapshot = Readonly<Record<string, unknown>>;
export type SettingsGroupSnapshot = Readonly<Record<string, SettingValue>>;
export type EffectiveSettingsSource = SettingScope | "default";

export interface EffectiveRuntimeSettingsSnapshot {
	readonly values: SettingsSnapshot;
	/** User-owned executable shell selected at Session startup, if configured. */
	readonly shellPath?: string;
	readonly retry: RetryPolicy;
	readonly compaction: CompactionPolicy;
	readonly toolPolicy: ToolPolicyProjection;
	readonly providerPolicy: ProviderPolicyProjection;
	readonly git: GitPolicyProjection;
	readonly plan: PlanPolicyProjection;
	readonly taskPolicy: TaskPolicyProjection;
	readonly workspacePolicy: Readonly<{
		readonly additionalDirectories: readonly string[];
	}>;
	readonly sessionPolicy: Readonly<{
		readonly autoTitle: boolean;
		readonly steeringMode: "one-at-a-time" | "all";
		readonly followUpMode: "one-at-a-time" | "all";
		readonly memoryBackend: "off" | "local";
	}>;
	readonly display: DisplaySettingsProjection;
	readonly startup: StartupSettingsProjection;
	readonly sourceLayers: Readonly<Record<SettingPath, EffectiveSettingsSource>>;
	readonly applyModes: Readonly<Record<SettingPath, SettingApplyMode>>;
	readonly diagnostics: readonly SettingDiagnostic[];
	readonly digest: RuntimeDigest;
}

interface Layer {
	readonly source: SettingScope;
	readonly settings: SettingsRecord;
}

interface PathLookup {
	readonly present: boolean;
	readonly value?: unknown;
}

interface ResolvedSettingsState {
	readonly values: ReadonlyMap<SettingPath, SettingValue>;
	readonly diagnostics: readonly SettingDiagnostic[];
	readonly sourceLayers: Readonly<Record<SettingPath, EffectiveSettingsSource>>;
}

type RestrictiveMerge = "boolean_and" | "string_union" | "number_min" | "zero_unbounded_min" | "provider_limit_min";

const RESTRICTIVE_BOOLEAN_PATHS = new Set<SettingPath>([
	"tools.read.enabled",
	"tools.write.enabled",
	"tools.edit.enabled",
	"tools.bash.enabled",
	"tools.grep.enabled",
	"tools.find.enabled",
	"tools.glob.enabled",
	"tools.ls.enabled",
	"tools.webFetch.enabled",
	"tools.lsp.enabled",
]);

const RESTRICTIVE_NUMBER_PATHS = new Set<SettingPath>([
	"tools.read.defaultLimit",
	"tools.bash.defaultTimeoutMs",
	"tools.bash.maxOutputChars",
	"tools.grep.defaultLimit",
	"tools.grep.contextBefore",
	"tools.grep.contextAfter",
	"tools.find.defaultLimit",
	"tools.glob.defaultLimit",
	"tools.ls.defaultLimit",
	"tools.lsp.timeoutMs",
	"task.maxConcurrency",
	"task.maxRecursionDepth",
]);

function restrictiveMerge(path: SettingPath): RestrictiveMerge | undefined {
	if (RESTRICTIVE_BOOLEAN_PATHS.has(path)) return "boolean_and";
	if (RESTRICTIVE_NUMBER_PATHS.has(path)) return "number_min";
	if (path === "disabledProviders" || path === "task.disabledAgents") return "string_union";
	if (
		path === "task.maxRuntimeMs"
		|| path === "task.softRequestBudget"
		|| path === "tools.artifactSpillThreshold"
		|| path === "tools.artifactTailBytes"
		|| path === "tools.artifactHeadBytes"
		|| path === "tools.artifactTailLines"
		|| path === "tools.outputMaxColumns"
	) return "zero_unbounded_min";
	if (path === "providers.maxInFlightRequests") return "provider_limit_min";
	return undefined;
}

function mergeRestrictiveValues(strategy: RestrictiveMerge, values: readonly SettingValue[]): SettingValue {
	switch (strategy) {
		case "boolean_and":
			return values.every((value) => value === true);
		case "string_union": {
			const merged: string[] = [];
			const seen = new Set<string>();
			for (const value of [...values].reverse()) {
				for (const item of value as readonly string[]) {
					if (seen.has(item)) continue;
					seen.add(item);
					merged.push(item);
				}
			}
			return Object.freeze(merged);
		}
		case "number_min":
			return Math.min(...values as readonly number[]);
		case "zero_unbounded_min": {
			const bounded = (values as readonly number[]).filter((value) => value > 0);
			return bounded.length === 0 ? 0 : Math.min(...bounded);
		}
		case "provider_limit_min": {
			const merged: Record<string, number> = {};
			for (const value of values as readonly Readonly<Record<string, number>>[]) {
				for (const [provider, limit] of Object.entries(value)) {
					merged[provider] = merged[provider] === undefined ? limit : Math.min(merged[provider], limit);
				}
			}
			return Object.freeze(merged);
		}
	}
}

function buildApplyModes(): Readonly<Record<SettingPath, SettingApplyMode>> {
	const result = {} as Record<SettingPath, SettingApplyMode>;
	for (const path of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
		result[path] = SETTINGS_SCHEMA[path].apply;
	}
	return Object.freeze(result);
}

const APPLY_MODES = buildApplyModes();

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPath(settings: SettingsRecord, path: string): PathLookup {
	let current: unknown = settings;
	for (const segment of path.split(".")) {
		if (!isRecord(current) || !Object.hasOwn(current, segment)) return { present: false };
		current = current[segment];
	}
	return { present: true, value: current };
}

function assignPath(target: Record<string, unknown>, path: string, value: SettingValue): void {
	const segments = path.split(".");
	let current = target;
	for (const segment of segments.slice(0, -1)) {
		const existing = current[segment];
		if (!isRecord(existing)) {
			const next: Record<string, unknown> = {};
			current[segment] = next;
			current = next;
		} else {
			current = existing;
		}
	}
	const leaf = segments[segments.length - 1];
	if (leaf !== undefined && value !== undefined) current[leaf] = value;
}

function freezeValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return Object.freeze(value.map((child) => freezeValue(child)));
	}
	if (!isRecord(value)) return value;
	const copy: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) copy[key] = freezeValue(child);
	return Object.freeze(copy);
}

export class SettingsResolver {
	readonly #values: ReadonlyMap<SettingPath, SettingValue>;
	readonly #snapshot: SettingsSnapshot;
	readonly #diagnostics: readonly SettingDiagnostic[];
	readonly #sourceLayers: Readonly<Record<SettingPath, EffectiveSettingsSource>>;
	readonly #digest: RuntimeDigest;

	public constructor(options: SettingsResolverOptions = {}, resolvedState?: ResolvedSettingsState) {
		if (resolvedState !== undefined) {
			this.#values = resolvedState.values;
			const snapshot: Record<string, unknown> = {};
			for (const [path, value] of resolvedState.values) assignPath(snapshot, path, value);
			this.#snapshot = freezeValue(snapshot) as SettingsSnapshot;
			this.#diagnostics = Object.freeze(resolvedState.diagnostics.map((item) => Object.freeze({ ...item })));
			this.#sourceLayers = Object.freeze({ ...resolvedState.sourceLayers });
			this.#digest = runtimeDigest({ settings: this.#snapshot, sourceLayers: this.#sourceLayers, applyModes: APPLY_MODES });
			return;
		}
		const values = new Map<SettingPath, SettingValue>();
		const diagnostics: SettingDiagnostic[] = [];
		const sourceLayers = {} as Record<SettingPath, EffectiveSettingsSource>;
		const layers: readonly Layer[] = [
			...(options.overrides === undefined ? [] : [{ source: options.overrideScope ?? "session", settings: options.overrides }]),
			...(options.workspace === undefined ? [] : [{ source: "workspace" as const, settings: options.workspace }]),
			...(options.user === undefined ? [] : [{ source: "user" as const, settings: options.user }]),
		];

		for (const path of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
			const definition = getSettingDefinition(path);
			if (definition === undefined) continue;
			let resolved = definition.defaultValue;
			let resolvedSource: EffectiveSettingsSource = "default";
			const merge = restrictiveMerge(path);
			const restrictiveValues: SettingValue[] = [];
			const restrictiveSources: SettingScope[] = [];
			for (const layer of layers) {
				const lookup = readPath(layer.settings, path);
				if (!lookup.present) continue;
				const normalized = normalizeSettingValue(path, lookup.value, layer.source);
				if (!normalized.ok) {
					diagnostics.push(normalized.diagnostic);
					continue;
				}
				if (merge !== undefined) {
					restrictiveValues.push(normalized.value);
					restrictiveSources.push(layer.source);
					if (resolvedSource === "default") resolvedSource = layer.source;
					continue;
				}
				resolved = freezeValue(normalized.value) as SettingValue;
				resolvedSource = layer.source;
				break;
			}
			if (merge !== undefined && restrictiveValues.length > 0) {
				resolved = mergeRestrictiveValues(merge, restrictiveValues);
				if (merge === "boolean_and" || merge === "number_min" || merge === "zero_unbounded_min") {
					for (let index = restrictiveValues.length - 1; index >= 0; index -= 1) {
						if (!Object.is(restrictiveValues[index], resolved)) continue;
						resolvedSource = restrictiveSources[index] ?? resolvedSource;
						break;
					}
				}
			}
			values.set(path, freezeValue(resolved) as SettingValue);
			sourceLayers[path] = resolvedSource;
		}

		this.#values = values;
		const snapshot: Record<string, unknown> = {};
		for (const [path, value] of values) assignPath(snapshot, path, value);
		this.#snapshot = freezeValue(snapshot) as SettingsSnapshot;
		this.#diagnostics = Object.freeze(diagnostics.map((item) => Object.freeze({ ...item })));
		this.#sourceLayers = Object.freeze({ ...sourceLayers });
		this.#digest = runtimeDigest({ settings: this.#snapshot, applyModes: APPLY_MODES });
	}

	/**
	 * 在已有解析结果上选择性采用另一个 source snapshot。
	 * Runtime store 用它实现 live/next-turn 边界，不重新读取 raw JSON，也不
	 * 让一个新的设置快照改变已经发出的 turn。
	 */
	public selectFrom(
		candidate: SettingsResolver,
		shouldAdopt: (definition: SettingDefinition) => boolean,
	): SettingsResolver {
		const values = new Map<SettingPath, SettingValue>();
		const sourceLayers = {} as Record<SettingPath, EffectiveSettingsSource>;
		for (const path of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
			const definition = SETTINGS_SCHEMA[path];
			const selected = shouldAdopt(definition) ? candidate : this;
			values.set(path, selected.#values.get(path));
			sourceLayers[path] = selected.#sourceLayers[path] ?? "default";
		}
		const diagnostics: SettingDiagnostic[] = [];
		for (const diagnostic of this.#diagnostics) {
			const definition = getSettingDefinition(diagnostic.path);
			if (definition === undefined || !shouldAdopt(definition)) diagnostics.push(diagnostic);
		}
		for (const diagnostic of candidate.#diagnostics) {
			const definition = getSettingDefinition(diagnostic.path);
			if (definition !== undefined && shouldAdopt(definition)) diagnostics.push(diagnostic);
		}
		return new SettingsResolver({}, { values, diagnostics, sourceLayers });
	}

	public get(path: SettingPath): SettingValue {
		if (getSettingDefinition(path) === undefined) throw new Error(`unknown settings path: ${path}`);
		return this.#values.get(path);
	}

	public source(path: SettingPath): EffectiveSettingsSource {
		if (getSettingDefinition(path) === undefined) throw new Error(`unknown settings path: ${path}`);
		return this.#sourceLayers[path] ?? "default";
	}

	public getGroup(group: SettingGroupName): SettingsGroupSnapshot {
		const result: Record<string, SettingValue> = {};
		for (const [path, definition] of Object.entries(SETTINGS_SCHEMA) as [SettingPath, (typeof SETTINGS_SCHEMA)[SettingPath]][]) {
			if (definition.group !== group) continue;
			const key = path.startsWith(`${group}.`) ? path.slice(group.length + 1) : path;
			result[key] = this.#values.get(path);
		}
		return Object.freeze(result);
	}

	public snapshot(): SettingsSnapshot {
		return this.#snapshot;
	}

	public diagnostics(): readonly SettingDiagnostic[] {
		return this.#diagnostics;
	}

	public effectiveRuntimeSnapshot(): EffectiveRuntimeSettingsSnapshot {
		const sourceLayers = this.#sourceLayers;
		const snapshot = Object.freeze({
			values: this.#snapshot,
			shellPath: this.get("shellPath") as string | undefined,
			retry: resolveRetryPolicy(this.getGroup("retry")),
			compaction: resolveCompactionPolicy(this.getGroup("compaction")),
			toolPolicy: resolveToolPolicy(this.getGroup("tools")),
			providerPolicy: resolveProviderPolicy(this.getGroup("providers")),
			git: resolveGitPolicy(this.getGroup("git")),
			plan: resolvePlanPolicy(this.getGroup("plan")),
			taskPolicy: resolveTaskPolicy(this.getGroup("task")),
			workspacePolicy: Object.freeze({
				additionalDirectories: Object.freeze([...(this.get("workspace.additionalDirectories") as readonly string[])]),
			}),
			sessionPolicy: Object.freeze({
				autoTitle: this.get("autoTitle") as boolean,
				steeringMode: this.get("steeringMode") as "one-at-a-time" | "all",
				followUpMode: this.get("followUpMode") as "one-at-a-time" | "all",
				memoryBackend: this.get("memory.backend") as "off" | "local",
			}),
			display: resolveDisplaySettings(this.#snapshot),
			startup: resolveStartupSettings(this.#snapshot),
			sourceLayers,
			applyModes: APPLY_MODES,
			diagnostics: this.#diagnostics,
			digest: runtimeDigest({ values: this.#snapshot, sourceLayers, applyModes: APPLY_MODES }),
		});
		return snapshot;
	}

	public digest(): RuntimeDigest {
		return this.#digest;
	}
}
