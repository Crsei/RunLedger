/**
 * 扩展工具的准入（D3）。
 *
 * 扩展工具不进入“第二套工具表”：它们先经过本模块的准入，投影为带
 * provenance 的 `AgentTool`，再由 session composition 注册进既有
 * `ToolRegistry`。准入是**原子且拒绝制**的：
 *
 *   - manifest 必须显式声明 `capabilities.tools`，且注册的工具名必须在声明内；
 *   - runtime name 全局唯一，与 stdlib/base 保留名或其它扩展冲突即拒绝，
 *     不自动改名、不静默遮蔽（§11 风险表）；
 *   - 参数 JSON Schema 只接受有界的结构子集：禁止 `$ref`/`$defs`/`pattern`
 *     等可导致无界解析或 ReDoS 的关键字；
 *   - 每次执行仍然经过 `ToolRegistry` → authorization → attempt barrier →
 *     ExecutionGateway；准入只决定“能否出现在工具表里”。
 */

import type { AgentTool, AgentToolResult } from "../../runtime/types.ts";
import type { TSchema } from "typebox";
import type { ExtensionToolApprovalClass, ExtensionToolRegistration } from "../../contracts/extensions/registry.ts";

export interface ExtensionToolProvenance {
	readonly packageId: string;
	readonly digest: string;
	readonly generation: number;
	/** 扩展自己声明的名字；只用于审计与诊断。 */
	readonly declaredName: string;
	/** 进入 Agent 面的 runtime name；当前与 declaredName 相同（冲突即拒绝）。 */
	readonly runtimeName: string;
	readonly approvalClass: ExtensionToolApprovalClass;
}

export type ExtensionToolAdmissionCode =
	| "capability_not_declared"
	| "runtime_name_reserved"
	| "runtime_name_conflict"
	| "runtime_name_invalid"
	| "schema_not_object"
	| "schema_keyword_forbidden"
	| "schema_oversize"
	| "schema_invalid";

export interface ExtensionToolRejection {
	readonly packageId: string;
	readonly name: string;
	readonly code: ExtensionToolAdmissionCode;
	readonly message: string;
}

export interface AdmittedExtensionTool {
	readonly tool: AgentTool;
	readonly provenance: ExtensionToolProvenance;
}

export interface ExtensionToolAdmissionResult {
	readonly admitted: readonly AdmittedExtensionTool[];
	readonly rejected: readonly ExtensionToolRejection[];
}

/** 一次执行的入口由 session composition 注入；准入不持有 host handle。 */
export type ExtensionToolInvoker = (input: {
	readonly provenance: ExtensionToolProvenance;
	readonly toolCallId: string;
	readonly args: unknown;
	readonly signal?: AbortSignal;
}) => Promise<AgentToolResult<unknown>>;

export interface ExtensionToolPackage {
	readonly packageId: string;
	readonly digest: string;
	readonly generation: number;
	/** manifest `capabilities.tools`：允许注册的工具名集合。 */
	readonly declaredTools: readonly string[];
	readonly tools: readonly ExtensionToolRegistration[];
}

export interface ExtensionToolAdmissionOptions {
	readonly packages: readonly ExtensionToolPackage[];
	/** stdlib / base / MCP 等既有工具名；扩展不得占用。 */
	readonly reservedNames: readonly string[];
	readonly invoke: ExtensionToolInvoker;
	readonly maxToolSchemaBytes?: number;
	readonly maxSchemaDepth?: number;
	readonly maxSchemaNodes?: number;
}

const DEFAULT_MAX_SCHEMA_BYTES = 64 * 1024;
const DEFAULT_MAX_SCHEMA_DEPTH = 8;
const DEFAULT_MAX_SCHEMA_NODES = 512;
const RUNTIME_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

/**
 * 允许出现的 JSON Schema 关键字。刻意排除 `$ref`/`$defs`/`$id`/`$schema`
 * （无界解析）以及 `pattern`/`patternProperties`（用户可控正则 → ReDoS）。
 */
const ALLOWED_SCHEMA_KEYWORDS = new Set([
	"type",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"enum",
	"const",
	"description",
	"title",
	"default",
	"minimum",
	"maximum",
	"minLength",
	"maxLength",
	"minItems",
	"maxItems",
	"defaultProperties",
]);

/**
 * 归一化一个候选 runtime name。当前契约要求名字本身已合法（schema 层已
 * 校验）；本函数只做防御性归一化，不合法即返回 undefined，绝不静默改名。
 */
export function sanitizeExtensionRuntimeName(candidate: string): string | undefined {
	const trimmed = candidate.trim();
	if (!RUNTIME_NAME.test(trimmed)) return undefined;
	return trimmed;
}

interface SchemaScanResult {
	readonly ok: boolean;
	readonly code?: ExtensionToolAdmissionCode;
	readonly message?: string;
}

/** 值是“属性名 → 子 schema”映射的关键字；映射键是数据，不是关键字。 */
const SCHEMA_CHILD_MAP_KEYWORDS = new Set(["properties", "defaultProperties"]);
/** 值是单个子 schema 的关键字。 */
const SCHEMA_CHILD_KEYWORDS = new Set(["items", "additionalProperties"]);

/**
 * 结构扫描：只对 schema 位置递归，绝不把 `properties` 的属性名、`enum`/
 * `const`/`default` 的数据值或 `required` 的字符串数组当成关键字。
 */
function scanSchema(value: unknown, maxDepth: number, maxNodes: number): SchemaScanResult {
	let nodes = 0;
	const stack: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 1 }];
	while (stack.length > 0) {
		const current = stack.pop();
		if (current === undefined) break;
		nodes += 1;
		if (nodes > maxNodes) return { ok: false, code: "schema_oversize", message: `parameter schema exceeds ${maxNodes} nodes` };
		if (current.depth > maxDepth) return { ok: false, code: "schema_oversize", message: `parameter schema exceeds depth ${maxDepth}` };
		const item = current.value;
		if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
		for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
			if (!ALLOWED_SCHEMA_KEYWORDS.has(key)) {
				return { ok: false, code: "schema_keyword_forbidden", message: `parameter schema keyword is not allowed: ${key}` };
			}
			if (SCHEMA_CHILD_MAP_KEYWORDS.has(key)) {
				if (typeof child !== "object" || child === null || Array.isArray(child)) continue;
				for (const subschema of Object.values(child as Record<string, unknown>)) {
					if (typeof subschema === "object" && subschema !== null && !Array.isArray(subschema)) {
						stack.push({ value: subschema, depth: current.depth + 1 });
					}
				}
				continue;
			}
			if (SCHEMA_CHILD_KEYWORDS.has(key)) {
				if (typeof child === "object" && child !== null && !Array.isArray(child)) {
					stack.push({ value: child, depth: current.depth + 1 });
				}
				continue;
			}
		}
	}
	return { ok: true };
}

function schemaBytes(value: unknown): number {
	try {
		return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
	} catch {
		return Number.POSITIVE_INFINITY;
	}
}

function approvalFlags(approvalClass: ExtensionToolApprovalClass): Pick<AgentTool, "isReadOnly" | "isConcurrencySafe" | "isDestructive"> {
	if (approvalClass === "read-only") {
		return { isReadOnly: () => true, isConcurrencySafe: () => true };
	}
	if (approvalClass === "mutating") {
		return { isReadOnly: () => false, isConcurrencySafe: () => false };
	}
	return { isReadOnly: () => false, isConcurrencySafe: () => false, isDestructive: () => true };
}

function errorResult(code: string, message: string): AgentToolResult<{ readonly code: string; readonly message: string }> {
	return {
		content: [{ type: "text", text: JSON.stringify({ code, message }) ?? "null" }],
		details: { code, message },
		isError: true,
	};
}

/**
 * 准入一组 package 的注册工具。包按 `packages` 顺序处理，因此同名冲突的
 * 结果由加载顺序确定，并被显式记录为 rejection（而不是静默 first-wins）。
 */
export function admitExtensionTools(options: ExtensionToolAdmissionOptions): ExtensionToolAdmissionResult {
	const maxSchemaBytes = options.maxToolSchemaBytes ?? DEFAULT_MAX_SCHEMA_BYTES;
	const maxSchemaDepth = options.maxSchemaDepth ?? DEFAULT_MAX_SCHEMA_DEPTH;
	const maxSchemaNodes = options.maxSchemaNodes ?? DEFAULT_MAX_SCHEMA_NODES;
	const reserved = new Set(options.reservedNames);
	const claimed = new Map<string, string>();
	const admitted: AdmittedExtensionTool[] = [];
	const rejected: ExtensionToolRejection[] = [];
	const reject = (packageId: string, name: string, code: ExtensionToolAdmissionCode, message: string): void => {
		rejected.push({ packageId, name, code, message });
	};

	for (const source of options.packages) {
		const declared = new Set(source.declaredTools);
		for (const registration of source.tools) {
			const runtimeName = sanitizeExtensionRuntimeName(registration.name);
			if (runtimeName === undefined) {
				reject(source.packageId, registration.name, "runtime_name_invalid", "tool name is not a valid runtime name");
				continue;
			}
			if (!declared.has(runtimeName)) {
				reject(source.packageId, runtimeName, "capability_not_declared", `manifest does not declare capability for tool ${runtimeName}`);
				continue;
			}
			if (reserved.has(runtimeName)) {
				reject(source.packageId, runtimeName, "runtime_name_reserved", `tool name ${runtimeName} is reserved by the runtime`);
				continue;
			}
			const owner = claimed.get(runtimeName);
			if (owner !== undefined) {
				reject(source.packageId, runtimeName, "runtime_name_conflict", `tool name ${runtimeName} is already claimed by ${owner}`);
				continue;
			}
			const parameters: unknown = registration.parameters;
			if (typeof parameters !== "object" || parameters === null || Array.isArray(parameters)) {
				reject(source.packageId, runtimeName, "schema_not_object", "parameter schema must be a JSON object");
				continue;
			}
			if (schemaBytes(parameters) > maxSchemaBytes) {
				reject(source.packageId, runtimeName, "schema_oversize", `parameter schema exceeds ${maxSchemaBytes} bytes`);
				continue;
			}
			const scanned = scanSchema(parameters, maxSchemaDepth, maxSchemaNodes);
			if (!scanned.ok) {
				reject(source.packageId, runtimeName, scanned.code ?? "schema_invalid", scanned.message ?? "parameter schema is not acceptable");
				continue;
			}
			const schema = parameters as Record<string, unknown>;
			const declaredType = schema.type;
			if (declaredType !== undefined && declaredType !== "object") {
				reject(source.packageId, runtimeName, "schema_not_object", "parameter schema must describe an object");
				continue;
			}
			if (declaredType === undefined && schema.properties === undefined) {
				reject(source.packageId, runtimeName, "schema_not_object", "parameter schema must describe an object");
				continue;
			}

			const provenance: ExtensionToolProvenance = {
				packageId: source.packageId,
				digest: source.digest,
				generation: source.generation,
				declaredName: registration.name,
				runtimeName,
				approvalClass: registration.approvalClass,
			};
			claimed.set(runtimeName, source.packageId);
			const tool: AgentTool = {
				name: runtimeName,
				label: `${runtimeName} (${source.packageId})`,
				description: registration.description,
				parameters: parameters as TSchema,
				...approvalFlags(registration.approvalClass),
				execute: async (toolCallId, args, signal) => {
					try {
						return await options.invoke({
							provenance,
							toolCallId,
							args,
							...(signal === undefined ? {} : { signal }),
						});
					} catch {
						// 扩展侧失败不泄漏原始错误文本（可能含路径或 secret）。
						return errorResult("extension_tool_failed", "extension tool invocation failed");
					}
				},
			};
			admitted.push({ tool, provenance });
		}
	}

	return {
		admitted: Object.freeze(admitted.map((entry) => Object.freeze(entry))),
		rejected: Object.freeze(rejected.map((entry) => Object.freeze(entry))),
	};
}

export type ActiveToolSelection =
	| { readonly ok: true; readonly active: readonly string[] }
	| { readonly ok: false; readonly code: "unknown_tool" | "selection_limit_exceeded"; readonly names: readonly string[] };

/**
 * owner 侧决定 `setActiveTools` 的语义：扩展只能提交请求，不能自行改变
 * 可见工具集（D4）。未知名字整条拒绝，绝不做部分应用。
 */
export function resolveActiveToolSelection(input: {
	readonly requested: readonly string[];
	readonly admittedNames: readonly string[];
	readonly maxActive?: number;
}): ActiveToolSelection {
	const allowed = new Set(input.admittedNames);
	const unique = [...new Set(input.requested)];
	const maxActive = input.maxActive ?? 128;
	if (unique.length > maxActive) return { ok: false, code: "selection_limit_exceeded", names: unique.slice(maxActive) };
	const unknown = unique.filter((name) => !allowed.has(name));
	if (unknown.length > 0) return { ok: false, code: "unknown_tool", names: unique };
	return { ok: true, active: unique };
}
