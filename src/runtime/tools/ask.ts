/**
 * A2:`ask` —— 模型向用户提问并等待回答的唯一手段。
 *
 * 工具本身不接触任何 I/O:提问经注入的 `AskPort`(生产接线为
 * `session-runtime/ask-reverse-request.ts` 的 reverse-request 端口)投递给
 * 用户界面。端口缺省时 execute 直接 throw —— 缺失的提问通道必须是硬失败,
 * 不能让模型把「没人看到的问题」当成已问过。
 *
 * 与 `request_permissions` 的差异:那里「拒绝」是正常业务结果,因此返回
 * isError=false 的 denied 文本;这里问不出去就是工具失败(工具失败即 throw,
 * agent-loop 转成 isError tool result)。
 */

import { Type } from "typebox";
import type { Static } from "typebox";
import type { AgentTool, AgentToolResult } from "../types.ts";
import type { AskAnswers, AskPort, AskQuestion } from "../session-runtime/ask-reverse-request.ts";
import { ASK_LIMITS } from "../session-runtime/ask-reverse-request.ts";

const askOptionSchema = Type.Object({
	label: Type.String({ minLength: 1, maxLength: ASK_LIMITS.maxLabelChars }),
	description: Type.Optional(Type.String({ minLength: 1, maxLength: ASK_LIMITS.maxDescriptionChars })),
}, { additionalProperties: false });

const askQuestionSchema = Type.Object({
	id: Type.String({ minLength: 1, maxLength: ASK_LIMITS.maxIdChars }),
	question: Type.String({ minLength: 1, maxLength: ASK_LIMITS.maxQuestionChars }),
	header: Type.Optional(Type.String({ minLength: 1, maxLength: ASK_LIMITS.maxHeaderChars })),
	options: Type.Array(askOptionSchema, { minItems: 1, maxItems: ASK_LIMITS.maxOptions }),
	/** true = 多选:用户可以提交 0..n 个标签。 */
	multi: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

export const askSchema = Type.Object({
	questions: Type.Array(askQuestionSchema, { minItems: 1, maxItems: ASK_LIMITS.maxQuestions }),
}, { additionalProperties: false });

export type AskInput = Static<typeof askSchema>;

export interface AskToolDetails {
	/** questionId → 所选选项标签(按选项声明顺序)。 */
	readonly answers: AskAnswers;
}

export function createAskTool(port?: AskPort): AgentTool<typeof askSchema, AskToolDetails> {
	return {
		name: "ask",
		label: "Ask User",
		description: "向用户提出 1–4 个带选项的问题并等待回答。仅在代码、文档与工具结果都无法给出答案时使用；每个问题必须给出 1–8 个选项，回答以所选选项标签返回。",
		parameters: askSchema,
		isReadOnly: () => true,
		isConcurrencySafe: () => false,
		async execute(_toolCallId, params, signal): Promise<AgentToolResult<AskToolDetails>> {
			if (port === undefined) {
				throw new Error("ask: 本会话未接入用户提问通道(ask port 未注入),问题未展示给任何人");
			}
			const answers = await port.ask(params.questions, signal);
			return {
				content: [{ type: "text", text: formatAnswers(params.questions, answers) }],
				details: { answers },
			};
		},
	};
}

/** 问题 → 所选标签的可读摘要;未选择时显式写「(未选择)」,不留空。 */
function formatAnswers(questions: readonly AskQuestion[], answers: AskAnswers): string {
	return questions
		.map((question) => {
			const picked = answers[question.id] ?? [];
			return `问：${question.question}\n答：${picked.length === 0 ? "(未选择)" : picked.join(", ")}`;
		})
		.join("\n\n");
}
