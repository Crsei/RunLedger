/**
 * ExtensionRegistrySnapshot：owner 侧不可变的扩展注册表投影。
 *
 * 注册表由 host 进程序列化回 owner（经 host 协议），owner 侧再校验、去重、
 * 加上 provenance 并投影为 `AgentTool`（D3）。host 自报的名字不是权威：
 * runtime name 唯一性与 sanitize 由 owner 在准入期决定。
 *
 * 本模块只描述形状与上限；不持有 host handle，也不执行注册。
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import {
	EXTENSION_CONTRACT_BOUNDS,
	ExtensionDigestSchema,
	ExtensionGenerationSchema,
	ExtensionPackageIdSchema,
	ExtensionRuntimeNameSchema,
} from "./common.ts";
import { ExtensionEventNameSchema } from "./events.ts";

/**
 * 工具在 owner 授权面上的分类。它是**声明**，用于决定 owner 侧默认策略与
 * presentation；实际授权仍逐调用解析，声明不能替代 authorization。
 */
export const EXTENSION_TOOL_APPROVAL_CLASSES = Object.freeze(["read-only", "mutating", "destructive"] as const);
export type ExtensionToolApprovalClass = (typeof EXTENSION_TOOL_APPROVAL_CLASSES)[number];

export const ExtensionToolApprovalClassSchema = Type.Unsafe<ExtensionToolApprovalClass>({
	type: "string",
	enum: [...EXTENSION_TOOL_APPROVAL_CLASSES],
});

/** 有界的 JSON Schema 文档；字节上限由消费者在序列化后校验。 */
export const ExtensionJsonSchemaSchema = Type.Record(Type.String(), Type.Unknown(), { maxProperties: 64 });

export const ExtensionToolRegistrationSchema = Type.Object(
	{
		name: ExtensionRuntimeNameSchema,
		description: Type.String({ minLength: 1, maxLength: 1_024 }),
		parameters: ExtensionJsonSchemaSchema,
		approvalClass: ExtensionToolApprovalClassSchema,
	},
	{ additionalProperties: false },
);

export const ExtensionCommandRegistrationSchema = Type.Object(
	{
		name: ExtensionRuntimeNameSchema,
		description: Type.String({ minLength: 1, maxLength: 1_024 }),
		argumentHint: Type.Optional(Type.String({ maxLength: 256 })),
	},
	{ additionalProperties: false },
);

export const ExtensionFlagRegistrationSchema = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9-]*$" }),
		description: Type.String({ minLength: 1, maxLength: 1_024 }),
		type: Type.Union([Type.Literal("boolean"), Type.Literal("string")]),
	},
	{ additionalProperties: false },
);

export const ExtensionEventSubscriptionSchema = Type.Object(
	{
		name: ExtensionEventNameSchema,
	},
	{ additionalProperties: false },
);

export const ExtensionHostLimitsSchema = Type.Object(
	{
		maxRegistrationsPerKind: Type.Integer({ minimum: 1, maximum: 4_096 }),
		maxEventPayloadBytes: Type.Integer({ minimum: 1, maximum: 1024 * 1024 }),
		handlerTimeoutMs: Type.Integer({ minimum: 1, maximum: 600_000 }),
		shutdownTimeoutMs: Type.Integer({ minimum: 1, maximum: 600_000 }),
		eventBudgetMs: Type.Integer({ minimum: 1, maximum: 600_000 }),
		maxInFlightEvents: Type.Integer({ minimum: 1, maximum: 64 }),
		maxRegistryBytes: Type.Integer({ minimum: 1, maximum: 16 * 1024 * 1024 }),
	},
	{ additionalProperties: false },
);

export const EXTENSION_DEFAULT_HOST_LIMITS: ExtensionHostLimits = Object.freeze({
	maxRegistrationsPerKind: EXTENSION_CONTRACT_BOUNDS.registrationsPerKind,
	maxEventPayloadBytes: EXTENSION_CONTRACT_BOUNDS.eventPayloadBytes,
	handlerTimeoutMs: EXTENSION_CONTRACT_BOUNDS.handlerTimeoutMs,
	shutdownTimeoutMs: EXTENSION_CONTRACT_BOUNDS.shutdownHandlerTimeoutMs,
	eventBudgetMs: EXTENSION_CONTRACT_BOUNDS.eventBudgetMs,
	maxInFlightEvents: EXTENSION_CONTRACT_BOUNDS.maxInFlightEvents,
	maxRegistryBytes: EXTENSION_CONTRACT_BOUNDS.registryBytes,
});

/**
 * snapshot 除 `generation` 外的字段；host 协议的 `registry` 帧复用同一份
 * schema，使单帧就是完整的注册表，避免 base 与 snapshot 两处 generation
 * 漂移。
 */
export const EXTENSION_REGISTRY_SNAPSHOT_FIELDS = Object.freeze({
	hostPid: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
	packageId: ExtensionPackageIdSchema,
	/** package 内容 digest；与 trust receipt 绑定，变化即 stale（D8）。 */
	digest: ExtensionDigestSchema,
	tools: Type.Array(ExtensionToolRegistrationSchema, { maxItems: EXTENSION_CONTRACT_BOUNDS.registrationsPerKind }),
	commands: Type.Array(ExtensionCommandRegistrationSchema, { maxItems: EXTENSION_CONTRACT_BOUNDS.registrationsPerKind }),
	flags: Type.Array(ExtensionFlagRegistrationSchema, { maxItems: EXTENSION_CONTRACT_BOUNDS.registrationsPerKind }),
	subscriptions: Type.Array(ExtensionEventSubscriptionSchema, { maxItems: EXTENSION_CONTRACT_BOUNDS.registrationsPerKind }),
	limits: ExtensionHostLimitsSchema,
});

export const ExtensionRegistrySnapshotSchema = Type.Object(
	{
		generation: ExtensionGenerationSchema,
		...EXTENSION_REGISTRY_SNAPSHOT_FIELDS,
	},
	{ additionalProperties: false },
);

export type ExtensionHostLimits = Static<typeof ExtensionHostLimitsSchema>;
export type ExtensionToolRegistration = Static<typeof ExtensionToolRegistrationSchema>;
export type ExtensionCommandRegistration = Static<typeof ExtensionCommandRegistrationSchema>;
export type ExtensionFlagRegistration = Static<typeof ExtensionFlagRegistrationSchema>;
export type ExtensionEventSubscription = Static<typeof ExtensionEventSubscriptionSchema>;
export type ExtensionRegistrySnapshot = Static<typeof ExtensionRegistrySnapshotSchema>;

/**
 * 注册表聚合 identity：只由已排序的注册内容与 package digest 决定，
 * 与 host pid 或到达顺序无关，便于测试与 receipt 复用。
 */
export const EXTENSION_REGISTRY_IDENTITY_FIELDS = Object.freeze([
	"packageId",
	"digest",
	"tools",
	"commands",
	"flags",
	"subscriptions",
	"limits",
] as const);
