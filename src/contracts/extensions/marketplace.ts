/**
 * Plugin 分发与 marketplace 的磁盘契约。
 *
 * 两个 registry 与 omp/Claude 的磁盘形态保持字段兼容，便于既有
 * `.claude-plugin/marketplace.json` 与 `installed_plugins.json` 可读：
 *   - `MarketplacesRegistry`：用户添加了哪些 catalog（配置）；
 *   - `InstalledPluginsRegistry`：安装了哪些 plugin（数据）；
 *   - `RunledgerPluginsRegistry`：RunLedger 自有的安装/启用/features 账本。
 *
 * §5.2 冻结：Claude 侧字段保持原名，RunLedger 增量字段一律以 `runledger`
 * 前缀命名，不挤占上游命名空间。
 *
 * 这些 schema 描述 canonical home 下的**磁盘**文件形态，不是面向 client 或
 * 扩展负载的公共 DTO：其中的 installPath 属于本地 authority 上下文，禁止
 * 转发进模型请求、扩展事件载荷或 Web API 响应。
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import {
	EXTENSION_CONTRACT_BOUNDS,
	ExtensionDigestSchema,
	ExtensionDiskScopeSchema,
	ExtensionMarketplaceNameSchema,
	ExtensionPackageIdSchema,
	ExtensionPackageNameSchema,
	ExtensionSemverSchema,
	ExtensionTextSchema,
	ExtensionTimestampSchema,
} from "./common.ts";
import { ExtensionSettingsSchema } from "./manifest.ts";

// ── Plugin source 变体 ───────────────────────────────────────────────

export const MARKETPLACE_SOURCE_TYPES = Object.freeze(["github", "git", "url", "local"] as const);
export type MarketplaceSourceType = (typeof MARKETPLACE_SOURCE_TYPES)[number];

export const MarketplaceSourceTypeSchema = Type.Unsafe<MarketplaceSourceType>({
	type: "string",
	enum: [...MARKETPLACE_SOURCE_TYPES],
});

/** catalog 条目中的相对路径；必须 `./` 前缀并经 containment 校验。 */
export const MarketplaceRelativeSourceSchema = Type.String({
	minLength: 3,
	maxLength: 512,
	pattern: "^\\./.+$",
});

export const MarketplaceGithubSourceSchema = Type.Object(
	{
		source: Type.Literal("github"),
		repo: Type.String({ minLength: 3, maxLength: 256, pattern: "^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$" }),
		ref: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		sha: Type.Optional(Type.String({ minLength: 7, maxLength: 64, pattern: "^[0-9a-f]+$" })),
	},
	{ additionalProperties: false },
);

export const MarketplaceUrlSourceSchema = Type.Object(
	{
		source: Type.Literal("url"),
		url: Type.String({ minLength: 8, maxLength: 2_048, pattern: "^https://" }),
		ref: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		sha: Type.Optional(Type.String({ minLength: 7, maxLength: 64, pattern: "^[0-9a-f]+$" })),
	},
	{ additionalProperties: false },
);

export const MarketplaceGitSubdirSourceSchema = Type.Object(
	{
		source: Type.Literal("git-subdir"),
		url: Type.String({ minLength: 8, maxLength: 2_048, pattern: "^https://" }),
		path: Type.String({ minLength: 1, maxLength: 512, pattern: "^[^/].*$" }),
		ref: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		sha: Type.Optional(Type.String({ minLength: 7, maxLength: 64, pattern: "^[0-9a-f]+$" })),
	},
	{ additionalProperties: false },
);

/**
 * `npm` 变体被本计划显式拒绝（§3.2）：schema 接受它，是为了给出明确的
 * `plugin_source_unsupported` 诊断，而不是静默降级到别的 source。
 */
export const MarketplaceNpmSourceSchema = Type.Object(
	{
		source: Type.Literal("npm"),
		package: Type.String({ minLength: 1, maxLength: 214 }),
		version: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
		registry: Type.Optional(Type.String({ minLength: 8, maxLength: 2_048, pattern: "^https://" })),
	},
	{ additionalProperties: false },
);

export const MarketplacePluginSourceSchema = Type.Union([
	MarketplaceRelativeSourceSchema,
	MarketplaceGithubSourceSchema,
	MarketplaceUrlSourceSchema,
	MarketplaceGitSubdirSourceSchema,
	MarketplaceNpmSourceSchema,
]);

/** 受治理 fetch 支持的 source 类型。 */
export const MARKETPLACE_SUPPORTED_SOURCE_KINDS = Object.freeze(["path", "github", "url", "git-subdir"] as const);
/** 显式不支持的 source 类型；解析成功但安装必须报错。 */
export const MARKETPLACE_REJECTED_SOURCE_KINDS = Object.freeze(["npm"] as const);

// ── Marketplace catalog ──────────────────────────────────────────────

export const MarketplaceCatalogOwnerSchema = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 256 }),
		email: Type.Optional(Type.String({ maxLength: 320 })),
	},
	{ additionalProperties: false },
);

export const MarketplaceCatalogMetadataSchema = Type.Object(
	{
		description: Type.Optional(ExtensionTextSchema),
		version: Type.Optional(Type.String({ minLength: 1, maxLength: 128 })),
		/** 若非空，则前置到相对 plugin source 路径。 */
		pluginRoot: Type.Optional(Type.String({ minLength: 1, maxLength: 512, pattern: "^\\./" })),
	},
	{ additionalProperties: false },
);

export const MarketplacePluginEntrySchema = Type.Object(
	{
		name: ExtensionPackageNameSchema,
		source: MarketplacePluginSourceSchema,
		description: Type.Optional(ExtensionTextSchema),
		version: Type.Optional(ExtensionSemverSchema),
		author: Type.Optional(MarketplaceCatalogOwnerSchema),
		homepage: Type.Optional(Type.String({ maxLength: 2_048 })),
		repository: Type.Optional(Type.String({ maxLength: 2_048 })),
		license: Type.Optional(Type.String({ maxLength: 128 })),
		keywords: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 64 })),
		category: Type.Optional(Type.String({ maxLength: 128 })),
		tags: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 64 })),
		/** 严格模式：条目只按 manifest 的精确 shape 解析。 */
		strict: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export const MarketplaceCatalogSchema = Type.Object(
	{
		name: ExtensionMarketplaceNameSchema,
		owner: MarketplaceCatalogOwnerSchema,
		metadata: Type.Optional(MarketplaceCatalogMetadataSchema),
		plugins: Type.Array(MarketplacePluginEntrySchema, { maxItems: EXTENSION_CONTRACT_BOUNDS.catalogPlugins }),
	},
	{ additionalProperties: false },
);

/** catalog 文件的查找顺序：RunLedger 自有目录优先，Claude 目录回退。 */
export const MARKETPLACE_CATALOG_PATHS = Object.freeze([
	".runledger-plugin/marketplace.json",
	".omp-plugin/marketplace.json",
	".claude-plugin/marketplace.json",
] as const);

// ── MarketplacesRegistry（marketplaces.json，登记版本 1） ───────────

export const MarketplaceRegistryEntrySchema = Type.Object(
	{
		name: ExtensionMarketplaceNameSchema,
		sourceType: MarketplaceSourceTypeSchema,
		sourceUri: Type.String({ minLength: 1, maxLength: 2_048 }),
		/** catalog 在 cache 中的规范位置（locator，不含凭据）。 */
		catalogPath: Type.String({ minLength: 1, maxLength: 1_024 }),
		addedAt: ExtensionTimestampSchema,
		updatedAt: ExtensionTimestampSchema,
		/** RunLedger 增量：workspace scope 的存储键；user scope 省略。 */
		runledgerWorkspaceKey: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
		/** RunLedger 增量：上次成功解析的 catalog digest。 */
		runledgerCatalogDigest: Type.Optional(ExtensionDigestSchema),
	},
	{ additionalProperties: false },
);

export const MarketplacesRegistrySchema = Type.Object(
	{
		version: Type.Literal(1),
		marketplaces: Type.Array(MarketplaceRegistryEntrySchema, { maxItems: 256 }),
	},
	{ additionalProperties: false },
);

// ── InstalledPluginsRegistry（installed_plugins.json，登记版本 2） ──

export const InstalledPluginEntrySchema = Type.Object(
	{
		/** 磁盘沿用 Claude 的 `project` 表示 RunLedger 的 workspace scope。 */
		scope: ExtensionDiskScopeSchema,
		installPath: Type.String({ minLength: 1, maxLength: 2_048 }),
		version: ExtensionSemverSchema,
		installedAt: ExtensionTimestampSchema,
		lastUpdated: ExtensionTimestampSchema,
		gitCommitSha: Type.Optional(Type.String({ minLength: 7, maxLength: 64, pattern: "^[0-9a-f]+$" })),
		enabled: Type.Optional(Type.Boolean()),
		/** RunLedger 增量：内容 digest，trust receipt 绑定值（D8）。 */
		runledgerDigest: Type.Optional(ExtensionDigestSchema),
		/** RunLedger 增量：workspace scope 的存储键。 */
		runledgerWorkspaceKey: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
	},
	{ additionalProperties: false },
);

export const InstalledPluginsRegistrySchema = Type.Object(
	{
		version: Type.Literal(2),
		/** key 为 `name@marketplace`。 */
		plugins: Type.Record(ExtensionPackageIdSchema, Type.Array(InstalledPluginEntrySchema, { maxItems: 16 }), {
			maxProperties: 1_024,
		}),
	},
	{ additionalProperties: false },
);

// ── RunledgerPluginsRegistry（plugins/registry.json，登记版本 1） ──

/**
 * feature 选择：`null` = 只启用 manifest 中 `default: true` 的 feature；
 * `[]` = 全关；`[a,b]` = 精确集合。与安装语法 `pkg[a,b]` / `pkg[*]` /
 * `pkg[]` 对应。
 */
export const ExtensionEnabledFeaturesSchema = Type.Union([
	Type.Null(),
	Type.Array(Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9-]*$" }), { maxItems: 64 }),
]);

export const RunledgerPluginRecordSchema = Type.Object(
	{
		name: ExtensionPackageNameSchema,
		version: ExtensionSemverSchema,
		/** 安装时计算的 package 内容 digest。 */
		digest: ExtensionDigestSchema,
		scope: ExtensionDiskScopeSchema,
		enabled: Type.Boolean(),
		enabledFeatures: ExtensionEnabledFeaturesSchema,
		source: MarketplacePluginSourceSchema,
		marketplace: Type.Optional(ExtensionMarketplaceNameSchema),
		installedAt: ExtensionTimestampSchema,
		lastUpdated: ExtensionTimestampSchema,
		gitCommitSha: Type.Optional(Type.String({ minLength: 7, maxLength: 64, pattern: "^[0-9a-f]+$" })),
		runledgerWorkspaceKey: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
	},
	{ additionalProperties: false },
);

export const RunledgerPluginsRegistrySchema = Type.Object(
	{
		version: Type.Literal(1),
		/** key 为 `name@marketplace`；未绑定 marketplace 的本地 link 使用裸 name。 */
		plugins: Type.Record(Type.String({ minLength: 1, maxLength: 128 }), RunledgerPluginRecordSchema, {
			maxProperties: 1_024,
		}),
		/** plugin settings 的具体值；声明式 schema 在 manifest 中。 */
		settings: Type.Record(Type.String({ minLength: 1, maxLength: 128 }), ExtensionSettingsSchema, {
			maxProperties: 1_024,
		}),
	},
	{ additionalProperties: false },
);

/** marketplace autoUpdate 模式；`notify` 必须有真实可见出口，否则退化为 off（D10）。 */
export const MARKETPLACE_AUTO_UPDATE_MODES = Object.freeze(["off", "notify", "auto"] as const);
export type MarketplaceAutoUpdateMode = (typeof MARKETPLACE_AUTO_UPDATE_MODES)[number];
export const MarketplaceAutoUpdateModeSchema = Type.Unsafe<MarketplaceAutoUpdateMode>({
	type: "string",
	enum: [...MARKETPLACE_AUTO_UPDATE_MODES],
});

export type MarketplaceCatalog = Static<typeof MarketplaceCatalogSchema>;
export type MarketplacePluginEntry = Static<typeof MarketplacePluginEntrySchema>;
export type MarketplacePluginSource = Static<typeof MarketplacePluginSourceSchema>;
export type MarketplaceRegistryEntry = Static<typeof MarketplaceRegistryEntrySchema>;
export type MarketplacesRegistry = Static<typeof MarketplacesRegistrySchema>;
export type InstalledPluginEntry = Static<typeof InstalledPluginEntrySchema>;
export type InstalledPluginsRegistry = Static<typeof InstalledPluginsRegistrySchema>;
export type RunledgerPluginRecord = Static<typeof RunledgerPluginRecordSchema>;
export type RunledgerPluginsRegistry = Static<typeof RunledgerPluginsRegistrySchema>;
export type ExtensionEnabledFeatures = Static<typeof ExtensionEnabledFeaturesSchema>;

/** 安装命令接受的 source 形态：marketplace 条目或显式 spec。 */
export const ExtensionInstallSpecSchema = Type.Object(
	{
		/** `name@marketplace`；给出时不再猜测 name。 */
		packageId: Type.Optional(ExtensionPackageIdSchema),
		name: ExtensionPackageNameSchema,
		marketplace: Type.Optional(ExtensionMarketplaceNameSchema),
		source: MarketplacePluginSourceSchema,
		scope: Type.Unsafe<"user" | "workspace">({ type: "string", enum: ["user", "workspace"] }),
		enabledFeatures: ExtensionEnabledFeaturesSchema,
	},
	{ additionalProperties: false },
);

export type ExtensionInstallSpec = Static<typeof ExtensionInstallSpecSchema>;
