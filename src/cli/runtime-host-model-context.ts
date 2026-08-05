/** Host-owned Plan/Context/Compaction/Memory domain adapter.
 *
 * 纯 reducer/store 只能证明局部行为；本模块把它们接到 resident Host 的
 * domain port、canonical home、expected revision 和唯一 Runtime event writer。
 * 它不创建第二个 session、writer、process manager 或 client controller。
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
	isContainedRuntimePath,
	RUNLEDGER_DIRECTORY_MODE,
	RUNLEDGER_FILE_MODE,
	type RunledgerLayout,
} from "../runtime/contracts/storage-layout.ts";
import {
	isCompactionCheckpoint,
	type CompactionCheckpoint,
	type CompactionReason,
} from "../runtime/contracts/public.ts";
import { calculateCompactionInvariantDigest } from "../runtime/context/invariants.ts";
import { runtimeDigest, type RuntimeContentRef, type RuntimeDigest, type RuntimeStreamHead } from "../runtime/protocol/foundation.ts";
import {
	isRuntimeContentRef,
	isRuntimeEventRangeRef,
	isRuntimeId,
	parseRuntimeId,
	type AuthorityId,
	type CommandId,
	type PrincipalId,
	type SessionId,
	type TenantId,
	type TraceId,
	type WorkspaceId,
} from "../runtime/contracts/public.ts";
import { createRuntimeId } from "../runtime/protocol/ids.ts";
import type { RuntimeEventPayloadFor, RuntimeEventType } from "../runtime/protocol/events.ts";
import type { RuntimeEventAppendInput } from "../storage/host/runtime-event-store.ts";
import type { HostRuntimeDomainContext, HostRuntimeDomainPort, HostRuntimeDomainResult } from "./runtime-host-service.ts";
import { isContextAssemblyReceipt } from "../runtime/context/schema.ts";
import type { ContextAssemblyReceipt } from "../runtime/context/types.ts";
import { assembleRuntimeContext, type RuntimeContextSource } from "../runtime/context/runtime-adapter.ts";
import { isModelRouteDecision, isModelRouteRequest } from "../runtime/model-routing/schema.ts";
import { ModelCompatibilityRouter } from "../runtime/model-routing/router.ts";
import type { ModelRouteDecision, ModelRouteRequest } from "../runtime/model-routing/types.ts";
import {
	InMemoryCompactionCheckpointStore,
	type CompactionCheckpointStorePort,
} from "../runtime/context/compaction/checkpoint-store.ts";
import { isMemoryStoreSnapshot, MemoryStoreSnapshotCodec, type MemoryStoreSnapshot } from "../runtime/context/memory/persistence.ts";
import { MemoryStore, type MemoryProposalInput, type MemorySearchOptions } from "../runtime/context/memory/store.ts";
import type { MemoryScope, MemorySearchReceipt } from "../runtime/context/memory/types.ts";
import {
	isPlanArtifactStoreSnapshot,
	type PlanArtifactStoreSnapshot,
} from "../runtime/modes/plan/artifact-store.ts";
import {
	isValidPlanModeState,
	reducePlanModeState,
	restorePlanModeState,
	type PlanModeCommand,
} from "../runtime/modes/plan/reducer.ts";
import type { PlanModeState } from "../runtime/modes/plan/types.ts";
import { PlanArtifactStore } from "../runtime/modes/plan/artifact-store.ts";

const DOMAIN_VERSION = 1 as const;
const MAX_CONTEXT_RECEIPTS = 64;
const MAX_ROUTE_DECISIONS = 64;
const EMPTY_EVENT_HASH = runtimeDigest("runledger-empty-runtime-stream");

export const HOST_MODEL_CONTEXT_QUERY_OPERATIONS = new Set([
	"plan.inspect",
	"context.inspect",
	"compaction.list",
	"memory.search",
	"memory.get",
	"memory.inspect",
	"model.routes",
]);

export const HOST_MODEL_CONTEXT_MUTATION_OPERATIONS = new Set([
	"plan.enter",
	"plan.activate",
	"plan.write",
	"plan.request_approval",
	"plan.resolve_approval",
	"plan.cancel",
	"plan.settle_exit",
	"context.assemble",
	"model.route",
	"compact.run",
	"memory.propose",
	"memory.approve",
	"memory.reject",
	"memory.revoke",
]);

export interface HostModelContextDomainOptions {
	readonly layout: RunledgerLayout;
	readonly workspaceStorageKey: string;
	readonly authorityId: AuthorityId;
	readonly tenantId: TenantId;
	readonly workspaceId: WorkspaceId;
	readonly policyCeilingDigest: RuntimeDigest;
	readonly clock?: () => Date;
	readonly modelRouter?: ModelCompatibilityRouter;
	/** Typed reason exposed by read-only queries when the canonical manifest is unavailable. */
	readonly modelRouterUnavailable?: string;
	readonly summarizer?: (input: { readonly transcript: string; readonly focus?: string }) => Promise<string>;
}

interface SessionDomainState {
	readonly sessionId: SessionId;
	readonly planStore: PlanArtifactStore;
	readonly compactionStore: CompactionCheckpointStorePort;
	plan: PlanModeState;
	contextReceipts: ContextAssemblyReceipt[];
	routes: ModelRouteDecision[];
}

interface HostModelContextSnapshot {
	readonly version: typeof DOMAIN_VERSION;
	readonly sessionId: SessionId;
	readonly plan: PlanModeState;
	readonly planArtifacts: PlanArtifactStoreSnapshot;
	readonly compactions: readonly CompactionCheckpoint[];
	readonly contextReceipts: readonly ContextAssemblyReceipt[];
	readonly routes: readonly ModelRouteDecision[];
}

/** Internal Host composition seam for synchronous tool-admission reads. */
export interface HostModelContextDomainPort extends HostRuntimeDomainPort {
	planState(sessionId: string): PlanModeState | undefined;
}

interface DomainResultWithEvents extends HostRuntimeDomainResult {
	readonly body?: Record<string, unknown>;
	readonly events?: readonly RuntimeEventAppendInput[];
}

function failure(code: string, message?: string): HostRuntimeDomainResult {
	return { ok: false, body: { code, ...(message === undefined ? {} : { message }) } };
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function sameDigest(left: RuntimeDigest, right: RuntimeDigest): boolean {
	return left.algorithm === right.algorithm && left.digest === right.digest;
}

function timestamp(clock: () => Date): string {
	return clock().toISOString();
}

function traceId(sessionId: SessionId, operation: string, domainRevision: number, subjectId: string): TraceId {
	return createRuntimeId("trace", runtimeDigest({ sessionId, operation, domainRevision, subjectId }).digest.slice(0, 48));
}

/** Build a deterministic event with the current event catalog, never a private union. */
function makeEvent<TType extends RuntimeEventType>(input: {
	readonly type: TType;
	readonly context: HostRuntimeDomainContext;
	readonly authorityId: AuthorityId;
	readonly tenantId: TenantId;
	readonly subjectKind: RuntimeEventPayloadFor<TType>["subject"]["kind"];
	readonly subjectId: RuntimeEventPayloadFor<TType>["subject"]["id"];
	readonly payload: RuntimeEventPayloadFor<TType>;
}): RuntimeEventAppendInput {
	const sessionId = parseRuntimeId("session", input.context.sessionId);
	if (!sessionId) throw new Error("host model/context session id is invalid");
	return {
		authorityId: input.authorityId,
		tenantId: input.tenantId,
		principalId: input.context.principal.principalId,
		sessionId,
		traceId: input.payload.correlationId,
		type: input.type,
		payload: input.payload,
	};
}

function contentRef(subjectKind: RuntimeContentRef["subjectKind"], value: unknown, mediaType = "application/json"): RuntimeContentRef {
	const digest = runtimeDigest(value);
	return { subjectKind, digest, mediaType, size: 0 };
}

function transition(revision: number, previousStatus: string | null, nextStatus: string) {
	return { revision, previousStatus, nextStatus } as const;
}

function stateKey(sessionId: SessionId): string {
	return sessionId;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const keys = [...expected].sort();
	return actual.length === keys.length && actual.every((item, index) => item === keys[index]);
}

function isDomainSnapshot(value: unknown, sessionId: SessionId): value is HostModelContextSnapshot {
	const record = recordValue(value);
	if (record === undefined || !exactKeys(record, ["contextReceipts", "compactions", "plan", "planArtifacts", "routes", "sessionId", "version"])) return false;
	if (record.version !== DOMAIN_VERSION || record.sessionId !== sessionId || !Array.isArray(record.compactions) || !record.compactions.every(isCompactionCheckpoint)) return false;
	if (!isPlanArtifactStoreSnapshot(record.planArtifacts) || !isValidPlanModeState(record.plan)) return false;
	if (!Array.isArray(record.contextReceipts) || !record.contextReceipts.every(isContextAssemblyReceipt)) return false;
	if (!Array.isArray(record.routes) || !record.routes.every(isModelRouteDecision)) return false;
	return true;
}

export function createHostModelContextDomainPort(options: HostModelContextDomainOptions): HostModelContextDomainPort {
	if (!/^ws-[a-f0-9]{64}$/u.test(options.workspaceStorageKey)) throw new Error("invalid model/context workspace storage key");
	if (!isRuntimeId(options.authorityId, "authority") || !isRuntimeId(options.tenantId, "tenant") || !isRuntimeId(options.workspaceId, "workspace")) throw new Error("invalid model/context domain identity");
	const clock = options.clock ?? (() => new Date());
	const sessions = new Map<string, SessionDomainState>();
	const memory = new MemoryStore({ clock });
	let memoryLoaded = false;
	let tail: Promise<void> = Promise.resolve();

	const execute = async (context: HostRuntimeDomainContext): Promise<HostRuntimeDomainResult> => {
		const operation = context.operation;
		if (!HOST_MODEL_CONTEXT_QUERY_OPERATIONS.has(operation) && !HOST_MODEL_CONTEXT_MUTATION_OPERATIONS.has(operation)) return failure("unsupported_operation");
		if (HOST_MODEL_CONTEXT_MUTATION_OPERATIONS.has(operation) && !context.mutation) return failure("mutation_required");
		const sessionId = parseRuntimeId("session", context.sessionId);
		if (!sessionId) return failure("session_required");
		const state = await ensureSession(sessionId);
		if (operation.startsWith("memory.")) await ensureMemory();
		return executeOperation(options, clock, memory, state, context);
	};

	const port: HostRuntimeDomainPort = {
		name: "model-context",
		queryOperations: HOST_MODEL_CONTEXT_QUERY_OPERATIONS,
		mutationOperations: HOST_MODEL_CONTEXT_MUTATION_OPERATIONS,
		execute: (context) => {
			const result = tail.then(() => execute(context));
			tail = result.then(() => undefined, () => undefined);
			return result;
		},
	};
	const hostPort: HostModelContextDomainPort = {
		...port,
		planState: (sessionId) => {
			const parsed = parseRuntimeId("session", sessionId);
			return parsed === undefined ? undefined : sessions.get(stateKey(parsed))?.plan;
		},
	};

	async function ensureSession(sessionId: SessionId): Promise<SessionDomainState> {
		const existing = sessions.get(stateKey(sessionId));
		if (existing) return existing;
		const planStore = new PlanArtifactStore();
		const compactionStore = new InMemoryCompactionCheckpointStore();
		const initial: SessionDomainState = {
			sessionId,
			planStore,
			compactionStore,
			plan: initialPlanState(sessionId, options.workspaceId, options.policyCeilingDigest, timestamp(clock)),
			contextReceipts: [],
			routes: [],
		};
		const serialized = await readOptional(sessionPath(options.layout, options.workspaceStorageKey, sessionId));
		if (serialized !== undefined) {
			let parsed: unknown;
			try { parsed = JSON.parse(serialized) as unknown; } catch { throw new Error("model/context snapshot is invalid JSON"); }
			if (!isDomainSnapshot(parsed, sessionId)) throw new Error("model/context snapshot failed exact validation");
			const restoredPlan = restorePlanModeState(parsed.plan);
			if (!restoredPlan.ok || !planStore.restore(parsed.planArtifacts).ok || !compactionStore.replay(parsed.compactions).ok) throw new Error("model/context snapshot failed semantic validation");
			initial.plan = restoredPlan.value;
			initial.contextReceipts = [...parsed.contextReceipts];
			initial.routes = [...parsed.routes];
		}
		sessions.set(stateKey(sessionId), initial);
		return initial;
	}

	async function ensureMemory(): Promise<void> {
		if (memoryLoaded) return;
		const serialized = await readOptional(memoryPath(options.layout, options.workspaceStorageKey));
		if (serialized !== undefined) {
			const decoded = MemoryStoreSnapshotCodec.decode(serialized);
			if (!decoded.ok || !isMemoryStoreSnapshot(decoded.value) || !memory.restore(decoded.value).ok) throw new Error("memory snapshot failed exact validation");
		}
		memoryLoaded = true;
	}

	return hostPort;
}

function initialPlanState(sessionId: SessionId, workspaceId: WorkspaceId, policyCeilingDigest: RuntimeDigest, updatedAt: string): PlanModeState {
	const goalId = createRuntimeId("goal", runtimeDigest({ sessionId, workspaceId }).digest.slice(0, 48));
	const sourceHead: RuntimeStreamHead = { streamId: sessionId, sequence: 0, eventHash: EMPTY_EVENT_HASH };
	const state: PlanModeState = {
		status: "inactive",
		sessionId,
		goalId,
		revision: 0,
		policyCeilingDigest,
		sourceHead,
		projectionDigest: runtimeDigest({ status: "inactive", sessionId, goalId }),
		completeness: "complete",
		updatedAt,
	};
	if (!isValidPlanModeState(state)) throw new Error("initial Plan Mode state is invalid");
	return state;
}

async function executeOperation(
	options: HostModelContextDomainOptions,
	clock: () => Date,
	memory: MemoryStore,
	state: SessionDomainState,
	context: HostRuntimeDomainContext,
): Promise<DomainResultWithEvents> {
	try {
		switch (context.operation) {
			case "plan.inspect": return planInspect(state);
			case "plan.enter": return planEnter(options, clock, state, context);
			case "plan.activate": return planActivate(options, clock, state, context);
			case "plan.write": return planWrite(options, clock, state, context);
			case "plan.request_approval": return planRequestApproval(options, clock, state, context);
			case "plan.resolve_approval": return planResolveApproval(options, clock, state, context);
			case "plan.cancel": return planCancel(options, clock, state, context);
			case "plan.settle_exit": return planSettleExit(options, clock, state, context);
			case "context.inspect": return { ok: true, body: { receipts: state.contextReceipts } };
			case "context.assemble": return contextAssemble(options, clock, state, context);
			case "compaction.list": return { ok: true, body: { checkpoints: state.compactionStore.list(state.sessionId) } };
			case "compact.run": return compactRun(options, clock, state, context);
			case "memory.search": return memorySearch(options, memory, state, context);
			case "memory.get": return memoryGet(memory, context);
			case "memory.inspect": return memoryInspect(memory);
			case "memory.propose": return memoryPropose(options, clock, memory, state, context);
			case "memory.approve": return memoryApprove(options, clock, memory, state, context);
			case "memory.reject": return memoryReject(options, clock, memory, state, context);
			case "memory.revoke": return memoryRevoke(options, clock, memory, state, context);
			case "model.routes": return {
				ok: true,
				body: {
					available: options.modelRouter !== undefined,
					...(options.modelRouter === undefined ? { unavailableCode: options.modelRouterUnavailable ?? "model_router_unavailable" } : {}),
					decisions: state.routes,
				},
			};
			case "model.route": return modelRoute(options, clock, state, context);
			default: return failure("unsupported_operation");
		}
	} catch (error) {
		return failure("model_context_failed", error instanceof Error ? error.message : "model/context operation failed");
	}
}

function planInspect(state: SessionDomainState): HostRuntimeDomainResult {
	const plan = state.plan.plan;
	const content = plan === undefined ? undefined : state.planStore.read(plan);
	return {
		ok: true,
		body: {
			state: state.plan,
			...(content?.ok === true ? { content: content.value } : {}),
		},
	};
}

async function planEnter(options: HostModelContextDomainOptions, clock: () => Date, state: SessionDomainState, context: HostRuntimeDomainContext): Promise<DomainResultWithEvents> {
	const expectedRevision = integerValue(context.frame.body.expectedRevision);
	if (expectedRevision === undefined) return failure("expected_revision_required");
	const result = reducePlanModeState(state.plan, { type: "request_activation", expectedRevision, requestedBy: context.frame.body.requestedBy === "agent" ? "agent" : "user", updatedAt: timestamp(clock) });
	if (!result.ok) return planError(result.error.code, result.error.message, result.error.retryable);
	const prior = state.plan;
	state.plan = result.value;
	await persistSession(options, state);
	return {
		ok: true,
		body: { state: state.plan },
		mutated: true,
		events: [makeEvent({
			type: "plan.enter_requested",
			context,
			authorityId: options.authorityId,
			tenantId: options.tenantId,
			subjectKind: "goal",
			subjectId: state.plan.goalId,
			payload: {
				subject: { kind: "goal", id: state.plan.goalId },
				correlationId: traceId(state.sessionId, context.operation, context.domainRevision, state.sessionId),
				effect: "committed",
				transition: transition(state.plan.revision, prior.status, state.plan.status),
				expectedRevision: context.domainRevision,
			},
		})],
	};
}

async function planActivate(options: HostModelContextDomainOptions, clock: () => Date, state: SessionDomainState, context: HostRuntimeDomainContext): Promise<DomainResultWithEvents> {
	const expectedRevision = integerValue(context.frame.body.expectedRevision);
	const content = stringValue(context.frame.body.content);
	if (expectedRevision === undefined || content === undefined) return failure("plan_content_required");
	const artifactsBefore = state.planStore.snapshot();
	const artifact = state.planStore.put({ goalId: state.plan.goalId, workspaceId: options.workspaceId, content, expectedRevision: null });
	if (!artifact.ok) return planError(artifact.error.code, artifact.error.message, artifact.error.retryable);
	const result = reducePlanModeState(state.plan, {
		type: "activate",
		expectedRevision,
		plan: artifact.value,
		updatedAt: timestamp(clock),
	});
	if (!result.ok) {
		state.planStore.restore(artifactsBefore);
		return planError(result.error.code, result.error.message, result.error.retryable);
	}
	const prior = state.plan;
	state.plan = result.value;
	await persistSession(options, state);
	return {
		ok: true,
		body: { state: state.plan, content },
		mutated: true,
		events: [makeEvent({
			type: "plan.entered",
			context,
			authorityId: options.authorityId,
			tenantId: options.tenantId,
			subjectKind: "goal",
			subjectId: state.plan.goalId,
			payload: {
				subject: { kind: "goal", id: state.plan.goalId },
				correlationId: traceId(state.sessionId, context.operation, context.domainRevision, state.sessionId),
				effect: "committed",
				transition: transition(state.plan.revision, prior.status, state.plan.status),
				expectedRevision: context.domainRevision,
				refs: [artifact.value.artifactRef],
			},
		})],
	};
}

async function planWrite(options: HostModelContextDomainOptions, clock: () => Date, state: SessionDomainState, context: HostRuntimeDomainContext): Promise<DomainResultWithEvents> {
	const expectedRevision = integerValue(context.frame.body.expectedRevision);
	const expectedPlanRevision = integerValue(context.frame.body.expectedPlanRevision);
	const content = stringValue(context.frame.body.content);
	if (expectedRevision === undefined || expectedPlanRevision === undefined || content === undefined) return failure("plan_write_request_invalid");
	const artifactsBefore = state.planStore.snapshot();
	const artifact = state.planStore.put({ goalId: state.plan.goalId, workspaceId: options.workspaceId, content, expectedRevision: expectedPlanRevision });
	if (!artifact.ok) return planError(artifact.error.code, artifact.error.message, artifact.error.retryable);
	const result = reducePlanModeState(state.plan, {
		type: "write_plan",
		expectedRevision,
		expectedPlanRevision,
		plan: artifact.value,
		updatedAt: timestamp(clock),
	});
	if (!result.ok) {
		state.planStore.restore(artifactsBefore);
		return planError(result.error.code, result.error.message, result.error.retryable);
	}
	const prior = state.plan;
	state.plan = result.value;
	await persistSession(options, state);
	const artifactId = createRuntimeId("artifact", artifact.value.digest.digest.slice(0, 48));
	return {
		ok: true,
		body: { state: state.plan, content },
		mutated: true,
		events: [makeEvent({
			type: "artifact.created",
			context,
			authorityId: options.authorityId,
			tenantId: options.tenantId,
			subjectKind: "artifact",
			subjectId: artifactId,
			payload: {
				subject: { kind: "artifact", id: artifactId },
				correlationId: traceId(state.sessionId, context.operation, context.domainRevision, artifactId),
				effect: "committed",
				idempotencyKey: `plan-artifact:${artifact.value.digest.digest}`,
				transition: transition(artifact.value.revision, prior.plan?.digest.digest ?? null, "created"),
				refs: [artifact.value.artifactRef],
			},
		})],
	};
}

async function planRequestApproval(options: HostModelContextDomainOptions, clock: () => Date, state: SessionDomainState, context: HostRuntimeDomainContext): Promise<DomainResultWithEvents> {
	const expectedRevision = integerValue(context.frame.body.expectedRevision);
	const expectedPlanRevision = integerValue(context.frame.body.expectedPlanRevision);
	const expectedPlanDigest = recordValue(context.frame.body.expectedPlanDigest) as RuntimeDigest | undefined;
	if (expectedRevision === undefined || expectedPlanRevision === undefined || expectedPlanDigest === undefined) return failure("plan_approval_request_invalid");
	const result = reducePlanModeState(state.plan, { type: "request_approval", expectedRevision, expectedPlanRevision, expectedPlanDigest, updatedAt: timestamp(clock) });
	if (!result.ok) return planError(result.error.code, result.error.message, result.error.retryable);
	const prior = state.plan;
	state.plan = result.value;
	await persistSession(options, state);
	const approval = state.plan.approval;
	if (approval === undefined || state.plan.plan === undefined) return failure("plan_approval_missing");
	return {
		ok: true,
		body: { state: state.plan },
		mutated: true,
		events: [makeEvent({
			type: "plan.approval_requested",
			context,
			authorityId: options.authorityId,
			tenantId: options.tenantId,
			subjectKind: "goal",
			subjectId: state.plan.goalId,
			payload: {
				subject: { kind: "goal", id: state.plan.goalId },
				correlationId: traceId(state.sessionId, context.operation, context.domainRevision, approval.approvalId),
				effect: "committed",
				transition: transition(state.plan.revision, prior.status, state.plan.status),
				expectedRevision: context.domainRevision,
				refs: [state.plan.plan.artifactRef],
			},
		})],
	};
}

async function planResolveApproval(options: HostModelContextDomainOptions, clock: () => Date, state: SessionDomainState, context: HostRuntimeDomainContext): Promise<DomainResultWithEvents> {
	const expectedRevision = integerValue(context.frame.body.expectedRevision);
	const approvalId = stringValue(context.frame.body.approvalId);
	const decision = context.frame.body.decision === "approved" ? "approved" : context.frame.body.decision === "rejected" ? "rejected" : undefined;
	if (expectedRevision === undefined || approvalId === undefined || decision === undefined || state.plan.approval?.approvalId !== approvalId) return failure("approval_request_invalid");
	const approval = state.plan.approval;
	const receiptRef = decision === "approved"
		? { subjectKind: "receipt" as const, digest: runtimeDigest({ approvalId, planDigest: approval.digest, decision }), mediaType: "application/json", size: 0 }
		: undefined;
	const command: PlanModeCommand = {
		type: "resolve_approval",
		expectedRevision,
		approval: { ...approval, status: decision, ...(receiptRef === undefined ? {} : { receiptRef }) },
		updatedAt: timestamp(clock),
	};
	const result = reducePlanModeState(state.plan, command);
	if (!result.ok) return planError(result.error.code, result.error.message, result.error.retryable);
	const prior = state.plan;
	state.plan = result.value;
	await persistSession(options, state);
	const eventType = decision === "approved" ? "plan.approved" : "plan.failed";
	const refs = receiptRef === undefined ? [state.plan.plan!.artifactRef] : [state.plan.plan!.artifactRef, receiptRef];
	return {
		ok: true,
		body: { state: state.plan },
		mutated: true,
		events: [makeEvent({
			type: eventType,
			context,
			authorityId: options.authorityId,
			tenantId: options.tenantId,
			subjectKind: "goal",
			subjectId: state.plan.goalId,
			payload: {
				subject: { kind: "goal", id: state.plan.goalId },
				correlationId: traceId(state.sessionId, context.operation, context.domainRevision, approval.approvalId),
				effect: decision === "approved" ? "committed" : "none",
				transition: transition(state.plan.revision, prior.status, state.plan.status),
				expectedRevision: context.domainRevision,
				...(decision === "rejected" ? { reasonCode: "user_rejected_plan" } : {}),
				refs,
			},
		})],
	};
}

async function planCancel(options: HostModelContextDomainOptions, clock: () => Date, state: SessionDomainState, context: HostRuntimeDomainContext): Promise<DomainResultWithEvents> {
	const expectedRevision = integerValue(context.frame.body.expectedRevision);
	if (expectedRevision === undefined) return failure("expected_revision_required");
	const command: PlanModeCommand = state.plan.status === "pending"
		? { type: "cancel_activation", expectedRevision, updatedAt: timestamp(clock) }
		: state.plan.status === "awaiting_approval" && state.plan.approval !== undefined
			? { type: "cancel_approval", expectedRevision, approvalId: state.plan.approval.approvalId, updatedAt: timestamp(clock) }
			: { type: "settle_exit", expectedRevision, updatedAt: timestamp(clock) };
	const result = reducePlanModeState(state.plan, command);
	if (!result.ok) return planError(result.error.code, result.error.message, result.error.retryable);
	const prior = state.plan;
	state.plan = result.value;
	await persistSession(options, state);
	return {
		ok: true,
		body: { state: state.plan },
		mutated: true,
		events: [makeEvent({
			type: "plan.exited",
			context,
			authorityId: options.authorityId,
			tenantId: options.tenantId,
			subjectKind: "goal",
			subjectId: state.plan.goalId,
			payload: {
				subject: { kind: "goal", id: state.plan.goalId },
				correlationId: traceId(state.sessionId, context.operation, context.domainRevision, state.sessionId),
				effect: "committed",
				transition: transition(state.plan.revision, prior.status, state.plan.status),
				expectedRevision: context.domainRevision,
				refs: [contentRef("details", state.plan)],
			},
		})],
	};
}

async function planSettleExit(options: HostModelContextDomainOptions, clock: () => Date, state: SessionDomainState, context: HostRuntimeDomainContext): Promise<DomainResultWithEvents> {
	return planCancel(options, clock, state, context);
}

function planError(code: string, message: string, retryable = false): HostRuntimeDomainResult {
	return { ok: false, body: { code, message, ...(retryable ? { retryable: true } : {}) } };
}

async function contextAssemble(options: HostModelContextDomainOptions, clock: () => Date, state: SessionDomainState, context: HostRuntimeDomainContext): Promise<DomainResultWithEvents> {
	const body = context.frame.body;
	const request = recordValue(body.request);
	const sources = Array.isArray(body.sources) ? body.sources : undefined;
	if (request === undefined || sources === undefined) return failure("context_assembly_request_invalid");
	const parsedSources = sources as RuntimeContextSource[];
	const assembled = assembleRuntimeContext({ request: request as never, sources: parsedSources, observedAt: timestamp(clock) });
	const receipt = assembled.receipt;
	state.contextReceipts = [...state.contextReceipts.filter((item) => item.requestId !== receipt.requestId), receipt].slice(-MAX_CONTEXT_RECEIPTS);
	await persistSession(options, state);
	const receiptRef = contentRef("receipt", receipt);
	return {
		ok: true,
		body: { receipt, contentByFragmentId: assembled.contentByFragmentId },
		mutated: true,
		events: [makeEvent({
			type: "context.assembled",
			context,
			authorityId: options.authorityId,
			tenantId: options.tenantId,
			subjectKind: "session",
			subjectId: state.sessionId,
			payload: {
				subject: { kind: "session", id: state.sessionId },
			correlationId: traceId(state.sessionId, context.operation, context.domainRevision, receipt.requestId),
				effect: "committed",
				transition: transition(state.contextReceipts.length, null, "assembled"),
				expectedRevision: context.domainRevision,
				refs: [receiptRef],
				metadataDigest: runtimeDigest(receipt),
			},
		})],
	};
}

async function compactRun(options: HostModelContextDomainOptions, clock: () => Date, state: SessionDomainState, context: HostRuntimeDomainContext): Promise<DomainResultWithEvents> {
	const reason = context.frame.body.reason;
	const sourceRange = context.frame.body.sourceRange;
	const transcript = stringValue(context.frame.body.transcript);
	if ((reason !== "manual" && reason !== "auto" && reason !== "overflow" && reason !== "model_switch") || !isRuntimeEventRangeRef(sourceRange) || transcript === undefined) return failure("compaction_request_invalid");
	const compactionId = createRuntimeId("snapshot", runtimeDigest({ sessionId: state.sessionId, sourceRange, reason, transcript }).digest.slice(0, 48));
	const createdAt = timestamp(clock);
	const initial = checkpoint({ compactionId, sessionId: state.sessionId, reason, status: "planned", sourceRange, attempt: 1, projectionDigest: runtimeDigest({ transcript }), completeness: "complete", createdAt });
	const started = checkpoint({ ...initial, status: "started", invariantDigest: undefined });
	const plannedResult = state.compactionStore.apply(initial);
	if (!plannedResult.ok) return failure(plannedResult.error.code, plannedResult.error.message);
	const startedResult = state.compactionStore.apply(started);
	if (!startedResult.ok) return failure(startedResult.error.code, startedResult.error.message);
	let summary = stringValue(context.frame.body.summary);
	if (summary === undefined && options.summarizer !== undefined) summary = await options.summarizer({ transcript, ...(stringValue(context.frame.body.focus) === undefined ? {} : { focus: stringValue(context.frame.body.focus) }) });
	if (summary === undefined) {
		const failed = checkpoint({ ...started, status: "failed", invariantDigest: undefined, terminalReceiptRef: contentRef("receipt", { compactionId, reason: "summarizer_unavailable" }) });
		const failedResult = state.compactionStore.apply(failed);
		if (!failedResult.ok) return failure(failedResult.error.code, failedResult.error.message);
		await persistSession(options, state);
		return {
			ok: false,
			body: { code: "summarizer_unavailable", checkpoint: failed },
			mutated: true,
			events: [compactionEvent("compaction.started", options, context, started, context.domainRevision), compactionEvent("compaction.failed", options, context, failed, context.domainRevision + 1)],
		};
	}
	const replacementArtifactRef = contentRef("artifact", summary, "text/plain");
	const terminalReceiptRef = contentRef("receipt", { compactionId, replacementArtifactRef, summaryDigest: runtimeDigest(summary) });
	const completed = checkpoint({ ...started, status: "completed", invariantDigest: undefined, replacementArtifactRef, terminalReceiptRef });
	const completeResult = state.compactionStore.apply(completed);
	if (!completeResult.ok) return failure(completeResult.error.code, completeResult.error.message);
	await persistSession(options, state);
	return {
		ok: true,
		body: { checkpoint: completed, summary },
		mutated: true,
		events: [compactionEvent("compaction.started", options, context, started, context.domainRevision), compactionEvent("compaction.completed", options, context, completed, context.domainRevision + 1)],
	};
}

function checkpoint(input: Omit<CompactionCheckpoint, "invariantDigest"> & { readonly invariantDigest?: undefined }): CompactionCheckpoint {
	const withoutDigest = { ...input } as Omit<CompactionCheckpoint, "invariantDigest">;
	return { ...withoutDigest, invariantDigest: calculateCompactionInvariantDigest(withoutDigest) };
}

function compactionEvent(type: "compaction.started" | "compaction.completed" | "compaction.failed", options: HostModelContextDomainOptions, context: HostRuntimeDomainContext, value: CompactionCheckpoint, expectedRevision: number): RuntimeEventAppendInput {
	const subject = value.compactionId;
	const refs = value.status === "completed" && value.replacementArtifactRef !== undefined && value.terminalReceiptRef !== undefined
		? [value.replacementArtifactRef, value.terminalReceiptRef]
		: [contentRef("details", value.sourceRange)];
	return makeEvent({
		type,
		context,
		authorityId: options.authorityId,
		tenantId: options.tenantId,
		subjectKind: "snapshot",
		subjectId: subject,
		payload: {
			subject: { kind: "snapshot", id: subject },
			correlationId: traceId(value.sessionId, type, expectedRevision, subject),
			effect: value.status === "failed" ? "none" : "committed",
			transition: transition(value.attempt, type === "compaction.started" ? "planned" : type === "compaction.completed" ? "started" : "started", value.status),
			expectedRevision,
			...(value.status === "failed" ? { reasonCode: "compaction_failed" } : {}),
			refs,
		},
	});
}

function memorySearch(options: HostModelContextDomainOptions, memory: MemoryStore, _state: SessionDomainState, context: HostRuntimeDomainContext): HostRuntimeDomainResult {
	const scope = memoryScope(context.frame.body.scope, context, options.workspaceId);
	const query = stringValue(context.frame.body.query);
	if (!scope || query === undefined) return failure("memory_search_request_invalid");
	const result = memory.search({ ...scope, query, ...(integerValue(context.frame.body.maxResults) === undefined ? {} : { maxResults: integerValue(context.frame.body.maxResults) }) } as MemorySearchOptions);
	return result.ok ? { ok: true, body: { results: result.value.results, receipt: result.value.receipt, ...(result.value.nextCursor === undefined ? {} : { nextCursor: result.value.nextCursor }) } } : failure(result.error.code, result.error.message);
}

function memoryGet(memory: MemoryStore, context: HostRuntimeDomainContext): HostRuntimeDomainResult {
	const memoryId = stringValue(context.frame.body.memoryId);
	if (!memoryId || !isRuntimeId(memoryId, "memory")) return failure("memory_id_required");
	const result = memory.get(memoryId as never);
	return result.ok ? { ok: true, body: { record: result.value } } : failure(result.error.code, result.error.message);
}

function memoryInspect(memory: MemoryStore): HostRuntimeDomainResult {
		const snapshot = memory.snapshot();
		return {
			ok: true,
			body: {
				memory: {
					generation: snapshot.generation,
					recordCount: snapshot.records.length,
					proposalCount: snapshot.proposals.length,
				},
			},
		};
}

async function memoryPropose(options: HostModelContextDomainOptions, _clock: () => Date, memory: MemoryStore, state: SessionDomainState, context: HostRuntimeDomainContext): Promise<DomainResultWithEvents> {
	const scope = memoryScope(context.frame.body.scope, context, options.workspaceId);
	const title = stringValue(context.frame.body.title);
	const content = stringValue(context.frame.body.content);
	const sourceKind = context.frame.body.sourceKind;
	const sourceRef = context.frame.body.sourceRef;
	const sourceDigest = context.frame.body.sourceDigest;
	if (!scope || title === undefined || content === undefined || (sourceKind !== "user" && sourceKind !== "agent" && sourceKind !== "tool" && sourceKind !== "import" && sourceKind !== "compaction") || !isRuntimeContentRef(sourceRef) || !isRuntimeDigestValue(sourceDigest)) return failure("memory_proposal_request_invalid");
	const input: MemoryProposalInput = { ...scope, title, content, sourceKind, sourceRef, sourceDigest };
	const result = memory.propose(input);
	if (!result.ok) return failure(result.error.code, result.error.message);
	await persistMemory(options, memory);
	const proposal = result.value.proposal;
	return {
		ok: true,
		body: { proposal, record: result.value.record },
		mutated: true,
		events: [makeEvent({
			type: "memory.proposed",
			context,
			authorityId: options.authorityId,
			tenantId: options.tenantId,
			subjectKind: "session",
			subjectId: state.sessionId,
			payload: {
				subject: { kind: "session", id: state.sessionId },
				correlationId: traceId(state.sessionId, context.operation, context.domainRevision, proposal.proposalId),
				effect: "committed",
				idempotencyKey: `memory:proposal:${proposal.proposalId}`,
				transition: transition(0, null, "proposed"),
				refs: [result.value.record.contentRef, result.value.record.provenance.sourceRef],
			},
		})],
	};
}

async function memoryApprove(options: HostModelContextDomainOptions, _clock: () => Date, memory: MemoryStore, state: SessionDomainState, context: HostRuntimeDomainContext): Promise<DomainResultWithEvents> {
	const proposalId = stringValue(context.frame.body.proposalId);
	const approvalRef = context.frame.body.approvalRef;
	if (!proposalId || !isRuntimeId(proposalId, "proposal") || !isRuntimeContentRef(approvalRef)) return failure("memory_approval_request_invalid");
	const result = memory.approve({ proposalId: proposalId as never, approvalRef });
	if (!result.ok) return failure(result.error.code, result.error.message);
	await persistMemory(options, memory);
	return {
		ok: true,
		body: { proposal: result.value.proposal, record: result.value.record },
		mutated: true,
		events: [makeEvent({
			type: "memory.approved",
			context,
			authorityId: options.authorityId,
			tenantId: options.tenantId,
			subjectKind: "session",
			subjectId: state.sessionId,
			payload: {
					subject: { kind: "session", id: state.sessionId },
				correlationId: traceId(state.sessionId, context.operation, context.domainRevision, result.value.record.memoryId),
				effect: "committed",
				transition: transition(result.value.record.revision, "proposed", "approved"),
				expectedRevision: context.domainRevision,
				refs: [result.value.record.contentRef, approvalRef],
			},
		})],
	};
}

async function memoryReject(options: HostModelContextDomainOptions, _clock: () => Date, memory: MemoryStore, _state: SessionDomainState, context: HostRuntimeDomainContext): Promise<DomainResultWithEvents> {
	const proposalId = stringValue(context.frame.body.proposalId);
	if (!proposalId || !isRuntimeId(proposalId, "proposal")) return failure("memory_proposal_id_required");
	const result = memory.reject(proposalId as never);
	if (!result.ok) return failure(result.error.code, result.error.message);
	await persistMemory(options, memory);
	return { ok: true, body: { proposal: result.value }, mutated: true };
}

async function memoryRevoke(options: HostModelContextDomainOptions, _clock: () => Date, memory: MemoryStore, state: SessionDomainState, context: HostRuntimeDomainContext): Promise<DomainResultWithEvents> {
	const memoryId = stringValue(context.frame.body.memoryId);
	if (!memoryId || !isRuntimeId(memoryId, "memory")) return failure("memory_id_required");
	const result = memory.revoke(memoryId as never);
	if (!result.ok) return failure(result.error.code, result.error.message);
	await persistMemory(options, memory);
	return {
		ok: true,
		body: { record: result.value },
		mutated: true,
		events: [makeEvent({
			type: "memory.revoked",
			context,
			authorityId: options.authorityId,
			tenantId: options.tenantId,
			subjectKind: "session",
			subjectId: state.sessionId,
			payload: {
				subject: { kind: "session", id: state.sessionId },
				correlationId: traceId(state.sessionId, context.operation, context.domainRevision, result.value.memoryId),
				effect: "committed",
				transition: transition(result.value.revision, "approved", "revoked"),
				expectedRevision: context.domainRevision,
				reasonCode: stringValue(context.frame.body.reason) ?? "user_revoked_memory",
				refs: [result.value.contentRef],
			},
		})],
	};
}

async function modelRoute(options: HostModelContextDomainOptions, _clock: () => Date, state: SessionDomainState, context: HostRuntimeDomainContext): Promise<HostRuntimeDomainResult> {
	if (options.modelRouter === undefined) return failure(options.modelRouterUnavailable ?? "model_router_unavailable");
	const request = context.frame.body.request;
	if (!isModelRouteRequest(request)) return failure("model_route_request_invalid");
	const decision = options.modelRouter.route(request);
	state.routes = [...state.routes.filter((item) => item.requestId !== decision.requestId), decision].slice(-MAX_ROUTE_DECISIONS);
	await persistSession(options, state);
	const turnId = createRuntimeId("turn", runtimeDigest({ sessionId: state.sessionId, requestId: decision.requestId }).digest.slice(0, 48));
	return {
		ok: true,
		body: { decision },
		mutated: true,
		events: [makeEvent({
			type: "model.routed",
			context,
			authorityId: options.authorityId,
			tenantId: options.tenantId,
			subjectKind: "turn",
			subjectId: turnId,
			payload: {
				subject: { kind: "turn", id: turnId },
				correlationId: request.traceId,
				effect: decision.outcome === "deny" ? "none" : "committed",
				transition: transition(state.routes.length, null, decision.outcome),
				expectedRevision: context.domainRevision,
				refs: [contentRef("details", decision), ...(decision.conversionRef === undefined ? [] : [decision.conversionRef])],
				metadataDigest: decision.decisionDigest,
			},
		})],
	};
}

function memoryScope(value: unknown, context: HostRuntimeDomainContext, workspaceId: WorkspaceId): MemorySearchOptions | MemoryProposalInput | { readonly scope: "user" } | { readonly scope: "workspace"; readonly workspaceId: WorkspaceId } | { readonly scope: "session"; readonly sessionId: SessionId } | undefined {
	if (value === "user") return { scope: "user" };
	if (value === "workspace") return { scope: "workspace", workspaceId };
	if (value === "session") {
		const sessionId = parseRuntimeId("session", context.sessionId);
		return sessionId === undefined ? undefined : { scope: "session", sessionId };
	}
	return undefined;
}

function isRuntimeDigestValue(value: unknown): value is RuntimeDigest {
	const record = recordValue(value);
	return record?.algorithm === "sha256" && typeof record.digest === "string" && /^[a-f0-9]{64}$/u.test(record.digest);
}

async function persistSession(options: HostModelContextDomainOptions, state: SessionDomainState): Promise<void> {
	const snapshot: HostModelContextSnapshot = {
		version: DOMAIN_VERSION,
		sessionId: state.sessionId,
		plan: state.plan,
		planArtifacts: state.planStore.snapshot(),
		compactions: state.compactionStore.list(state.sessionId),
		contextReceipts: state.contextReceipts,
		routes: state.routes,
	};
	if (!isDomainSnapshot(snapshot, state.sessionId)) throw new Error("model/context state failed exact validation before persistence");
	await atomicWrite(sessionPath(options.layout, options.workspaceStorageKey, state.sessionId), JSON.stringify(snapshot));
}

async function persistMemory(options: HostModelContextDomainOptions, memory: MemoryStore): Promise<void> {
	await atomicWrite(memoryPath(options.layout, options.workspaceStorageKey), MemoryStoreSnapshotCodec.encode(memory.snapshot()));
}

function domainRoot(layout: RunledgerLayout, workspaceStorageKey: string): string {
	const root = resolve(join(layout.state, "hosts", workspaceStorageKey, "domains"));
	if (!isContainedRuntimePath(resolve(layout.home), root, "posix")) throw new Error("model/context domain path escaped runledgerHome");
	return root;
}

function sessionPath(layout: RunledgerLayout, workspaceStorageKey: string, sessionId: SessionId): string {
	return join(domainRoot(layout, workspaceStorageKey), sessionId, "model-context.json");
}

function memoryPath(layout: RunledgerLayout, workspaceStorageKey: string): string {
	return join(domainRoot(layout, workspaceStorageKey), "workspace-memory.json");
}

async function readOptional(path: string): Promise<string | undefined> {
	try { return await readFile(path, "utf8"); } catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function atomicWrite(path: string, content: string): Promise<void> {
	const parent = dirname(path);
	await mkdir(parent, { recursive: true, mode: RUNLEDGER_DIRECTORY_MODE });
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
	try {
		await writeFile(temporary, `${content}\n`, { encoding: "utf8", mode: RUNLEDGER_FILE_MODE });
		await rename(temporary, path);
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
}
