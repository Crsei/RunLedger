/**
 * Extension package manifest 与 capability 声明合同。
 *
 * 磁盘形态是 `package.json#runledger`（D12）：RunLedger 自有键，不解释
 * `#omp` / `#pi`。未知顶层字段是 error，沿用现有 Plugin manifest 的严格性；
 * 已知字段只增加，不做兼容猜测。
 *
 * manifest 是**声明**而非授权：`capabilities` 只描述扩展打算使用什么，
 * 实际执行永远再次经过 owner 的 authorization 与 governed process。
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import {
	EXTENSION_CONTRACT_BOUNDS,
	ExtensionDescriptionSchema,
	ExtensionPackageNameSchema,
	ExtensionRelativePathSchema,
	ExtensionRuntimeNameSchema,
	ExtensionSemverSchema,
	ExtensionTextSchema,
} from "./common.ts";

/** 扩展事件投影的白名单名；具体目录由 `events.ts` 拥有。 */
export const EXTENSION_CAPABILITY_EVENT_PATTERN = "^[A-Za-z][A-Za-z0-9]*$";

export const ExtensionCapabilitySchema = Type.Object(
	{
		events: Type.Array(Type.String({ minLength: 1, maxLength: 64, pattern: EXTENSION_CAPABILITY_EVENT_PATTERN }), {
			maxItems: 64,
		}),
		tools: Type.Array(ExtensionRuntimeNameSchema, { maxItems: 64 }),
		filesystem: Type.Union([Type.Literal("none"), Type.Literal("read"), Type.Literal("write")]),
		process: Type.Union([Type.Literal(false), Type.Literal("governed")]),
		network: Type.Union([Type.Literal(false), Type.Literal("governed")]),
	},
	{ additionalProperties: false },
);

export const ExtensionSettingValueTypeSchema = Type.Unsafe<"string" | "number" | "boolean" | "enum">({
	type: "string",
	enum: ["string", "number", "boolean", "enum"],
});

/**
 * plugin settings 的声明式 schema。只描述类型与边界，不携带当前值；
 * 值存放于 canonical home 的 user/workspace 配置层，workspace 只能收窄。
 */
export const ExtensionSettingDescriptorSchema = Type.Object(
	{
		type: ExtensionSettingValueTypeSchema,
		description: Type.Optional(ExtensionTextSchema),
		/** `type: "enum"` 时必须非空且去重；其它类型必须省略。 */
		values: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 256 }), { maxItems: 64 })),
		default: Type.Optional(Type.Union([Type.String({ maxLength: 1_024 }), Type.Number(), Type.Boolean()])),
		/** secret 由 canonical secret 层解析，不写入 plugin 自有文件。 */
		secret: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export const ExtensionSettingsSchema = Type.Record(
	Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$" }),
	ExtensionSettingDescriptorSchema,
	{ maxProperties: 64 },
);

/**
 * feature 声明。`name` 与安装语法 `pkg[a,b]` 的选择项同名；`default: true`
 * 表示 `enabledFeatures === null`（未显式选择）时默认启用。声明是**选择域**，
 * 不是授权：启用某个 feature 不改变 capability/trust/enable 三层门禁。
 */
export const ExtensionFeatureDeclarationSchema = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9-]*$" }),
		description: Type.Optional(ExtensionTextSchema),
		default: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

const ExtensionPathDeclarationListSchema = Type.Array(ExtensionRelativePathSchema, {
	maxItems: EXTENSION_CONTRACT_BOUNDS.entrypointsPerPackage,
});

/**
 * executable entrypoint 声明。只接受 `.ts/.js/.mjs/.cjs`，且拒绝 `.d.ts`
 * 声明文件；与 omp 的 manifest 条目一致。自动扫描（约定目录）另有限制，
 * 由 P5 拥有。
 */
export const EXTENSION_ENTRYPOINT_PATTERN = "^(?!.*\\.d\\.ts$)\\./.+\\.(?:ts|js|mjs|cjs)$";
export const ExtensionEntrypointSchema = Type.String({
	minLength: 3,
	maxLength: 512,
	pattern: EXTENSION_ENTRYPOINT_PATTERN,
});

export const ExtensionPackageManifestSchema = Type.Object(
	{
		name: ExtensionPackageNameSchema,
		version: ExtensionSemverSchema,
		description: Type.Optional(ExtensionDescriptionSchema),
		author: Type.Optional(
			Type.Object({ name: Type.String({ minLength: 1, maxLength: 256 }) }, { additionalProperties: false }),
		),
		keywords: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 64 })),
		capabilities: ExtensionCapabilitySchema,
		/** 可执行扩展模块的相对路径；空数组表示纯声明式包。 */
		extensions: Type.Array(ExtensionEntrypointSchema, { maxItems: EXTENSION_CONTRACT_BOUNDS.entrypointsPerPackage }),
		/** 声明式命令定义路径；命令注册面由 owner 投影。 */
		commands: ExtensionPathDeclarationListSchema,
		skills: ExtensionPathDeclarationListSchema,
		hooks: ExtensionPathDeclarationListSchema,
		mcpServers: Type.Optional(ExtensionRelativePathSchema),
		/** feature 选择域；安装/后续选择只在这个集合内取值。 */
		features: Type.Optional(
			Type.Array(ExtensionFeatureDeclarationSchema, { maxItems: EXTENSION_CONTRACT_BOUNDS.featuresPerPackage }),
		),
		settings: Type.Optional(ExtensionSettingsSchema),
	},
	{ additionalProperties: false },
);

export type ExtensionCapability = Static<typeof ExtensionCapabilitySchema>;
export type ExtensionFeatureDeclaration = Static<typeof ExtensionFeatureDeclarationSchema>;
export type ExtensionSettingDescriptor = Static<typeof ExtensionSettingDescriptorSchema>;
export type ExtensionPackageManifest = Static<typeof ExtensionPackageManifestSchema>;

/** manifest 的已知顶层字段；未知字段一律 error（含 `omp`/`pi`）。 */
export const EXTENSION_PACKAGE_MANIFEST_KEYS = Object.freeze([
	"name",
	"version",
	"description",
	"author",
	"keywords",
	"capabilities",
	"extensions",
	"commands",
	"skills",
	"hooks",
	"mcpServers",
	"features",
	"settings",
] as const);

/** capability 的已知字段；与 `ExtensionPackageManifest` 同源。 */
export const EXTENSION_CAPABILITY_KEYS = Object.freeze([
	"events",
	"tools",
	"filesystem",
	"process",
	"network",
] as const);

export const EXTENSION_FILESYSTEM_MODES = Object.freeze(["none", "read", "write"] as const);
export const EXTENSION_GOVERNED_MODES = Object.freeze(["governed"] as const);
