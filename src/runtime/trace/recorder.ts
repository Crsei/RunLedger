import { createHash, randomUUID } from "node:crypto";
import { canonicalJson } from "../protocol/canonical-json.ts";
import type {
	Api,
	AssistantMessage,
	Model,
	Usage,
	StopReason,
} from "../../types.ts";
import type {
	AgentEvent,
	AgentTool,
	LlmContext,
} from "../types.ts";
import type { FileArtifactStore } from "./artifact-store.ts";
import type { JsonlTraceEventStore } from "./event-store.ts";
import type { RecordingFailurePolicy, RecordingMode } from "../../storage/settings-manager.ts";
import type {
	TraceContentDescriptor,
	TraceCost,
	TraceError,
	TraceEventInput,
	TraceEventPhase,
	TraceMetadata,
	TraceTreeNode,
	TraceUsage,
} from "./types.ts";
import { TraceTreeProjection } from "./tree.ts";
import { redactRuntimeArtifactText } from "./redaction.ts";
import { createLocalTelemetryPort } from "../telemetry/local/recorder.ts";
import type { LocalTelemetryPort } from "../telemetry/local/port.ts";
import type { SessionId, TraceId } from "../protocol/ids.ts";

export interface TraceClock {
	now(): number;
	monotonic(): number;
}

export interface RuntimeTraceRecorderOptions {
	readonly eventStore: Pick<JsonlTraceEventStore, "append" | "events">;
	readonly artifactStore?: Pick<FileArtifactStore, "put">;
	readonly traceId: string;
	readonly redactionPolicyDigest: string;
	readonly mode: Exclude<RecordingMode, "off">;
	readonly failurePolicy: RecordingFailurePolicy;
	readonly onDiagnostic?: (diagnostic: TraceRecordingDiagnostic) => void;
	readonly metadata?: TraceMetadata;
	readonly clock?: TraceClock;
}

export type TraceRecorderStatus = "active" | "degraded" | "failed";

export interface TraceRecordingDiagnostic {
	readonly code: "event_store_write_failed" | "artifact_store_write_failed" | "trace_index_write_failed";
	readonly message: string;
}

export class TraceRecordingError extends Error {
	public readonly code: TraceRecordingDiagnostic["code"];

	public constructor(code: TraceRecordingDiagnostic["code"], cause: unknown) {
		super(`trace recording failed: ${code}`, { cause });
		this.name = "TraceRecordingError";
		this.code = code;
	}
}

export interface TraceModelHandle {
	readonly nodeId: string;
	readonly parentNodeId: string;
	readonly turn: number;
	readonly model: Model<Api>;
	readonly inputContent: TraceContentDescriptor;
	readonly startedWallTime: number;
	readonly startedMonotonic: number;
}

export interface TraceRunTerminal {
	readonly phase: Exclude<TraceEventPhase, "started">;
	readonly error?: TraceError;
	readonly timestamp?: number;
}

interface TraceTurnState {
	readonly nodeId: string;
	readonly startedWallTime: number;
	readonly startedMonotonic: number;
}

interface TraceToolState {
	readonly nodeId: string;
	readonly parentNodeId: string;
	readonly toolName: string;
	readonly inputContent: TraceContentDescriptor;
	readonly startedWallTime: number;
	readonly startedMonotonic: number;
}

const defaultClock: TraceClock = {
	now: () => Date.now(),
	monotonic: () => performance.now(),
};

/**
 * 将运行时值变成可进入 Artifact Store 的 JSON 值。
 *
 * 该清洗边界故意位于 recorder，而不是 Opik exporter：本地 Event Store
 * 与所有下游 projection 都只能看到同一份安全值。private reasoning、凭据、
 * auth header、环境变量和不可序列化对象不会被复制到 artifact。
 */
export function sanitizeTraceValue(value: unknown): unknown {
	return sanitizeValue(value, undefined, new Set<object>());
}

export class RuntimeTraceRecorder {
	public readonly traceId: string;
	readonly #eventStore: Pick<JsonlTraceEventStore, "append" | "events">;
	readonly #artifactStore: Pick<FileArtifactStore, "put"> | undefined;
	readonly #mode: Exclude<RecordingMode, "off">;
	readonly #failurePolicy: RecordingFailurePolicy;
	readonly #onDiagnostic: ((diagnostic: TraceRecordingDiagnostic) => void) | undefined;
	readonly #redactionPolicyDigest: string;
	readonly #metadata: TraceMetadata;
	readonly #clock: TraceClock;
	readonly #turns = new Map<number, TraceTurnState>();
	readonly #tools = new Map<string, TraceToolState>();
	#agentNodeId: string | undefined;
	#currentTurnNodeId: string | undefined;
	#currentModelNodeId: string | undefined;
	#modelSequence = 0;
	#started = false;
	#finished = false;
	#status: TraceRecorderStatus = "active";
	#eventStoreDisabled = false;
	#artifactStoreDisabled = false;
	readonly #reportedDiagnostics = new Set<TraceRecordingDiagnostic["code"]>();
	readonly #localTelemetryPort: LocalTelemetryPort;

	public constructor(options: RuntimeTraceRecorderOptions) {
		this.traceId = options.traceId;
		this.#eventStore = options.eventStore;
		this.#artifactStore = options.artifactStore;
		this.#mode = options.mode;
		this.#failurePolicy = options.failurePolicy;
		this.#onDiagnostic = options.onDiagnostic;
		this.#redactionPolicyDigest = options.redactionPolicyDigest;
		this.#metadata = options.metadata ?? {};
		this.#clock = options.clock ?? defaultClock;
		const localTelemetryPort = createLocalTelemetryPort({
			eventStore: options.eventStore,
			traceId: options.traceId as TraceId,
			...(typeof options.metadata?.sessionId === "string" ? { sessionId: options.metadata.sessionId as SessionId } : {}),
			...(typeof options.metadata?.ownerGeneration === "number" ? { ownerGeneration: options.metadata.ownerGeneration } : {}),
			mode: options.mode,
			failurePolicy: options.failurePolicy,
		});
		if (localTelemetryPort === undefined) throw new Error("local telemetry port requires recording to be enabled");
		this.#localTelemetryPort = localTelemetryPort;
	}

	public get status(): TraceRecorderStatus {
		return this.#status;
	}

	/** Session Runtime 只在 recording enabled 时从已创建的 Trace recorder 取得本地 port。 */
	public localTelemetryPort(): LocalTelemetryPort {
		return this.#localTelemetryPort;
	}

	/** Agent Loop correlation 复用 factory 注入的 Session Owner 代际。 */
	public ownerGeneration(): number {
		const value = this.#metadata.ownerGeneration;
		return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
	}

	public async startRun(input: { agentId?: string; metadata?: TraceMetadata } = {}): Promise<void> {
		if (this.#started) return;
		this.#started = true;
		this.#finished = false;
		this.#agentNodeId = `agent:${input.agentId ?? this.traceId}`;
		const timestamp = this.#timestamp();
		try {
			await this.#append({
				nodeId: this.traceId,
				parentNodeId: null,
				kind: "trace",
				name: "agent.run",
				phase: "started",
				timestamp,
				metadata: { event: "trace.started", ...input.metadata, ...this.#metadata },
			});
			await this.#append({
				nodeId: this.#agentNodeId,
				parentNodeId: this.traceId,
				kind: "agent",
				name: "agent",
				phase: "started",
				timestamp,
				metadata: { event: "agent.started" },
			});
			await this.#localTelemetryPort.forceSample("run");
		} catch (error) {
			await this.#localTelemetryPort.close();
			throw error;
		}
	}

	/** 将已有 AgentEvent 投影为 trace 节点生命周期。 */
	public async recordAgentEvent(event: AgentEvent): Promise<void> {
		if (event.type !== "agent_start" && !this.#started) {
			await this.startRun();
		}
		switch (event.type) {
			case "agent_start":
				await this.startRun();
				return;
			case "agent_end":
				await this.finishRun({ phase: "finished", timestamp: event.timestamp });
				return;
			case "turn_start":
				await this.#startTurn(event.turn, event.timestamp);
				return;
			case "turn_end":
				await this.#finishTurn(event.turn, event.timestamp, event.stopReason);
				return;
			case "tool_execution_start":
				await this.#startTool(event);
				return;
			case "tool_execution_end":
				await this.#finishTool(event);
				return;
			case "message_start":
			case "message_end":
			case "message_update":
			case "tool_execution_update":
			case "queue_update":
				return;
		}
	}

	/** 显式闭合非 AgentEvent 驱动的 Runtime；重复调用不追加第二组终态。 */
	public async finishRun(input: TraceRunTerminal): Promise<void> {
		if (this.#finished) return;
		if (!this.#started) await this.startRun();
		this.#finished = true;
		const timestamp = this.#iso(input.timestamp ?? this.#clock.now());
		const eventName = input.phase === "finished" ? "finished" : input.phase;
		try {
			await this.#localTelemetryPort.forceSample("run");
			await this.#append({
				nodeId: this.#agentNodeId ?? `agent:${this.traceId}`,
				parentNodeId: this.traceId,
				kind: "agent",
				name: "agent",
				phase: input.phase,
				timestamp,
				...(input.error === undefined ? {} : { error: input.error }),
				metadata: { event: `agent.${eventName}` },
			});
			await this.#append({
				nodeId: this.traceId,
				parentNodeId: null,
				kind: "trace",
				name: "agent.run",
				phase: input.phase,
				timestamp,
				...(input.error === undefined ? {} : { error: input.error }),
				metadata: { event: `trace.${eventName}` },
			});
		} finally {
			await this.#localTelemetryPort.close();
		}
	}

	/** 记录 Host-owned process output 的可观测投影，不复制 process truth。 */
	public async recordManagedProcessOutput(input: {
		readonly executionId: string;
		readonly attemptId: string;
		readonly mode: Exclude<RecordingMode, "off">;
		readonly sourceDigest: { readonly algorithm: "sha256"; readonly digest: string };
		readonly recordDigest: { readonly algorithm: "sha256"; readonly digest: string };
		readonly outputContent: TraceContentDescriptor;
	}): Promise<void> {
		const identityDigest = createHash("sha256")
			.update(canonicalJson({
				traceId: this.traceId,
				executionId: input.executionId,
				attemptId: input.attemptId,
				recordDigest: input.recordDigest,
			}))
			.digest("hex");
		const eventId = `event:process-output-${identityDigest}`;
		let existing: readonly { readonly eventId: string }[];
		try {
			existing = await this.#eventStore.events();
		} catch (error) {
			this.#handleFailure("event_store_write_failed", error);
			return;
		}
		if (existing.some((event) => event.eventId === eventId)) return;

		if (!this.#started) await this.startRun();
		const outputContent = this.#mode === "events"
			? {
				storage: "digest_only" as const,
				digest: input.sourceDigest.digest,
				mediaType: input.outputContent.mediaType,
				size: input.outputContent.size,
			}
			: input.outputContent;
		await this.#append({
			nodeId: `process-output:${this.traceId}:${identityDigest}`,
			parentNodeId: this.#agentNodeId ?? this.traceId,
			kind: "tool_attempt",
			name: "process.output",
			phase: "finished",
			timestamp: this.#timestamp(),
			outputContent,
			metadata: {
				event: "process.output_materialized",
				executionId: input.executionId,
				attemptId: input.attemptId,
				mode: this.#mode,
				sourceDigest: input.sourceDigest.digest,
				recordDigest: input.recordDigest.digest,
			},
		}, eventId);
	}

	/** 在 provider 调用前记录完整的安全清洗 context 和 model span。 */
	public async startModel(input: {
		readonly turn: number;
		readonly model: Model<Api>;
		readonly context: LlmContext;
	}): Promise<TraceModelHandle> {
		if (!this.#started) await this.startRun();
		const parentNodeId = this.#turns.get(input.turn)?.nodeId ?? this.#currentTurnNodeId ?? this.#agentNodeId ?? this.traceId;
		const nodeId = `model:${this.traceId}:${input.turn}:${++this.#modelSequence}`;
		const startedWallTime = this.#clock.now();
		const startedMonotonic = this.#clock.monotonic();
		const inputContent = await this.#putJson({
			systemPrompt: input.context.systemPrompt,
			messages: input.context.messages,
			tools: input.context.tools?.map(toolDescriptor),
		});
		await this.#append({
			nodeId,
			parentNodeId,
			kind: "model",
			name: modelName(input.model),
			phase: "started",
			timestamp: this.#iso(startedWallTime),
			inputContent,
			metadata: {
				event: "model.requested",
				provider: input.model.provider,
				api: input.model.api,
				model: input.model.id,
				turn: input.turn,
			},
		});
		await this.#append({
			nodeId: `context:${nodeId}`,
			parentNodeId: nodeId,
			kind: "context",
			name: "context",
			phase: "finished",
			timestamp: this.#iso(startedWallTime),
			outputContent: inputContent,
			metadata: { event: "context.assembled", turn: input.turn },
		});
		this.#currentModelNodeId = nodeId;
		return {
			nodeId,
			parentNodeId,
			turn: input.turn,
			model: input.model,
			inputContent,
			startedWallTime,
			startedMonotonic,
		};
	}

	/** 在 provider stream 完成后记录 assistant output、usage、cost 和耗时。 */
	public async finishModel(handle: TraceModelHandle, message?: AssistantMessage): Promise<void> {
		const phase = message?.stopReason === "aborted"
			? "interrupted"
			: message?.stopReason === "error" || message === undefined
				? "failed"
				: "finished";
		const outputContent = message === undefined
			? undefined
			: await this.#putJson({ message });
		const usage = toTraceUsage(message?.usage);
		const cost = toTraceCost(message?.usage);
		const error = message?.stopReason === "stop" || message?.stopReason === "toolUse" || message?.stopReason === "length"
			? undefined
			: toTraceError(message?.stopReason, message?.errorMessage);
		await this.#append({
			nodeId: handle.nodeId,
			parentNodeId: handle.parentNodeId,
			kind: "model",
			name: modelName(handle.model),
			phase,
			timestamp: this.#timestamp(),
			durationMs: durationMs(this.#clock.monotonic(), handle.startedMonotonic),
			inputContent: handle.inputContent,
			...(outputContent === undefined ? {} : { outputContent }),
			usage,
			cost,
			...(error === undefined ? {} : { error }),
			metadata: {
				event: phase === "finished" ? "model.finished" : "model.failed",
				provider: handle.model.provider,
				api: handle.model.api,
				model: handle.model.id,
				turn: handle.turn,
				stopReason: message?.stopReason ?? "error",
			},
		});
	}

	/** 仅供本地 replay/UI 使用；Opik exporter 应从 Event Store 读取。 */
	public async tree(): Promise<TraceTreeNode | undefined> {
		const projection = new TraceTreeProjection();
		for (const event of await this.#eventStore.events()) projection.apply(event);
		return projection.tree(this.traceId);
	}

	async #startTurn(turn: number, timestamp: number): Promise<void> {
		if (this.#turns.has(turn)) return;
		const nodeId = `turn:${this.traceId}:${turn}`;
		const state: TraceTurnState = {
			nodeId,
			startedWallTime: timestamp,
			startedMonotonic: this.#clock.monotonic(),
		};
		this.#turns.set(turn, state);
		this.#currentTurnNodeId = nodeId;
		await this.#append({
			nodeId,
			parentNodeId: this.#agentNodeId ?? this.traceId,
			kind: "turn",
			name: "turn",
			phase: "started",
			timestamp: this.#iso(timestamp),
			metadata: { event: "turn.started", turn },
		});
		await this.#localTelemetryPort.forceSample("turn");
	}

	async #finishTurn(turn: number, timestamp: number, stopReason?: StopReason): Promise<void> {
		const state = this.#turns.get(turn);
		if (!state) return;
		await this.#append({
			nodeId: state.nodeId,
			parentNodeId: this.#agentNodeId ?? this.traceId,
			kind: "turn",
			name: "turn",
			phase: "finished",
			timestamp: this.#iso(timestamp),
			durationMs: durationMs(this.#clock.monotonic(), state.startedMonotonic),
			metadata: {
				event: "turn.finished",
				turn,
				...(stopReason === undefined ? {} : { stopReason }),
			},
		});
		await this.#localTelemetryPort.forceSample("turn");
		if (this.#currentTurnNodeId === state.nodeId) this.#currentTurnNodeId = undefined;
		if (this.#currentModelNodeId?.startsWith(`model:${this.traceId}:${turn}:`)) this.#currentModelNodeId = undefined;
	}

	async #startTool(event: Extract<AgentEvent, { type: "tool_execution_start" }>): Promise<void> {
		if (this.#tools.has(event.toolCallId)) return;
		const parentNodeId = this.#currentModelNodeId ?? this.#currentTurnNodeId ?? this.#agentNodeId ?? this.traceId;
		const inputContent = await this.#putJson(event.args);
		const state: TraceToolState = {
			nodeId: `tool:${event.toolCallId}`,
			parentNodeId,
			toolName: event.toolName,
			inputContent,
			startedWallTime: event.timestamp,
			startedMonotonic: this.#clock.monotonic(),
		};
		this.#tools.set(event.toolCallId, state);
		await this.#append({
			nodeId: state.nodeId,
			parentNodeId,
			kind: "tool",
			name: `tool:${event.toolName}`,
			phase: "started",
			timestamp: this.#iso(event.timestamp),
			inputContent,
			metadata: { event: "tool.requested", tool: event.toolName, toolCallId: event.toolCallId },
		});
	}

	async #finishTool(event: Extract<AgentEvent, { type: "tool_execution_end" }>): Promise<void> {
		const state = this.#tools.get(event.toolCallId);
		if (!state) return;
		const outputContent = await this.#putJson(event.result);
		const phase = event.isError ? "failed" : "finished";
		await this.#append({
			nodeId: state.nodeId,
			parentNodeId: state.parentNodeId,
			kind: "tool",
			name: `tool:${state.toolName}`,
			phase,
			timestamp: this.#timestamp(),
			durationMs: durationMs(this.#clock.monotonic(), state.startedMonotonic),
			inputContent: state.inputContent,
			outputContent,
			...(event.isError ? { error: { code: "tool_failed", message: "tool execution failed", outcomeCertain: true } } : {}),
			metadata: { event: event.isError ? "tool.failed" : "tool.finished", tool: state.toolName, toolCallId: event.toolCallId },
		});
	}

	async #putJson(value: unknown): Promise<TraceContentDescriptor> {
		const encoded = new TextEncoder().encode(canonicalJson(sanitizeTraceValue(value)));
		const digestOnly = {
			storage: "digest_only",
			digest: createHash("sha256").update(encoded).digest("hex"),
			mediaType: "application/json",
			size: encoded.byteLength,
		} as const;
		if (this.#mode === "events" || this.#eventStoreDisabled || this.#artifactStoreDisabled) return digestOnly;
		if (!this.#artifactStore) return this.#handleArtifactFailure(new Error("artifact store is required"), digestOnly);
		try {
			return await this.#artifactStore.put({
				bytes: encoded,
				mediaType: "application/json",
				redactionPolicyDigest: this.#redactionPolicyDigest,
			});
		} catch (error) {
			return this.#handleArtifactFailure(error, digestOnly);
		}
	}

	async #append(input: Omit<TraceEventInput, "eventId" | "traceId">, eventId = `event:${randomUUID()}`): Promise<void> {
		if (this.#eventStoreDisabled) return;
		try {
			await this.#eventStore.append({
				eventId,
				traceId: this.traceId,
				...input,
			});
		} catch (error) {
			this.#eventStoreDisabled = true;
			this.#handleFailure("event_store_write_failed", error);
		}
	}

	#handleArtifactFailure(error: unknown, fallback: TraceContentDescriptor): TraceContentDescriptor {
		this.#artifactStoreDisabled = true;
		this.#handleFailure("artifact_store_write_failed", error);
		return fallback;
	}

	#handleFailure(code: TraceRecordingDiagnostic["code"], error: unknown): void {
		if (this.#failurePolicy === "fail_closed") {
			this.#status = "failed";
			throw new TraceRecordingError(code, error);
		}
		this.#status = "degraded";
		if (!this.#reportedDiagnostics.has(code)) {
			this.#reportedDiagnostics.add(code);
			this.#onDiagnostic?.({ code, message: `trace recording degraded: ${code}` });
		}
	}

	#timestamp(): string {
		return this.#iso(this.#clock.now());
	}

	#iso(value: number): string {
		return new Date(value).toISOString();
	}
}

function modelName(model: Model<Api>): string {
	return `model:${model.provider}/${model.id}`;
}

function toolDescriptor(tool: AgentTool): Record<string, unknown> {
	return {
		name: tool.name,
		label: tool.label,
		description: tool.description,
		parameters: tool.parameters,
	};
}

function durationMs(current: number, started: number): number {
	return Math.max(0, Math.round(current - started));
}

function toTraceUsage(usage: Usage | undefined): TraceUsage {
	if (usage === undefined) return { source: "unavailable" };
	return {
		inputTokens: usage.input,
		outputTokens: usage.output,
		cacheReadTokens: usage.cacheRead,
		cacheWriteTokens: usage.cacheWrite,
		...(usage.reasoning === undefined ? {} : { reasoningTokens: usage.reasoning }),
		source: "provider_reported",
	};
}

function toTraceCost(usage: Usage | undefined): TraceCost {
	if (usage === undefined) return { source: "unavailable", billable: false };
	const total = usage.cost.total;
	return {
		...(Number.isFinite(total) ? { usdMicros: Math.max(0, Math.round(total * 1_000_000)) } : {}),
		source: "provider",
		billable: true,
	};
}

function toTraceError(stopReason: AssistantMessage["stopReason"] | undefined, message: string | undefined): TraceError {
	const code = stopReason === "aborted" ? "aborted" : "model_failed";
	return {
		code,
		message: redactErrorMessage(message ?? code),
		outcomeCertain: true,
	};
}

function redactErrorMessage(message: string): string {
	return message
		.slice(0, 512)
		.replace(/(bearer\s+)[^\s]+/gi, "$1[REDACTED]")
		.replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

function sanitizeValue(value: unknown, key: string | undefined, seen: Set<object>): unknown {
	if (key !== undefined && isSensitiveKey(key)) return "[REDACTED]";
	if (key !== undefined && isPrivateReasoningKey(key)) return { redacted: true };
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") return redactRuntimeArtifactText(value);
	if (typeof value === "number") return Number.isFinite(value) ? value : "[NON_FINITE_NUMBER]";
	if (value === undefined) return undefined;
	if (typeof value === "bigint") return `[BIGINT ${value.toString()}]`;
	if (typeof value === "function" || typeof value === "symbol") return "[UNSERIALIZABLE]";
	if (value instanceof Uint8Array) return { type: "binary", size: value.byteLength };
	if (typeof value !== "object") return "[UNSERIALIZABLE]";
	if (seen.has(value)) return "[CIRCULAR]";
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map((item) => {
				const child = sanitizeValue(item, undefined, seen);
				return child === undefined ? "[UNDEFINED]" : child;
			});
		}
		const record = value as Record<string, unknown>;
		if (record.type === "thinking") return { type: "thinking", redacted: true };
		const result: Record<string, unknown> = {};
		for (const childKey of Object.keys(record).sort()) {
			const child = sanitizeValue(record[childKey], childKey, seen);
			if (child !== undefined) result[childKey] = child;
		}
		return result;
	} finally {
		seen.delete(value);
	}
}

function isSensitiveKey(key: string): boolean {
	return /^(?:api[_-]?key|authorization|cookie|password|secret|credential|credentials|access[_-]?token|refresh[_-]?token|bearer|headers?|env|environment|private[_-]?key)$/i.test(key);
}

function isPrivateReasoningKey(key: string): boolean {
	return /^(?:thinking|thinkingSignature|thoughtSignature|privateReasoning|reasoningContent)$/i.test(key);
}
