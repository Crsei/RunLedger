/** Session durable streaming 边界：合并小 delta，并移除 provider cumulative partial。 */

import { createHash, type Hash } from "node:crypto";
import type { AssistantMessageEvent } from "../../types.ts";
import type { AgentEvent, DurableAssistantMessageBoundary, DurableAssistantMessageDelta, RuntimeAssistantMessageEvent } from "../types.ts";
import { clipUtf8Output } from "../process/output.ts";

export interface StreamEventCoalescerOptions {
	readonly flushIntervalMs?: number;
	readonly maxDeltaBytes?: number;
	readonly emit: (event: AgentEvent) => void;
}

interface PendingDelta {
	readonly type: DurableAssistantMessageDelta["type"];
	readonly contentIndex: number;
	readonly hash: Hash;
	delta: string;
	deltaBytes: number;
	aggregateSize: number;
	timestamp: number;
}

const DEFAULT_FLUSH_INTERVAL_MS = 50;
const DEFAULT_MAX_DELTA_BYTES = 4 * 1024;

export class SessionStreamEventCoalescer {
	private readonly emit: StreamEventCoalescerOptions["emit"];
	private readonly flushIntervalMs: number;
	private readonly maxDeltaBytes: number;
	private readonly streams = new Map<string, PendingDelta>();
	private timer: ReturnType<typeof setTimeout> | undefined;

	public constructor(options: StreamEventCoalescerOptions) {
		this.emit = options.emit;
		this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
		this.maxDeltaBytes = options.maxDeltaBytes ?? DEFAULT_MAX_DELTA_BYTES;
	}

	public accept(event: AgentEvent): void {
		if (event.type !== "message_update") {
			this.flush();
			if (event.type === "message_start") this.streams.clear();
			this.emit(event);
			if (event.type === "message_end" || event.type === "agent_end") this.streams.clear();
			return;
		}
		const update = event.assistantMessageEvent;
		if (isRawDelta(update)) {
			this.append(update.type, update.contentIndex, update.delta, event.timestamp);
			return;
		}
		this.flush();
		if (isDurableUpdate(update)) {
			this.emit(event);
			return;
		}
		if (update.type === "start" || update.type === "done" || update.type === "error") return;
		this.emit({ ...event, assistantMessageEvent: this.boundary(update) });
	}

	public flush(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		for (const state of this.streams.values()) {
			this.emitDelta(state);
			state.delta = "";
			state.deltaBytes = 0;
		}
	}

	public dispose(): void {
		this.flush();
		this.streams.clear();
	}

	private append(type: PendingDelta["type"], contentIndex: number, input: string, timestamp: number): void {
		const key = `${type}:${contentIndex}`;
		let remaining = input;
		while (remaining.length > 0) {
			let state = this.streams.get(key);
			if (state === undefined) {
				state = {
					type,
					contentIndex,
					hash: createHash("sha256"),
					delta: "",
					deltaBytes: 0,
					aggregateSize: 0,
					timestamp,
				};
				this.streams.set(key, state);
			}
			const available = this.maxDeltaBytes - state.deltaBytes;
			if (available === 0) {
				this.emitDelta(state);
				state.delta = "";
				state.deltaBytes = 0;
				continue;
			}
			const clipped = clipUtf8Output(remaining, available);
			if (clipped.byteLength === 0) {
				this.emitDelta(state);
				state.delta = "";
				state.deltaBytes = 0;
				continue;
			}
			state.delta += clipped.text;
			state.deltaBytes += clipped.byteLength;
			state.aggregateSize += clipped.byteLength;
			state.timestamp = timestamp;
			state.hash.update(clipped.text, "utf8");
			remaining = remaining.slice(clipped.text.length);
			if (state.deltaBytes >= this.maxDeltaBytes) {
				this.emitDelta(state);
				state.delta = "";
				state.deltaBytes = 0;
			}
		}
		this.scheduleFlush();
	}

	private emitDelta(state: PendingDelta): void {
		if (state.deltaBytes === 0) return;
		this.emit({
			type: "message_update",
			timestamp: state.timestamp,
			assistantMessageEvent: {
				type: state.type,
				contentIndex: state.contentIndex,
				delta: state.delta,
				aggregateDigest: state.hash.copy().digest("hex"),
				aggregateSize: state.aggregateSize,
			},
		});
	}

	private scheduleFlush(): void {
		if (this.timer !== undefined || ![...this.streams.values()].some((state) => state.deltaBytes > 0)) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.flush();
		}, this.flushIntervalMs);
		this.timer.unref?.();
	}

	private boundary(event: Exclude<AssistantMessageEvent, { readonly type: "text_delta" | "thinking_delta" | "toolcall_delta" | "done" | "error" | "start" }>): DurableAssistantMessageBoundary {
		const deltaType = event.type.startsWith("text_")
			? "text_delta"
			: event.type.startsWith("thinking_")
				? "thinking_delta"
				: "toolcall_delta";
		const key = `${deltaType}:${event.contentIndex}`;
		let state = this.streams.get(key);
		if (event.type.endsWith("_start") || state === undefined) {
			state = {
				type: deltaType,
				contentIndex: event.contentIndex,
				hash: createHash("sha256"),
				delta: "",
				deltaBytes: 0,
				aggregateSize: 0,
				timestamp: 0,
			};
			this.streams.set(key, state);
		}
		const boundary: DurableAssistantMessageBoundary = {
			type: event.type,
			contentIndex: event.contentIndex,
			aggregateDigest: state.hash.copy().digest("hex"),
			aggregateSize: state.aggregateSize,
			...(event.type === "toolcall_end" ? { toolCall: { id: event.toolCall.id, name: event.toolCall.name } } : {}),
		};
		if (event.type.endsWith("_end")) this.streams.delete(key);
		return boundary;
	}
}

function isRawDelta(event: RuntimeAssistantMessageEvent): event is Extract<AssistantMessageEvent, { readonly type: "text_delta" | "thinking_delta" | "toolcall_delta" }> {
	return (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") && "partial" in event;
}

function isDurableUpdate(event: RuntimeAssistantMessageEvent): event is DurableAssistantMessageDelta | DurableAssistantMessageBoundary {
	return "aggregateDigest" in event;
}
