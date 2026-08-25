/** Session Owner 内的异步 multi-agent domain port。 */

import type { SessionStore } from "../../storage/session-store/session-store.ts";
import type { SessionProtocolOperationDescriptor } from "../session-server/protocol.ts";
import type { SessionDomainMutationContext, SessionDomainRequestContext, SessionDomainResult } from "../session-runtime/domain-router.ts";
import type { AttemptPort } from "../session-runtime/attempt-gateway.ts";
import type { OwnerFence } from "../session-owner/types.ts";
import type { AgentTool } from "../types.ts";
import { runtimeDigest } from "../protocol/foundation.ts";
import { createRuntimeId, isRuntimeId, type AgentId, type SessionId, type ToolCallId } from "../protocol/ids.ts";
import { AgentGraphStore } from "./graph-store.ts";
import { AgentSupervisor, type AgentRecoverySummary, type PreviousOwnerLiveness, type SupervisorChildRuntimeTemplate } from "./supervisor.ts";
import { createInProcessChildRuntimeProvider, type ChildRuntimeProviderPort } from "./child-runtime.ts";
import { deriveGovernedChildCapabilitySubset, type SessionProductionToolSource } from "./capability-subset.ts";
import type { ChildModelRuntimeFactoryPort } from "./child-model-runtime.ts";
import type { AgentGraphNode } from "./graph-projection.ts";
import {
	buildMultiAgentPolicyReceipt,
	applyTaskPolicyNarrowing,
	resolveMultiAgentPolicy,
	validateSpawnSubagentRequest,
} from "./limits.ts";
import type {
	ChildReport,
	MultiAgentPolicy,
	MultiAgentPolicyReceipt,
	MultiAgentResult,
	SubagentInvocationContext,
	ValidatedSpawnSubagentInput,
} from "./types.ts";
import { createSpawnAgentTool, type SpawnAgentDomainPort } from "./spawn-tool.ts";
import type { TaskPolicyProjection } from "../../storage/settings-policies.ts";

export const MULTI_AGENT_OPERATION_MANIFEST: readonly SessionProtocolOperationDescriptor[] = Object.freeze([
	Object.freeze({ operation: "agent.inspect", capability: "session.multi-agent", access: "read" }),
	Object.freeze({ operation: "agent.spawn", capability: "session.multi-agent", access: "mutate" }),
	Object.freeze({ operation: "agent.cancel", capability: "session.multi-agent", access: "mutate" }),
]);

export interface SessionMultiAgentPolicySources {
	readonly runtimeEnabled: boolean;
	readonly user?: unknown;
	readonly workspace?: unknown;
	/** Effective settings task projection; only narrows the bounded M1 runtime. */
	readonly taskPolicy?: TaskPolicyProjection;
}

export interface MultiAgentChildRuntimeSource {
	readonly systemPrompt: string;
	readonly productionToolSource: SessionProductionToolSource;
	readonly modelRuntimeFactory: ChildModelRuntimeFactoryPort;
}

export interface MultiAgentDomainCompositionOptions {
	readonly sessionId: SessionId;
	readonly ownerGeneration: number;
	readonly store: SessionStore;
	readonly fence: OwnerFence;
	readonly policySources: SessionMultiAgentPolicySources;
	readonly childRuntime: MultiAgentChildRuntimeSource;
	readonly attemptPort?: AttemptPort;
	readonly provider?: ChildRuntimeProviderPort;
	readonly previousOwnerLiveness?: PreviousOwnerLiveness | ((node: AgentGraphNode) => PreviousOwnerLiveness | Promise<PreviousOwnerLiveness>);
}

export interface MultiAgentDomainPort {
	readonly policy: MultiAgentPolicy;
	readonly policyReceipt: MultiAgentPolicyReceipt;
	readonly rootAgentId: AgentId;
	readonly operationManifest: typeof MULTI_AGENT_OPERATION_MANIFEST;
	readonly tools: readonly AgentTool[];
	query(operation: string, payload: Record<string, unknown>, context: SessionDomainRequestContext): Promise<SessionDomainResult>;
	mutate(operation: string, payload: Record<string, unknown>, context: SessionDomainMutationContext): Promise<SessionDomainResult>;
	spawn(input: ValidatedSpawnSubagentInput, invocation: SubagentInvocationContext): Promise<MultiAgentResult<ChildReport>>;
	recover(): Promise<MultiAgentResult<AgentRecoverySummary>>;
}

export type MultiAgentDomainCreationResult = MultiAgentResult<MultiAgentDomainPort | undefined>;

/** Root identity is stable for the canonical Session and contains no model input. */
export function deriveRootAgentId(sessionId: SessionId): AgentId {
	return createRuntimeId("agent", `root-${runtimeDigest({ scope: "session-root-agent", sessionId }).digest}`);
}

/** Domain commands may reuse the exact identity produced by the model tool. */
export function deriveSpawnEffectId(sessionId: SessionId, toolCallId: ToolCallId | string): string {
	return `effect_${runtimeDigest({ scope: "agent.spawn", sessionId, toolCallId }).digest}`;
}

export async function createMultiAgentDomain(
	options: MultiAgentDomainCompositionOptions,
): Promise<MultiAgentDomainCreationResult> {
	const baseResolution = resolveMultiAgentPolicy({
		runtimeEnabled: options.policySources.runtimeEnabled,
		user: options.policySources.user,
		workspace: options.policySources.workspace,
	});
	const resolution = Object.freeze({
		...baseResolution,
		policy: applyTaskPolicyNarrowing(baseResolution.policy, options.policySources.taskPolicy),
	});
	if (!resolution.policy.enabled) return { ok: true, value: undefined };

	const policyReceipt = buildMultiAgentPolicyReceipt({
		runtimeEnabled: options.policySources.runtimeEnabled,
		userSourceDigest: runtimeDigest(options.policySources.user ?? null),
		workspaceSourceDigest: runtimeDigest(options.policySources.workspace ?? null),
		resolution,
	});
	const recordedPolicy = recordMultiAgentPolicyReceipt(options, policyReceipt);
	if (!recordedPolicy.ok) return recordedPolicy;
	const rootAgentId = deriveRootAgentId(options.sessionId);
	const graph = new AgentGraphStore({
		store: options.store,
		fence: options.fence,
		rootAgentId,
		limits: resolution.policy.limits,
	});
	const source = options.childRuntime.productionToolSource;
	const childRuntime: SupervisorChildRuntimeTemplate = {
		systemPrompt: options.childRuntime.systemPrompt,
		tools: [],
		modelRuntimeFactory: options.childRuntime.modelRuntimeFactory,
		cwd: source.cwd,
		executionEnv: source.executionEnv,
		authorizationPolicy: source.authorizationPolicy,
	};
	const previousOwnerLiveness = options.previousOwnerLiveness;
	const supervisor = new AgentSupervisor({
		graph,
		rootAgentId,
		policyReceiptDigest: policyReceipt.receiptDigest,
		provider: options.provider ?? createInProcessChildRuntimeProvider(),
		childRuntime,
		...(options.attemptPort === undefined ? {} : { attemptPort: options.attemptPort }),
		...(previousOwnerLiveness === undefined ? {} : {
			previousOwnerLiveness: typeof previousOwnerLiveness === "function"
				? previousOwnerLiveness
				: () => previousOwnerLiveness,
		}),
		childRuntimeForRequest: async (request) => {
			const subset = await deriveGovernedChildCapabilitySubset(source, request.requestedCapabilities);
			if (!subset.ok) return subset;
			return {
				ok: true,
				value: {
					...childRuntime,
					tools: subset.value.tools,
					cwd: subset.value.cwd,
					executionEnv: subset.value.executionEnv,
					authorizationPolicy: subset.value.authorizationPolicy,
				},
			};
		},
	});
	const registered = await supervisor.registerRoot();
	if (!registered.ok) return registered;

	let domain!: MultiAgentDomainPort;
	const consumer: SpawnAgentDomainPort = {
		spawn: (input, invocation) => domain.spawn(input, invocation),
	};
	const tool = createSpawnAgentTool({
		domain: consumer,
		policy: resolution.policy,
		sessionId: options.sessionId,
		rootAgentId,
		ownerGeneration: () => options.ownerGeneration,
	});
	domain = {
		policy: resolution.policy,
		policyReceipt,
		rootAgentId,
		operationManifest: MULTI_AGENT_OPERATION_MANIFEST,
		tools: Object.freeze([tool]),
		query: async (operation, payload) => {
			if (operation !== "agent.inspect") return unavailable(operation);
			if (Object.keys(payload).length !== 0) return failed(operation, "agent.inspect does not accept payload fields");
			const inspected = await supervisor.inspect();
			return inspected.ok
				? success(operation, inspected.value.revision, inspected.value as unknown as Record<string, unknown>)
				: failureResult(operation, inspected.error.code, inspected.error.message);
		},
		mutate: async (operation, payload, context) => {
			if (!Number.isSafeInteger(context.expectedRevision) || context.expectedRevision < 0) {
				return failed(operation, "invalid_expected_revision");
			}
			if (operation === "agent.spawn") {
				const invocation: SubagentInvocationContext = {
					sessionId: options.sessionId,
					ownerGeneration: options.ownerGeneration,
					rootAgentId,
					parentAgentId: rootAgentId,
					source: "domain_command",
					effectId: context.effectId,
					signal: new AbortController().signal,
				};
				const result = await domain.spawn(payload as unknown as ValidatedSpawnSubagentInput, invocation);
				return reportResult(operation, result, supervisor);
			}
			if (operation === "agent.cancel") {
				if (Object.keys(payload).some((key) => key !== "agentId")) return failed(operation, "invalid_payload");
				const agentId = typeof payload.agentId === "string" && isRuntimeId(payload.agentId, "agent")
					? payload.agentId as AgentId
					: undefined;
				if (agentId === undefined) return failed(operation, "agentId is required");
				return reportResult(operation, await supervisor.cancel(agentId), supervisor);
			}
			return unavailable(operation);
		},
		spawn: async (input, invocation) => {
			const validated = validateSpawnSubagentRequest(input, resolution.policy);
			if (!validated.ok) return validated;
			return supervisor.spawn(validated.value, invocation);
		},
		recover: () => supervisor.recover(),
	};
	return { ok: true, value: domain };
}

function recordMultiAgentPolicyReceipt(
	options: Pick<MultiAgentDomainCompositionOptions, "sessionId" | "store" | "fence">,
	receipt: MultiAgentPolicyReceipt,
): MultiAgentResult<void> {
	const payload = { policyKind: "multi_agent", receipt } as const;
	const payloadJson = JSON.stringify(payload);
	const existing = options.store.replaySessionEvents(options.sessionId)
		.filter((event) => event.eventType === "policy.effective_recorded")
		.filter((event) => {
			try {
				const parsed = JSON.parse(event.payloadJson) as unknown;
				return isRecord(parsed) && parsed.policyKind === "multi_agent";
			} catch {
				return false;
			}
		});
	if (existing.length > 0) {
		return existing.length === 1 && existing[0]!.payloadJson === payloadJson
			? { ok: true, value: undefined }
			: multiAgentFailure("idempotency_conflict", "recorded multi-agent policy receipt differs from the effective policy");
	}
	const events = options.store.replaySessionEvents(options.sessionId);
	const tail = events.at(-1);
	try {
		options.store.appendEvent(options.fence, {
			eventId: createRuntimeId("event", `multi-agent-policy-${runtimeDigest({ sessionId: options.sessionId, policyKind: "multi_agent" }).digest.slice(0, 64)}`),
			ownerGeneration: options.fence.generation,
			eventType: "policy.effective_recorded",
			payloadJson,
			createdAtMs: Date.now(),
			expectedPreviousEventHash: tail?.currentEventHash ?? null,
		});
	} catch {
		const durable = options.store.replaySessionEvents(options.sessionId)
			.filter((event) => event.eventType === "policy.effective_recorded")
			.filter((event) => event.payloadJson === payloadJson);
		if (durable.length !== 1) return multiAgentFailure("store_conflict", "effective multi-agent policy receipt could not be durably recorded");
	}
	return { ok: true, value: undefined };
}

function success(operation: string, domainRevision: number, value: Record<string, unknown>): SessionDomainResult {
	return { ok: true, status: "ok", operation, domainRevision, value };
}

function unavailable(operation: string): SessionDomainResult {
	return { ok: false, status: "unavailable", code: "operation_unavailable", operation };
}

function failed(operation: string, code: string): SessionDomainResult {
	return { ok: false, status: "failed", code, operation };
}

function failureResult(operation: string, code: string, message: string): SessionDomainResult {
	void message;
	return { ok: false, status: code === "recovery_required" ? "recovery_required" : "failed", code, operation };
}

async function reportResult(operation: string, result: MultiAgentResult<ChildReport>, supervisor: AgentSupervisor): Promise<SessionDomainResult> {
	if (!result.ok) {
		return {
			ok: false,
			status: result.error.code === "recovery_required" ? "recovery_required" : "failed",
			code: result.error.code,
			operation,
		};
	}
	const inspected = await supervisor.inspect();
	return inspected.ok
		? success(operation, inspected.value.revision, { report: result.value })
		: failureResult(operation, inspected.error.code, inspected.error.message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function multiAgentFailure<T>(code: "idempotency_conflict" | "store_conflict", message: string): MultiAgentResult<T> {
	return { ok: false, error: { code, message } };
}
