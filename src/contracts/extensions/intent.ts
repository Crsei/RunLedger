/**
 * ExtensionIntent：扩展影响呈现的唯一出口（D9）。
 *
 * 扩展没有 UI context：不得注册 renderer/组件/composer shape，也不得直接
 * 调用 `ui.*`。它只能提交有界 intent，由 owner 投影成 Session protocol 上的
 * read/mutate 结果，再由 TUI 按现有 presentation 契约渲染。需要用户输入时走
 * 既有审批 UI，而不是扩展自定义对话框。
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import { EXTENSION_CONTRACT_BOUNDS, ExtensionTextSchema } from "./common.ts";

export const EXTENSION_INTENT_KINDS = Object.freeze([
	/** 状态行文本，按 key 覆盖当前值。 */
	"status",
	/** 一次性通知，有界且不要求用户动作。 */
	"notify",
	/** 请求用户决策；owner 决定是否投影为既有审批 UI。 */
	"decision-request",
] as const);

export type ExtensionIntentKind = (typeof EXTENSION_INTENT_KINDS)[number];

export const EXTENSION_INTENT_LEVELS = Object.freeze(["info", "warning", "error"] as const);
export type ExtensionIntentLevel = (typeof EXTENSION_INTENT_LEVELS)[number];

export const ExtensionIntentKindSchema = Type.Unsafe<ExtensionIntentKind>({
	type: "string",
	enum: [...EXTENSION_INTENT_KINDS],
});

export const ExtensionIntentSchema = Type.Object(
	{
		kind: ExtensionIntentKindSchema,
		level: Type.Unsafe<ExtensionIntentLevel>({ type: "string", enum: [...EXTENSION_INTENT_LEVELS] }),
		/** status 的稳定键；notify/decision-request 省略。 */
		key: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9-]*$" })),
		text: ExtensionTextSchema,
		/** decision-request 的有界选项标签；其它 kind 省略。 */
		options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 8 })),
		/** 关联的 canonical 对象摘要；不携带路径或凭据。 */
		subjectDigest: Type.Optional(Type.String({ minLength: 64, maxLength: 64, pattern: "^[0-9a-f]{64}$" })),
	},
	{ additionalProperties: false },
);

export type ExtensionIntent = Static<typeof ExtensionIntentSchema>;

/** intent 载荷的 UTF-8 字节上限；消费者必须在序列化后校验。 */
export const EXTENSION_INTENT_MAX_BYTES = EXTENSION_CONTRACT_BOUNDS.intentBytes;
