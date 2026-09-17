/**
 * A2/ask reverse-request:把模型侧「向用户提问」经 Session 协议
 * reverse-request 通道投递给 driver 连接的 TUI,并把用户所选标签送回。
 *
 * 与既有两条通道(approval / credential)的关键差异:**不做任何重试**。
 * headless 客户端(未注入 `reverseRequestHandler`)会立即回
 * `{ ok:false, code:"reverse_request_unhandled" }`;approval 通道在
 * `approval-reverse-request.ts` 按 25–250ms 轮询到 deadline,credential 通道
 * 只发一次。ask 端口按 credential 语义并显式区分 code:
 *
 * - 收到 `reverse_request_unhandled` → 立即抛 `unhandled`,绝不重投;
 * - 收到 `reverse_request_invalid` → 立即抛 `invalid_response`;
 * - 客户端取消 → `cancelled`;传输超时/断线 → `timeout` / `delivery_failed`。
 *
 * 任何「问题没有展示给用户」的路径都必须抛错,否则模型会把未被看见的
 * 问题当成已问过(静默降级)。
 *
 * 帧体是不透明 `Record<string, unknown>`,新增 kind 不需要改协议 schema。
 */

import type { ConnectionId } from "../protocol/ids.ts";
import type { SessionFrameEnvelope } from "../session-server/protocol.ts";
import type { ReverseRequestSender } from "./credential-reverse-request.ts";

/** 问题数量/字段长度上限;与 `runtime/tools/ask.ts` 的 schema 同源。 */
export const ASK_LIMITS = Object.freeze({
	maxQuestions: 4,
	maxOptions: 8,
	maxIdChars: 64,
	maxQuestionChars: 1_024,
	maxHeaderChars: 64,
	maxLabelChars: 128,
	maxDescriptionChars: 512,
} as const);

export const ASK_REVERSE_REQUEST_KIND = "ask_prompt";

export interface AskOption {
	readonly label: string;
	readonly description?: string;
}

export interface AskQuestion {
	readonly id: string;
	readonly question: string;
	readonly header?: string;
	readonly options: readonly AskOption[];
	/** true = 多选(可提交 0..n 个标签)。 */
	readonly multi?: boolean;
}

/** questionId → 所选选项标签(按选项声明顺序,不按点击顺序)。 */
export type AskAnswers = Readonly<Record<string, readonly string[]>>;

export function encodeAskRequest(questions: readonly AskQuestion[]): Record<string, unknown> {
	return {
		questions: questions.map((question) => ({
			id: question.id,
			question: question.question,
			...(question.header === undefined ? {} : { header: question.header }),
			options: question.options.map((option) => ({
				label: option.label,
				...(option.description === undefined ? {} : { description: option.description }),
			})),
			...(question.multi === undefined ? {} : { multi: question.multi }),
		})),
	};
}

/**
 * 解码 reverse-request 载荷为受约束的问题列表。
 *
 * 任一字段越界、问题 id 重复或同一问题内选项标签重复 → `undefined`
 * (标签就是答案的身份,重复标签无法回传到具体选项)。
 */
export function decodeAskRequest(value: unknown): readonly AskQuestion[] | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = (value as Record<string, unknown>).questions;
	if (!Array.isArray(raw) || raw.length === 0 || raw.length > ASK_LIMITS.maxQuestions) return undefined;
	const questions: AskQuestion[] = [];
	const seenIds = new Set<string>();
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
		const record = entry as Record<string, unknown>;
		const id = boundedText(record.id, ASK_LIMITS.maxIdChars);
		const question = boundedText(record.question, ASK_LIMITS.maxQuestionChars);
		if (id === undefined || question === undefined || seenIds.has(id)) return undefined;
		seenIds.add(id);
		const header = record.header === undefined ? undefined : boundedText(record.header, ASK_LIMITS.maxHeaderChars);
		if (record.header !== undefined && header === undefined) return undefined;
		if (record.multi !== undefined && typeof record.multi !== "boolean") return undefined;
		const options = decodeOptions(record.options);
		if (options === undefined) return undefined;
		questions.push({
			id,
			question,
			...(header === undefined ? {} : { header }),
			options,
			...(record.multi === undefined ? {} : { multi: record.multi }),
		});
	}
	return questions;
}

/** 解码 reverse-response 的 answers:必须一问一答,标签必须来自该问题的选项。 */
export function decodeAskAnswers(value: unknown, questions: readonly AskQuestion[]): AskAnswers | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const allowedIds = new Set(questions.map((question) => question.id));
	for (const key of Object.keys(record)) {
		if (!allowedIds.has(key)) return undefined;
	}
	const answers: Record<string, readonly string[]> = {};
	for (const question of questions) {
		const raw = record[question.id];
		if (!Array.isArray(raw)) return undefined;
		const allowedLabels = new Set(question.options.map((option) => option.label));
		const picked: string[] = [];
		for (const entry of raw) {
			if (typeof entry !== "string" || !allowedLabels.has(entry) || picked.includes(entry)) return undefined;
			picked.push(entry);
		}
		// 多选按选项声明顺序归一,单选的 0/1 元素不受影响。
		answers[question.id] = question.options.map((option) => option.label).filter((label) => picked.includes(label));
	}
	return answers;
}

export type AskErrorCode = "unhandled" | "unavailable" | "cancelled" | "timeout" | "invalid_response" | "delivery_failed";

/** Typed ask 失败;`code` 供 caller/审计区分「没人看到问题」与「用户取消」。 */
export class AskRequestError extends Error {
	public readonly code: AskErrorCode;

	public constructor(code: AskErrorCode, message: string, cause?: unknown) {
		super(message);
		this.name = "AskRequestError";
		this.code = code;
		this.cause = cause;
	}
}

/** 模型侧提问端口;由 Session 组合注入 `createStdlibTools`。 */
export interface AskPort {
	ask(questions: readonly AskQuestion[], signal?: AbortSignal): Promise<AskAnswers>;
}

export interface ReverseRequestAskPortOptions {
	readonly sender: ReverseRequestSender;
	/**
	 * 固定连接,或每次调用时解析 driver 连接。会话组合在 driver 连接之前
	 * 构造工具,因此生产接线传 thunk(approval 通道同样在请求时解析连接)。
	 */
	readonly connectionId: ConnectionId | (() => ConnectionId | undefined);
	/** `null` = 不设 deadline,由 abort/断线释放(与无期限 approval 一致)。缺省 `null`。 */
	readonly timeoutMs?: number | null;
}

/**
 * 构造 server 侧 ask 端口:一次调用只投递一帧,收到 typed 失败立即抛出,
 * 不轮询、不重试、不返回空答案。
 */
export function createReverseRequestAskPort(options: ReverseRequestAskPortOptions): AskPort {
	const resolveConnection = typeof options.connectionId === "function" ? options.connectionId : () => options.connectionId as ConnectionId;
	return {
		async ask(questions, signal) {
			const connectionId = resolveConnection();
			if (connectionId === undefined) {
				throw new AskRequestError("unavailable", "ask: 没有已连接的客户端可以回答问题(driver 未连接),问题未展示给任何人");
			}
			let frame: SessionFrameEnvelope;
			try {
				frame = await options.sender.requestToConnection(
					connectionId,
					{ kind: ASK_REVERSE_REQUEST_KIND, body: encodeAskRequest(questions) },
					options.timeoutMs === undefined ? null : options.timeoutMs,
					signal,
				);
			} catch (error) {
				throw deliveryError(error, signal);
			}
			if (frame.body.ok !== true) throw rejectionError(frame.body);
			const answers = decodeAskAnswers(frame.body.answers, questions);
			if (answers === undefined) {
				throw new AskRequestError("invalid_response", "ask: 客户端返回的答案与请求的问题不匹配");
			}
			return answers;
		},
	};
}

function rejectionError(body: Record<string, unknown>): AskRequestError {
	const code = typeof body.code === "string" ? body.code : "";
	switch (code) {
		case "reverse_request_unhandled":
			return new AskRequestError("unhandled", "ask: 连接的客户端没有用户提问界面(headless),问题未展示给任何人");
		case "aborted":
			return new AskRequestError("cancelled", "ask: 用户取消了提问");
		case "reverse_request_invalid":
			return new AskRequestError("invalid_response", "ask: 客户端拒绝了本次提问载荷");
		default:
			return new AskRequestError("delivery_failed", `ask: 提问请求被拒绝(${code.length === 0 ? "unknown" : code})`);
	}
}

function deliveryError(error: unknown, signal: AbortSignal | undefined): AskRequestError {
	const message = error instanceof Error ? error.message : String(error);
	if (signal?.aborted === true) return new AskRequestError("cancelled", "ask: 提问已被调用方中止", error);
	if (/timed out/u.test(message)) return new AskRequestError("timeout", "ask: 等待用户回答超时", error);
	return new AskRequestError("delivery_failed", `ask: 提问无法投递:${message}`, error);
}

function decodeOptions(value: unknown): readonly AskOption[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > ASK_LIMITS.maxOptions) return undefined;
	const options: AskOption[] = [];
	const seenLabels = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
		const record = entry as Record<string, unknown>;
		const label = boundedText(record.label, ASK_LIMITS.maxLabelChars);
		if (label === undefined || seenLabels.has(label)) return undefined;
		seenLabels.add(label);
		const description = record.description === undefined ? undefined : boundedText(record.description, ASK_LIMITS.maxDescriptionChars);
		if (record.description !== undefined && description === undefined) return undefined;
		options.push({ label, ...(description === undefined ? {} : { description }) });
	}
	return options;
}

function boundedText(value: unknown, maxChars: number): string | undefined {
	if (typeof value !== "string") return undefined;
	return value.length === 0 || value.length > maxChars ? undefined : value;
}
