/**
 * Extension host / registry / marketplace 合同的公共边界。
 *
 * 这些上限同时被 host 协议编解码、注册表序列化、marketplace 落盘与
 * intent 投影消费。字符限制不能替代序列化后的 UTF-8 字节限制：
 * 每个 byte 级上限都必须由消费者按编码后字节数再校验一次。
 *
 * 本模块只导出纯数据与 schema，不持有 raw handle，也不授予任何权限。
 */

import { Type } from "typebox";

export const EXTENSION_CONTRACT_BOUNDS = Object.freeze({
	/** 单帧 JSONL 上限（UTF-8 字节）。 */
	frameBytes: 512 * 1024,
	/** 单个事件载荷上限（UTF-8 字节）。 */
	eventPayloadBytes: 128 * 1024,
	/** 每类注册项（工具/命令/flag/订阅）数量上限。 */
	registrationsPerKind: 128,
	/** 注册表序列化总上限（UTF-8 字节）。 */
	registryBytes: 2 * 1024 * 1024,
	/** 单个工具参数 JSON Schema 上限（UTF-8 字节）。 */
	toolSchemaBytes: 64 * 1024,
	/** 标识符字符上限。 */
	idCharacters: 256,
	/** 展示文本字符上限。 */
	textCharacters: 4 * 1024,
	/** 单个 intent 载荷上限（UTF-8 字节）。 */
	intentBytes: 8 * 1024,
	/** handler 默认超时；shutdown 使用独立短预算。 */
	handlerTimeoutMs: 30_000,
	shutdownHandlerTimeoutMs: 2_000,
	/** 单次事件全部 handler 的预算。 */
	eventBudgetMs: 60_000,
	/** 并发 in-flight 事件上限。 */
	maxInFlightEvents: 4,
	/** 单个 package 可声明的 executable entrypoint 数量上限。 */
	entrypointsPerPackage: 32,
	/** 单个 package 可声明的 feature 数量上限（安装语法 `pkg[a,b]` 的选择域）。 */
	featuresPerPackage: 64,
	/** 单个 marketplace catalog 的 plugin 条目上限。 */
	catalogPlugins: 1_024,
	/** 单次 fetch 的响应体上限（UTF-8 字节）。 */
	fetchBytes: 16 * 1024 * 1024,
	/** 单次解包后的条目数与总字节上限。 */
	archiveEntries: 20_000,
	archiveBytes: 256 * 1024 * 1024,
});

/** 公共 ID/摘要 schema；marketplace 与 host 协议共用。 */
export const ExtensionDigestSchema = Type.String({ minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" });
export const ExtensionGenerationSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
export const ExtensionFrameIdSchema = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_.:-]+$" });
export const ExtensionRequestIdSchema = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_.:-]+$" });
export const ExtensionPackageNameSchema = Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$" });
export const ExtensionMarketplaceNameSchema = Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,62}[A-Za-z0-9])?$" });
/** `name@marketplace`，与 Claude 的 plugin ID 形态一致。 */
export const ExtensionPackageIdSchema = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9][A-Za-z0-9.-]*@[A-Za-z0-9][A-Za-z0-9.-]*$" });
export const ExtensionSemverSchema = Type.String({
	minLength: 1,
	maxLength: 128,
	pattern: "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)(?:-[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
});
/** 工具/命令在 Agent 面上的运行时名：owner 会 sanitize，但作者名必须先合法。 */
export const ExtensionRuntimeNameSchema = Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z][A-Za-z0-9_-]{0,63}$" });
export const ExtensionTextSchema = Type.String({ maxLength: EXTENSION_CONTRACT_BOUNDS.textCharacters });
export const ExtensionDescriptionSchema = Type.String({ minLength: 1, maxLength: 1_024 });
export const ExtensionTimestampSchema = Type.String({ minLength: 1, maxLength: 64 });
/** manifest 与 marketplace 目录中的相对声明路径。 */
export const ExtensionRelativePathSchema = Type.String({ minLength: 1, maxLength: 512, pattern: "^\\./" });

export const ExtensionPackageScopeSchema = Type.Unsafe<"user" | "workspace">({
	type: "string",
	enum: ["user", "workspace"],
});
/** Claude 兼容磁盘形态使用 `project` 表示非 user scope。 */
export const ExtensionDiskScopeSchema = Type.Unsafe<"user" | "project">({
	type: "string",
	enum: ["user", "project"],
});

export type ExtensionPackageScope = "user" | "workspace";
export type ExtensionDiskScope = "user" | "project";
