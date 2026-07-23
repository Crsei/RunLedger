/** Tenant-scoped reference-aware GC；外部 workspace/approval/process 仍只交换 receipt。 */

import { Type, type TSchema } from "typebox";
import { Check } from "typebox/value";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import {
	createRuntimeId,
	isRuntimeId,
	type ArtifactId,
	type AuthorityId,
	type CommandId,
	type ReceiptId,
	type SessionId,
	type TenantId,
} from "../protocol/v3/ids.ts";
import {
	isCanonicalReferenceGraphSnapshot,
	type CanonicalArtifactGcState,
	type CanonicalArtifactReference,
	type CanonicalGcScope,
	type CanonicalReferenceGraphPort,
	type CanonicalReferenceGraphSnapshot,
	type CanonicalSessionGcState,
	type CanonicalSessionReference,
} from "./canonical-references.ts";
import { LIFECYCLE_SCHEMA_VERSION, type LifecycleResult } from "./recovery.ts";

export type RuntimeGcTargetKind = "session_ref" | "artifact_ref";
export type RuntimeGcOperation = "archive" | "tombstone" | "purge";

export type RuntimeGcTargetSelector =
	| { kind: "session_ref"; sessionId: SessionId }
	| { kind: "artifact_ref"; artifactId: ArtifactId };

/** request 只允许选择 canonical target，不能提交 referenceCount/pin/hold/activity 等授权事实。 */
export interface RuntimeGcRequest {
	schemaVersion: typeof LIFECYCLE_SCHEMA_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	requestId: CommandId;
	dryRun: boolean;
	operation: RuntimeGcOperation;
	requestedAt: string;
	expectedGraphRevision: number;
	expectedGraphDigest: string;
	targets: readonly RuntimeGcTargetSelector[];
}

/** 兼容既有 storage adapter 的最终删除 receipt；新协调器不会绕过 applyGcMutation 使用裸删除。 */
export interface RuntimeGcMutationReceipt {
	receiptId: ReceiptId;
	targetKind: RuntimeGcTargetKind;
	targetId: string;
	mutationDigest: string;
	deletedAt: string;
}

export interface RuntimeGcMutationRequest {
	schemaVersion: typeof LIFECYCLE_SCHEMA_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	requestId: CommandId;
	operation: RuntimeGcOperation;
	targetKind: RuntimeGcTargetKind;
	targetId: string;
	graphRevision: number;
	graphDigest: string;
	idempotencyKey: string;
	requestedAt: string;
}

export interface RuntimeGcTransitionReceiptBody extends RuntimeGcMutationRequest {
	committedAt: string;
}

export interface RuntimeGcTransitionReceipt extends RuntimeGcTransitionReceiptBody {
	receiptId: ReceiptId;
	mutationDigest: string;
}

export interface RuntimeGcMutationPort {
	/** @deprecated 仅保留旧 adapter 编译兼容；reference-aware coordinator 不调用该入口。 */
	deleteSessionRef(
		authorityId: AuthorityId,
		tenantId: TenantId,
		sessionId: SessionId,
	): Promise<LifecycleResult<RuntimeGcMutationReceipt>>;
	/** @deprecated 仅保留旧 adapter 编译兼容；reference-aware coordinator 不调用该入口。 */
	deleteArtifactRef(
		authorityId: AuthorityId,
		tenantId: TenantId,
		artifactId: ArtifactId,
	): Promise<LifecycleResult<RuntimeGcMutationReceipt>>;
	/** 必须按 idempotencyKey durable 去重，并以同一 receipt 回放已提交结果。 */
	applyGcMutation?(
		request: RuntimeGcMutationRequest,
		signal?: AbortSignal,
	): Promise<LifecycleResult<RuntimeGcTransitionReceipt>>;
	/** effect ack 丢失时按完整 request/idempotencyKey read-back，不允许重新执行。 */
	readGcMutation?(
		request: RuntimeGcMutationRequest,
		signal?: AbortSignal,
	): Promise<LifecycleResult<RuntimeGcTransitionReceipt | undefined>>;
}

export interface RuntimeGcCommandClaim {
	schemaVersion: typeof LIFECYCLE_SCHEMA_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	requestId: CommandId;
	requestDigest: string;
	graphRevision: number;
	graphDigest: string;
}

export type RuntimeGcCommandClaimResult =
	| { state: "claimed" }
	| { state: "completed"; receipt: RuntimeGcReceipt };

/** Journal 必须 durable；crash 后同 requestId 能恢复 claim 或返回原 terminal receipt。 */
export interface RuntimeGcJournalPort {
	claim(
		claim: RuntimeGcCommandClaim,
		signal?: AbortSignal,
	): Promise<LifecycleResult<RuntimeGcCommandClaimResult>>;
	complete(
		claim: RuntimeGcCommandClaim,
		receipt: RuntimeGcReceipt,
		signal?: AbortSignal,
	): Promise<LifecycleResult<RuntimeGcReceipt>>;
	/** 每个外部 mutation 前必须先 durable 记录完整 intent。 */
	recordMutationIntent?(
		claim: RuntimeGcCommandClaim,
		mutation: RuntimeGcMutationRequest,
		signal?: AbortSignal,
	): Promise<LifecycleResult<RuntimeGcMutationRequest>>;
}

export type RuntimeGcReceiptReason =
	| "eligible"
	| "not_expired"
	| "pinned"
	| "legal_hold"
	| "active_writer"
	| "active_lease"
	| "active_reader"
	| "unknown_activity"
	| "graph_incomplete"
	| "target_missing"
	| "descendant"
	| "unconfirmed_handoff"
	| "checkpoint_reference"
	| "episode_reference"
	| "artifact_reference"
	| "archive_required"
	| "tombstone_required"
	| "already_archived"
	| "already_tombstoned";

export type RuntimeGcReceiptAction =
	| "retained"
	| "would_archive"
	| "would_tombstone"
	| "would_purge"
	| "archived"
	| "tombstoned"
	| "purged";

export interface RuntimeGcReceiptEntry {
	targetKind: RuntimeGcTargetKind;
	targetId: string;
	action: RuntimeGcReceiptAction;
	reason: RuntimeGcReceiptReason;
	mutationReceiptId?: ReceiptId;
	mutationDigest?: string;
}

export interface RuntimeGcReceiptBody {
	schemaVersion: typeof LIFECYCLE_SCHEMA_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	requestId: CommandId;
	requestDigest: string;
	dryRun: boolean;
	operation: RuntimeGcOperation;
	requestedAt: string;
	completedAt: string;
	graphRevision: number;
	graphDigest: string;
	entries: readonly RuntimeGcReceiptEntry[];
}

export interface RuntimeGcReceipt extends RuntimeGcReceiptBody {
	receiptId: ReceiptId;
	receiptDigest: string;
}

export interface ExternalCleanupReceiptRef {
	schemaVersion: typeof LIFECYCLE_SCHEMA_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	receiptId: ReceiptId;
	kind: "workspace" | "approval" | "orphan_process";
	subjectId: string;
	outcome: "cleaned" | "retained" | "unavailable";
	cleanedAt: string;
	receiptDigest: string;
}

const runtimeId = (kind: string) => Type.String({ pattern: `^${kind}_[A-Za-z0-9][A-Za-z0-9._~-]*$`, maxLength: 128 });
const digest = Type.String({ pattern: "^[a-f0-9]{64}$", maxLength: 64 });
const timestamp = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$", maxLength: 24 });
const revision = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const exact = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const operation = Type.Union([Type.Literal("archive"), Type.Literal("tombstone"), Type.Literal("purge")]);
const targetKind = Type.Union([Type.Literal("session_ref"), Type.Literal("artifact_ref")]);

export const RuntimeGcTargetSchema = Type.Union([
	exact({ kind: Type.Literal("session_ref"), sessionId: runtimeId("session") }),
	exact({ kind: Type.Literal("artifact_ref"), artifactId: runtimeId("artifact") }),
]);

export const RuntimeGcRequestSchema = exact({
	schemaVersion: Type.Literal(LIFECYCLE_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	requestId: runtimeId("command"),
	dryRun: Type.Boolean(),
	operation,
	requestedAt: timestamp,
	expectedGraphRevision: revision,
	expectedGraphDigest: digest,
	targets: Type.Array(RuntimeGcTargetSchema, { maxItems: 100_000 }),
});

export const RuntimeGcMutationRequestSchema = exact({
	schemaVersion: Type.Literal(LIFECYCLE_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	requestId: runtimeId("command"),
	operation,
	targetKind,
	targetId: Type.String({ minLength: 1, maxLength: 128 }),
	graphRevision: revision,
	graphDigest: digest,
	idempotencyKey: digest,
	requestedAt: timestamp,
});

export function isRuntimeGcMutationRequest(value: unknown): value is RuntimeGcMutationRequest {
	return Check(RuntimeGcMutationRequestSchema, value);
}

export const RuntimeGcTransitionReceiptSchema = exact({
	...RuntimeGcMutationRequestSchema.properties,
	committedAt: timestamp,
	receiptId: runtimeId("receipt"),
	mutationDigest: digest,
});

const receiptReason = Type.Union([
	Type.Literal("eligible"), Type.Literal("not_expired"), Type.Literal("pinned"), Type.Literal("legal_hold"),
	Type.Literal("active_writer"), Type.Literal("active_lease"), Type.Literal("active_reader"),
	Type.Literal("unknown_activity"), Type.Literal("graph_incomplete"), Type.Literal("target_missing"),
	Type.Literal("descendant"), Type.Literal("unconfirmed_handoff"), Type.Literal("checkpoint_reference"),
	Type.Literal("episode_reference"), Type.Literal("artifact_reference"), Type.Literal("archive_required"),
	Type.Literal("tombstone_required"), Type.Literal("already_archived"), Type.Literal("already_tombstoned"),
]);
const receiptAction = Type.Union([
	Type.Literal("retained"), Type.Literal("would_archive"), Type.Literal("would_tombstone"),
	Type.Literal("would_purge"), Type.Literal("archived"), Type.Literal("tombstoned"), Type.Literal("purged"),
]);
const receiptEntry = exact({
	targetKind,
	targetId: Type.String({ minLength: 1, maxLength: 128 }),
	action: receiptAction,
	reason: receiptReason,
	mutationReceiptId: Type.Optional(runtimeId("receipt")),
	mutationDigest: Type.Optional(digest),
});

export const RuntimeGcReceiptSchema = exact({
	schemaVersion: Type.Literal(LIFECYCLE_SCHEMA_VERSION),
	authorityId: runtimeId("authority"),
	tenantId: runtimeId("tenant"),
	requestId: runtimeId("command"),
	requestDigest: digest,
	dryRun: Type.Boolean(),
	operation,
	requestedAt: timestamp,
	completedAt: timestamp,
	graphRevision: revision,
	graphDigest: digest,
	entries: Type.Array(receiptEntry, { maxItems: 100_000 }),
	receiptId: runtimeId("receipt"),
	receiptDigest: digest,
});

export const ExternalCleanupReceiptRefSchema = exact({
	schemaVersion: Type.Literal(LIFECYCLE_SCHEMA_VERSION), authorityId: runtimeId("authority"), tenantId: runtimeId("tenant"), receiptId: runtimeId("receipt"),
	kind: Type.Union([Type.Literal("workspace"), Type.Literal("approval"), Type.Literal("orphan_process")]),
	subjectId: Type.String({ minLength: 1, maxLength: 128 }), outcome: Type.Union([Type.Literal("cleaned"), Type.Literal("retained"), Type.Literal("unavailable")]),
	cleanedAt: timestamp, receiptDigest: digest,
});

function failure(
	code: "invalid_request" | "integrity_failed" | "external_unavailable" | "mutation_failed" | "mutation_uncertain",
	message: string,
	retryable = false,
): LifecycleResult<never> {
	return { ok: false, error: { code, message, retryable } };
}

function selectorId(target: RuntimeGcTargetSelector): string {
	return target.kind === "session_ref" ? target.sessionId : target.artifactId;
}

function selectorKey(target: RuntimeGcTargetSelector): string {
	return `${target.kind}\u0000${selectorId(target)}`;
}

function timestampIsValid(value: string): boolean {
	return Number.isFinite(Date.parse(value));
}

export function isExternalCleanupReceiptRef(value: unknown): value is ExternalCleanupReceiptRef {
	return Check(ExternalCleanupReceiptRefSchema, value) &&
		isRuntimeId(value.authorityId, "authority") && isRuntimeId(value.tenantId, "tenant") &&
		isRuntimeId(value.receiptId, "receipt");
}

export function isRuntimeGcRequest(value: unknown): value is RuntimeGcRequest {
	if (!Check(RuntimeGcRequestSchema, value) || !isRuntimeId(value.authorityId, "authority") ||
		!isRuntimeId(value.tenantId, "tenant") || !isRuntimeId(value.requestId, "command") ||
		!timestampIsValid(value.requestedAt)) return false;
	if (!value.targets.every((target) =>
		target.kind === "session_ref" ? isRuntimeId(target.sessionId, "session") : isRuntimeId(target.artifactId, "artifact")
	)) return false;
	const keys = value.targets.map((target) =>
		`${target.kind}\u0000${target.kind === "session_ref" ? target.sessionId : target.artifactId}`
	);
	return new Set(keys).size === value.targets.length;
}

function transitionReceiptBody(receipt: RuntimeGcTransitionReceipt): RuntimeGcTransitionReceiptBody {
	const { receiptId: _receiptId, mutationDigest: _mutationDigest, ...body } = receipt;
	return body;
}

export function createRuntimeGcTransitionReceipt(
	body: RuntimeGcTransitionReceiptBody,
): LifecycleResult<RuntimeGcTransitionReceipt> {
	let mutationDigest: string;
	try {
		mutationDigest = canonicalDigest(body);
	} catch {
		return failure("invalid_request", "GC transition receipt body is not serializable");
	}
	const receipt: RuntimeGcTransitionReceipt = {
		...body,
		receiptId: createRuntimeId("receipt", `gc-mutation-${mutationDigest.slice(0, 32)}`),
		mutationDigest,
	};
	return isRuntimeGcTransitionReceipt(receipt)
		? { ok: true, value: receipt }
		: failure("invalid_request", "GC transition receipt is invalid");
}

export function isRuntimeGcTransitionReceipt(value: unknown): value is RuntimeGcTransitionReceipt {
	if (!Check(RuntimeGcTransitionReceiptSchema, value) || !isRuntimeId(value.authorityId, "authority") ||
		!isRuntimeId(value.tenantId, "tenant") || !isRuntimeId(value.requestId, "command") ||
		!isRuntimeId(value.receiptId, "receipt") || !timestampIsValid(value.requestedAt) ||
		!timestampIsValid(value.committedAt)) return false;
	const candidate = value as RuntimeGcTransitionReceipt;
	const expectedTargetKind = candidate.targetKind === "session_ref" ? "session" : "artifact";
	return isRuntimeId(candidate.targetId, expectedTargetKind) &&
		canonicalDigest(transitionReceiptBody(candidate)) === candidate.mutationDigest;
}

export function isRuntimeGcReceipt(value: unknown): value is RuntimeGcReceipt {
	if (!Check(RuntimeGcReceiptSchema, value) || !isRuntimeId(value.authorityId, "authority") ||
		!isRuntimeId(value.tenantId, "tenant") || !isRuntimeId(value.requestId, "command") ||
		!isRuntimeId(value.receiptId, "receipt") || !timestampIsValid(value.requestedAt) ||
		!timestampIsValid(value.completedAt)) return false;
	if (!value.entries.every((entry) => {
		const idKind = entry.targetKind === "session_ref" ? "session" : "artifact";
		return isRuntimeId(entry.targetId, idKind) &&
			(entry.mutationReceiptId === undefined || isRuntimeId(entry.mutationReceiptId, "receipt"));
	})) return false;
	try {
		const { receiptId: _receiptId, receiptDigest: _receiptDigest, ...body } = value;
		return canonicalDigest(body) === value.receiptDigest;
	} catch {
		return false;
	}
}

function sessionRef(state: CanonicalSessionGcState): CanonicalSessionReference {
	return { authorityId: state.authorityId, tenantId: state.tenantId, sessionId: state.sessionId };
}

function artifactRef(state: CanonicalArtifactGcState): CanonicalArtifactReference {
	return { authorityId: state.authorityId, tenantId: state.tenantId, artifactId: state.artifactId };
}

function sameSession(left: CanonicalSessionReference, right: CanonicalSessionReference): boolean {
	return left.authorityId === right.authorityId && left.tenantId === right.tenantId && left.sessionId === right.sessionId;
}

function sameArtifact(left: CanonicalArtifactReference, right: CanonicalArtifactReference): boolean {
	return left.authorityId === right.authorityId && left.tenantId === right.tenantId && left.artifactId === right.artifactId;
}

function activeLegalHold(
	graph: CanonicalReferenceGraphSnapshot,
	target: CanonicalSessionReference | CanonicalArtifactReference,
): boolean {
	return graph.legalHolds.some((hold) => {
		if (hold.status === "released") return false;
		return "sessionId" in target && "sessionId" in hold.subject
			? sameSession(target, hold.subject)
			: "artifactId" in target && "artifactId" in hold.subject && sameArtifact(target, hold.subject);
	});
}

function sessionEvidenceReason(
	graph: CanonicalReferenceGraphSnapshot,
	state: CanonicalSessionGcState,
): RuntimeGcReceiptReason | undefined {
	const target = sessionRef(state);
	if (graph.forks.some((reference) => sameSession(reference.parent, target))) return "descendant";
	if (graph.handoffs.some((reference) => reference.confirmation !== "confirmed" &&
		(sameSession(reference.sourceSession, target) ||
			(reference.destinationSession !== undefined && sameSession(reference.destinationSession, target))))) {
		return "unconfirmed_handoff";
	}
	if (graph.checkpoints.some((reference) => sameSession(reference.session, target))) return "checkpoint_reference";
	if (graph.episodes.some((reference) => sameSession(reference.session, target))) return "episode_reference";
	return undefined;
}

function artifactEvidenceReason(
	graph: CanonicalReferenceGraphSnapshot,
	state: CanonicalArtifactGcState,
): RuntimeGcReceiptReason | undefined {
	const target = artifactRef(state);
	const handoffReferences = graph.handoffs.filter((reference) =>
		reference.artifacts.some((artifact) => sameArtifact(artifact, target))
	);
	if (handoffReferences.some((reference) => reference.confirmation !== "confirmed")) {
		return "unconfirmed_handoff";
	}
	if (handoffReferences.length > 0) return "artifact_reference";
	if (graph.checkpoints.some((reference) => reference.artifacts.some((artifact) => sameArtifact(artifact, target)))) {
		return "checkpoint_reference";
	}
	if (graph.episodes.some((reference) =>
		(reference.manifestArtifact !== undefined && sameArtifact(reference.manifestArtifact, target)) ||
		reference.artifacts.some((artifact) => sameArtifact(artifact, target)),
	)) return "episode_reference";
	if (graph.artifactReferences.some((reference) => sameArtifact(reference.target, target))) return "artifact_reference";
	return undefined;
}

function commonReason(
	graph: CanonicalReferenceGraphSnapshot,
	target: CanonicalSessionGcState | CanonicalArtifactGcState,
	now: Date,
): RuntimeGcReceiptReason | undefined {
	if (graph.completeness !== "complete") return "graph_incomplete";
	if (target.pins.length > 0) return "pinned";
	if (activeLegalHold(graph, "sessionId" in target ? sessionRef(target) : artifactRef(target))) return "legal_hold";
	if (!target.expiresAt || Date.parse(target.expiresAt) > now.getTime()) return "not_expired";
	if ("writerState" in target) {
		if (target.writerState === "active") return "active_writer";
		if (target.leaseState === "active") return "active_lease";
		if (target.writerState === "unknown" || target.leaseState === "unknown") return "unknown_activity";
	} else {
		if (target.readerState === "active") return "active_reader";
		if (target.readerState === "unknown") return "unknown_activity";
	}
	if (target.archiveState === "unknown" || target.tombstoneState === "unknown") return "graph_incomplete";
	return undefined;
}

function classify(
	graph: CanonicalReferenceGraphSnapshot,
	target: CanonicalSessionGcState | CanonicalArtifactGcState,
	operationToRun: RuntimeGcOperation,
	now: Date,
): RuntimeGcReceiptReason {
	const common = commonReason(graph, target, now);
	if (common) return common;
	if (operationToRun === "archive") {
		if (target.tombstoneState === "tombstoned") return "already_tombstoned";
		return target.archiveState === "archived" ? "already_archived" : "eligible";
	}
	const evidence = "sessionId" in target
		? sessionEvidenceReason(graph, target)
		: artifactEvidenceReason(graph, target);
	if (evidence) return evidence;
	if (operationToRun === "tombstone") {
		if (target.tombstoneState === "tombstoned") return "already_tombstoned";
		return target.archiveState === "archived" ? "eligible" : "archive_required";
	}
	return target.tombstoneState === "tombstoned" ? "eligible" : "tombstone_required";
}

function selectedTargets(
	graph: CanonicalReferenceGraphSnapshot,
	selectors: readonly RuntimeGcTargetSelector[],
): Array<{ selector: RuntimeGcTargetSelector; state?: CanonicalSessionGcState | CanonicalArtifactGcState }> {
	const allSelectors = selectors.length > 0 ? selectors : [
		...graph.sessions.map((state): RuntimeGcTargetSelector => ({ kind: "session_ref", sessionId: state.sessionId })),
		...graph.artifacts.map((state): RuntimeGcTargetSelector => ({ kind: "artifact_ref", artifactId: state.artifactId })),
	];
	return [...allSelectors]
		.sort((left, right) => selectorKey(left).localeCompare(selectorKey(right)))
		.map((selector) => ({
			selector,
			state: selector.kind === "session_ref"
				? graph.sessions.find((state) => state.sessionId === selector.sessionId)
				: graph.artifacts.find((state) => state.artifactId === selector.artifactId),
		}));
}

function mutationRequest(
	request: RuntimeGcRequest,
	target: RuntimeGcTargetSelector,
	requestDigest: string,
): RuntimeGcMutationRequest {
	const targetId = selectorId(target);
	return {
		schemaVersion: LIFECYCLE_SCHEMA_VERSION,
		authorityId: request.authorityId,
		tenantId: request.tenantId,
		requestId: request.requestId,
		operation: request.operation,
		targetKind: target.kind,
		targetId,
		graphRevision: request.expectedGraphRevision,
		graphDigest: request.expectedGraphDigest,
		idempotencyKey: canonicalDigest({ requestDigest, operation: request.operation, targetKind: target.kind, targetId }),
		requestedAt: request.requestedAt,
	};
}

function transitionMatchesRequest(receipt: RuntimeGcTransitionReceipt, request: RuntimeGcMutationRequest): boolean {
	return isRuntimeGcTransitionReceipt(receipt) && receipt.authorityId === request.authorityId &&
		receipt.tenantId === request.tenantId && receipt.requestId === request.requestId &&
		receipt.operation === request.operation && receipt.targetKind === request.targetKind &&
		receipt.targetId === request.targetId && receipt.graphRevision === request.graphRevision &&
		receipt.graphDigest === request.graphDigest && receipt.idempotencyKey === request.idempotencyKey;
}

function receiptFor(
	request: RuntimeGcRequest,
	requestDigest: string,
	entries: readonly RuntimeGcReceiptEntry[],
	completedAt: string,
): RuntimeGcReceipt {
	const body: RuntimeGcReceiptBody = {
		schemaVersion: LIFECYCLE_SCHEMA_VERSION,
		authorityId: request.authorityId,
		tenantId: request.tenantId,
		requestId: request.requestId,
		requestDigest,
		dryRun: request.dryRun,
		operation: request.operation,
		requestedAt: request.requestedAt,
		completedAt,
		graphRevision: request.expectedGraphRevision,
		graphDigest: request.expectedGraphDigest,
		entries,
	};
	const receiptDigest = canonicalDigest(body);
	return {
		...body,
		receiptId: createRuntimeId("receipt", `gc-${receiptDigest.slice(0, 32)}`),
		receiptDigest,
	};
}

function completedReceiptMatches(
	receipt: RuntimeGcReceipt,
	request: RuntimeGcRequest,
	requestDigest: string,
): boolean {
	return isRuntimeGcReceipt(receipt) && receipt.authorityId === request.authorityId &&
		receipt.tenantId === request.tenantId && receipt.requestId === request.requestId &&
		receipt.requestDigest === requestDigest && receipt.graphRevision === request.expectedGraphRevision &&
		receipt.graphDigest === request.expectedGraphDigest && receipt.operation === request.operation &&
		receipt.dryRun === request.dryRun;
}

export class RuntimeGcCoordinator {
	readonly #mutations: RuntimeGcMutationPort;
	readonly #references?: CanonicalReferenceGraphPort;
	readonly #journal?: RuntimeGcJournalPort;
	readonly #clock: () => Date;

	/**
	 * 第二参数保留旧 `(mutations, clock)` 构造方式以维持 storage adapter 编译；该方式 collect 时 fail closed。
	 */
	public constructor(
		mutations: RuntimeGcMutationPort,
		referencesOrClock?: CanonicalReferenceGraphPort | (() => Date),
		journal?: RuntimeGcJournalPort,
		clock: () => Date = () => new Date(),
	) {
		this.#mutations = mutations;
		if (typeof referencesOrClock === "function") {
			this.#clock = referencesOrClock;
		} else {
			this.#references = referencesOrClock;
			this.#journal = journal;
			this.#clock = clock;
		}
	}

	public async collect(requestValue: unknown, signal?: AbortSignal): Promise<LifecycleResult<RuntimeGcReceipt>> {
		if (!isRuntimeGcRequest(requestValue)) return failure("invalid_request", "Runtime GC request is invalid");
		const request = requestValue;
		if (!this.#references) return failure("external_unavailable", "canonical reference graph is unavailable", true);
		if (!request.dryRun && (!this.#journal || !this.#mutations.applyGcMutation)) {
			return failure("external_unavailable", "durable GC journal or idempotent mutation port is unavailable", true);
		}
		let requestDigest: string;
		try {
			requestDigest = canonicalDigest(request);
		} catch {
			return failure("invalid_request", "Runtime GC request is not serializable");
		}
		const claim: RuntimeGcCommandClaim = {
			schemaVersion: LIFECYCLE_SCHEMA_VERSION,
			authorityId: request.authorityId,
			tenantId: request.tenantId,
			requestId: request.requestId,
			requestDigest,
			graphRevision: request.expectedGraphRevision,
			graphDigest: request.expectedGraphDigest,
		};
		if (!request.dryRun && this.#journal) {
			let claimed: LifecycleResult<RuntimeGcCommandClaimResult>;
			try {
				claimed = await this.#journal.claim(claim, signal);
			} catch {
				return failure("external_unavailable", "GC command journal claim failed", true);
			}
			if (!claimed.ok) return claimed;
			if (claimed.value.state === "completed") {
				return completedReceiptMatches(claimed.value.receipt, request, requestDigest)
					? { ok: true, value: claimed.value.receipt }
					: failure("integrity_failed", "GC journal returned a mismatched terminal receipt");
			}
			if (claimed.value.state !== "claimed") {
				return failure("integrity_failed", "GC journal returned an unknown claim state");
			}
		}
		let loaded: LifecycleResult<CanonicalReferenceGraphSnapshot>;
		try {
			loaded = await this.#references.loadGraph({ authorityId: request.authorityId, tenantId: request.tenantId }, signal);
		} catch {
			return failure("external_unavailable", "canonical reference graph load failed", true);
		}
		if (!loaded.ok) return loaded;
		const graph = loaded.value;
		if (!isCanonicalReferenceGraphSnapshot(graph) || graph.authorityId !== request.authorityId ||
			graph.tenantId !== request.tenantId || graph.revision !== request.expectedGraphRevision ||
			graph.graphDigest !== request.expectedGraphDigest) {
			return failure("integrity_failed", "canonical reference graph scope or revision does not match the request");
		}
		const now = this.#clock();
		const entries: RuntimeGcReceiptEntry[] = [];
		for (const target of selectedTargets(graph, request.targets)) {
			const targetId = selectorId(target.selector);
			if (!target.state) {
				entries.push({ targetKind: target.selector.kind, targetId, action: "retained", reason: "target_missing" });
				continue;
			}
			const reason = classify(graph, target.state, request.operation, now);
			if (reason !== "eligible") {
				entries.push({ targetKind: target.selector.kind, targetId, action: "retained", reason });
				continue;
			}
			if (request.dryRun) {
				entries.push({
					targetKind: target.selector.kind,
					targetId,
					action: request.operation === "archive" ? "would_archive" :
						request.operation === "tombstone" ? "would_tombstone" : "would_purge",
					reason,
				});
				continue;
			}
			const mutation = mutationRequest(request, target.selector, requestDigest);
			const journal = this.#journal;
			if (journal?.recordMutationIntent) {
				let intent: LifecycleResult<RuntimeGcMutationRequest>;
				try {
					intent = await journal.recordMutationIntent(claim, mutation, signal);
				} catch {
					return failure("external_unavailable", "GC mutation intent journal failed", true);
				}
				if (!intent.ok || canonicalDigest(intent.value) !== canonicalDigest(mutation)) {
					return failure("integrity_failed", "GC mutation intent journal returned mismatched evidence");
				}
			}
			let applied: LifecycleResult<RuntimeGcTransitionReceipt>;
			try {
				applied = await this.#mutations.applyGcMutation?.(mutation, signal) ??
					failure("external_unavailable", "idempotent GC mutation port is unavailable", true);
			} catch {
				applied = failure("mutation_uncertain", "GC mutation outcome is uncertain", true);
			}
			if ((!applied.ok || !transitionMatchesRequest(applied.value, mutation)) && this.#mutations.readGcMutation) {
				let recovered: LifecycleResult<RuntimeGcTransitionReceipt | undefined>;
				try {
					recovered = await this.#mutations.readGcMutation(mutation, signal);
				} catch {
					recovered = failure("mutation_uncertain", "GC mutation receipt read-back failed", true);
				}
				if (recovered.ok && recovered.value && transitionMatchesRequest(recovered.value, mutation)) {
					applied = { ok: true, value: recovered.value };
				}
			}
			if (!applied.ok || !transitionMatchesRequest(applied.value, mutation)) {
				return failure("mutation_uncertain", "GC mutation receipt is unavailable or mismatched; replay the same requestId", true);
			}
			entries.push({
				targetKind: target.selector.kind,
				targetId,
				action: request.operation === "archive" ? "archived" :
					request.operation === "tombstone" ? "tombstoned" : "purged",
				reason,
				mutationReceiptId: applied.value.receiptId,
				mutationDigest: applied.value.mutationDigest,
			});
		}
		const receipt = receiptFor(request, requestDigest, entries, this.#clock().toISOString());
		if (!isRuntimeGcReceipt(receipt)) return failure("integrity_failed", "Runtime GC terminal receipt is invalid");
		if (request.dryRun) return { ok: true, value: receipt };
		if (!this.#journal) return failure("external_unavailable", "durable GC journal is unavailable", true);
		let completed: LifecycleResult<RuntimeGcReceipt>;
		try {
			completed = await this.#journal.complete(claim, receipt, signal);
		} catch {
			return failure("mutation_uncertain", "GC mutations committed before terminal journal receipt", true);
		}
		if (!completed.ok || !completedReceiptMatches(completed.value, request, requestDigest)) {
			return failure("mutation_uncertain", "GC terminal journal receipt is unavailable or mismatched", true);
		}
		return completed;
	}
}
