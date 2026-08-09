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
import type { ModelWorkflowPort } from "../models/types.ts";
import type { AuthWorkflowPort } from "../auth/types.ts";
import type { ThinkingWorkflowPort } from "../thinking/types.ts";
import type { PromptWorkflowPort } from "../prompts/types.ts";
import type { DurableQueueWorkflowPort } from "../queue/types.ts";
import type { SecurityModeWorkflowPort } from "../security-mode/types.ts";
import type { ApprovalWorkflowPort } from "../approval/types.ts";
import type { PlanRenderQueryPort } from "../goal-plan/types.ts";
import type { ShutdownWorkflowPort } from "../shutdown/types.ts";
import type { WorkspaceGitPort } from "../workspace/types.ts";
import type { ProcessPassivePort } from "../process/types.ts";
import type { SessionWorkflowPort } from "../sessions/port.ts";

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
			const port = portFor(effect, options.ports);
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
			// request 继承 effect 的 payload 字段（providerId/modelId/level 等）
			const request: TuiPortRequest = {
				...effect,
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
	if (controller.signal.aborted) {
		options.onResult({ status: "aborted", ref: effect, reason: "cancelled" });
		return;
	}
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
function portFor(effect: TuiEffect, ports: TuiDomainPorts): QueryPort | undefined {
	switch (effect.type) {
		case "session.list":
			return wrap(ports.session, (port, request) => port.list(request));
		case "session.create":
			return wrap(ports.session, (port, request: TuiPortRequest) => port.create(request as Parameters<SessionWorkflowPort["create"]>[0]));
		case "session.resume":
			return wrap(ports.session, (port, request: TuiPortRequest) => port.resume(request as Parameters<SessionWorkflowPort["resume"]>[0]));
		case "session.fork":
			return wrap(ports.session, (port, request: TuiPortRequest) => port.fork(request as Parameters<SessionWorkflowPort["fork"]>[0]));
		case "provider.list":
			return wrap(ports.provider, (port, request) => port.list(request));
		case "auth.inspect":
			return wrap(ports.auth, (port, request) => port.inspect(request));
		case "auth.login":
			return wrap(ports.auth, (port, request) => port.beginLogin(request as Parameters<AuthWorkflowPort["beginLogin"]>[0]));
		case "auth.logout":
			return wrap(ports.auth, (port, request) => port.logout(request as Parameters<AuthWorkflowPort["logout"]>[0]));
		case "model.list":
			return wrap(ports.model, (port, request: TuiPortRequest) => port.list(request as Parameters<ModelWorkflowPort["list"]>[0]));
		case "model.select":
			return wrap(ports.model, (port, request: TuiPortRequest) => port.select(request as Parameters<ModelWorkflowPort["select"]>[0]));
		case "thinking.inspect":
			return wrap(ports.thinking, (port, request) => port.inspect(request));
		case "thinking.select":
			return wrap(ports.thinking, (port, request: TuiPortRequest) => port.select(request as Parameters<ThinkingWorkflowPort["select"]>[0]));
		case "prompt.list":
			return wrap(ports.prompt, (port, request) => port.list(request));
		case "prompt.submit":
			return wrap(ports.prompt, (port, request: TuiPortRequest) => port.submit(request as Parameters<PromptWorkflowPort["submit"]>[0]));
		case "keymap.inspect":
			return wrap(ports.keymap, (port, request) => port.inspect(request));
		case "queue.inspect":
			return wrap(ports.queue, (port, request) => port.inspect(request));
		case "queue.cancel":
			return wrap(ports.queue, (port, request: TuiPortRequest) => port.cancel(request as Parameters<DurableQueueWorkflowPort["cancel"]>[0]));
		case "approval.inspect":
			return wrap(ports.approval, (port, request) => port.inspect(request));
		case "approval.resolve":
			return wrap(ports.approval, (port, request: TuiPortRequest) => port.resolve(request as Parameters<ApprovalWorkflowPort["resolve"]>[0]));
		case "task-goal.inspect":
			return wrap(ports.taskGoal, (port, request) => port.inspect(request));
		case "plan.inspect":
			return wrap(ports.plan, (port, request: TuiPortRequest) => port.inspect(request as Parameters<PlanRenderQueryPort["inspect"]>[0]));
		case "agent.inspect":
			return wrap(ports.agents, (port, request) => port.inspect(request));
		case "extension.inspect":
			return wrap(ports.extensions, (port, request) => port.inspect(request));
		case "runtime-snapshot.inspect":
			return wrap(ports.runtimeSnapshot, (port, request) => port.getSnapshot(request));
		case "security-mode.inspect":
			return wrap(ports.securityMode, (port, request) => port.inspect(request));
		case "security-mode.set":
			return wrap(ports.securityMode, (port, request: TuiPortRequest) => port.set(request as Parameters<SecurityModeWorkflowPort["set"]>[0]));
		case "shutdown.request":
			return wrap(ports.shutdown, (port, request: TuiPortRequest) => port.request(request as Parameters<ShutdownWorkflowPort["request"]>[0]));
		case "workspace-git.inspect":
			return wrap(ports.workspaceGit, (port, request: TuiPortRequest) => port.inspect(request as Parameters<WorkspaceGitPort["inspect"]>[0]));
		case "process.list":
			return wrap(ports.process, (port, request) => port.list(request));
		case "process.output":
			return wrap(ports.process, (port, request: TuiPortRequest) => port.output(request as Parameters<ProcessPassivePort["output"]>[0]));
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
