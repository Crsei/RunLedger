/**
 * Timeline event projector：replay / TuiEvent / notice / cleanup -> TimelineEvent。
 *
 * replay 与 live 共用同一入口（projectTimelineInput），同一 canonical message
 * 生成相同稳定 row id（user:${index} / assistant:${index} / tool:${toolCallId}）。
 * projector 是有显式种子的有状态类（shell chunk 累积、messageIndex 计数、
 * active tool presentation），相同 seed + 相同输入 → 相同输出；
 * 不接 renderer/IO/timer。流式正文由帧前 flush 以完整快照直接发
 * message_update（text + thinking），不在投影器里按 delta 零散发送。
 */

import type { AgentMessage } from "../../runtime/types.ts";
import type { TuiEvent } from "../types.ts";
import type {
	SafeShellChunk,
	SafeToolPresentation,
} from "../presentation/tools/types.ts";
import {
	boundedToolText,
	appendShellPresentationChunk,
	projectShellChunk,
	projectToolEnd,
	projectToolStart,
} from "../presentation/tools/projector.ts";
import type { TimelineEvent, TimelineRow, TimelineStatus } from "./types.ts";

export type TimelineProjectionInput =
	| { readonly kind: "replay-message"; readonly message: AgentMessage; readonly index: number }
	| { readonly kind: "tui-event"; readonly event: TuiEvent }
	| { readonly kind: "notice"; readonly severity: "info" | "warning" | "error"; readonly message: string; readonly correlationId: string }
	| { readonly kind: "cleanup"; readonly reason: "session-switch" | "abort" | "destroy"; readonly correlationId?: string };

export interface TimelineProjectorSeed {
	readonly messageIndex: number;
	readonly displayOrder: number;
	readonly startedAt: string;
}

export interface TimelineProjectorSnapshot {
	readonly seed: TimelineProjectorSeed;
	readonly shellChunks: Readonly<Record<string, readonly SafeShellChunk[]>>;
	readonly activeToolPresentation: Readonly<Record<string, SafeToolPresentation>>;
}

export const MESSAGE_TEXT_BOUND_BYTES = 1024 * 1024;

export class TimelineEventProjector {
	private messageIndex: number;
	private displayOrder: number;
	private readonly startedAt: string;
	private readonly shellChunks: Map<string, SafeShellChunk[]> = new Map();
	private readonly activeToolPresentation: Map<string, SafeToolPresentation> = new Map();

	constructor(seed: TimelineProjectorSeed = { messageIndex: 0, displayOrder: 0, startedAt: new Date().toISOString() }) {
		this.messageIndex = seed.messageIndex;
		this.displayOrder = seed.displayOrder;
		this.startedAt = seed.startedAt;
	}

	snapshot(): TimelineProjectorSnapshot {
		return {
			seed: { messageIndex: this.messageIndex, displayOrder: this.displayOrder, startedAt: this.startedAt },
			shellChunks: Object.fromEntries(this.shellChunks),
			activeToolPresentation: Object.fromEntries(this.activeToolPresentation),
		};
	}

	/** 当前 assistant 流式行的 correlationId（= 最近一次 assistant message_start 的 row id）。 */
	currentAssistantCorrelationId(): string {
		return `assistant:${this.messageIndex - 1}`;
	}

	/** /clear 视图重置：清空行序与累积器；messageIndex 继续递增保证 id 不复用。 */
	resetRows(): void {
		this.displayOrder = 0;
		this.shellChunks.clear();
		this.activeToolPresentation.clear();
	}

	/** replay 完成后把内部计数对齐到已重放消息数，保证 live id 不冲突。 */
	setMessageIndex(value: number): void {
		this.messageIndex = Math.max(this.messageIndex, value);
	}

	project(input: TimelineProjectionInput): TimelineEvent[] {
		switch (input.kind) {
			case "replay-message":
				return this.projectReplayMessage(input.message, input.index);
			case "tui-event":
				return this.projectTuiEvent(input.event);
			case "notice":
				return [{
					type: "notice",
					generation: 0,
					correlationId: input.correlationId,
					severity: input.severity,
					message: boundedToolText(input.message, MESSAGE_TEXT_BOUND_BYTES),
				}];
			case "cleanup":
				return [{
					type: "cleanup",
					generation: 0,
					// 不传 correlationId 时清全部 active rows（destroy/session-switch 全局清理）
					...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
					reason: input.reason,
				}];
		}
	}

	private projectReplayMessage(message: AgentMessage, index: number): TimelineEvent[] {
		if (message.role === "user") {
			const text = message.content.map((content) => content.text).join("");
			const row = this.messageRow("user", index, { text, status: "succeeded", streaming: false });
			return [
				{ type: "message_start", generation: 0, correlationId: row.id, row },
				{ type: "message_end", generation: 0, correlationId: row.id, status: "succeeded" },
			];
		}
		if (message.role === "assistant") {
			const text = message.content
				.filter((content) => content.type === "text")
				.map((content) => content.text)
				.join("");
			const thinking = message.content
				.filter((content) => content.type === "thinking")
				.map((content) => content.thinking)
				.join("");
			const status: TimelineStatus = message.stopReason === "aborted" ? "aborted" : "succeeded";
			const row = this.messageRow("assistant", index, {
				text,
				status,
				streaming: false,
				thinking,
			});
			const events: TimelineEvent[] = [
				{ type: "message_start", generation: 0, correlationId: row.id, row },
				{ type: "message_end", generation: 0, correlationId: row.id, status },
			];
			for (const toolCall of message.content.filter((content) => content.type === "toolCall")) {
				events.push(...this.toolStartEnd(toolCall.id, toolCall.name, toolCall.arguments));
			}
			return events;
		}
		const events: TimelineEvent[] = [];
		for (const content of message.content) {
			const start = projectToolStart(content.toolName, {}, this.startedAt);
			const resultText = toolContentText(content.content);
			const presentation = projectToolEnd(
				resultText.length > 0
					? { ...start, body: [...start.body, { kind: "text", content: boundedToolText(resultText, MESSAGE_TEXT_BOUND_BYTES) }] }
					: start,
				{ content: content.content, details: content.details, isError: content.isError === true },
				this.startedAt,
			);
			const status: TimelineStatus = content.isError === true ? "failed" : "succeeded";
			const row = this.toolRow(content.toolCallId, content.toolName, presentation, status);
			events.push({ type: "tool_start", generation: 0, correlationId: content.toolCallId, row });
			events.push({ type: "tool_end", generation: 0, correlationId: content.toolCallId, status });
		}
		return events;
	}

	private projectTuiEvent(event: TuiEvent): TimelineEvent[] {
		switch (event.type) {
			case "message_start": {
				const index = this.nextMessageIndex();
				const body = event.role === "assistant"
					? assistantText(event.message)
					: event.role === "user" && event.message?.role === "user"
						? event.message.content.map((content) => content.text).join("")
						: "";
				const thinking = event.role === "assistant" ? assistantThinking(event.message) : "";
				const row = this.messageRow(event.role, index, {
					text: body,
					status: event.role === "user" ? "succeeded" : "running",
					streaming: event.role === "assistant",
					thinking,
				});
				// user 行立即完成（事件流不为 user 消息发 message_end）
				if (event.role === "user") {
					return [
						{ type: "message_start", generation: 0, correlationId: row.id, row },
						{ type: "message_end", generation: 0, correlationId: row.id, status: "succeeded" },
					];
				}
				return [{ type: "message_start", generation: 0, correlationId: row.id, row }];
			}
			case "message_end": {
				const status: TimelineStatus = event.stopReason === "aborted" ? "aborted" : event.stopReason === "error" ? "failed" : "succeeded";
				return [{ type: "message_end", generation: 0, correlationId: this.currentAssistantCorrelationId(), status }];
			}
			case "tool_execution_start": {
				const presentation = projectToolStart(event.toolName, event.args, this.startedAt);
				this.activeToolPresentation.set(event.toolCallId, presentation);
				const row = this.toolRow(event.toolCallId, event.toolName, presentation, "running");
				return [{ type: "tool_start", generation: 0, correlationId: event.toolCallId, row }];
			}
			case "tool_execution_update": {
				let chunks = this.shellChunks.get(event.toolCallId) ?? [];
				if (isRecord(event.partialResult) && isRecord(event.partialResult.details)) {
					const details = event.partialResult.details;
					if (typeof details.stdoutChunk === "string" && details.stdoutChunk.length > 0) {
						chunks = [...chunks, projectShellChunk("stdout", details.stdoutChunk)];
					}
					if (typeof details.stderrChunk === "string" && details.stderrChunk.length > 0) {
						chunks = [...chunks, projectShellChunk("stderr", details.stderrChunk)];
					}
				}
				this.shellChunks.set(event.toolCallId, chunks);
				const presentation = this.activeToolPresentation.get(event.toolCallId);
				if (presentation === undefined || chunks.length === 0) return [];
				const chunk = chunks[chunks.length - 1]!;
				// 累积：只保留每通道有界 tail，避免长跑日志进入无界 Timeline state。
				const updated = appendShellPresentationChunk(presentation, chunk);
				if (updated.result?.kind === "shell") chunks = [...updated.result.chunks];
				this.shellChunks.set(event.toolCallId, chunks);
				this.activeToolPresentation.set(event.toolCallId, updated);
				return [{
					type: "tool_update",
					generation: 0,
					correlationId: event.toolCallId,
					presentation: { state: "known", value: updated },
				}];
			}
			case "tool_execution_end": {
				const presentation = this.activeToolPresentation.get(event.toolCallId);
				if (presentation === undefined) return [];
				const final = projectToolEnd(
					presentation,
					{ content: event.result.content, details: event.result.details, isError: event.isError },
					new Date(event.timestamp).toISOString(),
				);
				// tool end 后释放累积状态，防止内存持续占用
				this.shellChunks.delete(event.toolCallId);
				this.activeToolPresentation.delete(event.toolCallId);
				return [
					{ type: "tool_update", generation: 0, correlationId: event.toolCallId, presentation: { state: "known", value: final } },
					{ type: "tool_end", generation: 0, correlationId: event.toolCallId, status: event.isError ? "failed" : "succeeded" },
				];
			}
			default:
				return [];
		}
	}

	private toolStartEnd(toolCallId: string, toolName: string, args: unknown): TimelineEvent[] {
		const presentation = projectToolStart(toolName, args, this.startedAt);
		const row = this.toolRow(toolCallId, toolName, presentation, "succeeded");
		return [
			{ type: "tool_start", generation: 0, correlationId: toolCallId, row },
			{ type: "tool_end", generation: 0, correlationId: toolCallId, status: "succeeded" },
		];
	}

	private messageRow(role: "user" | "assistant", index: number, options: {
		text: string;
		status: TimelineStatus;
		streaming: boolean;
		thinking?: string;
	}): TimelineRow {
		const base = {
			id: `${role}:${index}`,
			timestamp: this.startedAt,
			displayOrder: this.nextDisplayOrder(),
			status: options.status,
			text: boundedToolText(options.text, MESSAGE_TEXT_BOUND_BYTES),
		};
		if (role === "assistant") {
			return {
				...base,
				kind: "assistant" as const,
				streaming: options.streaming,
				...(options.thinking !== undefined && options.thinking.length > 0
					? { thinking: boundedToolText(options.thinking, MESSAGE_TEXT_BOUND_BYTES) }
					: {}),
			};
		}
		return { ...base, kind: "user" as const };
	}

	private toolRow(toolCallId: string, toolName: string, presentation: SafeToolPresentation, status: TimelineStatus): TimelineRow {
		return {
			kind: "tool",
			id: `tool:${toolCallId}`,
			timestamp: this.startedAt,
			displayOrder: this.nextDisplayOrder(),
			status,
			toolCallId,
			toolName: boundedToolText(toolName, 120),
			presentation: { state: "known", value: presentation },
		};
	}

	private nextMessageIndex(): number {
		const value = this.messageIndex;
		this.messageIndex += 1;
		return value;
	}

	private nextDisplayOrder(): number {
		const value = this.displayOrder;
		this.displayOrder += 1;
		return value;
	}
}

function assistantText(message: { readonly role?: string; readonly content?: readonly unknown[] } | undefined): string {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((content): content is { type: string; text: string } => isRecord(content) && content.type === "text" && typeof content.text === "string")
		.map((content) => content.text)
		.join("");
}

function assistantThinking(message: { readonly role?: string; readonly content?: readonly unknown[] } | undefined): string {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return "";
	return message.content
		.filter((content): content is { type: string; thinking: string } => isRecord(content) && content.type === "thinking" && typeof content.thinking === "string")
		.map((content) => content.thinking)
		.join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolContentText(content: readonly unknown[]): string {
	return content
		.filter((item): item is { type: string; text: string } => isRecord(item) && item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("");
}
