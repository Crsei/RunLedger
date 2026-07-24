/** Active production session 上的 Plan/Context/Memory schema-v2 executor。 */

import type {
	ArtifactReadRequest,
	ArtifactReadResult,
	ArtifactResult,
} from "../artifacts/types.ts";
import type { ArtifactRef } from "../protocol/v3/capability.ts";
import type {
	ControlPlaneV2PlanContextMemoryCommand,
	ControlPlaneV2PlanContextMemoryQuery,
	ControlPlaneV2PlanContextMemoryQueryResponse,
	PlanContextMemoryMutationEffectV2,
} from "../control-plane/plan-context-memory-contracts.ts";
import type {
	PlanContextMemoryMutationExecutorPort,
	PlanContextMemoryQueryExecutorPort,
} from "../control-plane/plan-context-memory-control-plane.ts";
import {
	controlPlaneFailure,
	type ControlPlaneResult,
} from "../control-plane/errors.ts";
import type { ControlPlaneRequestContext } from "../control-plane/types.ts";
import type {
	MemoryScopeRef,
	MemorySourceRef,
	MemoryStatus,
} from "../context/memory/types.ts";
import {
	isMemoryScopeRef,
	isMemorySourceRef,
} from "../context/memory/schema.ts";
import { calculateCompactionInvariantDigest } from "../context/invariants.ts";
import type { CompactionInvariantSnapshot } from "../context/compaction/types.ts";
import type { PlanModeService } from "../modes/plan/service.ts";
import type { ExpectedRevision } from "../protocol/v3/events.ts";
import { sameRuntimeEventStream } from "../protocol/v3/events.ts";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import {
	createRuntimeId,
	parseRuntimeId,
	type MemoryId,
	type SessionId,
} from "../protocol/v3/ids.ts";
import type { ProductionSessionRuntime } from "./production-session-runtime.ts";
import type { PersistedWorkspaceBinding } from "../../worktree/types.ts";
import type { V3SessionManager } from "../../storage/v3-session-manager.ts";
import type { WorkspaceBindingRef } from "../protocol/v3/workspace.ts";
import { readAllRuntimeEvents } from "../session/snapshot.ts";
import { buildCompactionSourceHistory } from "./compaction-model-history.ts";

export interface ProductionPlanContextMemorySessionPort {
	readonly manager: V3SessionManager;
	readonly workspace: PersistedWorkspaceBinding;
	readonly runtimeWorkspace: WorkspaceBindingRef;
	readonly plan: PlanModeService;
	readonly memoryStore: ProductionSessionRuntime["memoryStore"];
	readonly memory: ProductionSessionRuntime["memory"];
	readonly memoryScopes: ProductionSessionRuntime["memoryScopes"];
	readonly compactionProjection: ProductionSessionRuntime["compactionProjection"];
	readonly compaction: ProductionSessionRuntime["compaction"];
	readonly compactionPolicy: ProductionSessionRuntime["compactionPolicy"];
	readonly goal: ProductionSessionRuntime["goal"];
	readonly tasks: ProductionSessionRuntime["tasks"];
	readonly verification: ProductionSessionRuntime["verification"];
	readonly artifacts: PlanContextMemoryArtifactAccessPort;
	waitForIdle(): Promise<void>;
}

/** 生产实现由 ArtifactAccessService 提供；窄 port 保证 executor 不可绕过受控读取。 */
export interface PlanContextMemoryArtifactAccessPort {
	read(request: ArtifactReadRequest): Promise<ArtifactResult<ArtifactReadResult>>;
}

export interface ActivePlanContextMemorySessionResolverPort {
	withSession<T>(
		sessionId: SessionId,
		operation: (session: ProductionPlanContextMemorySessionPort) => Promise<ControlPlaneResult<T>>,
	): Promise<ControlPlaneResult<T>>;
}

export type MemoryProposalArtifactDocument =
	| {
			schemaVersion: 1;
			operation: "create";
			title: string;
			content: string;
			scope: MemoryScopeRef;
			sourceRefs: readonly MemorySourceRef[];
			expiresAt?: string;
	  }
	| {
			schemaVersion: 1;
			operation: "revoke";
			memoryId: MemoryId;
			scope: MemoryScopeRef;
	  }
	| {
			schemaVersion: 1;
			operation: "update";
			memoryId: MemoryId;
			scope: MemoryScopeRef;
			title: string;
			content: string;
			sourceRefs: readonly MemorySourceRef[];
			expiresAt?: string;
	  };

export function memoryProposalArtifactDigest(
	document: MemoryProposalArtifactDocument,
	diffBody: string,
): string {
	return canonicalDigest({
		schemaVersion: 1,
		operation: document.operation,
		draftDigest: canonicalDigest(document),
		diffDigest: canonicalDigest(diffBody),
	});
}

function exactExpectedRevision(
	manager: V3SessionManager,
	expected: ExpectedRevision,
): ControlPlaneResult<void> {
	const head = manager.writer().currentHead();
	if (
		!head ||
		!sameRuntimeEventStream(head.stream, expected.stream) ||
		head.sequence !== expected.sequence ||
		head.eventHash !== expected.eventHash
	) {
		return controlPlaneFailure(
			"expected_revision_conflict",
			"Plan/Context/Memory command session revision is stale",
			true,
		);
	}
	return { ok: true, value: undefined };
}

function sameScope(
	session: ProductionPlanContextMemorySessionPort,
	request: ControlPlaneV2PlanContextMemoryCommand | ControlPlaneV2PlanContextMemoryQuery,
	context: ControlPlaneRequestContext,
): boolean {
	const identity = session.manager.identity();
	return (
		request.authorityId === identity.authorityId &&
		request.tenantId === identity.tenantId &&
		request.principalId === identity.principalId &&
		context.peer.principalId === identity.principalId &&
		request.payload.sessionId === session.manager.sessionId() &&
		session.workspace.authorityId === identity.authorityId &&
		session.workspace.tenantId === identity.tenantId &&
		session.workspace.principalId === identity.principalId &&
		session.workspace.sessionId === session.manager.sessionId()
	);
}

function durableCursor(session: ProductionPlanContextMemorySessionPort) {
	const head = session.manager.writer().currentHead();
	if (!head) throw new Error("specialty mutation completed without a durable session cursor");
	return head;
}

function effect<T extends Omit<PlanContextMemoryMutationEffectV2, "receiptDigest">>(
	body: T,
): T & { receiptDigest: string } {
	return { ...body, receiptDigest: canonicalDigest(body) };
}

function memoryRef(record: Awaited<ReturnType<ProductionSessionRuntime["memoryStore"]["readRecord"]>>) {
	return {
		schemaVersion: 1 as const,
		authorityId: record.authorityId,
		tenantId: record.tenantId,
		memoryId: record.memoryId,
		scope: record.scope,
		revision: record.revision,
		contentDigest: record.contentDigest,
		status: record.status,
	};
}

function exactArtifactReference(
	reference: ArtifactRef,
	read: ArtifactReadResult,
): boolean {
	const metadata = read.metadata;
	return (
		metadata.authorityId === reference.authorityId &&
		metadata.tenantId === reference.tenantId &&
		metadata.artifactId === reference.artifactId &&
		metadata.storedDigest === reference.storedDigest &&
		metadata.kind === reference.kind &&
		metadata.originalSize === reference.originalSize &&
		metadata.storedSize === reference.storedSize &&
		metadata.mediaType === reference.mediaType &&
		metadata.redaction === reference.redaction &&
		metadata.transformReceipt.receiptId === reference.transformReceipt &&
		metadata.source.workspaceId === reference.workspaceId
	);
}

async function readArtifactText(
	session: ProductionPlanContextMemorySessionPort,
	reference: ArtifactRef,
	expectedKind: "change_proposal" | "diff",
): Promise<ControlPlaneResult<string>> {
	if (
		reference.kind !== expectedKind ||
		reference.originalSize > 256 * 1024 ||
		reference.storedSize > 256 * 1024
	) {
		return controlPlaneFailure(
			"invalid_request",
			"memory proposal artifact kind or size is invalid",
		);
	}
	const identity = session.manager.identity();
	const read = await session.artifacts.read({
		authorityId: identity.authorityId,
		tenantId: identity.tenantId,
		artifactId: reference.artifactId,
		principalId: identity.principalId,
		sessionId: session.manager.sessionId(),
		workspaceId: session.workspace.workspaceId,
		capability: "repository_read",
		targetSink: "context",
	});
	if (!read.ok) {
		return controlPlaneFailure(
			read.error.code === "authorization_denied"
				? "unauthorized_peer"
				: "adapter_unavailable",
			"memory proposal artifact could not be read through the Capability Gateway",
			read.error.retryable,
			{ artifactCode: read.error.code },
		);
	}
	if (
		!exactArtifactReference(reference, read.value) ||
		read.value.metadata.source.sessionId !== session.manager.sessionId() ||
		read.value.content.byteLength > 256 * 1024
	) {
		return controlPlaneFailure(
			"invalid_request",
			"memory proposal artifact metadata does not match its exact reference",
		);
	}
	try {
		return {
			ok: true,
			value: new TextDecoder("utf-8", { fatal: true }).decode(read.value.content),
		};
	} catch {
		return controlPlaneFailure("invalid_request", "memory proposal artifact is not valid UTF-8");
	}
}

function exactKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): boolean {
	const allowed = new Set([...required, ...optional]);
	return required.every((key) => Object.hasOwn(value, key)) &&
		Object.keys(value).every((key) => allowed.has(key));
}

function parseMemoryProposalArtifact(
	source: string,
): ControlPlaneResult<MemoryProposalArtifactDocument> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(source) as unknown;
	} catch {
		return controlPlaneFailure("invalid_request", "memory draft artifact is malformed JSON");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return controlPlaneFailure("invalid_request", "memory draft artifact is not an object");
	}
	const value = parsed as Record<string, unknown>;
	if (
		value.schemaVersion !== 1 ||
		(value.operation !== "create" &&
			value.operation !== "update" &&
			value.operation !== "revoke")
	) {
		return controlPlaneFailure("invalid_request", "memory draft artifact operation is unsupported");
	}
	if (value.operation === "create") {
		if (
			!exactKeys(
				value,
				["schemaVersion", "operation", "title", "content", "scope", "sourceRefs"],
				["expiresAt"],
			) ||
			typeof value.title !== "string" ||
			value.title.trim().length < 1 ||
			value.title.length > 256 ||
			typeof value.content !== "string" ||
			value.content.length > 65_536 ||
			!isMemoryScopeRef(value.scope) ||
			!Array.isArray(value.sourceRefs) ||
			value.sourceRefs.length < 1 ||
			value.sourceRefs.length > 64 ||
			!value.sourceRefs.every(isMemorySourceRef) ||
			(value.expiresAt !== undefined &&
				(typeof value.expiresAt !== "string" ||
					new Date(value.expiresAt).toISOString() !== value.expiresAt))
		) {
			return controlPlaneFailure(
				"invalid_request",
				"memory create draft failed bounded contract validation",
			);
		}
		return {
			ok: true,
			value: {
				schemaVersion: 1,
				operation: "create",
				title: value.title,
				content: value.content,
				scope: value.scope,
				sourceRefs: value.sourceRefs,
				...(typeof value.expiresAt === "string"
					? { expiresAt: value.expiresAt }
					: {}),
			},
		};
	}
	const update = value.operation === "update";
	if (
		!exactKeys(
			value,
			update
				? [
						"schemaVersion",
						"operation",
						"memoryId",
						"scope",
						"title",
						"content",
						"sourceRefs",
					]
				: ["schemaVersion", "operation", "memoryId", "scope"],
			update ? ["expiresAt"] : [],
		) ||
		typeof value.memoryId !== "string" ||
		!isMemoryScopeRef(value.scope) ||
		(update &&
			(typeof value.title !== "string" ||
				value.title.trim().length < 1 ||
				value.title.length > 256 ||
				typeof value.content !== "string" ||
				value.content.length > 65_536 ||
				!Array.isArray(value.sourceRefs) ||
				value.sourceRefs.length < 1 ||
				value.sourceRefs.length > 64 ||
				!value.sourceRefs.every(isMemorySourceRef) ||
				(value.expiresAt !== undefined &&
					(typeof value.expiresAt !== "string" ||
						new Date(value.expiresAt).toISOString() !== value.expiresAt))))
	) {
		return controlPlaneFailure(
			"invalid_request",
			"memory revoke draft failed bounded contract validation",
		);
	}
	const memoryId = parseRuntimeId("memory", value.memoryId);
	if (!memoryId) {
		return controlPlaneFailure(
			"invalid_request",
			"memory revoke draft failed bounded contract validation",
		);
	}
	return {
		ok: true,
		value: update
			? {
					schemaVersion: 1,
					operation: "update",
					memoryId,
					scope: value.scope,
					title: value.title as string,
					content: value.content as string,
					sourceRefs: value.sourceRefs as readonly MemorySourceRef[],
					...(typeof value.expiresAt === "string"
						? { expiresAt: value.expiresAt }
						: {}),
				}
			: {
					schemaVersion: 1,
					operation: "revoke",
					memoryId,
					scope: value.scope,
				},
	};
}

function allowedMemoryScope(
	session: ProductionPlanContextMemorySessionPort,
	scope: MemoryScopeRef,
): boolean {
	return session.memoryScopes.some(
		(candidate) => canonicalDigest(candidate) === canonicalDigest(scope),
	);
}

async function loadMemoryProposal(
	session: ProductionPlanContextMemorySessionPort,
	proposalId: Extract<
		ControlPlaneV2PlanContextMemoryCommand,
		{ type: "memory:resolve" }
	>["payload"]["proposalId"],
) {
	for (const scope of session.memoryScopes) {
		try {
			return await session.memoryStore.loadProposal(scope, proposalId);
		} catch (error) {
			if (
				!(error instanceof Error) ||
				!("code" in error) ||
				error.code !== "not_found"
			) throw error;
		}
	}
	return undefined;
}

function approvalState(
	receipt: Extract<ControlPlaneV2PlanContextMemoryCommand, { type: "plan:resolve" }>["payload"]["resolutionReceipt"],
): "approved" | "rejected" | "expired" | "revoked" {
	switch (receipt.decision) {
		case "allowed":
			return "approved";
		case "expired":
			return "expired";
		case "revoked":
			return "revoked";
		default:
			return "rejected";
	}
}

function planFailure(error: unknown): ControlPlaneResult<never> {
	const name = error instanceof Error ? error.name : "UnknownError";
	const message = error instanceof Error ? error.message : "Plan mutation failed";
	if (
		name === "PlanTransitionError" &&
		/(revision|stale|changed)/iu.test(message)
	) {
		return controlPlaneFailure("expected_revision_conflict", message, true);
	}
	if (name === "PlanTransitionError" || error instanceof TypeError) {
		return controlPlaneFailure("invalid_request", message);
	}
	return controlPlaneFailure(
		"recovery_required",
		"Plan mutation did not reach a confirmed durable boundary",
		false,
		{ errorName: name },
		"uncertain",
	);
}

function invariantSnapshot(
	session: ProductionPlanContextMemorySessionPort,
	taskState: unknown,
	toolPairingDigest: string,
): CompactionInvariantSnapshot {
	const plan = session.plan.snapshot();
	const body: Omit<CompactionInvariantSnapshot, "invariantDigest"> = {
		authorityId: session.manager.identity().authorityId,
		tenantId: session.manager.identity().tenantId,
		sessionId: session.manager.sessionId(),
		workspace: structuredClone(session.runtimeWorkspace),
		modeRevision: plan.modeRevision,
		...(plan.kind === "exit_pending" && plan.approvedPlan
			? { approvedPlan: structuredClone(plan.approvedPlan) }
			: {}),
		pendingApprovalIds: plan.kind === "awaiting_approval"
			? [plan.approval.approvalId]
			: [],
		goalStateDigest: canonicalDigest(session.goal.snapshot()),
		taskStateDigest: canonicalDigest(taskState),
		workspaceStateDigest: session.workspace.bindingDigest,
		verificationStateDigest: session.verification.evidenceDigest,
		toolPairingDigest,
		inputSources: [],
		declassificationReceipts: [],
	};
	return { ...body, invariantDigest: calculateCompactionInvariantDigest(body) };
}

async function inspectMemory(
	session: ProductionPlanContextMemorySessionPort,
	memoryId: Extract<ControlPlaneV2PlanContextMemoryQuery, { type: "memory:inspect" }>["payload"]["memoryId"],
) {
	for (const scope of session.memoryScopes) {
		const inspected = await session.memoryStore.inspectRecord(scope, memoryId);
		if (inspected.state === "canonical") return inspected.record;
	}
	return null;
}

function pageMemoryRecords<T extends { memoryId: string }>(
	records: readonly T[],
	cursor: string | null,
	limit: number,
): { records: readonly T[]; nextCursor: string | null } {
	const ordered = [...records].sort((left, right) => left.memoryId.localeCompare(right.memoryId));
	const after = cursor === null
		? ordered
		: ordered.filter((record) => record.memoryId.localeCompare(cursor) > 0);
	const page = after.slice(0, limit);
	return {
		records: page,
		nextCursor: after.length > page.length ? page.at(-1)?.memoryId ?? null : null,
	};
}

export class ProductionPlanContextMemoryControlPlaneExecutor
	implements PlanContextMemoryMutationExecutorPort, PlanContextMemoryQueryExecutorPort {
	readonly #sessions: ActivePlanContextMemorySessionResolverPort;

	public constructor(sessions: ActivePlanContextMemorySessionResolverPort) {
		this.#sessions = sessions;
	}

	public execute(
		command: ControlPlaneV2PlanContextMemoryCommand,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<PlanContextMemoryMutationEffectV2>> {
		return this.#sessions.withSession<PlanContextMemoryMutationEffectV2>(
			command.payload.sessionId,
			async (session) => {
			if (!sameScope(session, command, context)) {
				return controlPlaneFailure(
					"unauthorized_peer",
					"specialty command scope does not match the active production session",
				);
			}
			const revision = exactExpectedRevision(session.manager, command.expectedSessionRevision);
			if (!revision.ok) return revision;
			switch (command.type) {
				case "plan:enter": {
					const before = session.plan.snapshot();
					if (before.modeRevision !== command.expectedDomainRevision) {
						return controlPlaneFailure("expected_revision_conflict", "Plan mode revision is stale", true);
					}
					try {
						const state = await session.plan.requestActivation(
							command.payload.requestedBy,
							command.expectedSessionRevision,
							createRuntimeId("trace", `plan-enter-${command.commandId.slice(-48)}`),
							command.commandId,
						);
						return {
							ok: true,
							value: effect({
								type: command.type,
								sessionId: command.payload.sessionId,
								domainRevision: state.modeRevision,
								durableCursor: durableCursor(session),
								stateKind: state.kind,
								modeRevision: state.modeRevision,
							}),
						};
					} catch (error) {
						return planFailure(error);
					}
				}
				case "plan:resolve": {
					const state = session.plan.snapshot();
					if (
						state.kind !== "awaiting_approval" ||
						state.modeRevision !== command.expectedDomainRevision ||
						state.modeRevision !== command.payload.expectedModeRevision ||
						state.plan.planId !== command.payload.planId ||
						state.plan.revision !== command.payload.expectedPlanRevision ||
						state.plan.contentDigest !== command.payload.contentDigest ||
						state.approval.approvalId !== command.payload.approvalId
					) {
						return controlPlaneFailure(
							"expected_revision_conflict",
							"Plan approval target or revision is stale",
							true,
						);
					}
					const resolvedState = approvalState(command.payload.resolutionReceipt);
					const approveAction = command.payload.action === "approve_same_session" ||
						command.payload.action === "approve_fresh_context";
					if (approveAction !== (resolvedState === "approved")) {
						return controlPlaneFailure(
							"invalid_request",
							"Plan approval action does not match the resolution receipt decision",
						);
					}
					try {
						const decision = await session.plan.decideApproval(
							{
								...state.approval,
								state: resolvedState,
								receipt: command.payload.resolutionReceipt,
							},
							command.payload.action,
							command.expectedSessionRevision,
							createRuntimeId("trace", `plan-resolve-${command.commandId.slice(-48)}`),
							command.commandId,
						);
						return {
							ok: true,
							value: effect({
								type: command.type,
								sessionId: command.payload.sessionId,
								domainRevision: decision.state.modeRevision,
								durableCursor: durableCursor(session),
								stateKind: decision.state.kind,
								modeRevision: decision.state.modeRevision,
							}),
						};
					} catch (error) {
						return planFailure(error);
					}
				}
				case "context:compact": {
					try {
						await session.waitForIdle();
						const current = exactExpectedRevision(
							session.manager,
							command.expectedSessionRevision,
						);
						if (!current.ok) return current;
						const flushed = await session.manager.flushCurrentHead();
						if (!flushed.ok) {
							return controlPlaneFailure(
								"recovery_required",
								"canonical session head could not be flushed before compaction",
								false,
								undefined,
								"uncertain",
							);
						}
						const [replayed, projectionState, tasks] = await Promise.all([
							readAllRuntimeEvents(session.manager.eventStore()),
							session.compactionProjection.loadState(),
							session.tasks.load(),
						]);
						if (!replayed.ok || !tasks.ok) {
							return controlPlaneFailure(
								"recovery_required",
								"canonical session state could not be projected for compaction",
							);
						}
						if (projectionState.revision !== command.expectedDomainRevision) {
							return controlPlaneFailure(
								"expected_revision_conflict",
								"compaction projection revision is stale",
								true,
							);
						}
						const source = buildCompactionSourceHistory(replayed.value);
						if (!source.ok) {
							return controlPlaneFailure(
								"unsupported_feature",
								source.message,
								false,
								{ sourceCode: source.code },
							);
						}
						const toolPairingDigest = source.toolPairingDigest;
						const invariants = invariantSnapshot(
							session,
							tasks.value,
							toolPairingDigest,
						);
						const compacted = await session.compaction.compact({
							commandId: command.commandId,
							traceId: createRuntimeId(
								"trace",
								`context-compact-${command.commandId.slice(-48)}`,
							),
							reason: command.payload.reason,
							history: source.entries,
							retainedTurns: session.compactionPolicy.retainedTurns,
							maxInputChars: session.compactionPolicy.maxInputChars,
							maxSummaryTokens: session.compactionPolicy.maxSummaryTokens,
							targetInputBudget: session.compactionPolicy.targetInputBudget,
							timeoutMs: session.compactionPolicy.timeoutMs,
							summarizerProfileId: session.compactionPolicy.summarizerProfileId,
							summarizerProfileDigest:
								session.compactionPolicy.summarizerProfileDigest,
							...(projectionState.projection
								? { previousCheckpoint: projectionState.projection.checkpoint }
								: {}),
							originalProjectionDigest:
								projectionState.projection?.projectionDigest ??
								canonicalDigest({ projection: null }),
							expectedProjectionRevision: projectionState.revision,
							captureInvariants: () => invariants,
						});
						if (!compacted.ok && compacted.status === "recovery_required") {
							return controlPlaneFailure(
								"recovery_required",
								"compaction committed but its live projection requires recovery",
								false,
								{ checkpointId: compacted.checkpoint.checkpointId },
								"uncertain",
							);
						}
						const attemptStatus = compacted.ok
							? "completed"
							: compacted.status === "suppressed"
								? "suppressed"
								: "failed";
						const checkpointId = compacted.ok
							? compacted.checkpoint.checkpointId
							: "checkpoint" in compacted && compacted.checkpoint
								? compacted.checkpoint.checkpointId
								: null;
						return {
							ok: true,
							value: effect({
								type: command.type,
								sessionId: command.payload.sessionId,
								domainRevision: compacted.ok
									? compacted.installation.installedProjectionRevision
									: projectionState.revision,
								durableCursor: durableCursor(session),
								attemptStatus,
								checkpointId,
							}),
						};
					} catch (error) {
						return controlPlaneFailure(
							"recovery_required",
							"production compaction did not reach a confirmed terminal boundary",
							false,
							{ errorName: error instanceof Error ? error.name : "UnknownError" },
							"uncertain",
						);
					}
				}
				case "memory:propose": {
					if (command.payload.operation === "scope_change") {
						return controlPlaneFailure(
							"unsupported_feature",
							"memory scope-change publication requires a cross-scope atomic store transaction",
						);
					}
					const [draftBody, diffBody] = await Promise.all([
						readArtifactText(
							session,
							command.payload.draftArtifact,
							"change_proposal",
						),
						readArtifactText(session, command.payload.diffArtifact, "diff"),
					]);
					if (!draftBody.ok) return draftBody;
					if (!diffBody.ok) return diffBody;
					const draft = parseMemoryProposalArtifact(draftBody.value);
					if (!draft.ok) return draft;
					if (
						draft.value.operation !== command.payload.operation ||
						!allowedMemoryScope(session, draft.value.scope) ||
						memoryProposalArtifactDigest(draft.value, diffBody.value) !==
							command.payload.proposalDigest
					) {
						return controlPlaneFailure(
							"invalid_request",
							"memory proposal digest, operation, or scope is invalid",
						);
					}
					const externalDiff = {
						artifact: command.payload.diffArtifact,
						digest: canonicalDigest(diffBody.value),
					};
					try {
						if (draft.value.operation === "create") {
							if (
								command.expectedDomainRevision !== 0 ||
								command.payload.expectedMemoryRevision !== null ||
								command.payload.expectedContentDigest !== null
							) {
								return controlPlaneFailure(
									"expected_revision_conflict",
									"memory create must begin at revision zero",
									true,
								);
							}
							const created = await session.memory.propose({
								title: draft.value.title,
								content: draft.value.content,
								scope: draft.value.scope,
								sourceRefs: draft.value.sourceRefs,
								traceId: createRuntimeId(
									"trace",
									`memory-propose-${command.commandId.slice(-48)}`,
								),
								...(draft.value.expiresAt
									? { expiresAt: draft.value.expiresAt }
									: {}),
								diffArtifact: externalDiff,
							});
							return {
								ok: true,
								value: effect({
									type: command.type,
									sessionId: command.payload.sessionId,
									domainRevision: created.proposal.memory.revision,
									durableCursor: durableCursor(session),
									proposalId: created.proposal.proposalId,
									proposalStatus: created.proposal.status,
								}),
							};
						}
						const inspected = await session.memoryStore.inspectRecord(
							draft.value.scope,
							draft.value.memoryId,
						);
						if (
							inspected.state !== "canonical" ||
							inspected.record.status !== "approved" ||
							inspected.record.revision !==
								command.payload.expectedMemoryRevision ||
							inspected.record.contentDigest !==
								command.payload.expectedContentDigest ||
							inspected.record.revision !== command.expectedDomainRevision
						) {
							return controlPlaneFailure(
								"expected_revision_conflict",
								"memory mutation target changed before proposal",
								true,
							);
						}
						const traceId = createRuntimeId(
							"trace",
							`memory-change-${command.commandId.slice(-48)}`,
						);
						const changed = draft.value.operation === "update"
							? await session.memory.proposeUpdate(
									inspected.record,
									{
										title: draft.value.title,
										content: draft.value.content,
										sourceRefs: draft.value.sourceRefs,
										...(draft.value.expiresAt
											? { expiresAt: draft.value.expiresAt }
											: {}),
									},
									traceId,
									externalDiff,
								)
							: await session.memory.proposeRevocation(
									inspected.record,
									traceId,
									externalDiff,
								);
						return {
							ok: true,
							value: effect({
								type: command.type,
								sessionId: command.payload.sessionId,
								domainRevision: changed.proposal.memory.revision,
								durableCursor: durableCursor(session),
								proposalId: changed.proposal.proposalId,
								proposalStatus: changed.proposal.status,
							}),
						};
					} catch (error) {
						return controlPlaneFailure(
							"recovery_required",
							"memory proposal did not reach a confirmed durable boundary",
							false,
							{ errorName: error instanceof Error ? error.name : "UnknownError" },
							"uncertain",
						);
					}
				}
				case "memory:resolve": {
					if (command.payload.action === "edit" || command.payload.action === "expire") {
						return controlPlaneFailure(
							"unsupported_feature",
							"memory edit and proposal expiry are not yet backed by an atomic canonical store transition",
						);
					}
					try {
						const stored = await loadMemoryProposal(
							session,
							command.payload.proposalId,
						);
						if (
							!stored ||
							stored.proposal.status !== "pending" ||
							stored.proposal.memory.revision !==
								command.payload.expectedProposalRevision ||
							stored.proposal.memory.revision !==
								command.expectedDomainRevision
						) {
							return controlPlaneFailure(
								"expected_revision_conflict",
								"memory proposal revision is stale or absent",
								true,
							);
						}
						const receipt = command.payload.resolutionReceipt;
						if (
							receipt.approvalId !== stored.proposal.approvalId ||
							receipt.principalId !== command.principalId
						) {
							return controlPlaneFailure(
								"invalid_request",
								"memory resolution receipt does not bind the pending proposal",
							);
						}
						let proposalStatus: "approved" | "rejected";
						let domainRevision = stored.proposal.memory.revision;
						const traceId = createRuntimeId(
							"trace",
							`memory-resolve-${command.commandId.slice(-48)}`,
						);
						if (command.payload.action === "reject") {
							if (receipt.decision !== "denied") {
								return controlPlaneFailure(
									"invalid_request",
									"memory rejection requires a denied approval receipt",
								);
							}
							await session.memory.reject(stored.proposal, receipt, traceId);
							proposalStatus = "rejected";
						} else if (
							command.payload.action === "approve" &&
							(stored.proposal.diff.kind === "create" ||
								stored.proposal.diff.kind === "update")
						) {
							if (receipt.decision !== "allowed") {
								return controlPlaneFailure(
									"invalid_request",
									"memory approval requires an allowed approval receipt",
								);
							}
							const published = await session.memory.approve(
								stored.proposal,
								receipt,
								traceId,
							);
							domainRevision = published.revision;
							proposalStatus = "approved";
						} else if (
							command.payload.action === "revoke" &&
							stored.proposal.diff.kind === "delete"
						) {
							if (receipt.decision !== "allowed") {
								return controlPlaneFailure(
									"invalid_request",
									"memory revocation requires an allowed approval receipt",
								);
							}
							const revoked = await session.memory.revoke(
								stored.proposal,
								receipt,
								traceId,
							);
							domainRevision = revoked.revision;
							proposalStatus = "approved";
						} else {
							return controlPlaneFailure(
								"invalid_request",
								"memory resolution action does not match the proposal diff",
							);
						}
						return {
							ok: true,
							value: effect({
								type: command.type,
								sessionId: command.payload.sessionId,
								domainRevision,
								durableCursor: durableCursor(session),
								proposalId: stored.proposal.proposalId,
								proposalStatus,
							}),
						};
					} catch (error) {
						const code = error && typeof error === "object" && "code" in error
							? String(error.code)
							: undefined;
						if (code === "revision_conflict" || code === "not_found") {
							return controlPlaneFailure(
								"expected_revision_conflict",
								"memory proposal or record changed before resolution",
								true,
							);
						}
						if (code === "approval_required" || code === "invalid_record") {
							return controlPlaneFailure(
								"invalid_request",
								"memory resolution failed canonical approval validation",
							);
						}
						return controlPlaneFailure(
							"recovery_required",
							"memory resolution did not reach a confirmed durable boundary",
							false,
							{ errorName: error instanceof Error ? error.name : "UnknownError" },
							"uncertain",
						);
					}
				}
			}
			},
		);
	}

	public query(
		query: ControlPlaneV2PlanContextMemoryQuery,
		context: ControlPlaneRequestContext,
	): Promise<ControlPlaneResult<ControlPlaneV2PlanContextMemoryQueryResponse>> {
		return this.#sessions.withSession<ControlPlaneV2PlanContextMemoryQueryResponse>(
			query.payload.sessionId,
			async (session) => {
			if (!sameScope(session, query, context)) {
				return controlPlaneFailure(
					"unauthorized_peer",
					"specialty query scope does not match the active production session",
				);
			}
			try {
				switch (query.type) {
					case "plan:inspect": {
						const state = session.plan.snapshot();
						const result = {
							type: query.type,
							sessionId: query.payload.sessionId,
							state,
							projectionDigest: canonicalDigest(state),
						} as const;
						return {
							ok: true,
							value: {
								kind: "query_result",
								queryId: query.queryId,
								type: query.type,
								result,
							},
						};
					}
					case "context:inspect": {
						const projection = await session.compactionProjection.load();
						const result = {
							type: query.type,
							sessionId: query.payload.sessionId,
							contextReceipt: null,
							checkpoint: projection?.checkpoint ?? null,
							suppression: null,
							projectionDigest: canonicalDigest({
								contextReceipt: null,
								checkpoint: projection?.checkpoint ?? null,
								suppression: null,
							}),
						} as const;
						return {
							ok: true,
							value: {
								kind: "query_result",
								queryId: query.queryId,
								type: query.type,
								result,
							},
						};
					}
					case "memory:list": {
						const selected = new Set<MemoryStatus>(query.payload.statuses);
						const listed = await session.memoryStore.listRecords(session.memoryScopes);
						const filtered = listed.filter((record) => selected.has(record.status));
						const page = pageMemoryRecords(filtered, query.payload.cursor, query.payload.limit);
						const refs = page.records.map(memoryRef);
						const result = {
							type: query.type,
							sessionId: query.payload.sessionId,
							records: refs,
							nextCursor: page.nextCursor,
							projectionDigest: canonicalDigest({
								records: refs,
								nextCursor: page.nextCursor,
							}),
						} as const;
						return {
							ok: true,
							value: {
								kind: "query_result",
								queryId: query.queryId,
								type: query.type,
								result,
							},
						};
					}
					case "memory:inspect": {
						const record = await inspectMemory(session, query.payload.memoryId);
						const result = {
							type: query.type,
							sessionId: query.payload.sessionId,
							record,
							proposal: null,
							projectionDigest: canonicalDigest({ record, proposal: null }),
						} as const;
						return {
							ok: true,
							value: {
								kind: "query_result",
								queryId: query.queryId,
								type: query.type,
								result,
							},
						};
					}
				}
			} catch (error) {
				return controlPlaneFailure(
					"adapter_unavailable",
					"production specialty projection is unavailable",
					true,
					{ errorName: error instanceof Error ? error.name : "UnknownError" },
				);
			}
			},
		);
	}
}
