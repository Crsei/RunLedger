/**
 * EffectRunner：effect dispatch、AbortController registry、stale fence。
 *
 * 只执行 effect 并回送 TuiResult；AbortController 不进入 TuiState。
 * capability 缺失时不发 effect，直接回 failed(capability_unavailable)。
 * stale/aborted/乱序 result 不得覆盖新 generation。
 */

import type { CorrelatedRequestRef, TuiPortRequest, TuiResultEnvelope, TuiError } from "./common.ts";
import type { TuiResult } from "./result.ts";
import type { TuiEffect } from "./effect.ts";
import type { TuiDomainPorts } from "./ports.ts";
import type { DurableQueueWorkflowPort } from "../queue/types.ts";
import type { ApprovalWorkflowPort } from "../approval/types.ts";
import { parseRuntimeId } from "../../runtime/protocol/ids.ts";
import { boundedToolText } from "../presentation/tools/projector.ts";

export interface EffectRunnerOptions {
	readonly ports: TuiDomainPorts;
	readonly onResult: (result: TuiResult) => void;
	/** 当前 authority generation；result 落地时低于该值判 stale。 */
	readonly currentGeneration: () => number;
}

interface ActiveEffect {
	readonly controller: AbortController;
	readonly ref: CorrelatedRequestRef;
}

export interface EffectRunner {
	dispatch(effect: TuiEffect): void;
	cancel(ref: CorrelatedRequestRef): void;
	cancelAll(): void;
}

export function createEffectRunner(options: EffectRunnerOptions): EffectRunner {
	const active = new Map<string, ActiveEffect>();
	return {
		dispatch: (effect) => {
			const port = portFor(effect, options.ports, options.currentGeneration);
			if (port === undefined) {
				options.onResult({
					status: "failed",
					ref: effect,
					error: { code: "capability_unavailable", message: `no port for ${effect.type}`, retryable: false },
				});
				return;
			}
			const controller = new AbortController();
			active.set(effect.effectId, { controller, ref: effect });
			// 通用关联信息与领域 payload 分开适配，不重复复制整个 effect。
			const request: TuiPortRequest = {
				generation: effect.generation,
				effectId: effect.effectId,
				correlationId: effect.correlationId,
				signal: controller.signal,
				authorityGeneration: options.currentGeneration(),
			};
			void port(request).then(
				(envelope) => settle(options, active, effect, controller, envelope),
				(error: unknown) => settle(options, active, effect, controller, {
					ok: false,
					ref: effect,
					error: { code: "effect_error", message: String(error), retryable: true },
				}),
			);
		},
		cancel: (ref) => {
			const entry = active.get(ref.effectId);
			if (entry === undefined || !sameRef(entry.ref, ref)) return;
			active.delete(ref.effectId);
			entry.controller.abort();
			options.onResult({ status: "aborted", ref: entry.ref, reason: "cancelled" });
		},
		cancelAll: () => {
			const entries = [...active.values()];
			active.clear();
			for (const entry of entries) {
				entry.controller.abort();
				options.onResult({ status: "aborted", ref: entry.ref, reason: "cancelled" });
			}
		},
	};
}

function settle(
	options: EffectRunnerOptions,
	active: Map<string, ActiveEffect>,
	effect: TuiEffect,
	controller: AbortController,
	envelope: TuiResultEnvelope<unknown>,
): void {
	const entry = active.get(effect.effectId);
	if (entry === undefined || entry.controller !== controller) return;
	active.delete(effect.effectId);
	if (effect.generation < options.currentGeneration()) {
		options.onResult({ status: "stale", ref: effect, currentGeneration: options.currentGeneration() });
		return;
	}
	if (envelope.ok) {
		options.onResult({ status: "completed", ref: effect, value: envelope.value });
		return;
	}
	const error: TuiError = envelope.error;
	options.onResult(error.recoveryRequired === true
		? { status: "uncertain", ref: effect, error: { ...error, recoveryRequired: true }, recoveryRequired: true }
		: { status: "failed", ref: effect, error });
}

function sameRef(left: CorrelatedRequestRef, right: CorrelatedRequestRef): boolean {
	return left.effectId === right.effectId
		&& left.correlationId === right.correlationId
		&& left.generation === right.generation;
}

type QueryPort = (request: TuiPortRequest) => Promise<TuiResultEnvelope<unknown>>;

/** effect -> 对应领域 port 的只读/写执行函数；无 port 返回 undefined。 */
function portFor(effect: TuiEffect, ports: TuiDomainPorts, currentGeneration: () => number): QueryPort | undefined {
	switch (effect.type) {
		case "session.list":
			return wrap(ports.session, (port, request) => port.list(request));
		case "session.create":
			return wrap(ports.session, (port, request) => port.create({ ...request, ...effect }));
		case "session.resume":
			return wrap(ports.session, (port, request) => port.resume({ ...request, ...effect }));
		case "session.fork":
			return wrap(ports.session, (port, request) => port.fork({ ...request, ...effect }));
		case "session.rename":
			return wrap(ports.session, (port, request) => port.rename({ ...request, ...effect }));
		case "provider.list":
			return wrap(ports.provider, (port, request) => port.list(request));
		case "auth.inspect":
			return wrap(ports.auth, (port, request) => port.inspect(request));
		case "auth.login":
			return wrap(ports.auth, (port, request) => port.beginLogin({ ...request, ...effect }));
		case "auth.logout":
			return wrap(ports.auth, (port, request) => port.logout({ ...request, ...effect }));
		case "model.list":
			return wrap(ports.model, (port, request) => port.list({ ...request, ...effect }));
		case "model.select":
			return wrap(ports.model, (port, request) => port.select({ ...request, ...effect }));
		case "thinking.inspect":
			return wrap(ports.thinking, (port, request) => port.inspect(request));
		case "thinking.select":
			return wrap(ports.thinking, (port, request) => port.select({ ...request, ...effect }));
		case "prompt.list":
			return wrap(ports.prompt, (port, request) => port.list(request));
		case "prompt.submit":
			return wrap(ports.prompt, (port, request) => port.submit({ ...request, ...effect }));
		case "keymap.inspect":
			return wrap(ports.keymap, (port, request) => port.inspect(request));
		case "queue.inspect":
			return wrap(ports.queue, (port, request) => port.inspect(request));
		case "queue.cancel":
			return wrap(ports.queue, (port, request) => cancelQueueItem(port, request, effect, currentGeneration));
		case "approval.inspect":
			return wrap(ports.approval, (port, request) => port.inspect(request));
		case "approval.resolve":
			return wrap(ports.approval, (port, request) => resolveApprovalItem(port, request, effect, currentGeneration));
		case "task-goal.inspect":
			return wrap(ports.taskGoal, (port, request) => port.inspect(request));
		case "plan.inspect":
			return wrap(ports.plan, (port, request) => port.inspect(request));
		case "agent.inspect":
			return wrap(ports.agents, (port, request) => port.inspect(request));
		case "extension.inspect":
			return wrap(ports.extensions, (port, request) => port.inspect(request));
		case "runtime-snapshot.inspect":
			return wrap(ports.runtimeSnapshot, (port, request) => port.getSnapshot(request));
		case "security-mode.inspect":
			return wrap(ports.securityMode, (port, request) => port.inspect(request));
		case "security-mode.set":
			return wrap(ports.securityMode, (port, request) => port.set({ ...request, ...effect }));
		case "shutdown.request":
			return wrap(ports.shutdown, (port, request) => port.request({ ...request, ...effect }));
		case "workspace-git.inspect":
			return wrap(ports.workspaceGit, (port, request) => port.inspect({ ...request, ...effect }));
		case "process.list":
			return wrap(ports.process, (port, request) => port.list(request));
		case "process.output":
			return wrap(ports.process, async (port, request) => {
				const executionId = parseRuntimeId("execution", effect.executionId);
				if (executionId === undefined) return failed(request, "invalid_execution_id");
				if (!validOutputCursor(effect.cursor)) return failed(request, "invalid_process_cursor");
				return port.output({ ...request, executionId, cursor: { state: "known", value: effect.cursor } });
			});
		case "update.inspect":
			return wrap(ports.update, (port, request) => port.inspect(request));
	}
}

function wrap<TPort, TResult extends TuiResultEnvelope<unknown>>(
	port: TPort | undefined,
	invoke: (port: TPort, request: TuiPortRequest) => Promise<TResult>,
): QueryPort | undefined {
	if (port === undefined) return undefined;
	return async (request: TuiPortRequest) => invoke(port, request);
}

/** 二阶段适配只消费查询回来的快照；真正的 permission/fence 仍由 mutation port 决定。 */
function validateSnapshot(
	request: TuiPortRequest,
	ref: CorrelatedRequestRef,
	authorityGeneration: number,
	currentGeneration: () => number,
): TuiResultEnvelope<never> | undefined {
	if (request.signal.aborted) return failed(request, "effect_aborted");
	const generation = currentGeneration();
	if (request.generation !== generation || authorityGeneration !== generation) return failed(request, "authority_generation_conflict");
	if (!sameRef(request, ref)) return failed(request, "snapshot_correlation_mismatch");
	return undefined;
}

async function cancelQueueItem(
	port: DurableQueueWorkflowPort,
	request: TuiPortRequest,
	effect: Extract<TuiEffect, { type: "queue.cancel" }>,
	currentGeneration: () => number,
): ReturnType<DurableQueueWorkflowPort["cancel"]> {
	const snapshot = await port.inspect(request);
	if (!snapshot.ok) return snapshot;
	const invalid = validateSnapshot(request, snapshot.ref, snapshot.value.authorityGeneration, currentGeneration);
	if (invalid !== undefined) return invalid;
	if (snapshot.value.queueRevision !== effect.expectedQueueRevision) return failed(request, "queue_revision_conflict");
	const items = snapshot.value.items.filter((item) => item.itemId === effect.itemId);
	if (items.length !== 1) return failed(request, "queue_item_unavailable");
	const item = items[0];
	if (item.queueRevision !== effect.expectedQueueRevision) return failed(request, "queue_revision_conflict");
	return port.cancel({ ...request, item, reason: boundedToolText(effect.reason, 1_024) });
}

async function resolveApprovalItem(
	port: ApprovalWorkflowPort,
	request: TuiPortRequest,
	effect: Extract<TuiEffect, { type: "approval.resolve" }>,
	currentGeneration: () => number,
): ReturnType<ApprovalWorkflowPort["resolve"]> {
	const snapshot = await port.inspect(request);
	if (!snapshot.ok) return snapshot;
	const invalid = validateSnapshot(request, snapshot.ref, snapshot.value.authorityGeneration, currentGeneration);
	if (invalid !== undefined) return invalid;
	if (snapshot.value.decisionRevision !== effect.expectedDecisionRevision) return failed(request, "approval_revision_conflict");
	const items = snapshot.value.items.filter((item) => item.approvalId === effect.approvalId);
	if (items.length !== 1) return failed(request, "approval_item_unavailable");
	const item = items[0];
	if (item.authorityGeneration !== currentGeneration()) return failed(request, "authority_generation_conflict");
	if (item.decisionRevision !== effect.expectedDecisionRevision) return failed(request, "approval_revision_conflict");
	return port.resolve({ ...request, item, decision: effect.decision });
}

function failed(ref: CorrelatedRequestRef, code: string): TuiResultEnvelope<never> {
	return { ok: false, ref, error: { code, message: code, retryable: false } };
}

function validOutputCursor(cursor: string): boolean {
	return /^(0|[1-9]\d*):(0|[1-9]\d*)$/u.test(cursor)
		&& cursor.split(":").every((value) => Number.isSafeInteger(Number(value)));
}
