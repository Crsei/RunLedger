import type {
	ComposerShapeDefinition,
	ComposerShapeInstallResult,
	ComposerShapeRegistry,
} from "./registry.ts";

/**
 * TUI composition root 明确提供的 first-party source。
 *
 * 该 seam 不读取插件目录、不执行动态 import，也不携带 OpenTUI handle。
 * source 的 load 函数只能由受信任的 composition code 提供；用户插件的
 * manifest/snapshot 不可直接转换为此类型。
 */
export interface TrustedComposerShapeSource {
	readonly extensionId: string;
	readonly load: () => readonly ComposerShapeDefinition[];
}

export type ComposerShapeLifecycleDiagnostic =
	| { readonly code: "invalid_source"; readonly sourceId: string; readonly fallback: "box" }
	| { readonly code: "duplicate_source"; readonly sourceId: string; readonly fallback: "box" }
	| { readonly code: "registration_failed"; readonly sourceId: string; readonly fallback: "previous" | "box" };

export type ComposerShapeLifecycleResult =
	| { readonly ok: true; readonly installed: readonly string[] }
	| { readonly ok: false; readonly diagnostic: ComposerShapeLifecycleDiagnostic };

export interface ComposerShapeLifecycle {
	load(): ComposerShapeLifecycleResult;
	reload(): ComposerShapeLifecycleResult;
	dispose(): void;
}

/** 只有 composition root 应调用此 factory；不提供插件模块加载能力。 */
export function createTrustedComposerShapeSource(
	extensionId: string,
	load: () => readonly ComposerShapeDefinition[],
): TrustedComposerShapeSource {
	return Object.freeze({ extensionId, load });
}

interface ActiveSource {
	readonly source: TrustedComposerShapeSource;
	readonly definitions: readonly ComposerShapeDefinition[];
	readonly disposers: readonly (() => void)[];
}

interface SourceInstall {
	readonly source: TrustedComposerShapeSource;
	readonly definitions: readonly ComposerShapeDefinition[];
	readonly disposers: readonly (() => void)[];
}

interface RegistrationFailure {
	readonly ok: false;
	readonly diagnostic: ComposerShapeLifecycleDiagnostic;
}

/**
 * 为一个 TUI 进程维护 trusted composer contribution 的生命周期。
 * reload 采用先卸载、后安装、失败恢复上一份 definitions 的事务语义；
 * registry 自身仍是 builtin protection 与 definition validation 的最终边界。
 */
export function createTrustedComposerShapeLifecycle(
	registry: ComposerShapeRegistry,
	sources: readonly TrustedComposerShapeSource[],
): ComposerShapeLifecycle {
	let active: readonly ActiveSource[] = [];

	const disposeInstallations = (installations: readonly SourceInstall[] | readonly ActiveSource[]): void => {
		for (const installation of [...installations].reverse()) {
			for (const dispose of [...installation.disposers].reverse()) dispose();
		}
	};

	const installDefinitions = (
		source: TrustedComposerShapeSource,
		definitions: readonly ComposerShapeDefinition[],
	): SourceInstall | RegistrationFailure => {
		const disposers: Array<() => void> = [];
		for (const definition of definitions) {
			const installed: ComposerShapeInstallResult = registry.installExtensionComposerShape(definition);
			if (!installed.ok) {
				for (const dispose of disposers.reverse()) dispose();
				return {
					ok: false,
					diagnostic: {
						code: "registration_failed",
						sourceId: source.extensionId,
						fallback: "previous",
					},
				};
			}
			disposers.push(installed.dispose);
		}
		return { source, definitions: Object.freeze([...definitions]), disposers: Object.freeze(disposers) };
	};

	const validateSources = (): ComposerShapeLifecycleDiagnostic | undefined => {
		const seen = new Set<string>();
		for (const source of sources) {
			const sourceId = typeof source?.extensionId === "string" ? source.extensionId : "unknown";
			if (source === undefined || source === null || typeof source.extensionId !== "string" || sourceId.length === 0 || sourceId !== sourceId.trim() || typeof source.load !== "function") {
				return { code: "invalid_source", sourceId, fallback: "box" };
			}
			if (seen.has(sourceId)) return { code: "duplicate_source", sourceId, fallback: "box" };
			seen.add(sourceId);
		}
		return undefined;
	};

	const loadDefinitions = ():
		| { readonly ok: true; readonly entries: readonly { readonly source: TrustedComposerShapeSource; readonly definitions: readonly ComposerShapeDefinition[] }[] }
		| { readonly ok: false; readonly diagnostic: ComposerShapeLifecycleDiagnostic } => {
		const entries: Array<{ readonly source: TrustedComposerShapeSource; readonly definitions: readonly ComposerShapeDefinition[] }> = [];
		for (const source of sources) {
			try {
				const definitions: unknown = source.load();
				if (!Array.isArray(definitions)) {
					return { ok: false, diagnostic: { code: "invalid_source", sourceId: source.extensionId, fallback: "box" } };
				}
				entries.push({ source, definitions: definitions as readonly ComposerShapeDefinition[] });
			} catch {
				return { ok: false, diagnostic: { code: "registration_failed", sourceId: source.extensionId, fallback: active.length > 0 ? "previous" : "box" } };
			}
		}
		return { ok: true, entries };
	};

	const apply = (): ComposerShapeLifecycleResult => {
		const validation = validateSources();
		if (validation !== undefined) return { ok: false, diagnostic: validation };
		const loaded = loadDefinitions();
		if (!loaded.ok) return loaded;

		const previous = active;
		active = [];
		disposeInstallations(previous);
		const next: SourceInstall[] = [];
		for (const entry of loaded.entries) {
			const installed = installDefinitions(entry.source, entry.definitions);
			if ("ok" in installed) {
				disposeInstallations(next);
				const restored: ActiveSource[] = [];
				for (const old of previous) {
					const oldInstalled = installDefinitions(old.source, old.definitions);
					if ("ok" in oldInstalled) {
						active = [];
						return installed;
					}
					restored.push(oldInstalled);
				}
				active = restored;
				return installed;
			}
			next.push(installed);
		}
		active = next.map((entry) => ({ ...entry }));
		return { ok: true, installed: sources.map((source) => source.extensionId) };
	};

	const currentResult = (): ComposerShapeLifecycleResult => ({
		ok: true,
		installed: active.map((entry) => entry.source.extensionId),
	});

	return Object.freeze({
		load: (): ComposerShapeLifecycleResult => active.length === 0 ? apply() : currentResult(),
		reload: apply,
		dispose: () => {
			const current = active;
			active = [];
			disposeInstallations(current);
		},
	});
}
