/**
 * `SessionLoopController` 的测试宿主：只提供 controller 需要的窄端口，
 * 不引入 store/server/agent。提交与审计都记录到数组，供断言迭代节奏。
 */

import type { AgentEvent } from "../../../src/runtime/types.ts";
import type { OwnerFence } from "../../../src/runtime/session-owner/types.ts";
import type { SessionControllerEvent, SessionRuntimeServer } from "../../../src/runtime/session-server/runtime-server.ts";
import type { RecoveryBarrier } from "../../../src/runtime/session-runtime/recovery-barrier.ts";
import { SessionLoopController, type LoopAuditPayload } from "../../../src/runtime/session-runtime/loop-controller.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import type { SessionDomainPort, SessionRuntimeState } from "../../../src/runtime/session-runtime/session-runtime.ts";

export interface LoopTestHarness {
	readonly controller: SessionLoopController;
	readonly submissions: readonly string[];
	readonly audits: readonly { readonly eventType: string; readonly payload: LoopAuditPayload }[];
	readonly stopReasons: readonly string[];
	readonly events: readonly SessionControllerEvent[];
	/** 模拟一次 run 结束；通过 terminationReason 表达 run budget 终止。 */
	emitAgentEnd(terminationReason?: Extract<AgentEvent, { type: "agent_end" }>["terminationReason"]): void;
	/** 模拟 driver claim 期间 recovery barrier 打开。 */
	openBarrier(): void;
	/** 等 controller 内部的 setTimeout(0) 结算。 */
	settle(): Promise<void>;
}

export function createLoopTestHarness(options: { readonly promptFailure?: Error } = {}): LoopTestHarness {
	const submissions: string[] = [];
	const audits: Array<{ readonly eventType: string; readonly payload: LoopAuditPayload }> = [];
	const stopReasons: string[] = [];
	const events: SessionControllerEvent[] = [];
	const fence: OwnerFence = { sessionId: createRuntimeId("session", "loop-harness"), runtimeId: createRuntimeId("runtime", "loop-harness"), generation: 1 };
	const domain = {
		controller: {
			// controller 侧必须提供 waitForIdle：注入新轮前要等上一轮 run 真正结束。
			waitForIdle: async () => undefined,
			prompt: async (text: string) => {
				if (options.promptFailure !== undefined) throw options.promptFailure;
				submissions.push(text);
			},
			getSteeringMessages: () => [],
			getFollowUpMessages: () => [],
		},
		snapshot: () => ({ inFlight: false }),
	} as unknown as SessionDomainPort;
	// 只实现 controller 真正使用的 barrier 面（admitPrompt + currentState）。
	// 只实现 controller 真正使用的 barrier 面（admitPrompt + currentState）。
	// currentState 在真实类上是 getter，这里用普通可变字段以便测试切换。
	const barrierState = { open: false };
	const barrier = {
		currentState: "closed" as "closed" | "open",
		admitPrompt: (): { readonly ok: true } | { readonly ok: false; readonly code: "recovery_barrier_active" } =>
			barrierState.open ? { ok: false, code: "recovery_barrier_active" } : { ok: true },
	} as unknown as RecoveryBarrier;
	const controller = new SessionLoopController({
		domain,
		sessionId: fence.sessionId,
		fence,
		barrier,
		server: { driverConnectionId: () => createRuntimeId("connection", "loop-harness") } as unknown as SessionRuntimeServer,
		state: () => "ready" as SessionRuntimeState,
		emit: (event) => { events.push(event); },
		appendAudit: (eventType, payload) => {
			audits.push({ eventType, payload });
			if (eventType === "loop.stopped" && payload.reasonCode !== undefined) stopReasons.push(payload.reasonCode);
		},
		settings: { enabled: true, maxIterations: 50, conditionEnabled: false },
	});
	return {
		controller,
		submissions,
		audits,
		stopReasons,
		events,
		emitAgentEnd: (terminationReason) => {
			controller.handleDomainAgentEvent({
				type: "agent_end",
				timestamp: Date.now(),
				stopReason: "stop",
				...(terminationReason === undefined ? {} : { terminationReason }),
			} as AgentEvent);
		},
		openBarrier: () => { barrierState.open = true; },
		settle: async () => {
			await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
		},
	};
}
