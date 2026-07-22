/** Agent loop 到 Session Kernel v3 的 durable 事件桥。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { ArtifactRef } from "../protocol/v3/capability.ts";
import { sameRuntimeEventStream, type EventCursor, type ExpectedRevision } from "../protocol/v3/events.ts";
import type { RuntimeEventPayloadMap } from "../protocol/v3/event-payloads.ts";
import type { RuntimeEventType } from "../protocol/v3/event-catalog.ts";
import { contextAssembledEventPayload } from "../context/context-engine.ts";
import type { ContextAssemblyReceipt } from "../context/types.ts";
import { modelRoutedEventPayload } from "../model-routing/router.ts";
import type { ModelRouteDecision } from "../model-routing/types.ts";
import {
	createRuntimeId,
	isRuntimeId,
	type AgentId,
	type CommandId,
	type GoalId,
	type ModelRequestId,
	type PrincipalId,
	type QueueItemId,
	type RuntimeInstanceId,
	type ToolCallId,
	type TraceId,
	type TurnId,
} from "../protocol/v3/ids.ts";
import type {
	AgentMessage,
	AgentTool,
	ToolExecutionAuthorizationGrant,
	ToolResultContent,
} from "../types.ts";
import { isWorkspaceValidationReceiptRef } from "../protocol/v3/workspace.ts";
import type { UserAgentMessage } from "../types.ts";
import type {
	DurableQueueKind,
	DurableQueueContent,
	DurableQueueNextTurnPolicy,
	DurableQueueReference,
	DurableQueueReplay,
	DurableQueueTargetTurnRevision,
	RestoredDurableQueueItem,
} from "./durable-queue.ts";
import type { EventWriter } from "./event-writer.ts";
import type { DurableEventReceipt, RuntimeEventDraft, SessionKernelError, SessionResult } from "./types.ts";

export type {
	DurableQueueContent,
	DurableQueueKind,
	DurableQueueNextTurnPolicy,
	DurableQueueReference,
	DurableQueueTargetTurnRevision,
	RestoredDurableQueueItem,
} from "./durable-queue.ts";

export interface AgentLoopSessionEventsOptions {
	writer: EventWriter;
	principalId: PrincipalId;
	runtimeId: RuntimeInstanceId;
	goalId?: GoalId;
	agentId?: AgentId;
	featureDigest: string;
	restoredQueue?: DurableQueueReplay;
	traceIdFactory?: () => TraceId;
}

export interface DurableTurnHandle {
	turnId: TurnId;
	modelRequestId?: ModelRequestId;
	queueReferences: readonly DurableQueueReference[];
}

export interface DurableQueueReceipt {
	queueItemId: QueueItemId;
	cursor: EventCursor;
	contentDigest: string;
	reference: DurableQueueReference;
}

export interface DurableQueueEnqueueOptions {
	sourceCommandId?: CommandId;
	enqueueRevision?: ExpectedRevision;
	targetTurnRevision?: DurableQueueTargetTurnRevision | null;
	nextTurnPolicy?: DurableQueueNextTurnPolicy;
}

export interface DurableQueueStateItem {
	queueItemId: QueueItemId;
	sourceCommandId: CommandId;
	kind: DurableQueueKind;
	enqueueRevision: ExpectedRevision;
	targetTurnRevision: DurableQueueTargetTurnRevision | null;
	nextTurnPolicy: DurableQueueNextTurnPolicy;
	contentDigest: string;
	content: DurableQueueContent;
	status: "pending" | "claimed";
	enqueuedSequence: number;
	message: UserAgentMessage | null;
}

export interface DurableQueueStateSnapshot {
	/** 仅绑定有序、尚未 terminal 的 queue 状态，不复用 session revision。 */
	queueRevision: string;
	items: readonly DurableQueueStateItem[];
}

export interface DurableQueueCancellationReceipt {
	queueItemId: QueueItemId;
	sourceCommandId: CommandId;
	kind: DurableQueueKind;
	contentDigest: string;
	durableCursor: EventCursor;
}

export interface DurableQueueCancellationTarget {
	queueItemId: QueueItemId;
	kind: DurableQueueKind;
}

export interface DurableQueueCancellationResult {
	previousQueueRevision: string;
	queueRevision: string;
	receipts: readonly DurableQueueCancellationReceipt[];
}

export interface DurableModelHandle {
	turnId: TurnId;
	requestId: ModelRequestId;
}

export interface DurableToolHandle {
	turnId: TurnId;
	toolCallId: ToolCallId;
	providerToolCallId: string;
	toolIdentityDigest: string;
	argumentsDigest: string;
	started: boolean;
	readOnly: boolean;
}

export class SessionEventBarrierError extends Error {
	public readonly sessionError: SessionKernelError;

	public constructor(error: SessionKernelError) {
		super(`Session v3 durable event barrier failed: ${error.code}: ${error.message}`);
		this.name = "SessionEventBarrierError";
		this.sessionError = error;
	}
}

export class DurableQueueBindingError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "DurableQueueBindingError";
	}
}

export class DurableQueueRevisionConflictError extends Error {
	public readonly expectedQueueRevision: string;
	public readonly actualQueueRevision: string;

	public constructor(expectedQueueRevision: string, actualQueueRevision: string) {
		super("durable queue revision is stale");
		this.name = "DurableQueueRevisionConflictError";
		this.expectedQueueRevision = expectedQueueRevision;
		this.actualQueueRevision = actualQueueRevision;
	}
}

export class DurableQueueEnqueueRevisionConflictError extends Error {
	public readonly expectedRevision: ExpectedRevision;
	public readonly actualRevision: ExpectedRevision;

	public constructor(expectedRevision: ExpectedRevision, actualRevision: ExpectedRevision) {
		super("durable queue enqueue revision is stale");
		this.name = "DurableQueueEnqueueRevisionConflictError";
		this.expectedRevision = expectedRevision;
		this.actualRevision = actualRevision;
	}
}

export class DurableQueueCancellationPartialError extends Error {
	public readonly previousQueueRevision: string;
	public readonly queueRevision: string;
	public readonly receipts: readonly DurableQueueCancellationReceipt[];
	public readonly cause: unknown;

	public constructor(options: {
		previousQueueRevision: string;
		queueRevision: string;
		receipts: readonly DurableQueueCancellationReceipt[];
		cause: unknown;
	}) {
		const causeMessage = options.cause instanceof Error ? options.cause.message : String(options.cause);
		super(`durable queue cancellation stopped before the whole batch was confirmed: ${causeMessage}`);
		this.name = "DurableQueueCancellationPartialError";
		this.previousQueueRevision = options.previousQueueRevision;
		this.queueRevision = options.queueRevision;
		this.receipts = options.receipts;
		this.cause = options.cause;
	}
}

function digestJsonCompatible(value: unknown): string {
	return canonicalDigest(JSON.stringify(value));
}

function boundedToken(value: string): string {
	const normalized = value.trim();
	if (normalized.length === 0) return "unknown";
	return normalized.length <= 128 ? normalized : canonicalDigest(normalized);
}

function errorPayload(error: unknown): { code: string; messageDigest: string; retryable: boolean } {
	const message = error instanceof Error ? error.message : String(error);
	return {
		code: boundedToken(error instanceof Error ? error.name : "runtime_error"),
		messageDigest: canonicalDigest(message),
		retryable: false,
	};
}

function expectedRevisionFromCursor(cursor: EventCursor): ExpectedRevision {
	return { stream: cursor.stream, sequence: cursor.sequence, eventHash: cursor.eventHash };
}

function sameExpectedRevision(left: ExpectedRevision, right: ExpectedRevision): boolean {
	return sameRuntimeEventStream(left.stream, right.stream) && left.sequence === right.sequence && left.eventHash === right.eventHash;
}

function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function authorizationReceiptBody(grant: ToolExecutionAuthorizationGrant): Omit<ToolExecutionAuthorizationGrant["authorization"], "receiptDigest"> {
	const { receiptDigest: _receiptDigest, ...body } = grant.authorization;
	return body;
}

function authorizationGrantBody(grant: ToolExecutionAuthorizationGrant): Omit<ToolExecutionAuthorizationGrant, "grantDigest"> {
	const { grantDigest: _grantDigest, ...body } = grant;
	return body;
}

function sandboxResolutionBody(
	sandbox: ToolExecutionAuthorizationGrant["sandbox"],
): Omit<ToolExecutionAuthorizationGrant["sandbox"], "resolutionDigest"> {
	const { resolutionDigest: _resolutionDigest, ...body } = sandbox;
	return body;
}

function assertGrantMatchesHandle(handle: DurableToolHandle, grant: ToolExecutionAuthorizationGrant): void {
	const sandbox = grant.sandbox;
	if (
		grant.schemaVersion !== 1 ||
		grant.toolCallId !== handle.toolCallId ||
		grant.providerToolCallDigest !== canonicalDigest(handle.providerToolCallId) ||
		grant.toolIdentityDigest !== handle.toolIdentityDigest ||
		grant.argumentsDigest !== handle.argumentsDigest ||
		!isDigest(grant.invocationDigest) ||
		!isDigest(grant.workspaceEnvelopeDigest) ||
		!isWorkspaceValidationReceiptRef(grant.workspaceValidation) ||
		grant.workspaceValidation.outcome !== "valid" ||
		grant.workspaceValidation.envelopeDigest !== grant.workspaceEnvelopeDigest ||
		!isRuntimeId(grant.authorization.receiptId, "receipt") ||
		!isRuntimeId(grant.authorization.requestId, "command") ||
		!isDigest(grant.authorization.requestDigest) ||
		!isDigest(grant.authorization.decisionDigest) ||
		grant.authorization.receiptDigest !== canonicalDigest(authorizationReceiptBody(grant)) ||
		grant.policyDigest !== sandbox.policyDigest ||
		!isRuntimeId(sandbox.receiptId, "receipt") ||
		!isRuntimeId(sandbox.profileId, "resource") ||
		sandbox.resolutionDigest !== canonicalDigest(sandboxResolutionBody(sandbox)) ||
		(sandbox.effectiveEnforcement === "unavailable") ||
		(sandbox.effectiveEnforcement === "degraded" && !isDigest(sandbox.reasonDigest)) ||
		grant.grantDigest !== canonicalDigest(authorizationGrantBody(grant))
	) {
		throw new DurableQueueBindingError("tool execution grant is invalid, unavailable, or not correlated to the durable request");
	}
}

/**
 * 每个方法只有在 EventWriter 返回 durable cursor 后才 resolve。调用方必须 await，
 * 这样 tool terminal 与下一次 model.requested 之间形成真实持久化屏障。
 */
export class AgentLoopSessionEvents {
	private readonly writer: EventWriter;
	private readonly principalId: PrincipalId;
	private readonly runtimeId: RuntimeInstanceId;
	private readonly goalId: GoalId;
	private readonly agentId: AgentId;
	private readonly featureDigest: string;
	private readonly traceIdFactory: () => TraceId;
	private readonly pendingQueue: RestoredDurableQueueItem[];
	private readonly unrecoverablePendingQueueCount: number;
	private readonly claimedQueueItemIds = new Set<QueueItemId>();
	private readonly queueBindings = new WeakMap<AgentMessage, DurableQueueReference>();
	private queueMutation: Promise<void> = Promise.resolve();
	private activeTurnId: TurnId | null = null;
	private initialized: boolean;

	public constructor(options: AgentLoopSessionEventsOptions) {
		this.writer = options.writer;
		this.principalId = options.principalId;
		this.runtimeId = options.runtimeId;
		this.goalId = options.goalId ?? createRuntimeId("goal");
		this.agentId = options.agentId ?? createRuntimeId("agent");
		this.featureDigest = options.featureDigest;
		this.traceIdFactory = options.traceIdFactory ?? (() => createRuntimeId("trace"));
		this.pendingQueue = [...(options.restoredQueue?.pending ?? [])];
		this.unrecoverablePendingQueueCount = options.restoredQueue?.unrecoverable.length ?? 0;
		this.initialized = options.writer.currentHead() !== undefined;
	}

	public lineage(): { goalId: GoalId; agentId: AgentId } {
		return { goalId: this.goalId, agentId: this.agentId };
	}

	/** 供 governed model coordinator 构造严格 expected revision。 */
	public currentExpectedRevision(): ExpectedRevision {
		const head = this.writer.currentHead();
		if (!head) throw new DurableQueueBindingError("governed model request requires an initialized session head");
		return expectedRevisionFromCursor(head);
	}

	public async recordModelRoute(turnId: TurnId, decision: ModelRouteDecision): Promise<void> {
		await this.append("model.routed", modelRoutedEventPayload(turnId, decision));
	}

	public async recordContextAssembly(receipt: ContextAssemblyReceipt): Promise<void> {
		await this.append("context.assembled", contextAssembledEventPayload(receipt));
	}

	public hasUnrecoverablePendingQueue(): boolean {
		return this.unrecoverablePendingQueueCount > 0;
	}

	public pendingQueueItems(): readonly RestoredDurableQueueItem[] {
		return this.pendingQueue.filter(
			(item) => item.reference.status === "pending" || item.reference.status === "claimed",
		);
	}

	private queueSnapshotExclusive(): DurableQueueStateSnapshot {
		const items = this.pendingQueueItems()
			.slice()
			.sort((left, right) => left.enqueuedSequence - right.enqueuedSequence)
			.map((item): DurableQueueStateItem => ({
				queueItemId: item.reference.queueItemId,
				sourceCommandId: item.reference.sourceCommandId,
				kind: item.reference.kind,
				enqueueRevision: item.reference.enqueueRevision,
				targetTurnRevision: item.reference.targetTurnRevision,
				nextTurnPolicy: item.reference.nextTurnPolicy,
				contentDigest: item.reference.contentDigest,
				content: item.content,
				status: item.reference.status === "claimed" ? "claimed" : "pending",
				enqueuedSequence: item.enqueuedSequence,
				message: item.message,
			}));
		const queueRevision = canonicalDigest(items.map((item) => ({
			queueItemId: item.queueItemId,
			sourceCommandId: item.sourceCommandId,
			kind: item.kind,
			enqueueRevision: item.enqueueRevision,
			targetTurnRevision: item.targetTurnRevision,
			nextTurnPolicy: item.nextTurnPolicy,
			contentDigest: item.contentDigest,
			content: item.content,
			status: item.status,
			enqueuedSequence: item.enqueuedSequence,
		})));
		return { queueRevision, items };
	}

	/** queue:list 与 queue:cancel 共用同一 authoritative queue mutex。 */
	public inspectQueue(): Promise<DurableQueueStateSnapshot> {
		return this.withQueueMutation(async () => {
			await this.ensureInitialized();
			return this.queueSnapshotExclusive();
		});
	}

	private assertQueueRecoverable(): void {
		if (this.unrecoverablePendingQueueCount > 0) {
			throw new DurableQueueBindingError(
				`durable queue contains ${this.unrecoverablePendingQueueCount} item(s) without a recoverable message body`,
			);
		}
	}

	private findPendingQueueItem(queueItemId: QueueItemId): RestoredDurableQueueItem | undefined {
		return this.pendingQueue.find(
			(item) => item.reference.queueItemId === queueItemId && item.reference.status === "pending",
		);
	}

	private bindQueueItem(
		item: RestoredDurableQueueItem,
		message: AgentMessage,
	): DurableQueueReference {
		const messageJson = JSON.stringify(message);
		if (
			item.content.storage !== "bounded_text" ||
			item.message === null ||
			message.role !== "user" ||
			canonicalDigest({ storage: "bounded_text", messageJson }) !== item.reference.contentDigest
		) {
			throw new DurableQueueBindingError(
				`durable queue item ${item.reference.queueItemId} is artifact-backed or does not match the supplied user message`,
			);
		}
		this.claimedQueueItemIds.add(item.reference.queueItemId);
		this.queueBindings.set(message, item.reference);
		return item.reference;
	}

	/** 新 Agent 接管重放出的全部 pending item；返回顺序严格等于 enqueue sequence。 */
	public adoptPendingQueueItems(): readonly RestoredDurableQueueItem[] {
		this.assertQueueRecoverable();
		const adopted: RestoredDurableQueueItem[] = [];
		for (const item of this.pendingQueueItems()) {
			if (item.reference.status !== "pending") continue;
			if (this.claimedQueueItemIds.has(item.reference.queueItemId)) continue;
			if (!item.message) {
				throw new DurableQueueBindingError(
					`durable queue item ${item.reference.queueItemId} requires artifact resolution before Agent adoption`,
				);
			}
			this.bindQueueItem(item, item.message);
			adopted.push(item);
		}
		return adopted;
	}

	/**
	 * Control Plane 已 durable enqueue、但内存 message 是另一个对象时，按 kind 的
	 * FIFO 位置选择 item，再校验完整正文；绝不按 digest 搜索或跨 kind 猜测。
	 */
	public claimNextPendingQueueItem(
		kind: DurableQueueKind,
		message: UserAgentMessage,
	): DurableQueueReference | undefined {
		this.assertQueueRecoverable();
		const item = this.pendingQueue.find(
			(candidate) =>
				candidate.reference.status === "pending" &&
				candidate.reference.kind === kind &&
				!this.claimedQueueItemIds.has(candidate.reference.queueItemId),
		);
		return item ? this.bindQueueItem(item, message) : undefined;
	}

	/** enqueue receipt 已给出精确 ID 时直接绑定，不执行内容检索。 */
	public claimQueueReference(
		reference: DurableQueueReference,
		message: UserAgentMessage,
	): DurableQueueReference {
		this.assertQueueRecoverable();
		const item = this.findPendingQueueItem(reference.queueItemId);
		if (!item || item.reference.kind !== reference.kind || item.reference !== reference) {
			throw new DurableQueueBindingError(`durable queue reference ${reference.queueItemId} is not pending`);
		}
		return this.bindQueueItem(item, message);
	}

	/**
	 * Daemon/Control Plane 只可使用 queue.enqueued 返回的完整 durable receipt 认领。
	 * 选择依据是 queueItem/sourceCommand/kind/cursor 的精确关联；正文 digest 仅作为
	 * 最后的完整性校验，绝不用于搜索或 FIFO 猜测。
	 */
	public claimQueueReceipt(
		receipt: DurableQueueReceipt,
		message: UserAgentMessage,
	): DurableQueueReference {
		this.assertQueueRecoverable();
		const item = this.findPendingQueueItem(receipt.queueItemId);
		const reference = receipt.reference;
		const cursor = receipt.cursor;
		const enqueuedCursor = item?.enqueuedCursor;
		if (
			!item ||
			this.claimedQueueItemIds.has(receipt.queueItemId) ||
			reference.queueItemId !== receipt.queueItemId ||
			reference.queueItemId !== item.reference.queueItemId ||
			reference.sourceCommandId !== item.reference.sourceCommandId ||
			reference.kind !== item.reference.kind ||
			reference.contentDigest !== receipt.contentDigest ||
			reference.contentDigest !== item.reference.contentDigest ||
			reference.status !== "pending" ||
			!enqueuedCursor ||
			!sameRuntimeEventStream(cursor.stream, enqueuedCursor.stream) ||
			cursor.sequence !== enqueuedCursor.sequence ||
			cursor.eventId !== enqueuedCursor.eventId ||
			cursor.eventHash !== enqueuedCursor.eventHash
		) {
			throw new DurableQueueBindingError(
				`durable queue receipt ${receipt.queueItemId} is stale, already claimed, or not exactly correlated`,
			);
		}
		return this.bindQueueItem(item, message);
	}

	/** beginTurn 的调用方只拿到由精确 message 对象绑定的 queue reference。 */
	public queueReferencesFor(messages: readonly AgentMessage[]): readonly DurableQueueReference[] {
		const references: DurableQueueReference[] = [];
		const seen = new Set<QueueItemId>();
		for (const message of messages) {
			const reference = this.queueBindings.get(message);
			if (!reference || reference.status !== "pending" || seen.has(reference.queueItemId)) continue;
			seen.add(reference.queueItemId);
			references.push(reference);
		}
		return references;
	}

	/** cancellation 赢得竞争后，从下一 turn 的 message batch 中同步剔除正文。 */
	public activeQueueMessages(messages: readonly AgentMessage[]): readonly AgentMessage[] {
		return messages.filter((message) => {
			const reference = this.queueBindings.get(message);
			return !reference || reference.status === "pending" || reference.status === "claimed";
		});
	}

	private withQueueMutation<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queueMutation.then(operation);
		this.queueMutation = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async append<TType extends RuntimeEventType>(
		type: TType,
		payload: RuntimeEventPayloadMap[TType],
	): Promise<import("../protocol/v3/events.ts").EventCursor> {
		const draft = {
			type,
			principalId: this.principalId,
			traceId: this.traceIdFactory(),
			payload,
		} as RuntimeEventDraft<TType>;
		const result = await this.writer.append(draft);
		if (!result.ok) throw new SessionEventBarrierError(result.error);
		return {
			stream: result.value.cursor.stream,
			sequence: result.value.cursor.sequence,
			eventId: result.value.cursor.eventId,
			eventHash: result.value.cursor.eventHash,
		};
	}

	public async ensureInitialized(origin: "new" | "import" | "test" = "new"): Promise<void> {
		if (this.initialized) return;
		if (this.writer.currentHead() !== undefined) {
			this.initialized = true;
			return;
		}
		await this.append("session.created", {
			origin,
			runtimeId: this.runtimeId,
			featureDigest: this.featureDigest,
			initialGoalId: this.goalId,
			rootAgentId: this.agentId,
		});
		this.initialized = true;
	}

	public enqueueWithReceipt(
		kind: DurableQueueKind,
		message: AgentMessage,
		options: DurableQueueEnqueueOptions = {},
	): Promise<DurableQueueReceipt> {
		if (message.role !== "user") {
			return Promise.reject(new DurableQueueBindingError("durable steer/follow-up queue only accepts user messages"));
		}
		const content: DurableQueueContent = { storage: "bounded_text", messageJson: JSON.stringify(message) };
		return this.withQueueMutation(() => this.enqueueContentWithReceiptExclusive(kind, content, message, options));
	}

	/** Artifact body is durable and cancellable/replayable, but Agent adoption still needs an injected resolver. */
	public enqueueArtifactWithReceipt(
		kind: DurableQueueKind,
		artifact: ArtifactRef,
		options: DurableQueueEnqueueOptions = {},
	): Promise<DurableQueueReceipt> {
		const content: DurableQueueContent = { storage: "artifact", artifact };
		return this.withQueueMutation(() => this.enqueueContentWithReceiptExclusive(kind, content, null, options));
	}

	private async enqueueContentWithReceiptExclusive(
		kind: DurableQueueKind,
		content: DurableQueueContent,
		message: UserAgentMessage | null,
		options: DurableQueueEnqueueOptions,
	): Promise<DurableQueueReceipt> {
		await this.ensureInitialized();
		const head = this.writer.currentHead();
		if (!head) throw new DurableQueueBindingError("durable queue requires an initialized session head");
		const actualRevision = expectedRevisionFromCursor(head);
		const enqueueRevision = options.enqueueRevision ?? actualRevision;
		if (!sameExpectedRevision(enqueueRevision, actualRevision)) {
			throw new DurableQueueEnqueueRevisionConflictError(enqueueRevision, actualRevision);
		}
		const sourceCommandId = options.sourceCommandId ?? createRuntimeId("command");
		const targetTurnRevision = options.targetTurnRevision === undefined
			? (this.activeTurnId === null ? null : { turnId: this.activeTurnId, sessionRevision: actualRevision })
			: options.targetTurnRevision;
		if (
			targetTurnRevision !== null &&
			(targetTurnRevision.turnId !== this.activeTurnId ||
				!sameExpectedRevision(targetTurnRevision.sessionRevision, enqueueRevision))
		) throw new DurableQueueBindingError("durable queue target turn revision is stale");
		const nextTurnPolicy = options.nextTurnPolicy ?? (kind === "steer" ? "next_model_turn" : "after_active_run");
		if (
			(kind === "steer" && nextTurnPolicy !== "next_model_turn") ||
			(kind === "follow_up" && nextTurnPolicy !== "after_active_run")
		) throw new DurableQueueBindingError("durable queue kind, target turn, and next-turn policy are inconsistent");
		const queueItemId = createRuntimeId("queueItem");
		const contentDigest = canonicalDigest(content);
		const cursor = await this.append("queue.enqueued", {
			queueItemId,
			sourceCommandId,
			kind,
			enqueueRevision,
			targetTurnRevision,
			nextTurnPolicy,
			contentDigest,
			content,
		});
		const reference: DurableQueueReference = {
			queueItemId,
			sourceCommandId,
			kind,
			enqueueRevision,
			targetTurnRevision,
			nextTurnPolicy,
			contentDigest,
			status: "pending",
		};
		this.pendingQueue.push({
			reference,
			content,
			message,
			enqueuedSequence: cursor.sequence,
			enqueuedCursor: cursor,
		});
		return { queueItemId, cursor, contentDigest, reference };
	}

	public async enqueue(kind: DurableQueueKind, message: AgentMessage): Promise<void> {
		await this.enqueueWithReceipt(kind, message);
	}

	public async recordMessage(message: AgentMessage): Promise<void> {
		await this.ensureInitialized();
		const messageJson = JSON.stringify(message);
		await this.append("conversation.message_recorded", {
			role: message.role,
			messageJson,
			contentDigest: canonicalDigest(messageJson),
		});
	}

	public beginTurn(queueReferences: readonly DurableQueueReference[] = []): Promise<DurableTurnHandle> {
		return this.withQueueMutation(() => this.beginTurnExclusive(queueReferences));
	}

	private async beginTurnExclusive(
		queueReferences: readonly DurableQueueReference[],
	): Promise<DurableTurnHandle> {
		await this.ensureInitialized();
		this.assertQueueRecoverable();
		const queueItems: RestoredDurableQueueItem[] = [];
		const seen = new Set<QueueItemId>();
		for (const reference of queueReferences) {
			if (seen.has(reference.queueItemId)) {
				throw new DurableQueueBindingError(`durable queue reference ${reference.queueItemId} was repeated`);
			}
			seen.add(reference.queueItemId);
			const item = this.findPendingQueueItem(reference.queueItemId);
			if (
				!item ||
				item.reference !== reference ||
				item.reference.kind !== reference.kind ||
				!this.claimedQueueItemIds.has(reference.queueItemId)
			) {
				throw new DurableQueueBindingError(
					`durable queue reference ${reference.queueItemId} is not an exact claimed pending item`,
				);
			}
			queueItems.push(item);
		}
		const turnId = createRuntimeId("turn");
		const modelRequestId = queueItems.length > 0 ? createRuntimeId("modelRequest") : undefined;
		await this.append("turn.started", {
			turnId,
			goalId: this.goalId,
			...(queueItems[0] ? { queueItemId: queueItems[0].reference.queueItemId } : {}),
		});
		this.activeTurnId = turnId;
		const first = queueItems[0];
		if (first && modelRequestId) {
			await this.append("queue.claimed", {
				queueItemId: first.reference.queueItemId,
				sourceCommandId: first.reference.sourceCommandId,
				kind: first.reference.kind,
				turnId,
				modelRequestId,
				contentDigest: first.reference.contentDigest,
			});
			first.reference.status = "claimed";
		}
		return {
			turnId,
			...(modelRequestId ? { modelRequestId } : {}),
			queueReferences: queueItems.map((item) => item.reference),
		};
	}

	/** 每个 cancellation durable 后才更新对应引用；中途失败的剩余 item 仍保持 pending。 */
	public cancelQueueReferences(
		references: readonly DurableQueueReference[],
		reason: string,
	): Promise<void> {
		return this.withQueueMutation(() => this.cancelQueueReferencesExclusive(references, reason));
	}

	private async cancelQueueReferencesExclusive(
		references: readonly DurableQueueReference[],
		reason: string,
	): Promise<void> {
		if (references.length === 0) return;
		for (const reference of references) {
			const item = this.findPendingQueueItem(reference.queueItemId);
			if (!item || item.reference !== reference || item.reference.kind !== reference.kind) {
				throw new DurableQueueBindingError(
					`durable queue reference ${reference.queueItemId} was already accepted or is not pending`,
				);
			}
		}
		const snapshot = this.queueSnapshotExclusive();
		await this.cancelQueueItemsExclusive(
			snapshot.queueRevision,
			references.map((reference) => ({ queueItemId: reference.queueItemId, kind: reference.kind })),
			reason,
			createRuntimeId("command"),
		);
	}

	/**
	 * expectedQueueRevision compare、逐项 durable append 和内存状态推进均在同一
	 * queueMutation 临界区。批次中途失败时只报告已经取得 durable cursor 的前缀。
	 */
	public cancelQueueItems(
		expectedQueueRevision: string,
		targets: readonly DurableQueueCancellationTarget[],
		reason: string,
		cancellationCommandId: CommandId,
	): Promise<DurableQueueCancellationResult> {
		return this.withQueueMutation(() => this.cancelQueueItemsExclusive(
			expectedQueueRevision,
			targets,
			reason,
			cancellationCommandId,
		));
	}

	private async cancelQueueItemsExclusive(
		expectedQueueRevision: string,
		targets: readonly DurableQueueCancellationTarget[],
		reason: string,
		cancellationCommandId: CommandId,
	): Promise<DurableQueueCancellationResult> {
		await this.ensureInitialized();
		this.assertQueueRecoverable();
		const before = this.queueSnapshotExclusive();
		if (before.queueRevision !== expectedQueueRevision) {
			throw new DurableQueueRevisionConflictError(expectedQueueRevision, before.queueRevision);
		}
		if (targets.length === 0 || new Set(targets.map((target) => target.queueItemId)).size !== targets.length) {
			throw new DurableQueueBindingError("durable queue cancellation requires distinct queue item ids");
		}
		const selected = targets.map((target) => {
			const item = this.findPendingQueueItem(target.queueItemId);
			if (!item || item.reference.kind !== target.kind) {
				throw new DurableQueueBindingError(
					`durable queue item ${target.queueItemId} does not match the requested pending kind`,
				);
			}
			return item;
		});
		const boundedReason = reason.slice(0, 512) || "queue cancelled";
		const receipts: DurableQueueCancellationReceipt[] = [];
		for (const item of selected) {
			let durableCursor: EventCursor;
			try {
				durableCursor = await this.append("queue.cancelled", {
					queueItemId: item.reference.queueItemId,
					sourceCommandId: item.reference.sourceCommandId,
					kind: item.reference.kind,
					contentDigest: item.reference.contentDigest,
					reason: boundedReason,
					cancellationCommandId,
				});
			} catch (error) {
				throw new DurableQueueCancellationPartialError({
					previousQueueRevision: before.queueRevision,
					queueRevision: this.queueSnapshotExclusive().queueRevision,
					receipts,
					cause: error,
				});
			}
			item.reference.status = "cancelled";
			this.claimedQueueItemIds.delete(item.reference.queueItemId);
			receipts.push({
				queueItemId: item.reference.queueItemId,
				sourceCommandId: item.reference.sourceCommandId,
				kind: item.reference.kind,
				contentDigest: item.reference.contentDigest,
				durableCursor,
			});
		}
		return {
			previousQueueRevision: before.queueRevision,
			queueRevision: this.queueSnapshotExclusive().queueRevision,
			receipts,
		};
	}

	public beginModelRequest(
		turn: DurableTurnHandle,
		modelId: string,
		context: unknown,
	): Promise<DurableModelHandle> {
		return this.withQueueMutation(() => this.beginModelRequestExclusive(turn, modelId, context));
	}

	private async beginModelRequestExclusive(
		turn: DurableTurnHandle,
		modelId: string,
		context: unknown,
	): Promise<DurableModelHandle> {
		const requestId = turn.modelRequestId ?? createRuntimeId("modelRequest");
		await this.append("model.requested", {
			turnId: turn.turnId,
			requestId,
			modelId: boundedToken(modelId),
			contextDigest: digestJsonCompatible(context),
		});
		for (const reference of turn.queueReferences) {
			await this.append("queue.consumed", {
				queueItemId: reference.queueItemId,
				sourceCommandId: reference.sourceCommandId,
				kind: reference.kind,
				turnId: turn.turnId,
				modelRequestId: requestId,
				contentDigest: reference.contentDigest,
			});
			reference.status = "consumed";
			this.claimedQueueItemIds.delete(reference.queueItemId);
		}
		return { turnId: turn.turnId, requestId };
	}

	public async finishModelRequest(
		model: DurableModelHandle,
		response: unknown,
		usage: { inputTokens: number; outputTokens: number },
	): Promise<void> {
		await this.append("model.finished", {
			turnId: model.turnId,
			requestId: model.requestId,
			responseDigest: digestJsonCompatible(response),
			inputTokens: Math.max(0, Math.trunc(usage.inputTokens)),
			outputTokens: Math.max(0, Math.trunc(usage.outputTokens)),
		});
	}

	public async failModelRequest(model: DurableModelHandle, error: unknown): Promise<void> {
		await this.append("model.failed", {
			turnId: model.turnId,
			requestId: model.requestId,
			error: errorPayload(error),
		});
	}

	public async requestTool(
		turn: DurableTurnHandle,
		providerToolCallId: string,
		toolName: string,
		args: unknown,
	): Promise<DurableToolHandle> {
		const toolCallId = createRuntimeId("toolCall");
		const toolIdentityDigest = canonicalDigest(boundedToken(toolName));
		const argumentsDigest = digestJsonCompatible(args);
		await this.append("tool.requested", {
			turnId: turn.turnId,
			toolCallId,
			agentId: this.agentId,
			toolIdentityDigest,
			argumentsDigest,
		});
		return {
			turnId: turn.turnId,
			toolCallId,
			providerToolCallId,
			toolIdentityDigest,
			argumentsDigest,
			started: false,
			readOnly: false,
		};
	}

	public async authorizeAndStartTool(
		handle: DurableToolHandle,
		grant: ToolExecutionAuthorizationGrant,
		tool: AgentTool,
	): Promise<DurableToolHandle> {
		assertGrantMatchesHandle(handle, grant);
		await this.append("sandbox.resolved", {
			requestId: grant.authorization.requestId,
			profileId: grant.sandbox.profileId,
			requested: grant.sandbox.requested,
			resolved: grant.sandbox.resolved,
			policyDigest: grant.sandbox.policyDigest,
			resolutionReceiptId: grant.sandbox.receiptId,
			backendId: grant.sandbox.backendId,
			effectiveEnforcement: grant.sandbox.effectiveEnforcement,
			...(grant.sandbox.reasonDigest ? { reasonDigest: grant.sandbox.reasonDigest } : {}),
		} as unknown as RuntimeEventPayloadMap["sandbox.resolved"]);
		await this.append("tool.authorized", {
			toolCallId: handle.toolCallId,
			requestId: grant.authorization.requestId,
			decisionReceiptId: grant.authorization.receiptId,
			approvalId: grant.authorization.approvalId,
			sessionId: grant.authorization.sessionId,
			runtimeId: grant.authorization.runtimeId,
			runtimeGeneration: grant.authorization.runtimeGeneration,
			turnId: grant.authorization.turnId,
			capability: grant.capability,
			requestDigest: grant.authorization.requestDigest,
			policyDigest: grant.policyDigest,
			workspaceEnvelopeDigest: grant.workspaceEnvelopeDigest,
			sandboxResolutionReceiptId: grant.sandbox.receiptId,
		} as unknown as RuntimeEventPayloadMap["tool.authorized"]);
		await this.append("tool.started", {
			toolCallId: handle.toolCallId,
			invocationDigest: grant.invocationDigest,
			workspaceReceiptId: grant.workspaceValidation.receiptId,
		});
		return { ...handle, started: true, readOnly: tool.isReadOnly?.() === true };
	}

	public async recordToolSandboxExecution(
		handle: DurableToolHandle,
		grant: ToolExecutionAuthorizationGrant,
		receipt: import("../protocol/v3/capability.ts").SandboxExecutionReceiptRef,
	): Promise<void> {
		assertGrantMatchesHandle(handle, grant);
		if (
			!handle.started ||
			receipt.requestId !== grant.authorization.requestId ||
			receipt.profileId !== grant.sandbox.profileId ||
			receipt.policyDigest !== grant.policyDigest ||
			receipt.invocationDigest !== grant.invocationDigest ||
			receipt.effectiveEnforcement === "unavailable"
		) throw new DurableQueueBindingError("sandbox execution receipt is unavailable or not correlated to the authorized tool");
		await this.append("sandbox.execution_recorded", {
			requestId: receipt.requestId,
			invocationDigest: receipt.invocationDigest,
			receipt,
			toolCallId: handle.toolCallId,
		} as unknown as RuntimeEventPayloadMap["sandbox.execution_recorded"]);
	}

	public async finishTool(handle: DurableToolHandle, result: ToolResultContent): Promise<void> {
		await this.append("tool.finished", {
			toolCallId: handle.toolCallId,
			resultDigest: digestJsonCompatible(result),
			...(result.artifactRef ? { artifactId: result.artifactRef.artifactId } : {}),
		});
	}

	public async failTool(handle: DurableToolHandle, error: unknown, outcomeCertain: boolean): Promise<void> {
		await this.append("tool.failed", {
			toolCallId: handle.toolCallId,
			error: errorPayload(error),
			outcomeCertain,
		});
	}

	public async interruptTool(handle: DurableToolHandle, reason: string, outcomeCertain: boolean): Promise<void> {
		await this.append("tool.interrupted", {
			toolCallId: handle.toolCallId,
			reason: reason.slice(0, 512) || "interrupted",
			outcomeCertain,
		});
	}

	public finishTurn(turn: DurableTurnHandle, result: unknown, stopReason: string): Promise<void> {
		return this.withQueueMutation(async () => {
			await this.append("turn.finished", {
				turnId: turn.turnId,
				resultDigest: digestJsonCompatible(result),
				stopReason: boundedToken(stopReason),
			});
			if (this.activeTurnId === turn.turnId) this.activeTurnId = null;
		});
	}

	public interruptTurn(turn: DurableTurnHandle, reason: string): Promise<void> {
		return this.withQueueMutation(async () => {
			await this.append("turn.interrupted", { turnId: turn.turnId, reason: reason.slice(0, 512) || "interrupted" });
			if (this.activeTurnId === turn.turnId) this.activeTurnId = null;
		});
	}

	public failTurn(turn: DurableTurnHandle, error: unknown): Promise<void> {
		return this.withQueueMutation(async () => {
			await this.append("turn.failed", { turnId: turn.turnId, error: errorPayload(error) });
			if (this.activeTurnId === turn.turnId) this.activeTurnId = null;
		});
	}

	public flush(): Promise<SessionResult<DurableEventReceipt | undefined>> {
		return this.writer.flush();
	}
}
