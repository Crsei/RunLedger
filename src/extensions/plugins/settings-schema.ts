/**
 * Plugin settings 的取值校验与分层授权（P5、D13）。
 *
 * manifest 只**声明** settings schema；具体值存放在 canonical home 的配置层里。
 * 分层规则沿用 Skill policy 的 master/narrow 语义：
 *   - `secret: true` 的键只在 user 层授权，workspace 层的取值被拒绝；
 *   - workspace 取值必须仍然是合法值（enum 必须落在声明集合内），不能靠
 *     workspace 层扩大取值面；
 *   - 覆盖发生时显式标记 `narrowed`，不做静默合并。
 */

import type { ExtensionSettingDescriptor } from "../../contracts/extensions/manifest.ts";

export type ExtensionSettingCode =
	| "unknown_setting"
	| "invalid_type"
	| "invalid_enum"
	| "invalid_bounds"
	| "secret_scope_denied";

export type ExtensionSettingParse =
	| { readonly ok: true; readonly value: string | number | boolean }
	| { readonly ok: false; readonly code: ExtensionSettingCode; readonly message: string };

export const EXTENSION_SETTING_BOUNDS = Object.freeze({
	maxStringCharacters: 4_096,
	minNumber: -1_000_000_000,
	maxNumber: 1_000_000_000,
});

/** 把 CLI/JSON 的原始输入按描述符解析成具体值。 */
export function parseExtensionSettingValue(descriptor: ExtensionSettingDescriptor, raw: unknown): ExtensionSettingParse {
	switch (descriptor.type) {
		case "string": {
			if (typeof raw !== "string") return { ok: false, code: "invalid_type", message: "setting requires a string value" };
			if (raw.length > EXTENSION_SETTING_BOUNDS.maxStringCharacters) return { ok: false, code: "invalid_bounds", message: "setting string exceeds the character bound" };
			return { ok: true, value: raw };
		}
		case "number": {
			const value = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
			if (typeof value !== "number" || !Number.isFinite(value)) return { ok: false, code: "invalid_type", message: "setting requires a finite number" };
			if (value < EXTENSION_SETTING_BOUNDS.minNumber || value > EXTENSION_SETTING_BOUNDS.maxNumber) return { ok: false, code: "invalid_bounds", message: "setting number is outside the allowed range" };
			return { ok: true, value };
		}
		case "boolean": {
			if (typeof raw === "boolean") return { ok: true, value: raw };
			if (raw === "true") return { ok: true, value: true };
			if (raw === "false") return { ok: true, value: false };
			return { ok: false, code: "invalid_type", message: "setting requires a boolean value" };
		}
		case "enum": {
			const declared = descriptor.values ?? [];
			if (declared.length === 0) return { ok: false, code: "invalid_enum", message: "enum setting declares no values" };
			if (typeof raw !== "string" || !declared.includes(raw)) return { ok: false, code: "invalid_enum", message: "setting value is not one of the declared enum values" };
			return { ok: true, value: raw };
		}
		default:
			return { ok: false, code: "invalid_type", message: "setting declares an unsupported type" };
	}
}

export interface ExtensionSettingLayer {
	readonly scope: "user" | "workspace";
	readonly values: Readonly<Record<string, unknown>>;
}

export type ExtensionSettingResolution =
	| { readonly ok: true; readonly values: Readonly<Record<string, string | number | boolean>>; readonly narrowed: readonly string[] }
	| { readonly ok: false; readonly code: ExtensionSettingCode; readonly key: string; readonly message: string };

/**
 * 合并 user → workspace 两层取值。workspace 只能覆盖非 secret 键，且覆盖值
 * 必须自身合法；被 workspace 覆盖的键记入 `narrowed`。
 */
export function resolvePluginSettings(
	declared: Readonly<Record<string, ExtensionSettingDescriptor>>,
	layers: readonly ExtensionSettingLayer[],
): ExtensionSettingResolution {
	const resolved: Record<string, string | number | boolean> = {};
	const narrowed: string[] = [];
	for (const layer of layers) {
		for (const [key, raw] of Object.entries(layer.values)) {
			const descriptor = declared[key];
			if (descriptor === undefined) return { ok: false, code: "unknown_setting", key, message: `setting is not declared by the plugin manifest: ${key}` };
			if (layer.scope === "workspace" && descriptor.secret === true) {
				return { ok: false, code: "secret_scope_denied", key, message: `secret setting can only be set in the user scope: ${key}` };
			}
			const parsed = parseExtensionSettingValue(descriptor, raw);
			if (!parsed.ok) return { ok: false, code: parsed.code, key, message: parsed.message };
			if (layer.scope === "workspace" && key in resolved) narrowed.push(key);
			resolved[key] = parsed.value;
		}
	}
	return { ok: true, values: Object.freeze({ ...resolved }), narrowed: narrowed.sort() };
}

/** 用 manifest 默认值补齐未显式设置的键。 */
export function applySettingDefaults(
	declared: Readonly<Record<string, ExtensionSettingDescriptor>>,
	values: Readonly<Record<string, string | number | boolean>>,
): Readonly<Record<string, string | number | boolean>> {
	const result: Record<string, string | number | boolean> = {};
	for (const [key, descriptor] of Object.entries(declared)) {
		const explicit = values[key];
		if (explicit !== undefined) { result[key] = explicit; continue; }
		if (descriptor.default === undefined) continue;
		const parsed = parseExtensionSettingValue(descriptor, descriptor.default);
		if (parsed.ok) result[key] = parsed.value;
	}
	return Object.freeze(result);
}

/** `plugin config validate` 的输出形状。 */
export function validatePluginSettings(
	declared: Readonly<Record<string, ExtensionSettingDescriptor>>,
	values: Readonly<Record<string, unknown>>,
): { readonly ok: true; readonly accepted: readonly string[] } | { readonly ok: false; readonly code: ExtensionSettingCode; readonly key: string; readonly message: string } {
	const accepted: string[] = [];
	for (const [key, raw] of Object.entries(values)) {
		const descriptor = declared[key];
		if (descriptor === undefined) return { ok: false, code: "unknown_setting", key, message: `setting is not declared by the plugin manifest: ${key}` };
		const parsed = parseExtensionSettingValue(descriptor, raw);
		if (!parsed.ok) return { ok: false, code: parsed.code, key, message: parsed.message };
		accepted.push(key);
	}
	return { ok: true, accepted: accepted.sort() };
}
