/** Canonical settings list/get/set/reset service。CLI/TUI 共用这一条写入路径。 */

import {
	loadProjectSettings,
	updateProjectSettings,
	type ProjectSettings,
} from "./settings-manager.ts";
import {
	getSettingDefinition,
	normalizeSettingValue,
	SETTINGS_SCHEMA,
	type SettingApplyMode,
	type SettingDiagnostic,
	type SettingPath,
	type SettingScope,
	type SettingValue,
} from "./settings-schema.ts";
import { SettingsResolver } from "./settings-resolver.ts";
import type { RunledgerLayout } from "../runtime/contracts/storage-layout.ts";

export interface SettingsServiceOptions {
	readonly layout: RunledgerLayout;
	readonly workspaceKey?: string;
}

export interface SettingListItem {
	readonly path: SettingPath;
	readonly defaultValue: SettingValue;
	readonly scope: readonly SettingScope[];
	readonly apply: SettingApplyMode;
	readonly secret: false;
}

export interface SettingValueResult {
	readonly path: SettingPath;
	readonly value: SettingValue;
	readonly source: "default" | "user" | "workspace";
}

export type SettingsCommandErrorCode = SettingDiagnostic["code"] | "invalid_workspace_key";

export class SettingsCommandError extends Error {
	public readonly code: SettingsCommandErrorCode;
	public readonly path: string;

	public constructor(code: SettingsCommandErrorCode, path: string, message: string) {
		super(message);
		this.name = "SettingsCommandError";
		this.code = code;
		this.path = path;
	}
}

function settingsScope(workspaceKey: string | undefined): "user" | "workspace" {
	return workspaceKey === undefined ? "user" : "workspace";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setPath(settings: Record<string, unknown>, path: string, value: SettingValue): void {
	const segments = path.split(".");
	let current = settings;
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

function deletePath(settings: Record<string, unknown>, path: string): void {
	const segments = path.split(".");
	const parents: Array<{ readonly record: Record<string, unknown>; readonly key: string }> = [];
	let current: Record<string, unknown> = settings;
	for (const segment of segments.slice(0, -1)) {
		const next = current[segment];
		if (!isRecord(next)) return;
		parents.push({ record: current, key: segment });
		current = next;
	}
	const leaf = segments[segments.length - 1];
	if (leaf === undefined) return;
	delete current[leaf];
	for (let index = parents.length - 1; index >= 0; index -= 1) {
		const parent = parents[index]!;
		const child = parent.record[parent.key];
		if (isRecord(child) && Object.keys(child).length === 0) delete parent.record[parent.key];
	}
}

function commandError(result: Extract<ReturnType<typeof normalizeSettingValue>, { readonly ok: false }>): SettingsCommandError {
	return new SettingsCommandError(result.diagnostic.code, result.diagnostic.path, result.diagnostic.message);
}

export function parseSettingCliValue(text: string): SettingValue {
	const trimmed = text.trim();
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(trimmed)) {
		const number = Number(trimmed);
		if (Number.isFinite(number)) return number;
	}
	if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (typeof parsed === "string") return parsed;
		} catch {
			// 保持为普通字符串；后续 schema normalize 会给出稳定错误。
		}
	}
	if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (Array.isArray(parsed) && parsed.every((item): item is string => typeof item === "string")) return parsed;
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				!Array.isArray(parsed) &&
				Object.values(parsed as Record<string, unknown>).every(
					(item): item is number => typeof item === "number" && Number.isFinite(item),
				)
			) return parsed as Readonly<Record<string, number>>;
		} catch {
			// 保持为普通字符串；后续 schema normalize 会给出稳定错误。
		}
	}
	return text;
}

export class SettingsService {
	readonly #options: SettingsServiceOptions;
	readonly #scope: "user" | "workspace";

	public constructor(options: SettingsServiceOptions) {
		this.#options = options;
		this.#scope = settingsScope(options.workspaceKey);
	}

	public async list(): Promise<readonly SettingListItem[]> {
		return Object.values(SETTINGS_SCHEMA)
			.filter((definition) => definition.scope.includes(this.#scope))
			.map((definition) => Object.freeze({
				path: definition.path,
				defaultValue: definition.defaultValue,
				scope: definition.scope,
				apply: definition.apply,
				secret: false as const,
			}));
	}

	public async get(path: string): Promise<SettingValueResult> {
		const definition = this.assertPath(path);
		const user = await loadProjectSettings({ layout: this.#options.layout });
		const workspace = this.#scope === "workspace"
			? await loadProjectSettings(this.#options)
			: undefined;
		const resolver = new SettingsResolver({
			user,
			...(workspace === undefined ? {} : { workspace }),
		});
		return {
			path: definition.path,
			value: resolver.get(definition.path),
			source: resolver.source(definition.path) as SettingValueResult["source"],
		};
	}

	public async set(path: string, value: unknown): Promise<SettingValueResult> {
		const definition = this.assertPath(path);
		const normalized = normalizeSettingValue(definition.path, value, this.#scope);
		if (!normalized.ok) throw commandError(normalized);
		await updateProjectSettings(this.#options, (current) => {
			const next: Record<string, unknown> = { ...current };
			setPath(next, definition.path, normalized.value);
			return next as ProjectSettings;
		});
		return this.get(definition.path);
	}

	public async reset(path: string): Promise<SettingValueResult> {
		const definition = this.assertPath(path);
		await updateProjectSettings(this.#options, (current) => {
			const next: Record<string, unknown> = { ...current };
			deletePath(next, definition.path);
			return next as ProjectSettings;
		});
		return this.get(definition.path);
	}

	private assertPath(path: string) {
		const definition = getSettingDefinition(path);
		if (definition === undefined) throw new SettingsCommandError("unknown_path", path, "setting path is not supported");
		if (!definition.scope.includes(this.#scope)) {
			throw new SettingsCommandError("scope_not_allowed", path, `${this.#scope} scope cannot own this setting`);
		}
		return definition;
	}
}
