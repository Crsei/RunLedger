/**
 * S7 拆分:streaming/usage controller —— delta 队列、usage 累积与 flush/backpressure。
 *
 * 拥有 streaming 标志、usage 生命周期、DeltaCoalescer、pending buffer 与
 * timeline projector;flush 每次发完整快照(单调累积),buffer 在 message_end
 * 时清除。Footer 状态由 facade 经本 controller 读取。
 */

import { DeltaCoalescer, type AppendTextDelta } from "../opentui/delta-coalescer.ts";
import { TimelineEventProjector } from "../timeline/event-projector.ts";
import { STATUS_INDICATOR_FRAME_MS } from "../opentui/block-layout.ts";
import { projectStatusIndicator } from "../presentation/projectors.ts";
import {
	applyUsageObservation,
	seedUsageAccumulator,
	usageObservationFromAssistantMessage,
	usageSnapshot,
	type UsageAccumulator,
	type UsageContextInput,
	type UsageObservation,
	type UsageSnapshot,
} from "../../runtime/usage/index.ts";
import type { AgentMessage } from "../../runtime/types.ts";
import type { AssistantMessage } from "../../types.ts";
import type { TimelineEvent } from "../timeline/types.ts";
import type { TuiPerformanceObserver } from "../opentui/performance-observer.ts";
import type { InteractiveModePorts } from "./types.ts";

export class StreamingController {
	private readonly port: InteractiveModePorts;
	private readonly performanceObserver: TuiPerformanceObserver | undefined;
	private streaming = false;
	private stopReason: string | undefined = undefined;
	private streamingGeneration = 0;
	private usageLifecycleObserved = false;
	private usageRunActive = false;
	private activeUsageRunId: string | undefined;
	private usageAccumulator: UsageAccumulator;
	private activeUsageRequestStartedAtMs: number | undefined;
	private readonly streamingDeltas = new DeltaCoalescer({
		softByteLimit: 256 * 1024,
		hardByteLimit: 1024 * 1024,
		softEventLimit: 512,
		hardEventLimit: 4096,
	});
	// B2:帧前 flush 时按 correlationId 累积完整正文快照，再发 message_update
	private readonly pendingMessageBuffers = new Map<string, { text: string; thinking: string }>();
	// B2:Timeline 为 chat 内容的唯一业务 owner；DeltaCoalescer 只做 lossless append/帧前 drain。
	private readonly timelineProjector = new TimelineEventProjector();

	public constructor(port: InteractiveModePorts, initialMessages: readonly AgentMessage[], performanceObserver: TuiPerformanceObserver | undefined) {
		this.port = port;
		this.performanceObserver = performanceObserver;
		this.usageAccumulator = seedUsageAccumulator(initialMessages);
		if (port.controller === undefined) this.timelineProjector.setMessageIndex(initialMessages.length);
	}

	public resetFromCanonicalMessages(): void {
		const messages = this.port.controller?.messages ?? this.port.agent?.state.messages ?? [];
		this.usageAccumulator = seedUsageAccumulator(messages);
		this.activeUsageRequestStartedAtMs = undefined;
		this.usageRunActive = false;
		this.activeUsageRunId = undefined;
		this.streaming = false;
		this.stopReason = undefined;
		this.streamingGeneration += 1;
	}

	public getUsageSnapshot(): UsageSnapshot {
		return usageSnapshot(this.usageAccumulator, this.runtimeContextUsage(), this.usageStatus());
	}

	public isStreaming(): boolean {
		return this.streaming;
	}

	public getStopReason(): string | undefined {
		return this.stopReason;
	}

	public getRunTiming(): { readonly state: "working" | "waiting" | "recovery_required"; readonly activeDurationMs: number; readonly lastResumedAtMs?: number } | undefined {
		if (this.port.store.getState().recoveryRequired) {
			const active = this.port.store.getState().timeline.activeRun;
			return { state: "recovery_required", activeDurationMs: active?.activeDurationMs ?? 0 };
		}
		const active = this.port.store.getState().timeline.activeRun;
		if (active === undefined) return undefined;
		return {
			state: active.state,
			activeDurationMs: active.activeDurationMs,
			...(active.lastResumedAtMs === undefined ? {} : { lastResumedAtMs: active.lastResumedAtMs }),
		};
	}

	public getContextUsage(): { readonly totalTokens?: number; readonly contextWindow?: number } | undefined {
		const state = this.port.store.getState();
		const context = this.runtimeContextUsage();
		let totalTokens = context?.usedTokens;
		let contextWindow = context?.contextWindow;
		if (totalTokens === undefined) {
			const rows = [
				...state.timeline.committedRows,
				...state.timeline.activeOrder.flatMap((id) => {
					const row = state.timeline.activeRowsByCorrelationId[id];
					return row === undefined ? [] : [row];
				}),
			];
			for (let index = rows.length - 1; index >= 0; index -= 1) {
				const row = rows[index];
				if (row?.kind !== "assistant" || row.usage === undefined) continue;
				const input = timelineUsageValue(row.usage.input);
				const output = timelineUsageValue(row.usage.output);
				if (input !== undefined && output !== undefined) {
					totalTokens = input + output;
					break;
				}
			}
		}
		if (contextWindow === undefined) {
			const model = this.port.controller?.currentSelection.model ?? this.port.agent?.state.model;
			if (typeof model === "object" && model !== null && Number.isFinite(model.contextWindow) && model.contextWindow > 0) {
				contextWindow = model.contextWindow;
			}
		}
		if (totalTokens === undefined && contextWindow === undefined) return undefined;
		return {
			...(totalTokens === undefined ? {} : { totalTokens }),
			...(contextWindow === undefined ? {} : { contextWindow }),
		};
	}

	public project(input: Parameters<TimelineEventProjector["project"]>[0]): readonly TimelineEvent[] {
		return this.timelineProjector.project(input);
	}

	public setMessageIndex(count: number): void {
		this.timelineProjector.setMessageIndex(count);
	}

	public currentAssistantCorrelationId(): string {
		return this.timelineProjector.currentAssistantCorrelationId();
	}

	public resetRows(): void {
		this.timelineProjector.resetRows();
	}

	public queueAssistantDelta(delta: AppendTextDelta): void {
		const before = this.streamingDeltas.stats;
		this.performanceObserver?.recordQueued({
			events: 1,
			bytes: new TextEncoder().encode(delta.text).byteLength,
		});
		this.streamingDeltas.push(delta);
		const after = this.streamingDeltas.stats;
		this.performanceObserver?.recordCoalesced({
			textEvents: after.mergedTextEvents - before.mergedTextEvents,
			supersededStatusEvents: after.supersededStatusEvents - before.supersededStatusEvents,
		});
		this.recordStreamingQueueDepth();
		if (!this.port.ui.isStarted) this.flushStreamingDeltas();
	}

	public flushStreamingDeltas(): void {
		let changed = false;
		for (const delta of this.streamingDeltas.drain()) {
			if (delta.kind !== "append-text") continue;
			const correlationId = this.timelineProjector.currentAssistantCorrelationId();
			const buffer = this.pendingMessageBuffers.get(correlationId) ?? { text: "", thinking: "" };
			if (delta.channel === "thinking") buffer.thinking += delta.text;
			else buffer.text += delta.text;
			this.pendingMessageBuffers.set(correlationId, buffer);
			changed = true;
		}
		if (changed) {
			// 每次 flush 发完整快照（单调累积；行正文只会增长），buffer 在 message_end 时清除
			const correlationId = this.timelineProjector.currentAssistantCorrelationId();
			const buffer = this.pendingMessageBuffers.get(correlationId);
			if (buffer !== undefined && (buffer.text.length > 0 || buffer.thinking.length > 0)) {
				this.port.dispatchTimeline([{
					type: "message_update",
					generation: 0,
					correlationId,
					text: { text: buffer.text, truncated: false, byteLength: new TextEncoder().encode(buffer.text).byteLength },
					...(buffer.thinking.length > 0 ? { thinking: { text: buffer.thinking, truncated: false, byteLength: new TextEncoder().encode(buffer.thinking).byteLength } } : {}),
				}]);
			}
		}
		this.recordStreamingQueueDepth();
	}

	public deletePendingBuffer(correlationId: string): void {
		this.pendingMessageBuffers.delete(correlationId);
	}

	public clearPendingBuffers(): void {
		this.pendingMessageBuffers.clear();
	}

	public drainStreamingDeltas(): void {
		this.streamingDeltas.drain();
	}

	public streamingPressure(): { queuedEvents: number; queuedBytes: number; oldestAgeMs: number } {
		const pressure = this.streamingDeltas.pressure;
		return {
			queuedEvents: pressure.queuedEvents,
			queuedBytes: pressure.queuedBytes,
			oldestAgeMs: pressure.oldestAgeMs,
		};
	}

	public generation(): number {
		return this.streamingGeneration;
	}

	public beginStreamingRun(runId: string): void {
		this.flushStreamingDeltas();
		this.port.clearIdleRecapStatus();
		this.streamingGeneration += 1;
		this.usageLifecycleObserved = true;
		this.usageRunActive = true;
		this.activeUsageRunId = runId;
		this.streaming = true;
		this.stopReason = undefined;
		this.activeUsageRequestStartedAtMs = undefined;
		this.scheduleStatusIndicatorFrame();
	}

	public endStreamingRun(stopReason: string | undefined): void {
		this.flushStreamingDeltas();
		this.streaming = false;
		this.usageRunActive = false;
		this.activeUsageRunId = undefined;
		this.stopReason = stopReason ?? this.stopReason ?? "stop";
		this.port.refs.status.setStopReason(this.stopReason);
	}

	public setStreaming(value: boolean): void {
		this.streaming = value;
	}

	public setStopReason(value: string | undefined): void {
		this.stopReason = value;
	}

	public beginAssistantRequest(timestamp: number): void {
		this.activeUsageRequestStartedAtMs = timestamp;
	}

	public endAssistantRequest(): void {
		this.activeUsageRequestStartedAtMs = undefined;
	}

	public observeAssistantUsage(
		id: string,
		message: AgentMessage | AssistantMessage | undefined,
		observedAtMs: number,
		status: UsageObservation["status"],
	): void {
		if (message?.role !== "assistant") return;
		const observation = usageObservationFromAssistantMessage(id, message, "provider", status);
		this.usageAccumulator = applyUsageObservation(this.usageAccumulator, {
			...observation,
			observedAtMs,
			...(this.activeUsageRequestStartedAtMs === undefined ? {} : { streamStartedAtMs: this.activeUsageRequestStartedAtMs }),
		});
	}

	public acceptUsageRunEvent(runId: string | undefined): boolean {
		if (!this.usageLifecycleObserved) return true;
		if (!this.usageRunActive) return false;
		return runId === undefined || this.activeUsageRunId === undefined || runId === this.activeUsageRunId;
	}

	private usageStatus(): UsageSnapshot["status"] {
		if (this.port.store.getState().recoveryRequired) return "unavailable";
		const activeRun = this.port.store.getState().timeline.activeRun;
		if (activeRun?.state === "waiting") return "waiting";
		if (this.streaming || activeRun?.state === "working") return "streaming";
		if (this.stopReason === "error" || this.stopReason === "aborted") return "error";
		return "idle";
	}

	/** Usage row 只接受 runtime snapshot；旧 getter 的 input+output 仅是 legacy approximate fallback。 */
	private runtimeContextUsage(): UsageContextInput | undefined {
		const workflow = this.port.store.getState().runtimeSnapshotWorkflow;
		const snapshot = workflow.state === "ready"
			? workflow.value
			: workflow.state === "loading" || workflow.state === "error"
				? workflow.previous
				: undefined;
		const usedTokens = snapshot?.context.state === "known" && snapshot.context.value.totalTokens.state === "known"
			? snapshot.context.value.totalTokens.value
			: undefined;
		let contextWindow = snapshot?.context.state === "known" && snapshot.context.value.contextWindow.state === "known"
			? snapshot.context.value.contextWindow.value
			: undefined;
		if (contextWindow === undefined) {
			const model = this.port.controller?.currentSelection.model ?? this.port.agent?.state.model;
			if (typeof model === "object" && model !== null && Number.isFinite(model.contextWindow) && model.contextWindow > 0) {
				contextWindow = model.contextWindow;
			}
		}
		if (usedTokens === undefined && contextWindow === undefined) return undefined;
		return {
			...(usedTokens === undefined ? {} : { usedTokens }),
			...(contextWindow === undefined ? {} : { contextWindow }),
		};
	}

	public scheduleStatusIndicatorFrame(): void {
		if (this.port.quitting || this.port.shimmerMode === "disabled") return;
		this.port.ui.scheduleFrameIn(STATUS_INDICATOR_FRAME_MS);
	}

	public refreshStatusIndicator(): void {
		const nowMs = Date.now();
		const activeRun = this.port.store.getState().timeline.activeRun;
		this.port.ui.setStatusIndicator(projectStatusIndicator(activeRun, {
			nowMs,
			animationFrame: Math.floor(nowMs / STATUS_INDICATOR_FRAME_MS),
			interruptKey: this.statusInterruptKey(),
		}), {
			mode: this.port.shimmerMode,
			nowMs,
			theme: this.port.theme,
			truecolor: /^(?:truecolor|24bit)$/iu.test(process.env.COLORTERM ?? ""),
		});
		if (activeRun?.state === "working" || activeRun?.state === "waiting") {
			this.scheduleStatusIndicatorFrame();
		}
	}

	private statusInterruptKey(): string | undefined {
		const configured = this.port.keyBindings()["tui.input.interrupt"];
		const key = Array.isArray(configured) ? configured[0] : configured;
		if (key === undefined) return undefined;
		const control = /^ctrl\+([a-z])$/iu.exec(key);
		return control === null ? key : `^${control[1]!.toUpperCase()}`;
	}

	private recordStreamingQueueDepth(): void {
		const pressure = this.streamingDeltas.pressure;
		this.performanceObserver?.recordQueueDepth({
			events: pressure.queuedEvents,
			bytes: pressure.queuedBytes,
			oldestAgeMs: pressure.oldestAgeMs,
			pressureLevel: pressure.level,
		});
	}
}

function timelineUsageValue(quantity: { readonly state: string; readonly value?: number }): number | undefined {
	return quantity.state === "exact" || quantity.state === "estimated" ? quantity.value : undefined;
}
