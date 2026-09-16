/**
 * Owner 侧 `/loop` 迭代驱动（D1/D2/D3）。
 *
 * loop 状态是 **ephemeral**：不进 canonical reducer，重启后不自动继续（D3），
 * 但每次迭代写 durable 审计事件（loop.started / iteration_submitted /
 * iteration_settled / stopped），因此可审计、可解释。
 *
 * 迭代间动作（D2）：
 * - `prompt`：owner 在 `agent_end` 后注入下一轮（经 barrier.admitPrompt + 审计）；
 * - `compact`：调用方注入的 compaction 端口，本类只负责节奏与审计；
 * - `reset`：runtime 只能发信号，由 client 换新 session 执行（D2）。
 */

import type { OwnerFence } from "../session-owner/types.ts";
import type { SessionDomainPort, SessionRuntimeState } from "./session-runtime.ts";
import type { SessionControllerEvent, SessionRuntimeServer } from "../session-server/runtime-server.ts";
import type { RecoveryBarrier } from "./recovery-barrier.ts";
import type { AgentEvent, UserAgentMessage } from "../types.ts";
import type { EffectiveLoopSettings } from "../../storage/settings-manager.ts";
import type { SessionProtocolOperationDescriptor } from "../session-server/protocol.ts";
import type { SessionDomainMutationContext, SessionDomainResult } from "./domain-router.ts";
import {
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	describeLoopLimitRuntime,
	isLoopLimitExhausted,
	type LoopConditionConfig,
	type LoopLimitConfig,
	type LoopLimitRuntime,
} from "../loop/limit.ts";
import { evaluateLoopCondition, type LoopConditionExecution, type LoopConditionVerdict } from "../loop/condition.ts";

export type LoopIterationAction = "prompt" | "compact" | "reset";

export interface LoopAuditPayload {
	readonly limit: string;
	readonly iteration: number;
	readonly action: LoopIterationAction;
	readonly reasonCode?: string;
}

export interface SessionLoopPort {
	readonly domain: SessionDomainPort | undefined;
	readonly sessionId: string;
	readonly fence: OwnerFence;
	readonly barrier: RecoveryBarrier;
	readonly server: SessionRuntimeServer;
	readonly state: () => SessionRuntimeState;
	readonly emit: (event: SessionControllerEvent) => void;
	/** durable 审计写入；由 composition 注入 store.appendEvent。 */
	readonly appendAudit: (eventType: string, payload: LoopAuditPayload) => void;
	/** `compact` 动作的宿主；缺省时该动作不可用。 */
	readonly compact?: () => Promise<void>;
	readonly settings: EffectiveLoopSettings;
	/** 受治理的条件求值端口（P5）；`conditionEnabled` 关闭时不会调用。 */
	readonly executeCondition?: (command: string, signal: AbortSignal) => Promise<LoopConditionExecution>;
	readonly conditionTimeoutMs?: number;
}

export interface StartLoopInput {
	readonly prompt: string;
	readonly limit?: LoopLimitConfig;
	readonly action: LoopIterationAction;
	readonly condition?: LoopConditionConfig;
}

export type LoopRejectCode =
	| "loop_disabled"
	| "loop_already_running"
	| "loop_prompt_required"
	| "loop_condition_disabled"
	| "loop_reset_requires_client"
	| "loop_reset_unsupported"
	| "session_busy";

export interface LoopStateView {
	readonly running: boolean;
	readonly prompt?: string;
	readonly limit?: string;
	readonly iteration?: number;
	readonly action?: LoopIterationAction;
}

/** loop 的协议面：与其它 Session resource domain 同构，便于复用既有派发链。 */
export const LOOP_OPERATION_MANIFEST: readonly SessionProtocolOperationDescriptor[] = Object.freeze([
	Object.freeze({ operation: "loop.start", capability: "session.loop", access: "mutate" as const }),
	Object.freeze({ operation: "loop.stop", capability: "session.loop", access: "mutate" as const }),
	Object.freeze({ operation: "loop.inspect", capability: "session.loop", access: "read" as const }),
]);

/**
 * 循环状态全部在 owner 内存中；只有审计事件落库。
 * 每次迭代的提交都要求 driver 在位、owner ready、无在飞请求、队列为空。
 */
export class SessionLoopController {
	private readonly port: SessionLoopPort;
	private loop: { readonly prompt: string; readonly action: LoopIterationAction; readonly limit: LoopLimitRuntime; readonly condition?: LoopConditionConfig } | undefined;
	private iteration = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;
	private generation = 0;
	private pendingCondition: AbortController | undefined;

	public constructor(port: SessionLoopPort) {
		this.port = port;
	}

	public inspect(): LoopStateView {
		return this.loop === undefined
			? { running: false }
			: {
				running: true,
				prompt: this.loop.prompt,
				limit: describeLoopLimitRuntime(this.loop.limit),
				iteration: this.iteration,
				action: this.loop.action,
			};
	}

	public get operationManifest(): readonly SessionProtocolOperationDescriptor[] {
		return LOOP_OPERATION_MANIFEST;
	}

	public async query(operation: string, payload: Record<string, unknown> = {}): Promise<SessionDomainResult> {
		if (operation !== "loop.inspect") return loopFailure(operation, "operation_unavailable", "unavailable");
		if (Object.keys(payload).length > 0) return loopFailure(operation, "loop_inspect_invalid");
		return { ok: true, status: "ok", operation, domainRevision: 0, value: { loop: this.inspect() } };
	}

	public async mutate(operation: string, payload: Record<string, unknown>, context: SessionDomainMutationContext): Promise<SessionDomainResult> {
		void context;
		if (operation === "loop.stop") {
			if (this.loop === undefined) return loopFailure(operation, "loop_not_running");
			const reasonCode = typeof payload.reasonCode === "string" && payload.reasonCode.length > 0 ? payload.reasonCode : "user_requested";
			this.stop(reasonCode);
			return { ok: true, status: "ok", operation, domainRevision: 0, value: { loop: this.inspect() } };
		}
		if (operation !== "loop.start") return loopFailure(operation, "operation_unavailable", "unavailable");
		const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
		const action = payload.action === "compact" || payload.action === "reset" || payload.action === "prompt" ? payload.action : "prompt";
		const started = await this.start({
			prompt,
			action,
			...(isLoopLimitConfig(payload.limit) ? { limit: payload.limit } : {}),
			...(isLoopConditionConfig(payload.condition) ? { condition: payload.condition } : {}),
		});
		return started.ok
			? { ok: true, status: "ok", operation, domainRevision: 0, value: { loop: this.inspect() } }
			: loopFailure(operation, started.code);
	}

	/** 启动 loop 并立即提交第一轮（omp 的 `/loop` 语义：首轮 + N 次迭代）。 */
	public async start(input: StartLoopInput): Promise<{ readonly ok: true } | { readonly ok: false; readonly code: LoopRejectCode }> {
		if (!this.port.settings.enabled) return { ok: false, code: "loop_disabled" };
		if (this.loop !== undefined) return { ok: false, code: "loop_already_running" };
		if (input.prompt.trim().length === 0) return { ok: false, code: "loop_prompt_required" };
		if (input.condition !== undefined && !this.port.settings.conditionEnabled) return { ok: false, code: "loop_condition_disabled" };
		if (input.condition !== undefined && this.port.executeCondition === undefined) return { ok: false, code: "loop_condition_disabled" };
		// reset 只能由 client 执行（换新 session），runtime 只回信号。
		if (input.action === "reset") return { ok: false, code: "loop_reset_requires_client" };
		if (input.action === "compact" && this.port.compact === undefined) return { ok: false, code: "loop_reset_unsupported" };
		if (this.busy()) return { ok: false, code: "session_busy" };
		const limit = createLoopLimitRuntime(input.limit, this.port.settings.maxIterations);
		this.loop = { prompt: input.prompt, action: input.action, limit, ...(input.condition === undefined ? {} : { condition: input.condition }) };
		this.iteration = 0;
		await this.submit("initial");
		return { ok: true };
	}

	public stop(reasonCode: string): void {
		if (this.loop === undefined) return;
		this.pendingCondition?.abort();
		this.pendingCondition = undefined;
		this.cancelPending();
		this.port.appendAudit("loop.stopped", {
			limit: describeLoopLimitRuntime(this.loop.limit),
			iteration: this.iteration,
			action: this.loop.action,
			reasonCode,
		});
		this.loop = undefined;
		this.iteration = 0;
	}

	public handleDomainAgentEvent(event: AgentEvent): void {
		if (this.loop === undefined) return;
		if (event.type !== "agent_end") {
			if (event.type === "agent_start") this.cancelPending();
			return;
		}
		// run budget 终止即停止 loop：不靠自主循环绕过既有边界（D9 同款）。
		if (event.terminationReason !== undefined) {
			this.stop("run_budget_terminated");
			return;
		}
		this.cancelPending();
		if (this.disposed) return;
		const generation = this.generation;
		const timer = setTimeout(() => {
			this.timer = undefined;
			void this.iterate(generation, event.terminationReason === undefined);
		}, 0);
		timer.unref?.();
		this.timer = timer;
	}

	public handleDriverStateChange(): void {
		if (this.loop !== undefined && this.port.server.driverConnectionId?.() === undefined) this.stop("driver_detached");
		this.cancelPending();
	}

	public dispose(): void {
		this.disposed = true;
		this.pendingCondition?.abort();
		this.cancelPending();
	}

	private cancelPending(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.generation += 1;
	}

	private busy(): boolean {
		const snapshot = this.port.domain?.snapshot();
		if (snapshot?.inFlight === true) return true;
		const controller = this.port.domain?.controller;
		return (controller?.getSteeringMessages().length ?? 0) > 0 || (controller?.getFollowUpMessages().length ?? 0) > 0;
	}

	private async iterate(generation: number, settled: boolean): Promise<void> {
		const state = this.loop;
		if (this.disposed || generation !== this.generation || state === undefined) return;
		this.port.appendAudit("loop.iteration_settled", {
			limit: describeLoopLimitRuntime(state.limit),
			iteration: this.iteration,
			action: state.action,
			...(settled ? {} : { reasonCode: "iteration_unspecified" }),
		});
		if (isLoopLimitExhausted(state.limit)) {
			this.stop("iteration_limit_reached");
			return;
		}
		if (state.condition !== undefined) {
			const verdict = await this.evaluateCondition(state.condition);
			if (verdict.kind === "aborted") return;
			if (verdict.kind === "halt") {
				this.port.emit({ eventType: "session.loop_notice", payload: { message: verdict.message } });
				this.stop("condition_halt");
				return;
			}
			if (verdict.kind === "error") {
				this.port.emit({ eventType: "session.loop_notice", payload: { message: verdict.message } });
				this.stop("condition_error");
				return;
			}
		}
		const consumed = consumeLoopLimitIteration(state.limit);
		if (consumed === undefined) {
			this.stop("iteration_limit_reached");
			return;
		}
		this.loop = { ...state, limit: consumed };
		await this.submit("iteration");
	}

	private async evaluateCondition(condition: LoopConditionConfig): Promise<LoopConditionVerdict> {
		const execute = this.port.executeCondition;
		if (execute === undefined) return { kind: "halt", message: "Loop condition execution is unavailable. Loop stopped." };
		const abort = new AbortController();
		this.pendingCondition = abort;
		try {
			return await evaluateLoopCondition(condition, {
				execute,
				timeoutMs: this.port.conditionTimeoutMs ?? 60_000,
				signal: abort.signal,
			});
		} finally {
			this.pendingCondition = undefined;
		}
	}

	private async submit(phase: "initial" | "iteration"): Promise<void> {
		const state = this.loop;
		if (state === undefined) return;
		// 必须保留接收者：controller.prompt 读取实例状态，解构后会丢 this。
		const controller = this.port.domain?.controller;
		if (controller?.prompt === undefined) {
			this.stop("domain_unavailable");
			return;
		}
		if (this.port.barrier.currentState === "open") {
			this.stop("recovery_barrier_active");
			return;
		}
		const admission = this.port.barrier.admitPrompt();
		if (!admission.ok) {
			this.stop("recovery_barrier_active");
			return;
		}
		// agent_end 在 agent.inFlight 仍为 true 时派发；此刻直接 prompt 会被当成 steering
		// 入队，而当前 run 已过 dequeue 点，消息将无人消费 → loop 停摆。
		await controller.waitForIdle?.();
		this.iteration += 1;
		this.port.appendAudit("loop.iteration_submitted", {
			limit: describeLoopLimitRuntime(state.limit),
			iteration: this.iteration,
			action: state.action,
		});
		if (phase === "iteration" && state.action === "compact") {
			await this.port.compact?.();
		}
		this.port.emit({ eventType: "turn.started", payload: { promptText: state.prompt.slice(0, 512), origin: "runtime" } });
		try {
			await controller.prompt(state.prompt, undefined, "runtime");
		} catch (error) {
			// 失败必须让用户看见原因：静默停止会让「loop 看起来在跑」变成误导。
			const message = error instanceof Error ? error.message : String(error);
			this.port.emit({ eventType: "session.loop_notice", payload: { message: `Loop iteration could not start: ${message}` } });
			this.stop("prompt_failed");
		}
	}

	/** loop 迭代的外部触发消息：runtime-origin，与 goal 续跑同一约定（D7）。 */
	public iterationMessage(): UserAgentMessage {
		return { role: "user", origin: "runtime", content: [{ type: "text", text: this.loop?.prompt ?? "" }] };
	}
}

/** 协议载荷只接受已声明的形状，不猜测调用方意图。 */
function isLoopLimitConfig(value: unknown): value is LoopLimitConfig {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (record.kind === "iterations") return typeof record.iterations === "number" && Number.isSafeInteger(record.iterations) && record.iterations > 0;
	if (record.kind === "duration") return typeof record.durationMs === "number" && Number.isSafeInteger(record.durationMs) && record.durationMs > 0;
	return false;
}

function isLoopConditionConfig(value: unknown): value is LoopConditionConfig {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return typeof record.command === "string" && record.command.trim().length > 0 && typeof record.until === "boolean";
}

function loopFailure(operation: string, code: string, status: "failed" | "unavailable" = "failed"): Extract<SessionDomainResult, { ok: false }> {
	return { ok: false, status, code, operation };
}
