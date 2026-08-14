/** 进程内 child runtime：prepare 与真正执行之间有明确 activation barrier。 */

import { Agent } from "../agent.ts";
import type { ExecutionEnv } from "../execution-env.ts";
import type { LedgerSink } from "../ledger/types.ts";
import type {
	AgentEvent,
	AgentMessage,
	AgentRunBudgetUsage,
	AgentTool,
	AgentToolHookContext,
	BeforeToolCallResult,
	ToolAuthorizationPolicy,
} from "../types.ts";
import type { RuntimeDigest } from "../protocol/foundation.ts";
import { runtimeDigest } from "../protocol/foundation.ts";
import { createRuntimeId, isRuntimeId, type AgentId, type ReceiptId } from "../protocol/ids.ts";
import type {
	ChildModelRuntimeDescriptor,
	ChildModelRuntimeFactoryPort,
} from "./child-model-runtime.ts";
import type { ChildReport, MultiAgentResult } from "./types.ts";

export interface ChildRuntimeBudget {
	readonly maxModelTurns: number;
	readonly maxToolCalls: number;
	readonly maxActiveDurationMs: number;
	readonly maxReportBytes: number;
}

export interface ChildPrepareSpec {
	readonly agentId: AgentId;
	readonly objective: string;
	readonly systemPrompt: string;
	readonly tools: readonly AgentTool[];
	readonly modelRuntimeFactory: ChildModelRuntimeFactoryPort;
	readonly budget: ChildRuntimeBudget;
	readonly cwd: string;
	readonly executionEnv: ExecutionEnv;
	readonly authorizationPolicy: ToolAuthorizationPolicy;
	readonly ledger?: LedgerSink;
	readonly signal?: AbortSignal;
	/** 测试或上层 Runtime 注入的 active-time authority；缺省为 child 自己的单调 wall clock。 */
	readonly activeDurationMs?: () => number;
}

export interface ChildRuntimeDescriptor {
	readonly agentId: AgentId;
	readonly model: ChildModelRuntimeDescriptor;
	readonly descriptorDigest: RuntimeDigest;
}

export interface ChildActivationReceipt {
	readonly receiptId: ReceiptId;
	readonly agentId: AgentId;
	readonly activatedAtMs: number;
	readonly receiptDigest: RuntimeDigest;
}

export interface ChildRuntimeCompletion {
	readonly report: ChildReport;
	readonly messages: readonly AgentMessage[];
}

export type ChildStopReason = "cancelled" | "owner_takeover";

export interface ActiveChildHandle {
	readonly activationReceipt: ChildActivationReceipt;
	readonly completion: Promise<MultiAgentResult<ChildRuntimeCompletion>>;
}

export interface PreparedChildHandle {
	readonly descriptor: ChildRuntimeDescriptor;
	activate(): Promise<MultiAgentResult<ActiveChildHandle>>;
	cancel(reason: ChildStopReason): Promise<MultiAgentResult<void>>;
	dispose(): Promise<MultiAgentResult<void>>;
}

export interface ChildRuntimeProviderPort {
	readonly providerId: "in_process";
	prepare(spec: ChildPrepareSpec): Promise<MultiAgentResult<PreparedChildHandle>>;
}

/** 仅用于 Host/测试注入启动实现；默认实现调用真实 Agent.prompt。 */
export type ChildAgentStarter = (agent: Agent, objective: string) => Promise<AgentMessage[]>;

export interface InProcessChildRuntimeProviderOptions {
	readonly start?: ChildAgentStarter;
}

interface ChildUsage {
	modelTurns: number;
	toolCalls: number;
	activeDurationMs: number;
}

type ChildLifecycle = "prepared" | "activating" | "active" | "terminal" | "disposed" | "uncertain";

export function createInProcessChildRuntimeProvider(
	options: InProcessChildRuntimeProviderOptions = {},
): ChildRuntimeProviderPort {
	const start = options.start ?? ((agent: Agent, objective: string) => agent.prompt(objective));
	return {
		providerId: "in_process",
		prepare: async (spec) => prepareChild(spec, start),
	};
}

async function prepareChild(
	spec: ChildPrepareSpec,
	start: ChildAgentStarter,
): Promise<MultiAgentResult<PreparedChildHandle>> {
	if (!isRuntimeId(spec.agentId, "agent")) return failure("invalid_request", "child agentId is invalid");
	if (spec.objective.trim().length === 0) return failure("invalid_request", "child objective must not be empty");
	const budgetError = validateBudget(spec.budget);
	if (budgetError !== undefined) return failure("invalid_request", budgetError);

	let preparedModel: Awaited<ReturnType<ChildModelRuntimeFactoryPort["prepare"]>>;
	try {
		preparedModel = await spec.modelRuntimeFactory.prepare({
			systemPrompt: spec.systemPrompt,
			tools: spec.tools,
		});
	} catch (error) {
		return failure("runtime_unavailable", errorMessage(error, "child model runtime preparation failed"));
	}
	if (!preparedModel.ok) return preparedModel;

	const modelRuntime = preparedModel.value;
	if (modelRuntime.tools.length !== spec.tools.length || modelRuntime.tools.some((tool, index) => tool !== spec.tools[index])) {
		return failure("runtime_unavailable", "child model runtime widened or changed the governed tool subset");
	}
	const descriptorBody = {
		agentId: spec.agentId,
		model: modelRuntime.descriptor,
	};
	const descriptor: ChildRuntimeDescriptor = Object.freeze({
		agentId: spec.agentId,
		model: Object.freeze({ ...modelRuntime.descriptor }),
		descriptorDigest: runtimeDigest(descriptorBody),
	});
	let activationStartedAtMs: number | undefined;
	const activeDuration = spec.activeDurationMs ?? (() => Math.max(0, Date.now() - (activationStartedAtMs ?? Date.now())));
	const usage: ChildUsage = {
		modelTurns: 0,
		toolCalls: 0,
		activeDurationMs: 0,
	};
	const usageAuthority: AgentRunBudgetUsage = {
		activeDurationMs: () => {
			const value = activeDuration();
			if (!Number.isFinite(value) || value < 0) return Number.MAX_SAFE_INTEGER;
			return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
		},
	};

	let lifecycle: ChildLifecycle = "prepared";
	let cancelReason: ChildStopReason | undefined;
	let completion: Promise<MultiAgentResult<ChildRuntimeCompletion>> | undefined;
	let activeHandle: ActiveChildHandle | undefined;
	let lastAgentEnd: Extract<AgentEvent, { type: "agent_end" }> | undefined;
	const onSignalAbort = (): void => {
		if (lifecycle === "active" || lifecycle === "activating") cancelReason ??= "cancelled";
	};
	if (spec.signal !== undefined && !spec.signal.aborted) {
		spec.signal.addEventListener("abort", onSignalAbort, { once: true });
	}

	const beforeToolCall = async (
		request: AgentToolHookContext,
		signal?: AbortSignal,
	): Promise<BeforeToolCallResult | void> => {
		if (usage.toolCalls > spec.budget.maxToolCalls) {
			return {
				block: true,
				reason: "child tool-call budget exhausted",
			};
		}
		const authorization = await spec.authorizationPolicy.authorize(request, signal);
		if (authorization.decision === "deny") return { block: true, reason: authorization.reason };
		return undefined;
	};

	const agent = new Agent({
		initialState: {
			systemPrompt: spec.systemPrompt,
			model: modelRuntime.model,
			tools: [...modelRuntime.tools],
			thinkingLevel: modelRuntime.descriptor.thinkingLevel,
		},
		streamFn: modelRuntime.streamFn,
		ledger: spec.ledger,
		signal: spec.signal,
		loopConfig: {
			cwd: spec.cwd,
			executionEnv: spec.executionEnv,
			runBudget: {
				maxModelTurns: spec.budget.maxModelTurns,
				maxToolTurns: Math.max(1, spec.budget.maxToolCalls),
				maxActiveDurationMs: spec.budget.maxActiveDurationMs,
				maxRepeatedFailureFingerprint: 3,
				maxApprovalExpirations: 2,
			},
			runBudgetUsage: usageAuthority,
			beforeToolCall,
			shouldStopAfterTurn: () => usage.toolCalls >= spec.budget.maxToolCalls,
		},
		toolExecution: "sequential",
	});

	agent.subscribe((event) => {
		if (event.type === "turn_start") usage.modelTurns += 1;
		if (event.type === "tool_execution_start") usage.toolCalls += 1;
		if (event.type === "agent_end") {
			lastAgentEnd = event;
			usage.activeDurationMs = usageAuthority.activeDurationMs();
		}
	});

	const handle: PreparedChildHandle = {
		descriptor,
		activate: async () => {
			if (lifecycle === "disposed" || lifecycle === "terminal") return failure("runtime_unavailable", "prepared child runtime is no longer activatable");
			if (lifecycle === "active" || lifecycle === "activating") return failure("runtime_unavailable", "child runtime activation is already in progress");
			if (lifecycle === "uncertain") return failure("recovery_required", "child runtime activation outcome is uncertain");
			if (spec.signal?.aborted) {
				lifecycle = "disposed";
				return failure("runtime_unavailable", "child activation was aborted before it began");
			}

			lifecycle = "activating";
			activationStartedAtMs = Date.now();
			let started: Promise<AgentMessage[]>;
			try {
				started = start(agent, spec.objective);
			} catch (error) {
				lifecycle = "uncertain";
				spec.signal?.removeEventListener("abort", onSignalAbort);
				return failure("recovery_required", errorMessage(error, "child activation outcome is uncertain"));
			}

			const receiptBody = {
				agentId: spec.agentId,
				activatedAtMs: Date.now(),
				descriptorDigest: descriptor.descriptorDigest,
			};
			const activationReceipt: ChildActivationReceipt = Object.freeze({
				receiptId: createRuntimeId("receipt", `child-activation-${spec.agentId}`),
				agentId: spec.agentId,
				activatedAtMs: receiptBody.activatedAtMs,
				receiptDigest: runtimeDigest(receiptBody),
			});
			lifecycle = "active";
			completion = Promise.resolve(started)
				.then(
					(messages) => completeChild(messages, undefined),
					(error) => completeChild([], error),
				)
				.catch((error: unknown) => ({
					ok: true as const,
					value: {
						report: failedReport(spec.agentId, "runtime_failed", usage),
						messages: Object.freeze([]),
					},
				}));
			activeHandle = Object.freeze({ activationReceipt, completion });
			return { ok: true, value: activeHandle };
		},
		cancel: async (reason) => {
			if (lifecycle === "disposed" || lifecycle === "terminal") return { ok: true, value: undefined };
			cancelReason = reason;
			if (lifecycle === "prepared") {
				lifecycle = "disposed";
				spec.signal?.removeEventListener("abort", onSignalAbort);
				return { ok: true, value: undefined };
			}
			if (lifecycle === "active" || lifecycle === "activating") agent.interrupt();
			return { ok: true, value: undefined };
		},
		dispose: async () => {
			if (lifecycle === "disposed" || lifecycle === "terminal") return { ok: true, value: undefined };
			cancelReason ??= "cancelled";
			if (lifecycle === "active" || lifecycle === "activating") agent.interrupt();
			lifecycle = "disposed";
			spec.signal?.removeEventListener("abort", onSignalAbort);
			return { ok: true, value: undefined };
		},
	};

	async function completeChild(
		messages: AgentMessage[],
		error: unknown,
	): Promise<MultiAgentResult<ChildRuntimeCompletion>> {
		lifecycle = "terminal";
		spec.signal?.removeEventListener("abort", onSignalAbort);
		usage.activeDurationMs = usageAuthority.activeDurationMs();
		const terminal = cancelReason !== undefined
			? { outcome: "stopped" as const, reasonCode: cancelReason === "owner_takeover" ? "owner_takeover" as const : "cancelled" as const }
			: error !== undefined
				? { outcome: "failed" as const, reasonCode: "runtime_failed" as const }
				: lastAgentEnd?.terminationReason !== undefined || usage.modelTurns >= spec.budget.maxModelTurns || usage.toolCalls >= spec.budget.maxToolCalls
					? { outcome: "stopped" as const, reasonCode: "budget_exhausted" as const }
					: { outcome: "completed" as const };
		const reportText = error === undefined ? extractReport(messages) : "";
		const reportBytes = new TextEncoder().encode(reportText).byteLength;
		if (reportBytes > spec.budget.maxReportBytes) {
			const report = failedReport(spec.agentId, "report_limit_exceeded", usage);
			return {
				ok: true,
				value: { report, messages: Object.freeze([...messages]) },
			};
		}
		const report: ChildReport = Object.freeze({
			agentId: spec.agentId,
			outcome: terminal.outcome,
			report: reportText,
			reportDigest: runtimeDigest(reportText),
			reportBytes,
			usage: Object.freeze({ ...usage }),
			...(terminal.reasonCode === undefined ? {} : { reasonCode: terminal.reasonCode }),
		});
		return { ok: true, value: { report, messages: Object.freeze([...messages]) } };
	}

	function failedReport(
		agentId: AgentId,
		reasonCode: "report_limit_exceeded" | "runtime_failed",
		currentUsage: ChildUsage,
	): ChildReport {
		return Object.freeze({
			agentId,
			outcome: "failed",
			report: "",
			reportDigest: runtimeDigest(""),
			reportBytes: 0,
			usage: Object.freeze({ ...currentUsage }),
			reasonCode,
		});
	}

	return { ok: true, value: handle };
}

function extractReport(messages: readonly AgentMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		return message.content
			.filter((content): content is { type: "text"; text: string } => content.type === "text")
			.map((content) => content.text)
			.join("");
	}
	return "";
}

function validateBudget(budget: ChildRuntimeBudget): string | undefined {
	for (const [name, value] of Object.entries(budget)) {
		if (!Number.isSafeInteger(value) || value < 1) return `child budget ${name} must be a positive safe integer`;
	}
	return undefined;
}

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error && error.message.length > 0 ? error.message : fallback;
}

function failure<T>(code: "invalid_request" | "runtime_unavailable" | "recovery_required", message: string): MultiAgentResult<T> {
	return { ok: false, error: { code, message } };
}
