/**
 * Extension host 协议（版本 1）。
 *
 * 每个 owned Session 拥有 0..1 个 extension host 子进程（D1），由既有
 * governed managed process 能力创建。扩展工厂在该进程内求值，注册结果经
 * 本协议序列化回 owner。协议是 owner 与 host 之间**唯一**的通道：host 没有
 * store、settings 或 trust 文件的句柄，也不能直接写任何 authority。
 *
 * 帧集合在 P0 冻结为最小 7 类（§12 风险缓解）。每帧必有
 * `protocolVersion` 与 `generation`；跨 generation 的帧一律拒绝。
 * `result` 是对面请求的应答，方向与请求相反，靠 `requestId` 关联。
 *
 * 本模块只描述帧形状；编解码、半包、UTF-8 字节上限与版本校验由
 * `src/extensions/host/protocol.ts` 实现。契约模块不做 I/O。
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import {
	EXTENSION_CONTRACT_BOUNDS,
	ExtensionDigestSchema,
	ExtensionFrameIdSchema,
	ExtensionGenerationSchema,
	ExtensionPackageIdSchema,
	ExtensionRequestIdSchema,
} from "./common.ts";
import { ExtensionIntentSchema } from "./intent.ts";
import { EXTENSION_REGISTRY_SNAPSHOT_FIELDS, ExtensionHostLimitsSchema } from "./registry.ts";

export const EXTENSION_HOST_PROTOCOL_VERSION = 1;

export const EXTENSION_HOST_FRAME_KINDS = Object.freeze([
	"hello",
	"registry",
	"event",
	"action",
	"result",
	"error",
	"shutdown",
] as const);

export type ExtensionHostFrameKind = (typeof EXTENSION_HOST_FRAME_KINDS)[number];

/** 帧方向：`result` 的发送方是对面请求的接收方。 */
export const EXTENSION_HOST_FRAME_DIRECTIONS = Object.freeze({
	hello: "host_to_owner",
	registry: "host_to_owner",
	event: "owner_to_host",
	action: "host_to_owner",
	result: "response",
	error: "both",
	shutdown: "both",
} as const);

/**
 * host 可请求的运行时动作（D4）。全部经 Session protocol 的 mutate/read
 * 路径 + attempt barrier + receipt；host 侧只是发起意图。`service-tier`
 * 与 provider 动态模型注册不在本次范围（§13）。
 */
export const EXTENSION_HOST_ACTION_NAMES = Object.freeze([
	"send-message",
	"send-user-message",
	"append-entry",
	"set-active-tools",
	"set-model",
	"set-thinking-level",
	"set-session-name",
	"exec",
	"intent",
] as const);

export type ExtensionHostActionName = (typeof EXTENSION_HOST_ACTION_NAMES)[number];

export const ExtensionHostActionNameSchema = Type.Unsafe<ExtensionHostActionName>({
	type: "string",
	enum: [...EXTENSION_HOST_ACTION_NAMES],
});

export const ExtensionHostShutdownReasons = Object.freeze([
	"host-exit",
	"owner-request",
	"protocol-violation",
	"budget-exceeded",
	"generation-replaced",
] as const);

export type ExtensionHostShutdownReason = (typeof ExtensionHostShutdownReasons)[number];

const FrameBase = {
	protocolVersion: Type.Literal(EXTENSION_HOST_PROTOCOL_VERSION),
	generation: ExtensionGenerationSchema,
	frameId: ExtensionFrameIdSchema,
};

const ExtensionHostErrorPayloadSchema = Type.Object(
	{
		code: Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z][a-z0-9_]*$" }),
		message: Type.String({ minLength: 1, maxLength: 1_024 }),
		/** 可选关联请求；自由错误没有 requestId。 */
		requestId: Type.Optional(ExtensionRequestIdSchema),
	},
	{ additionalProperties: false },
);

export const ExtensionHostHelloFrameSchema = Type.Object(
	{
		...FrameBase,
		kind: Type.Literal("hello"),
		hostPid: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
		packageId: ExtensionPackageIdSchema,
		digest: ExtensionDigestSchema,
		/** host 侧 API 版本；与 owner 期望不一致即握手失败。 */
		apiVersion: Type.String({ minLength: 1, maxLength: 64, pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$" }),
		limits: ExtensionHostLimitsSchema,
	},
	{ additionalProperties: false },
);

export const ExtensionHostRegistryFrameSchema = Type.Object(
	{
		...FrameBase,
		kind: Type.Literal("registry"),
		...EXTENSION_REGISTRY_SNAPSHOT_FIELDS,
	},
	{ additionalProperties: false },
);

export const ExtensionHostEventFrameSchema = Type.Object(
	{
		...FrameBase,
		kind: Type.Literal("event"),
		requestId: ExtensionRequestIdSchema,
		name: Type.String({ minLength: 1, maxLength: 64 }),
		cancelable: Type.Boolean(),
		/** 已按投影白名单裁剪；字节上限由消费者在序列化后校验。 */
		payload: Type.Record(Type.String(), Type.Unknown(), { maxProperties: 32 }),
		/** handler 预算；owner 侧取本值与事件预算的较小者。 */
		deadlineMs: Type.Integer({ minimum: 1, maximum: 600_000 }),
	},
	{ additionalProperties: false },
);

export const ExtensionHostActionFrameSchema = Type.Object(
	{
		...FrameBase,
		kind: Type.Literal("action"),
		requestId: ExtensionRequestIdSchema,
		action: ExtensionHostActionNameSchema,
		/**
		 * 动作载荷。结构性上限在帧层（键数 + 序列化字节），逐动作 schema 与
		 * receipt 语义由 P4 在 owner 侧校验；本字段的帧形状在版本 1 内不变。
		 */
		payload: Type.Record(Type.String(), Type.Unknown(), { maxProperties: 32 }),
		/** 请求方给出的预算；owner 仍可缩短。 */
		deadlineMs: Type.Integer({ minimum: 1, maximum: 600_000 }),
		/** `intent` 动作的载体；其它动作必须省略。 */
		intent: Type.Optional(ExtensionIntentSchema),
	},
	{ additionalProperties: false },
);

export const ExtensionHostResultFrameSchema = Type.Object(
	{
		...FrameBase,
		kind: Type.Literal("result"),
		requestId: ExtensionRequestIdSchema,
		ok: Type.Boolean(),
		value: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { maxProperties: 32 })),
		/** 结果内容的 digest；value 被裁剪或省略时仍是权威关联。 */
		valueDigest: Type.Optional(ExtensionDigestSchema),
		error: Type.Optional(ExtensionHostErrorPayloadSchema),
		durationMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 600_000 })),
	},
	{ additionalProperties: false },
);

export const ExtensionHostErrorFrameSchema = Type.Object(
	{
		...FrameBase,
		kind: Type.Literal("error"),
		error: ExtensionHostErrorPayloadSchema,
		/** fatal 表示 host 认为自身不可继续；owner 据此进入 failed generation。 */
		fatal: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export const ExtensionHostShutdownFrameSchema = Type.Object(
	{
		...FrameBase,
		kind: Type.Literal("shutdown"),
		reason: Type.Unsafe<ExtensionHostShutdownReason>({ type: "string", enum: [...ExtensionHostShutdownReasons] }),
		/** 请求方给出的退出预算；shutdown 使用短预算而非 handler 超时。 */
		deadlineMs: Type.Integer({ minimum: 1, maximum: 600_000 }),
	},
	{ additionalProperties: false },
);

export const ExtensionHostFrameSchema = Type.Union([
	ExtensionHostHelloFrameSchema,
	ExtensionHostRegistryFrameSchema,
	ExtensionHostEventFrameSchema,
	ExtensionHostActionFrameSchema,
	ExtensionHostResultFrameSchema,
	ExtensionHostErrorFrameSchema,
	ExtensionHostShutdownFrameSchema,
]);

/** 逐 kind 的帧 schema 索引；编解码按 kind 取用。 */
export const EXTENSION_HOST_FRAME_SCHEMAS = Object.freeze({
	hello: ExtensionHostHelloFrameSchema,
	registry: ExtensionHostRegistryFrameSchema,
	event: ExtensionHostEventFrameSchema,
	action: ExtensionHostActionFrameSchema,
	result: ExtensionHostResultFrameSchema,
	error: ExtensionHostErrorFrameSchema,
	shutdown: ExtensionHostShutdownFrameSchema,
} as const);

const FRAME_KIND_SET = new Set<string>(EXTENSION_HOST_FRAME_KINDS);

export function isExtensionHostFrameKind(value: unknown): value is ExtensionHostFrameKind {
	return typeof value === "string" && FRAME_KIND_SET.has(value);
}

/** 帧载荷中的嵌套对象深度上限；用于拒绝结构炸弹。 */
export const EXTENSION_HOST_FRAME_MAX_DEPTH = 12;
/** 单帧 JSONL 字节上限；编解码必须在 UTF-8 序列化后校验。 */
export const EXTENSION_HOST_FRAME_MAX_BYTES = EXTENSION_CONTRACT_BOUNDS.frameBytes;

export type ExtensionHostHelloFrame = Static<typeof ExtensionHostHelloFrameSchema>;
export type ExtensionHostRegistryFrame = Static<typeof ExtensionHostRegistryFrameSchema>;
export type ExtensionHostEventFrame = Static<typeof ExtensionHostEventFrameSchema>;
export type ExtensionHostActionFrame = Static<typeof ExtensionHostActionFrameSchema>;
export type ExtensionHostResultFrame = Static<typeof ExtensionHostResultFrameSchema>;
export type ExtensionHostErrorFrame = Static<typeof ExtensionHostErrorFrameSchema>;
export type ExtensionHostShutdownFrame = Static<typeof ExtensionHostShutdownFrameSchema>;
export type ExtensionHostFrame = Static<typeof ExtensionHostFrameSchema>;
export type ExtensionHostErrorPayload = Static<typeof ExtensionHostErrorPayloadSchema>;
