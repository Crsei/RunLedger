import type { StopReason } from "../../types.ts";
import type { SessionEventRecord } from "../../storage/session-store/session-store.ts";
import type { AgentEvent, AgentRunBudgetUsage, AgentRunTerminationReason } from "../types.ts";

export type HumanWaitReason = "approval" | "credential";

export interface AgentRunSummary {
	readonly runId: string;
	readonly status: "completed" | "active" | "recovery_required";
	readonly startedAtMs: number;
	readonly endedAtMs?: number;
	readonly stopReason?: StopReason;
	readonly elapsedMs?: number;
	readonly activeDurationMs?: number;
	readonly messageCountAtEnd?: number;
	readonly terminationReason?: AgentRunTerminationReason;
}

interface ActiveRun {
	readonly runId: string;
	readonly startedAtMs: number;
	readonly startedAtMonotonicMs: number;
	activeStartedAtMonotonicMs: number | undefined;
	activeDurationMs: number;
	readonly waits: Map<string, HumanWaitReason>;
}

/** 领域装配早于 SessionRuntime；绑定前读取必须 fail closed。 */
export class LateBoundAgentRunBudgetUsage implements AgentRunBudgetUsage {
	private current: AgentRunBudgetUsage | undefined;

	public bind(usage: AgentRunBudgetUsage): void {
		this.current = usage;
	}

	public activeDurationMs(): number {
		const current = this.current;
		if (current === undefined) throw new Error("Agent run budget usage is not bound");
		return current.activeDurationMs();
	}
}

/** SessionRuntime 的单调时钟计时器；只把人工 reverse-request 等待排除。 */
export class AgentRunTimingTracker {
	private readonly monotonicNow: () => number;
	private current: ActiveRun | undefined;

	public constructor(monotonicNow: () => number = defaultMonotonicNow) {
		this.monotonicNow = monotonicNow;
	}

	public get activeRun(): AgentRunSummary | undefined {
		const run = this.current;
		if (run === undefined) return undefined;
		return {
			runId: run.runId,
			status: "active",
			startedAtMs: run.startedAtMs,
			activeDurationMs: this.accumulated(run),
		};
	}

	public accept(event: AgentEvent, messageCount: number): AgentEvent {
		if (event.type === "agent_start") {
			const now = this.monotonicNow();
			const runId = event.runId ?? `run-${event.timestamp}`;
			this.current = {
				runId,
				startedAtMs: event.timestamp,
				startedAtMonotonicMs: now,
				activeStartedAtMonotonicMs: now,
				activeDurationMs: 0,
				waits: new Map(),
			};
			return { ...event, runId };
		}
		if (event.type !== "agent_end") return event;
		const run = this.current;
		if (run === undefined || (event.runId !== undefined && event.runId !== run.runId)) return event;
		const now = this.monotonicNow();
		const activeDurationMs = this.accumulated(run, now);
		const explicitMessageCount = Number.isSafeInteger(event.messageCountAtEnd) && (event.messageCountAtEnd ?? -1) >= 0
			? event.messageCountAtEnd
			: undefined;
		const normalized: AgentEvent = {
			type: "agent_end",
			timestamp: event.timestamp,
			runId: run.runId,
			stopReason: event.stopReason ?? "stop",
			elapsedMs: nonNegative(now - run.startedAtMonotonicMs),
			activeDurationMs,
			messageCountAtEnd: explicitMessageCount ?? messageCount,
			...(event.terminationReason === undefined ? {} : { terminationReason: event.terminationReason }),
		};
		this.current = undefined;
		return normalized;
	}

	public pause(waitId: string, reason: HumanWaitReason, timestamp: number): AgentEvent | undefined {
		const run = this.current;
		if (run === undefined || run.waits.has(waitId)) return undefined;
		const wasActive = run.waits.size === 0;
		run.waits.set(waitId, reason);
		if (!wasActive) return undefined;
		const now = this.monotonicNow();
		run.activeDurationMs = this.accumulated(run, now);
		run.activeStartedAtMonotonicMs = undefined;
		return { type: "agent_work_pause", timestamp, runId: run.runId, waitId, reason, activeDurationMs: run.activeDurationMs };
	}

	public resume(waitId: string, timestamp: number): AgentEvent | undefined {
		const run = this.current;
		if (run === undefined) return undefined;
		const reason = run.waits.get(waitId);
		if (reason === undefined) return undefined;
		run.waits.delete(waitId);
		if (run.waits.size > 0) return undefined;
		run.activeStartedAtMonotonicMs = this.monotonicNow();
		return { type: "agent_work_resume", timestamp, runId: run.runId, waitId, reason, activeDurationMs: run.activeDurationMs };
	}

	public abort(timestamp: number, messageCount: number): AgentEvent | undefined {
		if (this.current === undefined) return undefined;
		return this.accept({ type: "agent_end", timestamp, runId: this.current.runId, stopReason: "aborted" }, messageCount);
	}

	private accumulated(run: ActiveRun, now = this.monotonicNow()): number {
		return nonNegative(run.activeDurationMs + (run.activeStartedAtMonotonicMs === undefined ? 0 : now - run.activeStartedAtMonotonicMs));
	}
}

/** 旧 canonical Session 兼容投影；孤立 end 丢弃，孤立 start 标记 recovery。 */
export function projectAgentRunSummaries(events: readonly SessionEventRecord[], currentMessageCount: number): AgentRunSummary[] {
	const summaries: AgentRunSummary[] = [];
	let active: { runId: string; startedAtMs: number; sequence: number; lastStopReason?: StopReason } | undefined;
	let messageCount = 0;
	for (const record of events) {
		if (record.eventType === "ledger.message") messageCount += 1;
		if (record.eventType !== "agent.event") continue;
		const event = parseRecord(record.payloadJson);
		if (event === undefined) continue;
		if (event.type === "agent_start") {
			if (active !== undefined) summaries.push({ runId: active.runId, status: "recovery_required", startedAtMs: active.startedAtMs });
			active = {
				runId: stringValue(event.runId) ?? `legacy-run-${record.sequence}`,
				startedAtMs: numberValue(event.timestamp) ?? record.createdAtMs,
				sequence: record.sequence,
			};
			continue;
		}
		if (event.type === "turn_end" && active !== undefined && isStopReason(event.stopReason)) {
			active.lastStopReason = event.stopReason;
			continue;
		}
		if (event.type !== "agent_end" || active === undefined) continue;
		const eventRunId = stringValue(event.runId);
		if (eventRunId !== undefined && eventRunId !== active.runId) continue;
		const endedAtMs = numberValue(event.timestamp) ?? record.createdAtMs;
		const elapsedMs = numberValue(event.elapsedMs) ?? nonNegative(endedAtMs - active.startedAtMs);
		const explicitMessageCount = numberValue(event.messageCountAtEnd);
		summaries.push({
			runId: active.runId,
			status: "completed",
			startedAtMs: active.startedAtMs,
			endedAtMs,
			stopReason: isStopReason(event.stopReason) ? event.stopReason : active.lastStopReason ?? "stop",
			elapsedMs,
			activeDurationMs: numberValue(event.activeDurationMs) ?? elapsedMs,
			messageCountAtEnd: explicitMessageCount ?? (messageCount > 0 ? messageCount : currentMessageCount),
			...(isTerminationReason(event.terminationReason) ? { terminationReason: event.terminationReason } : {}),
		});
		active = undefined;
	}
	if (active !== undefined) summaries.push({ runId: active.runId, status: "recovery_required", startedAtMs: active.startedAtMs });
	return summaries;
}

function defaultMonotonicNow(): number {
	return performance.now();
}

function nonNegative(value: number): number {
	return Math.max(0, Math.floor(value));
}

function parseRecord(json: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(json) as unknown;
		return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined;
}

function isStopReason(value: unknown): value is StopReason {
	return value === "stop" || value === "length" || value === "toolUse" || value === "error" || value === "aborted";
}

function isTerminationReason(value: unknown): value is AgentRunTerminationReason {
	return value === "model_turn_limit"
		|| value === "tool_turn_limit"
		|| value === "active_duration_limit"
		|| value === "repeated_tool_failure"
		|| value === "approval_expiration_limit";
}
