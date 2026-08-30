/**
 * S5 拆分:领域事件持久化(normalized event + checkpoint boundary)。
 *
 * 拥有 runTiming 与 stream coalescer:AgentEvent 以 owner-fenced durable
 * event 落库并广播,checkpoint 只作 cache(sourceSequence 取 live head);
 * 落库失败不阻断领域执行(fence 失效由 heartbeat/write fence 自停)。
 */

import type { SessionStore } from "../../storage/session-store/session-store.ts";
import { createRuntimeId, type SessionId } from "../protocol/ids.ts";
import type { OwnerFence, SessionCheckpointBoundary } from "../session-owner/types.ts";
import type { AgentEvent } from "../types.ts";
import type { SessionControllerEvent } from "../session-server/runtime-server.ts";
import type { RestoreOutcome } from "./restore.ts";
import { putSessionCheckpoint } from "./checkpoint.ts";
import { AgentRunTimingTracker, projectAgentRunSummaries, type AgentRunSummary, type HumanWaitReason } from "./run-timing.ts";
import { SessionStreamEventCoalescer } from "./stream-event-coalescer.ts";
import type { SessionDomainPort } from "./session-runtime.ts";

export interface SessionEventPersistencePort {
	readonly store: SessionStore;
	readonly fence: OwnerFence;
	readonly sessionId: SessionId;
	readonly restored: Extract<RestoreOutcome, { readonly ok: true }>;
	readonly domain: SessionDomainPort | undefined;
	readonly emit: (event: SessionControllerEvent) => void;
}

export class SessionEventPersistence {
	private readonly port: SessionEventPersistencePort;
	private readonly runTiming = new AgentRunTimingTracker();
	private readonly streamEvents: SessionStreamEventCoalescer;

	public constructor(port: SessionEventPersistencePort) {
		this.port = port;
		this.streamEvents = new SessionStreamEventCoalescer({ emit: (event) => this.persistDomainAgentEvent(event) });
	}

	public acceptDomainEvent(event: AgentEvent): void {
		this.streamEvents.accept(event);
	}

	public flush(): void {
		this.streamEvents.flush();
	}

	public dispose(): void {
		this.streamEvents.dispose();
	}

	private persistDomainAgentEvent(event: AgentEvent): void {
		this.persistAgentEvent(event);
		const boundary = checkpointBoundaryForAgentEvent(event);
		if (boundary !== undefined) this.putCheckpoint(boundary, this.checkpointState(event.type, event.timestamp, false));
	}

	public checkpointState(eventType: string, eventTimestamp: number, replayReady: boolean): Record<string, unknown> {
		const snapshot = this.port.domain?.snapshot();
		return {
			replayReady,
			eventType,
			eventTimestamp,
			...(snapshot === undefined ? {} : {
				messages: snapshot.messages,
				warnings: snapshot.warnings,
				auditEntries: snapshot.auditEntries,
				selection: snapshot.selection,
				steeringQueue: typeof this.port.domain?.controller.getSteeringMessages === "function" ? this.port.domain.controller.getSteeringMessages() : [],
				followUpQueue: typeof this.port.domain?.controller.getFollowUpMessages === "function" ? this.port.domain.controller.getFollowUpMessages() : [],
			}),
		};
	}

	/** AgentEvent → durable `agent.event`(owner-fenced)+ emit 广播。 */
	private persistAgentEvent(event: AgentEvent): void {
		const normalized = this.runTiming.accept(event, this.port.domain?.snapshot().messages.length ?? 0);
		this.persistNormalizedAgentEvent(normalized);
	}

	private persistNormalizedAgentEvent(event: AgentEvent): void {
		let sequence: number | undefined;
		try {
			const tail = this.port.store.replaySessionEvents(this.port.sessionId).at(-1);
			const appended = this.port.store.appendEvent(this.port.fence, {
				eventId: createRuntimeId("event", `agent-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`),
				ownerGeneration: this.port.fence.generation,
				eventType: "agent.event",
				payloadJson: JSON.stringify(event),
				createdAtMs: event.timestamp,
				expectedPreviousEventHash: tail?.currentEventHash ?? null,
			});
			sequence = appended.sequence;
		} catch {
			// 事件落库失败不阻断领域执行;fence 失效由 heartbeat/write fence 自停。
		}
		this.port.emit({ eventType: "agent_event", payload: { event: event as unknown as Record<string, unknown> }, sequence });
	}

	/** 现有/未来 reverse-request 的统一人工等待边界，finally 保证最后一个 wait 闭合。 */
	public async withHumanInputWait<T>(waitId: string, reason: HumanWaitReason, operation: () => Promise<T>): Promise<T> {
		const pause = this.runTiming.pause(waitId, reason, Date.now());
		if (pause !== undefined) this.persistNormalizedAgentEvent(pause);
		try {
			return await operation();
		} finally {
			const resume = this.runTiming.resume(waitId, Date.now());
			if (resume !== undefined) this.persistNormalizedAgentEvent(resume);
		}
	}

	public activeDurationMs(): number {
		return this.runTiming.activeRun?.activeDurationMs ?? 0;
	}

	/** §7.2 六个 safe checkpoint boundary。sourceSequence 取当前 live head(不是
	 *  启动时冻结的 restored.headSequence),运行中新事件持续推进 checkpoint。 */
	public putCheckpoint(boundary: SessionCheckpointBoundary, state: Record<string, unknown>): void {
		try {
			const descriptor = putSessionCheckpoint(this.port.store, this.port.fence, boundary, this.currentHeadSequence(), state);
			this.port.emit({ eventType: "session.checkpoint", payload: { checkpointId: descriptor.checkpointId, boundary, sourceSequence: descriptor.sourceSequence } });
		} catch {
			// checkpoint 是 cache:写入失败不改变 authority。
		}
	}

	/** 当前权威 event head(sessions.head_sequence 是唯一真源)。 */
	public currentHeadSequence(): number {
		try {
			const row = this.port.store.database().querySingle("SELECT head_sequence FROM sessions WHERE session_id = ?", [this.port.sessionId]);
			return Number(row?.head_sequence ?? this.port.restored.headSequence);
		} catch {
			return this.port.restored.headSequence;
		}
	}

	public persistAbortedRunIfNeeded(): void {
		const aborted = this.runTiming.abort(Date.now(), this.port.domain?.snapshot().messages.length ?? 0);
		if (aborted !== undefined) this.persistNormalizedAgentEvent(aborted);
	}

	public runSummaries(events: ReturnType<SessionStore["replaySessionEvents"]>, messageCount: number): readonly AgentRunSummary[] {
		const projected = projectAgentRunSummaries(events, messageCount);
		const active = this.runTiming.activeRun;
		if (active === undefined) return projected;
		return [...projected.filter((summary) => summary.runId !== active.runId), active];
	}
}

function checkpointBoundaryForAgentEvent(event: AgentEvent): SessionCheckpointBoundary | undefined {
	switch (event.type) {
		case "turn_start": return "before_model";
		case "message_end": return event.role === "assistant" ? "after_model" : undefined;
		case "tool_execution_start": return "before_tool";
		case "tool_execution_end": return "after_tool";
		case "turn_end": return "turn_completed";
		default: return undefined;
	}
}
