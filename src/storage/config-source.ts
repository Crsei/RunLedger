/**
 * 配置文件载体的双格式（JSON / YAML）定位与文本解析。
 *
 * 本模块只做两件事：**定位实际生效的候选文件**、**把文本解析成未知值**。它不碰
 * 任何 schema —— authority、fail-closed、字段清洗仍由各载体既有的 sanitizer /
 * typebox schema 负责（Plan 22 §4.1：YAML 只承担语法层替代）。
 *
 * 优先级（Plan 22 §4.3 裁定 D2 = B）：`<base>.yaml` > `<base>.yml` > `<base>.json`。
 * `.yaml` 与 `.yml` 同时存在属于同格式冲突，按诊断报错而不是猜优先级。
 */

import { readFile, stat } from "node:fs/promises";
import { parseDocument } from "yaml";

export type ConfigFormat = "json" | "yaml";

export interface ConfigCandidate {
	readonly path: string;
	readonly format: ConfigFormat;
}

/** 载体解析结果：只描述「哪个文件生效」，不读内容。 */
export type ConfigSourceResolution =
	| { readonly status: "absent" }
	/** `.yaml` 与 `.yml` 同时存在，无法确定作者意图。 */
	| { readonly status: "ambiguous"; readonly paths: readonly string[] }
	| {
			readonly status: "resolved";
			readonly path: string;
			readonly format: ConfigFormat;
			/** 已存在但因优先级被遮蔽的同载体文件（YAML 优先时的 `.json`）。 */
			readonly shadowed: readonly string[];
	  };

/** 载体读取 + 解析结果。 */
export type ConfigDocumentRead =
	| { readonly status: "absent" }
	| { readonly status: "ambiguous"; readonly paths: readonly string[] }
	| { readonly status: "unreadable"; readonly path: string; readonly format: ConfigFormat }
	| { readonly status: "invalid"; readonly path: string; readonly format: ConfigFormat }
	| {
			readonly status: "ok";
			readonly path: string;
			readonly format: ConfigFormat;
			readonly value: unknown;
			readonly shadowed: readonly string[];
	  };

/** 解析失败。调用方据此降级（settings 段失效 / recording 关闭 / 返回默认偏好）。 */
export class ConfigParseError extends Error {
	readonly format: ConfigFormat;

	constructor(format: ConfigFormat, reason: string) {
		super(`invalid ${format} config document: ${reason}`);
		this.name = "ConfigParseError";
		this.format = format;
	}
}

const JSON_SUFFIX = ".json";

/**
 * YAML 1.2 core schema + 严格键。
 *
 * - `version: "1.2"` / `schema: "core"`：`yes`/`no`/`on`/`off` 保持字符串，
 *   时间戳不隐式转 Date —— 避免 YAML 1.1 的隐式类型转换产生与 JSON 不同的值。
 * - `uniqueKeys`：重复键直接报错，不静默取最后一个。
 * - `merge: true`：允许 `<<` 合并键。合并只发生在**同一文件内**，结果仍要过同一
 *   sanitizer，不会绕过 authority；关掉它会把 `<<:` 变成普通键并被静默丢弃。
 * - `maxAliasCount`：alias 展开上限，防「billion laughs」式资源耗尽。
 */
const YAML_PARSE_OPTIONS = {
	version: "1.2",
	schema: "core",
	merge: true,
	uniqueKeys: true,
	maxAliasCount: 100,
} as const;

/** 列出同一载体的候选文件，按生效优先级排列（YAML 优先）。 */
export function configCandidatePaths(jsonPath: string): readonly ConfigCandidate[] {
	if (!jsonPath.endsWith(JSON_SUFFIX)) {
		throw new Error(`config candidate base must end with ${JSON_SUFFIX}: ${jsonPath}`);
	}
	const base = jsonPath.slice(0, -JSON_SUFFIX.length);
	return Object.freeze([
		Object.freeze({ path: `${base}.yaml`, format: "yaml" as const }),
		Object.freeze({ path: `${base}.yml`, format: "yaml" as const }),
		Object.freeze({ path: jsonPath, format: "json" as const }),
	]);
}

/**
 * 文本 → 未知值。JSON 与 YAML 对**同一语义**的文档必须返回逐字段相同的值。
 *
 * 空文档（含只有空白/BOM）在两种格式下都按解析失败处理：`JSON.parse("")` 本来就
 * 抛错，而 YAML 会得到 `null`。统一成失败既保持了 JSON 的既有行为（settings 空
 * 文件仍会关闭 recording 并输出诊断），也让两种格式的结论一致。
 */
export function parseConfigText(text: string, format: ConfigFormat): unknown {
	const normalized = stripBom(text);
	if (normalized.trim().length === 0) throw new ConfigParseError(format, "empty document");
	if (format === "json") {
		try {
			return JSON.parse(normalized) as unknown;
		} catch (error) {
			throw new ConfigParseError(format, reasonOf(error));
		}
	}
	const document = parseDocument(normalized, YAML_PARSE_OPTIONS);
	const failure = document.errors[0] ?? document.warnings[0];
	// 告警也按失败处理：未知 tag 之类的构造只产生 warning，静默接受等于让用户
	// 以为自己写的语义生效了。
	if (failure !== undefined) throw new ConfigParseError(format, reasonOf(failure));
	try {
		return document.toJS({ maxAliasCount: YAML_PARSE_OPTIONS.maxAliasCount });
	} catch (error) {
		throw new ConfigParseError(format, reasonOf(error));
	}
}

/** 定位该载体实际生效的文件；不读内容，供写入方判断能否安全写 JSON。 */
export async function resolveConfigSource(jsonPath: string): Promise<ConfigSourceResolution> {
	const existing: ConfigCandidate[] = [];
	for (const candidate of configCandidatePaths(jsonPath)) {
		if (await isFile(candidate.path)) existing.push(candidate);
	}
	if (existing.length === 0) return Object.freeze({ status: "absent" as const });
	const yamlCount = existing.filter((candidate) => candidate.format === "yaml").length;
	if (yamlCount > 1) {
		return Object.freeze({
			status: "ambiguous" as const,
			paths: Object.freeze(existing.filter((candidate) => candidate.format === "yaml").map((candidate) => candidate.path)),
		});
	}
	// existing 继承 configCandidatePaths 的优先级顺序，首项即生效文件。
	const winner = existing[0];
	const shadowed = existing.slice(1).map((candidate) => candidate.path);
	return Object.freeze({
		status: "resolved" as const,
		path: winner.path,
		format: winner.format,
		shadowed: Object.freeze(shadowed),
	});
}

/**
 * 读取并解析生效文件。
 *
 * 解析失败与读取失败都返回结构化状态而不是抛错：各载体对「坏配置」的处置不同
 * （settings 段失效 / 关闭 recording / 回退默认偏好），由调用方决定降级方式。
 */
export async function readConfigDocument(jsonPath: string): Promise<ConfigDocumentRead> {
	const source = await resolveConfigSource(jsonPath);
	if (source.status === "absent") return Object.freeze({ status: "absent" as const });
	if (source.status === "ambiguous") return source;
	let text: string;
	try {
		text = await readFile(source.path, "utf8");
	} catch {
		return Object.freeze({ status: "unreadable" as const, path: source.path, format: source.format });
	}
	let value: unknown;
	try {
		value = parseConfigText(text, source.format);
	} catch {
		return Object.freeze({ status: "invalid" as const, path: source.path, format: source.format });
	}
	if (source.shadowed.length > 0) emitShadowedDiagnostic(source.path, source.shadowed);
	return Object.freeze({
		status: "ok" as const,
		path: source.path,
		format: source.format,
		value,
		shadowed: source.shadowed,
	});
}

/** 双文件并存时的显式诊断：不允许静默忽略被遮蔽的那份（Plan 22 §4.3 约束 1）。 */
function emitShadowedDiagnostic(winner: string, shadowed: readonly string[]): void {
	process.stderr.write(`[runledger] config_shadowed; using ${winner}, ignoring ${shadowed.join(", ")}\n`);
}

function stripBom(text: string): string {
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message.split("\n")[0] ?? error.message : String(error);
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}
