/**
 * 扩展可见事件投影合同（D5）。
 *
 * 扩展事件是 canonical event 的**投影**，不是第二事实源：本模块只冻结
 * 扩展能看到的稳定命名空间、每类事件的可见字段白名单、上限与结果形态。
 * 新增 canonical event 类型仍由 Runtime 04 的 event catalog 拥有；扩展层
 * 不得自行扩 catalog。
 *
 * 有返回值的中间件事件（`PreToolUse`/`PostToolUse`/`ContextAssemble`/
 * `BeforeProviderRequest`/`SessionBeforeStop`/`SessionBeforeCompact`）在 owner
 * 侧合成，结果必须再次通过既有 canonicalize/authorize 才能生效。
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import { EXTENSION_CONTRACT_BOUNDS, ExtensionTextSchema } from "./common.ts";

/** handler 返回值语义。 */
export const EXTENSION_EVENT_RESULT_KINDS = Object.freeze([
	/** 结果被忽略；handler 只观察。 */
	"none",
	/** handler 可返回有界 additionalContext。 */
	"context",
	/** handler 可 block/cancel；工具事件另可重写输入。 */
	"decision",
	/** handler 可返回有界替换体，替换体需重新校验。 */
	"replace",
	/** handler 结果按注册顺序累积为变换链。 */
	"middleware",
] as const);

export const EXTENSION_EVENT_PHASES = Object.freeze([
	"session",
	"turn",
	"tool",
	"context",
	"provider",
	"resources",
] as const);

export type ExtensionEventResultKind = (typeof EXTENSION_EVENT_RESULT_KINDS)[number];
export type ExtensionEventPhase = (typeof EXTENSION_EVENT_PHASES)[number];

export interface ExtensionEventProjectionDescriptor {
	readonly name: string;
	readonly phase: ExtensionEventPhase;
	readonly cancelable: boolean;
	readonly resultKind: ExtensionEventResultKind;
	/** 扩展 handler 可见的载荷键精确白名单；未列出的键不出现在载荷中。 */
	readonly payloadFields: readonly string[];
	/** 裁剪后载荷的硬上限（UTF-8 字节），以本值与框架上限的较小者为准。 */
	readonly payloadBytes: number;
	/** 事件是否携带用户正文，消费者必须按 redaction 策略处理。 */
	readonly containsUserText: boolean;
}

/**
 * 投影白名单（§12 Q4 选项 A）：12 个与现有 hook 生命周期和扩展中间件
 * 需求对齐的事件。omp 的其余事件不进入本次范围。
 */
export const EXTENSION_EVENT_PROJECTION_CATALOG = Object.freeze([
	{
		name: "SessionStart",
		phase: "session",
		cancelable: false,
		resultKind: "none",
		payloadFields: ["sessionId", "profileId", "workspaceKey", "trustState"],
		payloadBytes: 8 * 1024,
		containsUserText: false,
	},
	{
		name: "SessionEnd",
		phase: "session",
		cancelable: false,
		resultKind: "none",
		payloadFields: ["sessionId", "reason"],
		payloadBytes: 4 * 1024,
		containsUserText: false,
	},
	{
		name: "SessionBeforeStop",
		phase: "session",
		cancelable: true,
		resultKind: "decision",
		payloadFields: ["sessionId", "reason"],
		payloadBytes: 4 * 1024,
		containsUserText: false,
	},
	{
		name: "SessionBeforeCompact",
		phase: "session",
		cancelable: true,
		resultKind: "decision",
		payloadFields: ["sessionId", "contextDigest", "estimatedTokens"],
		payloadBytes: 4 * 1024,
		containsUserText: false,
	},
	{
		name: "TurnStart",
		phase: "turn",
		cancelable: false,
		resultKind: "none",
		payloadFields: ["sessionId", "turnId", "promptDigest"],
		payloadBytes: 4 * 1024,
		containsUserText: false,
	},
	{
		name: "TurnEnd",
		phase: "turn",
		cancelable: false,
		resultKind: "none",
		payloadFields: ["sessionId", "turnId", "stopReason", "usageDigest"],
		payloadBytes: 4 * 1024,
		containsUserText: false,
	},
	{
		name: "UserPromptSubmit",
		phase: "turn",
		cancelable: false,
		resultKind: "context",
		payloadFields: ["sessionId", "turnId", "promptText"],
		payloadBytes: 64 * 1024,
		containsUserText: true,
	},
	{
		name: "PreToolUse",
		phase: "tool",
		cancelable: true,
		resultKind: "decision",
		payloadFields: ["sessionId", "turnId", "toolCallId", "toolName", "argsJson"],
		payloadBytes: 64 * 1024,
		containsUserText: true,
	},
	{
		name: "PostToolUse",
		phase: "tool",
		cancelable: false,
		resultKind: "middleware",
		payloadFields: ["sessionId", "turnId", "toolCallId", "toolName", "resultDigest", "isError"],
		payloadBytes: 8 * 1024,
		containsUserText: false,
	},
	{
		name: "ContextAssemble",
		phase: "context",
		cancelable: false,
		resultKind: "middleware",
		payloadFields: ["sessionId", "turnId", "modelContextChars", "fragmentDigests"],
		payloadBytes: 8 * 1024,
		containsUserText: false,
	},
	{
		name: "BeforeProviderRequest",
		phase: "provider",
		cancelable: false,
		resultKind: "replace",
		payloadFields: ["sessionId", "turnId", "providerId", "modelId", "requestDigest"],
		payloadBytes: 8 * 1024,
		containsUserText: false,
	},
	{
		name: "ResourcesDiscover",
		phase: "resources",
		cancelable: false,
		resultKind: "replace",
		payloadFields: ["sessionId", "turnId", "sourceRoot"],
		payloadBytes: 8 * 1024,
		containsUserText: false,
	},
] as const satisfies readonly ExtensionEventProjectionDescriptor[]);

export const EXTENSION_EVENT_NAMES = Object.freeze(
	EXTENSION_EVENT_PROJECTION_CATALOG.map((descriptor) => descriptor.name),
) as readonly string[];

export type ExtensionEventName = (typeof EXTENSION_EVENT_PROJECTION_CATALOG)[number]["name"];

const EVENT_NAME_SET = new Set<string>(EXTENSION_EVENT_NAMES);
const EVENT_BY_NAME = new Map<string, ExtensionEventProjectionDescriptor>(
	EXTENSION_EVENT_PROJECTION_CATALOG.map((descriptor) => [descriptor.name, descriptor]),
);

export function isExtensionEventName(value: unknown): value is ExtensionEventName {
	return typeof value === "string" && EVENT_NAME_SET.has(value);
}

export function extensionEventDescriptor(name: string): ExtensionEventProjectionDescriptor | undefined {
	return EVENT_BY_NAME.get(name);
}

/** 扩展事件名的 schema；只接受白名单内的名字。 */
export const ExtensionEventNameSchema = Type.Unsafe<ExtensionEventName>({
	type: "string",
	enum: [...EXTENSION_EVENT_NAMES],
});

export const ExtensionEventResultKindSchema = Type.Unsafe<ExtensionEventResultKind>({
	type: "string",
	enum: [...EXTENSION_EVENT_RESULT_KINDS],
});

/**
 * 运行时投影实例。`payload` 已按 descriptor 裁剪；消费者必须在序列化后
 * 再次校验 UTF-8 字节上限，字符上限不构成字节保证。
 */
export const ExtensionEventProjectionSchema = Type.Object(
	{
		name: ExtensionEventNameSchema,
		cancelable: Type.Boolean(),
		resultKind: ExtensionEventResultKindSchema,
		payload: Type.Record(Type.String(), Type.Unknown(), { maxProperties: 32 }),
	},
	{ additionalProperties: false },
);

/** 投影描述符的公开 schema；catalog 数据在编译期由 `satisfies` 约束。 */
export const ExtensionEventProjectionDescriptorSchema = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 64 }),
		phase: Type.Unsafe<ExtensionEventPhase>({ type: "string", enum: [...EXTENSION_EVENT_PHASES] }),
		cancelable: Type.Boolean(),
		resultKind: ExtensionEventResultKindSchema,
		payloadFields: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), { maxItems: 32 }),
		payloadBytes: Type.Integer({ minimum: 1, maximum: EXTENSION_CONTRACT_BOUNDS.eventPayloadBytes }),
		containsUserText: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export const ExtensionAdditionalContextSchema = Type.Object(
	{
		additionalContext: ExtensionTextSchema,
	},
	{ additionalProperties: false },
);

export type ExtensionEventProjection = Static<typeof ExtensionEventProjectionSchema>;
export type ExtensionAdditionalContext = Static<typeof ExtensionAdditionalContextSchema>;
