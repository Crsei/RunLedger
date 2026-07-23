/** 从 canonical v3 events 重建待外部服务复核的 Workspace/Approval receipts。 */

import { isApprovalReceiptRef, type ApprovalReceiptRef } from "../protocol/v3/capability.ts";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import { createSessionEventStreamRef, type RuntimeEventV3 } from "../protocol/v3/events.ts";
import {
	isRuntimeId,
	type ArtifactId,
	type AuthorityId,
	type CheckpointId,
	type CommandId,
	type SessionId,
	type TenantId,
} from "../protocol/v3/ids.ts";
import { isWorkspaceLeaseRef, type WorkspaceLeaseRef } from "../protocol/v3/workspace.ts";
import { verifyRuntimeEventChain } from "../session/chain-verification.ts";
import type { RuntimeEventStore } from "../session/event-store.ts";
import { readAllRuntimeEvents } from "../session/snapshot.ts";
import {
	LIFECYCLE_SCHEMA_VERSION,
	type ExternalReceiptReferenceSet,
	type LifecycleResult,
	type StartupExternalReferenceSourcePort,
} from "./recovery.ts";

export interface CanonicalReferenceScope {
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
}

export interface CanonicalGcScope {
	authorityId: AuthorityId;
	tenantId: TenantId;
}

export interface CanonicalSessionReference {
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
}

export interface CanonicalArtifactReference {
	authorityId: AuthorityId;
	tenantId: TenantId;
	artifactId: ArtifactId;
}

export type CanonicalReferenceSubject = CanonicalSessionReference | CanonicalArtifactReference;

/**
 * GC 元数据只能由 canonical source 构造。request 只携带 target id，不能覆盖这些字段。
 */
export interface CanonicalSessionGcState extends CanonicalSessionReference {
	expiresAt?: string;
	pins: readonly string[];
	writerState: "inactive" | "active" | "unknown";
	leaseState: "inactive" | "active" | "unknown";
	archiveState: "live" | "archived" | "unknown";
	tombstoneState: "live" | "tombstoned" | "unknown";
}

export interface CanonicalArtifactGcState extends CanonicalArtifactReference {
	expiresAt?: string;
	pins: readonly string[];
	readerState: "inactive" | "active" | "unknown";
	archiveState: "live" | "archived" | "unknown";
	tombstoneState: "live" | "tombstoned" | "unknown";
}

export interface CanonicalForkReference {
	parent: CanonicalSessionReference;
	descendant: CanonicalSessionReference;
}

export interface CanonicalAgentHandoffReference {
	handoffId: CommandId;
	sourceSession: CanonicalSessionReference;
	destinationSession?: CanonicalSessionReference;
	artifacts: readonly CanonicalArtifactReference[];
	confirmation: "confirmed" | "unconfirmed" | "unknown";
}

export interface CanonicalCheckpointReference {
	checkpointId: CheckpointId;
	session: CanonicalSessionReference;
	artifacts: readonly CanonicalArtifactReference[];
	completeness: "complete" | "unknown";
}

export interface CanonicalEpisodeReference {
	session: CanonicalSessionReference;
	manifestArtifact?: CanonicalArtifactReference;
	artifacts: readonly CanonicalArtifactReference[];
	manifestDigest: string;
	manifestState: "present" | "missing" | "unknown";
	sealState: "confirmed" | "unconfirmed" | "unknown";
	completeness: "complete" | "unknown";
}

export interface CanonicalArtifactTransitiveReference {
	source: CanonicalArtifactReference;
	target: CanonicalArtifactReference;
}

export interface CanonicalLegalHoldReference {
	holdId: string;
	subject: CanonicalReferenceSubject;
	status: "active" | "released" | "unknown";
}

export interface CanonicalReferenceGraphBody extends CanonicalGcScope {
	schemaVersion: typeof LIFECYCLE_SCHEMA_VERSION;
	revision: number;
	completeness: "complete" | "unknown";
	observedAt: string;
	sessions: readonly CanonicalSessionGcState[];
	artifacts: readonly CanonicalArtifactGcState[];
	forks: readonly CanonicalForkReference[];
	handoffs: readonly CanonicalAgentHandoffReference[];
	checkpoints: readonly CanonicalCheckpointReference[];
	episodes: readonly CanonicalEpisodeReference[];
	artifactReferences: readonly CanonicalArtifactTransitiveReference[];
	legalHolds: readonly CanonicalLegalHoldReference[];
}

export interface CanonicalReferenceGraphSnapshot extends CanonicalReferenceGraphBody {
	graphDigest: string;
}

/**
 * 实现方负责聚合所有 canonical stores；completeness 不能确定时必须返回 unknown。
 */
export interface CanonicalReferenceGraphPort {
	loadGraph(
		scope: CanonicalGcScope,
		signal?: AbortSignal,
	): Promise<LifecycleResult<CanonicalReferenceGraphSnapshot>>;
}

function failure(
	code: "invalid_request" | "integrity_failed" | "external_unavailable",
	message: string,
	retryable = false,
): LifecycleResult<never> {
	return { ok: false, error: { code, message, retryable } };
}

type ApprovalRequestPayload = Extract<RuntimeEventV3, { type: "permission.requested" }>["payload"];

interface CanonicalApprovalRequest {
	principalId: string;
	payload: ApprovalRequestPayload;
}

function sameApprovalRequest(
	event: ApprovalTerminalEvent,
	payload: {
		approvalId: string;
		requestId: string;
		requestDigest: string;
		ticketDigest: string;
	},
	request: CanonicalApprovalRequest,
): boolean {
	return (
		event.principalId === request.principalId &&
		payload.approvalId === request.payload.approvalId &&
		payload.requestId === request.payload.requestId &&
		payload.requestDigest === request.payload.requestDigest &&
		payload.ticketDigest === request.payload.ticketDigest &&
		event.payload.sessionId === request.payload.sessionId &&
		event.payload.runtimeId === request.payload.runtimeId &&
		event.payload.runtimeGeneration === request.payload.runtimeGeneration &&
		event.payload.turnId === request.payload.turnId &&
		event.payload.toolCallId === request.payload.toolCallId
	);
}

interface ApprovalEvidenceProjection {
	evidenceComplete: boolean;
	evidenceTruncated: boolean;
	originalInputDigest: string;
	originalArtifactId?: string;
	originalArtifactDigest?: string;
}

function approvalEvidence(request: ApprovalRequestPayload): ApprovalEvidenceProjection {
	return {
		evidenceComplete: request.evidenceComplete,
		evidenceTruncated: request.evidenceTruncated,
		originalInputDigest: request.originalInputDigest,
		...(request.originalArtifactId === undefined
			? {}
			: {
				originalArtifactId: request.originalArtifactId,
				originalArtifactDigest: request.originalArtifactDigest,
			}),
	};
}

type ApprovalTerminalEvent = Extract<
	RuntimeEventV3,
	{ type: "permission.decided" | "permission.expired" | "permission.revoked" }
>;

type ToolAuthorizedEvent = Extract<RuntimeEventV3, { type: "tool.authorized" }>;

interface CanonicalApprovalToolLifecycle {
	approvalId: string;
	authorizationDigest: string;
	started: boolean;
}

function isExactApprovalRevision(
	event: ApprovalTerminalEvent,
	previous: ApprovalReceiptRef | undefined,
): boolean {
	if (!previous) return event.type !== "permission.revoked" && event.payload.decisionRevision === 1;
	const duplicateDecision =
		(event.type === "permission.decided" && event.payload.decision === previous.decision) ||
		(event.type === "permission.expired" && previous.decision === "expired") ||
		(event.type === "permission.revoked" && previous.decision === "revoked");
	if (duplicateDecision) return event.payload.decisionRevision === previous.decisionRevision;
	if (
		previous.decision !== "allowed" ||
		(event.type !== "permission.expired" && event.type !== "permission.revoked")
	) return false;
	return (
		event.payload.decisionRevision === previous.decisionRevision + 1
	);
}

function toolAuthorizationMatchesApproval(
	event: ToolAuthorizedEvent,
	request: CanonicalApprovalRequest,
	receipt: ApprovalReceiptRef,
): boolean {
	const payload = event.payload;
	if (!("approvalReceiptId" in payload)) return false;
	return (
		receipt.decision === "allowed" &&
		event.principalId === request.principalId &&
		payload.approvalId === request.payload.approvalId &&
		payload.requestId === request.payload.requestId &&
		payload.sessionId === request.payload.sessionId &&
		payload.runtimeId === request.payload.runtimeId &&
		payload.runtimeGeneration === request.payload.runtimeGeneration &&
		payload.turnId === request.payload.turnId &&
		payload.toolCallId === request.payload.toolCallId &&
		payload.capability === request.payload.capability &&
		// tool.authorized 绑定的是完整 Gateway/authentication request；permission.requested
		// 绑定的是 Approval ticket.request。两个 canonical digest 属于不同域，不能互相覆盖或等同比较。
		payload.policyDigest === request.payload.policyDigest &&
		payload.workspaceEnvelopeDigest === request.payload.workspaceEnvelopeDigest &&
		payload.approvalReceiptId === receipt.receiptId &&
		payload.approvalReceiptDigest === receipt.receiptDigest &&
		payload.approvalDecisionRevision === receipt.decisionRevision
	);
}

function approvalReceipt(
	event: ApprovalTerminalEvent,
	request: CanonicalApprovalRequest | undefined,
	previous: ApprovalReceiptRef | undefined,
): ApprovalReceiptRef | undefined {
	if (!request || !sameApprovalRequest(event, event.payload, request)) return undefined;
	if (!isExactApprovalRevision(event, previous)) return undefined;
	const requestPayload = request.payload;
	let candidate: unknown;
	switch (event.type) {
		case "permission.decided": {
			const payload = event.payload;
			if (payload.originalInputDigest !== requestPayload.originalInputDigest) return undefined;
			candidate = {
				authorityId: event.authorityId,
				tenantId: event.tenantId,
				principalId: event.principalId,
				receiptId: payload.receiptId,
				approvalId: payload.approvalId,
				requestId: payload.requestId,
				requestDigest: payload.requestDigest,
				ticketDigest: payload.ticketDigest,
				decision: payload.decision,
				decisionRevision: payload.decisionRevision,
				decidedBy: payload.decidedBy,
				decidedAt: payload.decidedAt,
				receiptDigest: payload.receiptDigest,
				evidenceComplete: payload.evidenceComplete,
				evidenceTruncated: payload.evidenceTruncated,
				originalInputDigest: payload.originalInputDigest,
				...(requestPayload.originalArtifactId === undefined
					? {}
					: {
						originalArtifactId: requestPayload.originalArtifactId,
						originalArtifactDigest: requestPayload.originalArtifactDigest,
					}),
				...(payload.expiresAt === undefined ? {} : { expiresAt: payload.expiresAt }),
			};
			break;
		}
		case "permission.expired": {
			if (previous && previous.decision !== "allowed" && previous.decision !== "expired") return undefined;
			const evidence = previous ?? approvalEvidence(requestPayload);
			candidate = {
				authorityId: event.authorityId,
				tenantId: event.tenantId,
				principalId: event.principalId,
				receiptId: event.payload.receiptId,
				approvalId: event.payload.approvalId,
				requestId: event.payload.requestId,
				requestDigest: event.payload.requestDigest,
				ticketDigest: event.payload.ticketDigest,
				decision: "expired",
				decisionRevision: event.payload.decisionRevision,
				decidedBy: event.payload.decidedBy,
				decidedAt: event.payload.expiredAt,
				// expiredAt 是实际持久化 terminal 的时刻；receipt 仍绑定 request 的原始 expiry。
				expiresAt: requestPayload.expiresAt,
				receiptDigest: event.payload.receiptDigest,
				evidenceComplete: evidence.evidenceComplete,
				evidenceTruncated: evidence.evidenceTruncated,
				originalInputDigest: evidence.originalInputDigest,
				...(evidence.originalArtifactId === undefined
					? {}
					: {
						originalArtifactId: evidence.originalArtifactId,
						originalArtifactDigest: evidence.originalArtifactDigest,
					}),
			};
			break;
		}
		case "permission.revoked": {
			if (!previous || (previous.decision !== "allowed" && previous.decision !== "revoked")) return undefined;
			candidate = {
				authorityId: event.authorityId,
				tenantId: event.tenantId,
				principalId: event.principalId,
				receiptId: event.payload.receiptId,
				approvalId: event.payload.approvalId,
				requestId: event.payload.requestId,
				requestDigest: event.payload.requestDigest,
				ticketDigest: event.payload.ticketDigest,
				decision: "revoked",
				decisionRevision: event.payload.decisionRevision,
				decidedBy: event.payload.decidedBy,
				decidedAt: event.payload.revokedAt,
				revokedAt: event.payload.revokedAt,
				receiptDigest: event.payload.receiptDigest,
				evidenceComplete: previous.evidenceComplete,
				evidenceTruncated: previous.evidenceTruncated,
				originalInputDigest: previous.originalInputDigest,
				...(previous.expiresAt === undefined ? {} : { expiresAt: previous.expiresAt }),
				...(previous.originalArtifactId === undefined
					? {}
					: {
						originalArtifactId: previous.originalArtifactId,
						originalArtifactDigest: previous.originalArtifactDigest,
					}),
			};
			break;
		}
		default:
			return undefined;
	}
	if (!isApprovalReceiptRef(candidate)) return undefined;
	if (!previous) return candidate;
	const isDuplicate =
		event.type === "permission.decided" ||
		(event.type === "permission.expired" && previous?.decision === "expired") ||
		(event.type === "permission.revoked" && previous?.decision === "revoked");
	if (!isDuplicate) return candidate;
	return canonicalDigest(previous) === canonicalDigest(candidate) ? previous : undefined;
}

export function projectExternalReceiptReferences(
	events: readonly RuntimeEventV3[],
	scope: CanonicalReferenceScope,
): LifecycleResult<ExternalReceiptReferenceSet> {
	const verification = verifyRuntimeEventChain(events, {
		authorityId: scope.authorityId,
		tenantId: scope.tenantId,
		stream: createSessionEventStreamRef(scope, scope.sessionId),
	});
	if (verification.integrity !== "valid") {
		return failure("integrity_failed", "external receipt references require a valid canonical event chain");
	}
	const workspaceLeases = new Map<string, WorkspaceLeaseRef>();
	const approvalRequests = new Map<string, CanonicalApprovalRequest>();
	const approvalReceipts = new Map<string, ApprovalReceiptRef>();
	const activeApprovalDecisions = new Map<string, ApprovalReceiptRef>();
	const approvalToolLifecycles = new Map<string, CanonicalApprovalToolLifecycle>();
	const consumedApprovals = new Set<string>();
	for (const event of events) {
		switch (event.type) {
			case "workspace.bound":
			case "lease.acquired":
			case "lease.taken_over":
				if (!isWorkspaceLeaseRef(event.payload.lease)) {
					return failure("integrity_failed", "canonical workspace lease reference is invalid");
				}
				workspaceLeases.set(event.payload.lease.leaseId, event.payload.lease);
				break;
			case "workspace.released":
				workspaceLeases.delete(event.payload.leaseId);
				break;
			case "lease.released":
				workspaceLeases.delete(event.payload.lease.leaseId);
				break;
			case "permission.requested": {
				if (event.payload.sessionId !== scope.sessionId) {
					return failure("integrity_failed", "canonical approval request session binding is invalid");
				}
				const current = {
					principalId: event.principalId,
					payload: event.payload,
				};
				const previous = approvalRequests.get(event.payload.approvalId);
				if (
					previous &&
					(previous.principalId !== current.principalId ||
						canonicalDigest(previous.payload) !== canonicalDigest(current.payload))
				) {
					return failure("integrity_failed", "canonical approval request duplicate is inconsistent");
				}
				if (!previous) approvalRequests.set(event.payload.approvalId, current);
				break;
			}
			case "permission.decided":
			case "permission.expired":
			case "permission.revoked": {
				const receipt = approvalReceipt(
					event,
					approvalRequests.get(event.payload.approvalId),
					approvalReceipts.get(event.payload.approvalId),
				);
				if (!receipt) return failure("integrity_failed", "canonical approval receipt reference is invalid");
				approvalReceipts.set(receipt.approvalId, receipt);
				if (
					!consumedApprovals.has(receipt.approvalId) &&
					(receipt.decision === "allowed" || receipt.decision === "expired" || receipt.decision === "revoked")
				) activeApprovalDecisions.set(receipt.approvalId, receipt);
				else activeApprovalDecisions.delete(receipt.approvalId);
				break;
			}
			case "tool.authorized": {
				const request = approvalRequests.get(event.payload.approvalId);
				const receipt = approvalReceipts.get(event.payload.approvalId);
				if (!request && !receipt) {
					if ("approvalReceiptId" in event.payload) {
						return failure("integrity_failed", "canonical tool authorization names an approval receipt without its request lifecycle");
					}
					break;
				}
				if (!request || !receipt || !toolAuthorizationMatchesApproval(event, request, receipt)) {
					return failure("integrity_failed", "canonical tool authorization is not bound to the active approval receipt");
				}
				const authorizationDigest = canonicalDigest(event.payload);
				const previous = approvalToolLifecycles.get(event.payload.toolCallId);
				if (
					previous &&
					(previous.approvalId !== event.payload.approvalId || previous.authorizationDigest !== authorizationDigest)
				) {
					return failure("integrity_failed", "canonical tool authorization lifecycle is inconsistent");
				}
				if (!previous) {
					approvalToolLifecycles.set(event.payload.toolCallId, {
						approvalId: event.payload.approvalId,
						authorizationDigest,
						started: false,
					});
				}
				break;
			}
			case "tool.started": {
				const lifecycle = approvalToolLifecycles.get(event.payload.toolCallId);
				if (lifecycle) lifecycle.started = true;
				break;
			}
			case "tool.finished":
			case "tool.failed":
			case "tool.interrupted": {
				const lifecycle = approvalToolLifecycles.get(event.payload.toolCallId);
				if (!lifecycle?.started) break;
				const request = approvalRequests.get(lifecycle.approvalId);
				if (request?.payload.scope === "once") {
					consumedApprovals.add(lifecycle.approvalId);
					activeApprovalDecisions.delete(lifecycle.approvalId);
				}
				approvalToolLifecycles.delete(event.payload.toolCallId);
				break;
			}
			default:
				break;
		}
	}
	return {
		ok: true,
		value: {
			schemaVersion: LIFECYCLE_SCHEMA_VERSION,
			...scope,
			completeness: "complete",
			workspaceLeases: [...workspaceLeases.values()].sort((left, right) => left.leaseId.localeCompare(right.leaseId)),
			approvalDecisions: [...activeApprovalDecisions.values()].sort((left, right) =>
				left.approvalId.localeCompare(right.approvalId)
			),
		},
	};
}

export class CanonicalEventExternalReferenceSource implements StartupExternalReferenceSourcePort {
	readonly #store: RuntimeEventStore;
	readonly #scope: CanonicalReferenceScope;

	public constructor(store: RuntimeEventStore, scope: CanonicalReferenceScope) {
		this.#store = store;
		this.#scope = scope;
	}

	public async loadReferences(
		scope: CanonicalReferenceScope,
		signal?: AbortSignal,
	): Promise<LifecycleResult<ExternalReceiptReferenceSet>> {
		if (
			scope.authorityId !== this.#scope.authorityId ||
			scope.tenantId !== this.#scope.tenantId ||
			scope.sessionId !== this.#scope.sessionId
		) return failure("invalid_request", "canonical reference source scope mismatch");
		if (signal?.aborted) return failure("external_unavailable", "canonical reference scan was aborted", true);
		const replay = await readAllRuntimeEvents(this.#store);
		if (!replay.ok) return failure("integrity_failed", "canonical reference replay failed");
		return projectExternalReceiptReferences(replay.value, this.#scope);
	}
}

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const MAX_CANONICAL_REFERENCES = 100_000;

function isTimestamp(value: unknown): value is string {
	return typeof value === "string" && TIMESTAMP_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function isOptionalTimestamp(value: unknown): value is string | undefined {
	return value === undefined || isTimestamp(value);
}

function isStringList(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.length <= MAX_CANONICAL_REFERENCES &&
		value.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 128);
}

function hasExactKeys(value: object, required: readonly string[], optional: readonly string[] = []): boolean {
	const allowed = new Set([...required, ...optional]);
	const keys = Object.keys(value);
	return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function isSessionReference(value: unknown): value is CanonicalSessionReference {
	if (typeof value !== "object" || value === null) return false;
	if (!hasExactKeys(value, ["authorityId", "tenantId", "sessionId"])) return false;
	const candidate = value as Partial<CanonicalSessionReference>;
	return isRuntimeId(candidate.authorityId, "authority") && isRuntimeId(candidate.tenantId, "tenant") &&
		isRuntimeId(candidate.sessionId, "session");
}

function isArtifactReference(value: unknown): value is CanonicalArtifactReference {
	if (typeof value !== "object" || value === null) return false;
	if (!hasExactKeys(value, ["authorityId", "tenantId", "artifactId"])) return false;
	const candidate = value as Partial<CanonicalArtifactReference>;
	return isRuntimeId(candidate.authorityId, "authority") && isRuntimeId(candidate.tenantId, "tenant") &&
		isRuntimeId(candidate.artifactId, "artifact");
}

function isReferenceSubject(value: unknown): value is CanonicalReferenceSubject {
	return isSessionReference(value) || isArtifactReference(value);
}

function inScope(reference: CanonicalSessionReference | CanonicalArtifactReference, scope: CanonicalGcScope): boolean {
	return reference.authorityId === scope.authorityId && reference.tenantId === scope.tenantId;
}

function sessionKey(reference: CanonicalSessionReference): string {
	return `${reference.authorityId}\u0000${reference.tenantId}\u0000${reference.sessionId}`;
}

function artifactKey(reference: CanonicalArtifactReference): string {
	return `${reference.authorityId}\u0000${reference.tenantId}\u0000${reference.artifactId}`;
}

function isSessionState(value: unknown, scope: CanonicalGcScope): value is CanonicalSessionGcState {
	if (typeof value !== "object" || value === null || !inScope(value as CanonicalSessionReference, scope)) return false;
	if (!hasExactKeys(
		value,
		["authorityId", "tenantId", "sessionId", "pins", "writerState", "leaseState", "archiveState", "tombstoneState"],
		["expiresAt"],
	)) return false;
	const candidate = value as Partial<CanonicalSessionGcState>;
	return isRuntimeId(candidate.authorityId, "authority") && isRuntimeId(candidate.tenantId, "tenant") &&
		isRuntimeId(candidate.sessionId, "session") && isOptionalTimestamp(candidate.expiresAt) && isStringList(candidate.pins) &&
		(candidate.writerState === "inactive" || candidate.writerState === "active" || candidate.writerState === "unknown") &&
		(candidate.leaseState === "inactive" || candidate.leaseState === "active" || candidate.leaseState === "unknown") &&
		(candidate.archiveState === "live" || candidate.archiveState === "archived" || candidate.archiveState === "unknown") &&
		(candidate.tombstoneState === "live" || candidate.tombstoneState === "tombstoned" ||
			candidate.tombstoneState === "unknown") &&
		(candidate.tombstoneState !== "tombstoned" || candidate.archiveState === "archived");
}

function isArtifactState(value: unknown, scope: CanonicalGcScope): value is CanonicalArtifactGcState {
	if (typeof value !== "object" || value === null || !inScope(value as CanonicalArtifactReference, scope)) return false;
	if (!hasExactKeys(
		value,
		["authorityId", "tenantId", "artifactId", "pins", "readerState", "archiveState", "tombstoneState"],
		["expiresAt"],
	)) return false;
	const candidate = value as Partial<CanonicalArtifactGcState>;
	return isRuntimeId(candidate.authorityId, "authority") && isRuntimeId(candidate.tenantId, "tenant") &&
		isRuntimeId(candidate.artifactId, "artifact") && isOptionalTimestamp(candidate.expiresAt) && isStringList(candidate.pins) &&
		(candidate.readerState === "inactive" || candidate.readerState === "active" || candidate.readerState === "unknown") &&
		(candidate.archiveState === "live" || candidate.archiveState === "archived" || candidate.archiveState === "unknown") &&
		(candidate.tombstoneState === "live" || candidate.tombstoneState === "tombstoned" || candidate.tombstoneState === "unknown") &&
		(candidate.tombstoneState !== "tombstoned" || candidate.archiveState === "archived");
}

function graphBody(snapshot: CanonicalReferenceGraphSnapshot): CanonicalReferenceGraphBody {
	const { graphDigest: _graphDigest, ...body } = snapshot;
	return body;
}

function forkGraphIsAcyclic(snapshot: CanonicalReferenceGraphSnapshot): boolean {
	const parentByDescendant = new Map<string, string>();
	for (const reference of snapshot.forks) {
		const parent = sessionKey(reference.parent);
		const descendant = sessionKey(reference.descendant);
		if (parentByDescendant.has(descendant)) return false;
		parentByDescendant.set(descendant, parent);
	}
	for (const start of parentByDescendant.keys()) {
		const visited = new Set<string>();
		let cursor: string | undefined = start;
		while (cursor !== undefined) {
			if (visited.has(cursor)) return false;
			visited.add(cursor);
			cursor = parentByDescendant.get(cursor);
		}
	}
	return true;
}

function referencesAreWellFormed(snapshot: CanonicalReferenceGraphSnapshot): boolean {
	if (new Set(snapshot.handoffs.map((reference) => reference.handoffId)).size !== snapshot.handoffs.length ||
		new Set(snapshot.checkpoints.map((reference) => reference.checkpointId)).size !== snapshot.checkpoints.length ||
		new Set(snapshot.legalHolds.map((reference) => reference.holdId)).size !== snapshot.legalHolds.length) return false;
	if (!snapshot.forks.every((reference) =>
		hasExactKeys(reference, ["parent", "descendant"]) &&
		isSessionReference(reference.parent) && isSessionReference(reference.descendant) &&
		inScope(reference.parent, snapshot) && inScope(reference.descendant, snapshot) &&
		reference.parent.sessionId !== reference.descendant.sessionId,
	)) return false;
	if (!snapshot.handoffs.every((reference) =>
		hasExactKeys(reference, ["handoffId", "sourceSession", "artifacts", "confirmation"], ["destinationSession"]) &&
		isRuntimeId(reference.handoffId, "command") && isSessionReference(reference.sourceSession) &&
		inScope(reference.sourceSession, snapshot) &&
		(reference.destinationSession === undefined || isSessionReference(reference.destinationSession)) &&
		(reference.destinationSession === undefined || inScope(reference.destinationSession, snapshot)) &&
		Array.isArray(reference.artifacts) && reference.artifacts.length <= MAX_CANONICAL_REFERENCES &&
		reference.artifacts.every((artifact) => isArtifactReference(artifact) && inScope(artifact, snapshot)) &&
		(reference.confirmation === "confirmed" || reference.confirmation === "unconfirmed" || reference.confirmation === "unknown"),
	)) return false;
	if (!snapshot.checkpoints.every((reference) =>
		hasExactKeys(reference, ["checkpointId", "session", "artifacts", "completeness"]) &&
		isRuntimeId(reference.checkpointId, "checkpoint") && isSessionReference(reference.session) &&
		inScope(reference.session, snapshot) &&
		Array.isArray(reference.artifacts) && reference.artifacts.length <= MAX_CANONICAL_REFERENCES &&
		reference.artifacts.every((artifact) => isArtifactReference(artifact) && inScope(artifact, snapshot)) &&
		(reference.completeness === "complete" || reference.completeness === "unknown"),
	)) return false;
	if (!snapshot.episodes.every((reference) =>
		hasExactKeys(
			reference,
			["session", "artifacts", "manifestDigest", "manifestState", "sealState", "completeness"],
			["manifestArtifact"],
		) &&
		isSessionReference(reference.session) &&
		inScope(reference.session, snapshot) &&
		(reference.manifestArtifact === undefined || isArtifactReference(reference.manifestArtifact)) &&
		(reference.manifestArtifact === undefined || inScope(reference.manifestArtifact, snapshot)) &&
		Array.isArray(reference.artifacts) && reference.artifacts.length <= MAX_CANONICAL_REFERENCES &&
		reference.artifacts.every((artifact) => isArtifactReference(artifact) && inScope(artifact, snapshot)) &&
		DIGEST_PATTERN.test(reference.manifestDigest) &&
		(reference.manifestState === "present" || reference.manifestState === "missing" || reference.manifestState === "unknown") &&
		(reference.sealState === "confirmed" || reference.sealState === "unconfirmed" || reference.sealState === "unknown") &&
		(reference.completeness === "complete" || reference.completeness === "unknown"),
	)) return false;
	if (!snapshot.artifactReferences.every((reference) =>
		hasExactKeys(reference, ["source", "target"]) &&
		isArtifactReference(reference.source) && isArtifactReference(reference.target) &&
		inScope(reference.source, snapshot) && inScope(reference.target, snapshot) &&
		reference.source.artifactId !== reference.target.artifactId,
	)) return false;
	return forkGraphIsAcyclic(snapshot) && snapshot.legalHolds.every((hold) =>
		hasExactKeys(hold, ["holdId", "subject", "status"]) &&
		typeof hold.holdId === "string" && hold.holdId.length > 0 && hold.holdId.length <= 128 &&
		isReferenceSubject(hold.subject) && inScope(hold.subject, snapshot) &&
		(hold.status === "active" || hold.status === "released" || hold.status === "unknown"),
	);
}

function completeGraphReferencesResolve(snapshot: CanonicalReferenceGraphSnapshot): boolean {
	if (snapshot.completeness !== "complete") return true;
	const sessions = new Set(snapshot.sessions.map(sessionKey));
	const artifacts = new Set(snapshot.artifacts.map(artifactKey));
	const sessionResolves = (reference: CanonicalSessionReference): boolean =>
		!inScope(reference, snapshot) || sessions.has(sessionKey(reference));
	const artifactResolves = (reference: CanonicalArtifactReference): boolean =>
		!inScope(reference, snapshot) || artifacts.has(artifactKey(reference));
	return snapshot.forks.every((reference) => sessionResolves(reference.parent) && sessionResolves(reference.descendant)) &&
		snapshot.handoffs.every((reference) =>
			sessionResolves(reference.sourceSession) &&
			(reference.destinationSession === undefined || sessionResolves(reference.destinationSession)) &&
			reference.artifacts.every(artifactResolves),
		) &&
		snapshot.checkpoints.every((reference) => sessionResolves(reference.session) && reference.artifacts.every(artifactResolves)) &&
		snapshot.episodes.every((reference) =>
			sessionResolves(reference.session) &&
			(reference.manifestArtifact === undefined || artifactResolves(reference.manifestArtifact)) &&
			reference.artifacts.every(artifactResolves),
		) &&
		snapshot.artifactReferences.every((reference) => artifactResolves(reference.source) && artifactResolves(reference.target)) &&
		snapshot.legalHolds.every((hold) =>
			"sessionId" in hold.subject ? sessionResolves(hold.subject) : artifactResolves(hold.subject),
		);
}

export function isCanonicalReferenceGraphSnapshot(value: unknown): value is CanonicalReferenceGraphSnapshot {
	if (typeof value !== "object" || value === null) return false;
	if (!hasExactKeys(value, [
		"schemaVersion", "authorityId", "tenantId", "revision", "completeness", "observedAt", "sessions",
		"artifacts", "forks", "handoffs", "checkpoints", "episodes", "artifactReferences", "legalHolds", "graphDigest",
	])) return false;
	const snapshot = value as Partial<CanonicalReferenceGraphSnapshot>;
	if (
		snapshot.schemaVersion !== LIFECYCLE_SCHEMA_VERSION ||
		!isRuntimeId(snapshot.authorityId, "authority") || !isRuntimeId(snapshot.tenantId, "tenant") ||
		!Number.isSafeInteger(snapshot.revision) || (snapshot.revision as number) < 0 ||
		(snapshot.completeness !== "complete" && snapshot.completeness !== "unknown") ||
		!isTimestamp(snapshot.observedAt) || typeof snapshot.graphDigest !== "string" || !DIGEST_PATTERN.test(snapshot.graphDigest) ||
		!Array.isArray(snapshot.sessions) || snapshot.sessions.length > MAX_CANONICAL_REFERENCES ||
		!Array.isArray(snapshot.artifacts) || snapshot.artifacts.length > MAX_CANONICAL_REFERENCES ||
		!Array.isArray(snapshot.forks) || snapshot.forks.length > MAX_CANONICAL_REFERENCES ||
		!Array.isArray(snapshot.handoffs) || snapshot.handoffs.length > MAX_CANONICAL_REFERENCES ||
		!Array.isArray(snapshot.checkpoints) || snapshot.checkpoints.length > MAX_CANONICAL_REFERENCES ||
		!Array.isArray(snapshot.episodes) || snapshot.episodes.length > MAX_CANONICAL_REFERENCES ||
		!Array.isArray(snapshot.artifactReferences) || snapshot.artifactReferences.length > MAX_CANONICAL_REFERENCES ||
		!Array.isArray(snapshot.legalHolds) || snapshot.legalHolds.length > MAX_CANONICAL_REFERENCES
	) return false;
	const typed = snapshot as CanonicalReferenceGraphSnapshot;
	if (!typed.sessions.every((entry) => isSessionState(entry, typed)) ||
		!typed.artifacts.every((entry) => isArtifactState(entry, typed)) || !referencesAreWellFormed(typed)) return false;
	if (new Set(typed.sessions.map((entry) => entry.sessionId)).size !== typed.sessions.length ||
		new Set(typed.artifacts.map((entry) => entry.artifactId)).size !== typed.artifacts.length ||
		!completeGraphReferencesResolve(typed)) return false;
	try {
		return canonicalDigest(graphBody(typed)) === typed.graphDigest;
	} catch {
		return false;
	}
}

export function createCanonicalReferenceGraphSnapshot(
	body: CanonicalReferenceGraphBody,
): LifecycleResult<CanonicalReferenceGraphSnapshot> {
	let graphDigest: string;
	try {
		graphDigest = canonicalDigest(body);
	} catch {
		return failure("invalid_request", "canonical reference graph is not serializable");
	}
	const snapshot: CanonicalReferenceGraphSnapshot = { ...body, graphDigest };
	return isCanonicalReferenceGraphSnapshot(snapshot)
		? { ok: true, value: snapshot }
		: failure("invalid_request", "canonical reference graph is invalid");
}
