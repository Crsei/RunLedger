/**
 * S7 拆分:event controller —— TuiEvent → state/effect/timeline。
 *
 * 主控 switch 把 Agent 事件投影到 canonical Timeline 并流式更新;user 消息
 * 块在 submit 阶段已 push,事件流不再处理 user 分支。异常不外抛,记 stderr。
 */

import { adaptAgentEvent, type TuiEvent } from "../types.ts";
import { messageAssistantText, messageAssistantThinking, isRunStopReason } from "./event-helpers.ts";
import type { SessionTitleChangedEvent } from "../../runtime/interactive-session-controller.ts";
import { isSessionCatalogResult } from "../sessions/types.ts";
import type { AgentEvent } from "../../runtime/types.ts";
import type { TimelineEvent } from "../timeline/types.ts";
import type { StreamingController } from "./streaming-controller.ts";
import type { InteractiveModePorts } from "./types.ts";

export class EventController {
	private readonly port: InteractiveModePorts;
	private readonly streaming: StreamingController;
	private timelineEventGeneration = 0;

	public constructor(port: InteractiveModePorts, streaming: StreamingController) {
		this.port = port;
		this.streaming = streaming;
	}

	public dispatchTimeline(events: readonly TimelineEvent[]): void {
		for (const event of events) {
			this.timelineEventGeneration += 1;
			this.port.store.dispatch({ type: "timeline.event", event: { ...event, generation: this.timelineEventGeneration } });
		}
	}

	/** Agent.subscribe 回调,适配为 TuiEvent 后分发。 */
	public handleAgentEvent(ev: AgentEvent): void {
		let adapted: TuiEvent;
		try {
			adapted = adaptAgentEvent(ev);
		} catch (e) {
			process.stderr.write(`[interactive-mode] adaptAgentEvent failed: ${String(e)}\n`);
			return;
		}
		this.handleEvent(adapted);
	}

	/** Durable title events update the immediate strip and requery catalog state. */
	public handleSessionTitleChanged(event: SessionTitleChangedEvent): void {
		const port = this.port;
		if (port.quitting || event.sessionId !== port.getSessionId()) return;
		port.store.dispatch({
			type: "session.title.changed",
			generation: port.store.getState().authorityGeneration,
			sessionId: event.sessionId,
			title: event.title,
		});
		port.uiRequestRender();
		const workflow = port.store.getState().sessionWorkflow;
		if (workflow.state === "loading") return;
		if (workflow.state === "ready" && isSessionCatalogResult(workflow.value)) {
			const current = workflow.value.items.find((item) => item.sessionId === event.sessionId);
			if (current?.title === event.title && (event.sequence === undefined || current.headSequence >= event.sequence)) return;
		}
		void this.sessionCatalogRefresh();
	}

	private sessionCatalogRefresh(): Promise<void> {
		return Promise.resolve(this.port.refreshSessionCatalog());
	}

	/**
	 * 主控 switch：message_* 统一投影到 canonical Timeline 并流式更新；
	 * user 消息块在 handleSubmit 阶段已 push,事件流不再处理 user 分支;
	 * 其余 case 留 noop 占位,M3 起逐 case 落实(对照 03-event-binding §1 表)。
	 */
	public handleEvent(ev: TuiEvent): void {
		try {
			switch (ev.type) {
				case "agent_start":
					this.streaming.beginStreamingRun(ev.runId ?? `legacy-live-${ev.timestamp}`);
					this.dispatchTimeline([{
						type: "run_start",
						generation: 0,
						runId: ev.runId ?? `legacy-live-${ev.timestamp}`,
						timestamp: ev.timestamp,
						activeDurationMs: 0,
					}]);
					this.streaming.scheduleStatusIndicatorFrame();
					break;
				case "agent_end":
					{
						const activeRunId = this.port.store.getState().timeline.activeRun?.runId;
						if (activeRunId === undefined || (ev.runId !== undefined && ev.runId !== activeRunId)) break;
						this.streaming.endStreamingRun(ev.stopReason ?? this.streaming.getStopReason() ?? "stop");
						const stopReason = this.streaming.getStopReason() ?? "stop";
						if (isRunStopReason(stopReason)) {
							this.dispatchTimeline([{
								type: "run_end",
								generation: 0,
								runId: ev.runId ?? activeRunId,
								timestamp: ev.timestamp,
								stopReason,
								...(ev.elapsedMs === undefined ? {} : { elapsedMs: ev.elapsedMs }),
								...(ev.activeDurationMs === undefined ? {} : { activeDurationMs: ev.activeDurationMs }),
								...(ev.messageCountAtEnd === undefined ? {} : { messageCountAtEnd: ev.messageCountAtEnd }),
							}]);
						}
						break;
					}
				case "agent_work_pause":
					this.dispatchTimeline([{ type: "run_pause", generation: 0, runId: ev.runId, waitId: ev.waitId, reason: ev.reason, timestamp: ev.timestamp, activeDurationMs: ev.activeDurationMs }]);
					this.streaming.scheduleStatusIndicatorFrame();
					break;
				case "agent_work_resume":
					this.dispatchTimeline([{ type: "run_resume", generation: 0, runId: ev.runId, waitId: ev.waitId, timestamp: ev.timestamp, activeDurationMs: ev.activeDurationMs }]);
					this.streaming.scheduleStatusIndicatorFrame();
					break;
				case "turn_start":
				case "turn_end":
					break;
				case "message_start":
					if (!this.streaming.acceptUsageRunEvent(ev.runId)) break;
					this.streaming.flushStreamingDeltas();
					this.dispatchTimeline(this.streaming.project({ kind: "tui-event", event: ev }));
					if (ev.role === "assistant") {
						this.streaming.beginAssistantRequest(ev.timestamp);
						this.streaming.observeAssistantUsage(
							this.streaming.currentAssistantCorrelationId(),
							ev.message,
							ev.timestamp,
							"streaming",
						);
					}
					break;
				case "message_end": {
					if (!this.streaming.acceptUsageRunEvent(ev.runId)) break;
					const stopReason = ev.stopReason ?? this.streaming.getStopReason();
					this.streaming.setStopReason(stopReason);
					// 1) 先把帧前累积的 delta 快照送入
					this.streaming.flushStreamingDeltas();
					// 2) 用完整消息正文覆盖最后一次 delta 快照
					if (ev.message?.role === "assistant") {
						this.streaming.observeAssistantUsage(
							this.streaming.currentAssistantCorrelationId(),
							ev.message,
							ev.timestamp,
							ev.stopReason === "error" || ev.stopReason === "aborted" ? "error" : "completed",
						);
						const text = messageAssistantText(ev.message);
						const thinking = messageAssistantThinking(ev.message);
						const correlationId = this.streaming.currentAssistantCorrelationId();
						const finalEvents: TimelineEvent[] = [{
							type: "message_update",
							generation: 0,
							correlationId,
							text: { text, truncated: false, byteLength: new TextEncoder().encode(text).byteLength },
							...(thinking.length > 0 ? { thinking: { text: thinking, truncated: false, byteLength: new TextEncoder().encode(thinking).byteLength } } : {}),
						}];
						this.dispatchTimeline(finalEvents);
					}
					// 3) 提交行
					this.dispatchTimeline(this.streaming.project({ kind: "tui-event", event: ev }));
					this.streaming.deletePendingBuffer(this.streaming.currentAssistantCorrelationId());
					this.streaming.endAssistantRequest();
					break;
				}
				case "message_update": {
					if (!this.streaming.acceptUsageRunEvent(ev.runId)) break;
					const e = ev.assistantMessageEvent;
					const partial = "partial" in e ? e.partial : undefined;
					if (partial?.role === "assistant") {
						this.streaming.observeAssistantUsage(
							this.streaming.currentAssistantCorrelationId(),
							partial,
							ev.timestamp,
							"streaming",
						);
					}
					if (e.type === "done" || e.type === "error") {
						this.streaming.observeAssistantUsage(
							this.streaming.currentAssistantCorrelationId(),
							e.type === "done" ? e.message : e.error,
							ev.timestamp,
							e.type === "error" ? "error" : "completed",
						);
						// done/error 即 stream fan-in 终点;先把已接受正文送入最终 frame。
						this.streaming.flushStreamingDeltas();
						break;
					}
					if (partial !== undefined && partial.role !== "assistant") break;
					switch (e.type) {
						case "text_delta":
							this.streaming.queueAssistantDelta({
								kind: "append-text",
								entryId: "assistant",
								partId: `text:${e.contentIndex}`,
								channel: "text",
								generation: this.streamingGeneration(),
								text: e.delta,
								receivedAt: Date.now(),
							});
							break;
						case "thinking_delta":
							this.streaming.queueAssistantDelta({
								kind: "append-text",
								entryId: "assistant",
								partId: `thinking:${e.contentIndex}`,
								channel: "thinking",
								generation: this.streamingGeneration(),
								text: e.delta,
								receivedAt: Date.now(),
							});
							break;
						default:
							break;
					}
					break;
				}
				case "tool_execution_start":
					this.streaming.flushStreamingDeltas();
					this.dispatchTimeline(this.streaming.project({ kind: "tui-event", event: ev }));
					break;
				case "tool_execution_update":
					this.dispatchTimeline(this.streaming.project({ kind: "tui-event", event: ev }));
					break;
				case "tool_execution_end": {
					this.streaming.flushStreamingDeltas();
					this.dispatchTimeline(this.streaming.project({ kind: "tui-event", event: ev }));
					break;
				}
				case "queue_update":
					this.port.store.dispatch({ type: "queue.changed", steering: ev.steering.length, followUp: ev.followUp.length });
					break;
			}
		} catch (e) {
			// 异常不外抛(对照 02 §1 不可变契约);记 stderr
			process.stderr.write(`[interactive-mode] handleEvent ${ev.type} failed: ${String(e)}\n`);
		}
		// 任何事件后都请求一次合帧；stream backlog 超过预算时由 scheduler 提前让出一帧。
		const pressure = this.streaming.streamingPressure();
		this.port.ui.requestRender(false, {
			queuedEvents: pressure.queuedEvents,
			queuedBytes: pressure.queuedBytes,
			oldestAgeMs: pressure.oldestAgeMs,
		});
	}

	private streamingGeneration(): number {
		return this.streaming.generation();
	}
}
