/** 活跃 session 每次副作用前的外部 receipt 持续复核与 fail-closed latch。 */

import {
	auditReceiptMatchesApproval,
	auditReceiptMatchesWorkspaceLease,
	isExternalReceiptReferenceSet,
	type ExternalReceiptAuditReceipt,
	type LifecycleError,
	type LifecycleResult,
	type StartupExternalReceiptAuditPort,
	type StartupExternalReferenceSourcePort,
} from "./recovery.ts";
import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import {
	sameRuntimeEventStream,
	type EventCursor,
} from "../protocol/v3/events.ts";
import {
	createRuntimeId,
	type AuthorityId,
	type SessionId,
	type TenantId,
} from "../protocol/v3/ids.ts";
import type {
	AgentLoopConfig,
	ToolExecutionAuthorizationResult,
	ToolExecutionGatewayExecuteRequest,
	ToolExecutionGatewayExecuteResult,
	ToolExecutionGatewayPort,
} from "../types.ts";
import type { AgentToolUpdateCallback } from "../types.ts";

export type SessionMutationKind =
	| "model_request"
	| "tool_authorize"
	| "tool_execute"
	| "child_spawn"
	| "session_fork";

export interface SessionMutationAdmissionRequest {
	kind: SessionMutationKind;
	correlationId: string;
	expectedHead?: EventCursor;
}

export interface SessionMutationAdmissionReceipt {
	schemaVersion: 1;
	authorityId: AuthorityId;
	tenantId: TenantId;
	sessionId: SessionId;
	kind: SessionMutationKind;
	correlationId: string;
	eventHead: EventCursor;
	checkedAt: string;
	auditReceipts: readonly ExternalReceiptAuditReceipt[];
	receiptDigest: string;
}

export interface SessionMutationAdmissionGatePort {
	revalidate(
		request: SessionMutationAdmissionRequest,
		signal?: AbortSignal,
	): Promise<LifecycleResult<SessionMutationAdmissionReceipt>>;
}

export interface ContinuousExternalReceiptMutationGateOptions {
	references: StartupExternalReferenceSourcePort;
	auditor: StartupExternalReceiptAuditPort;
	scope: { authorityId: AuthorityId; tenantId: TenantId; sessionId: SessionId };
	currentHead: () => EventCursor | undefined;
	clock?: () => Date;
	externalOperationTimeoutMs?: number;
	externalScanTimeoutMs?: number;
}

type ExternalCallResult<T> =
	| { kind: "value"; value: T }
	| { kind: "unavailable"; cause: "aborted" | "throw" | "timeout" };

const MUTATION_KINDS: ReadonlySet<string> = new Set<SessionMutationKind>([
	"model_request",
	"tool_authorize",
	"tool_execute",
	"child_spawn",
	"session_fork",
]);

function sameCursor(left: EventCursor, right: EventCursor): boolean {
	return sameRuntimeEventStream(left.stream, right.stream) &&
		left.sequence === right.sequence &&
		left.eventId === right.eventId &&
		left.eventHash === right.eventHash;
}

function failure(
	code: LifecycleError["code"],
	message: string,
): LifecycleResult<never> {
	return { ok: false, error: { code, message, retryable: false } };
}

async function boundedExternalCall<T>(
	operation: (signal: AbortSignal) => Promise<T>,
	parentSignal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<ExternalCallResult<T>> {
	if (parentSignal?.aborted) return { kind: "unavailable", cause: "aborted" };
	const controller = new AbortController();
	let resolveParentAbort: ((result: ExternalCallResult<T>) => void) | undefined;
	const parentAbort = new Promise<ExternalCallResult<T>>((resolve) => {
		resolveParentAbort = resolve;
	});
	const onParentAbort = () => {
		controller.abort(parentSignal?.reason);
		resolveParentAbort?.({ kind: "unavailable", cause: "aborted" });
	};
	parentSignal?.addEventListener("abort", onParentAbort, { once: true });
	let timer: ReturnType<typeof setTimeout> | undefined;
	const work = Promise.resolve()
		.then(() => operation(controller.signal))
		.then(
			(value): ExternalCallResult<T> => ({ kind: "value", value }),
			(): ExternalCallResult<T> => ({ kind: "unavailable", cause: "throw" }),
		);
	const deadline = new Promise<ExternalCallResult<T>>((resolve) => {
		timer = setTimeout(() => {
			controller.abort("session_mutation_external_operation_timeout");
			resolve({ kind: "unavailable", cause: "timeout" });
		}, timeoutMs);
	});
	try {
		return await Promise.race([work, deadline, parentAbort]);
	} finally {
		if (timer) clearTimeout(timer);
		parentSignal?.removeEventListener("abort", onParentAbort);
	}
}

function duplicateReferenceIds(
	workspaceIds: readonly string[],
	approvalIds: readonly string[],
): boolean {
	return new Set(workspaceIds).size !== workspaceIds.length ||
		new Set(approvalIds).size !== approvalIds.length;
}

export class ContinuousExternalReceiptMutationGate implements SessionMutationAdmissionGatePort {
	readonly #references: StartupExternalReferenceSourcePort;
	readonly #auditor: StartupExternalReceiptAuditPort;
	readonly #scope: ContinuousExternalReceiptMutationGateOptions["scope"];
	readonly #currentHead: () => EventCursor | undefined;
	readonly #clock: () => Date;
	readonly #externalOperationTimeoutMs: number;
	readonly #externalScanTimeoutMs: number;
	#latchedError: LifecycleError | undefined;
	#queue: Promise<void> = Promise.resolve();

	public constructor(options: ContinuousExternalReceiptMutationGateOptions) {
		this.#references = options.references;
		this.#auditor = options.auditor;
		this.#scope = { ...options.scope };
		this.#currentHead = options.currentHead;
		this.#clock = options.clock ?? (() => new Date());
		this.#externalOperationTimeoutMs = options.externalOperationTimeoutMs ?? 5_000;
		this.#externalScanTimeoutMs = options.externalScanTimeoutMs ?? 30_000;
		for (const [name, value] of [
			["external operation", this.#externalOperationTimeoutMs],
			["external scan", this.#externalScanTimeoutMs],
		] as const) {
			if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
				throw new TypeError(`session mutation ${name} timeout is outside the supported range`);
			}
		}
	}

	public isLatched(): boolean {
		return this.#latchedError !== undefined;
	}

	public revalidate(
		request: SessionMutationAdmissionRequest,
		signal?: AbortSignal,
	): Promise<LifecycleResult<SessionMutationAdmissionReceipt>> {
		const operation = this.#queue.then(async () => {
			try {
				return await this.#revalidateOne(request, signal);
			} catch {
				return this.#latch({
					code: "external_unavailable",
					message: "session mutation admission failed without a trustworthy receipt",
					retryable: false,
				});
			}
		});
		this.#queue = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	#latch(error: LifecycleError): LifecycleResult<never> {
		this.#latchedError ??= { ...error, retryable: false };
		return { ok: false, error: { ...this.#latchedError } };
	}

	#remainingMs(deadline: number): number {
		return Math.max(0, deadline - Date.now());
	}

	async #call<T>(
		operation: (signal: AbortSignal) => Promise<T>,
		parentSignal: AbortSignal | undefined,
		deadline: number,
	): Promise<LifecycleResult<T>> {
		const timeoutMs = Math.min(this.#externalOperationTimeoutMs, this.#remainingMs(deadline));
		if (timeoutMs < 1) return failure("timeout", "session mutation external receipt scan timed out");
		const result = await boundedExternalCall(operation, parentSignal, timeoutMs);
		if (result.kind === "value") return { ok: true, value: result.value };
		return failure(
			result.cause === "timeout" ? "timeout" : "external_unavailable",
			`session mutation external receipt scan ${result.cause}`,
		);
	}

	async #revalidateOne(
		request: SessionMutationAdmissionRequest,
		signal?: AbortSignal,
	): Promise<LifecycleResult<SessionMutationAdmissionReceipt>> {
		if (this.#latchedError) return { ok: false, error: { ...this.#latchedError } };
		if (!MUTATION_KINDS.has(request.kind) ||
			typeof request.correlationId !== "string" ||
			request.correlationId.length < 1 ||
			request.correlationId.length > 256) {
			return this.#latch({
				code: "invalid_request",
				message: "session mutation admission request is invalid",
				retryable: false,
			});
		}
		if (signal?.aborted) {
			return this.#latch({
				code: "external_unavailable",
				message: "session mutation admission was aborted",
				retryable: false,
			});
		}
		const before = this.#currentHead();
		if (!before) {
			return this.#latch({
				code: "integrity_failed",
				message: "session mutation admission requires a canonical event head",
				retryable: false,
			});
		}
		if (request.expectedHead && !sameCursor(before, request.expectedHead)) {
			return this.#latch({
				code: "mutation_failed",
				message: "session mutation expected event head is stale",
				retryable: false,
			});
		}

		const deadline = Date.now() + this.#externalScanTimeoutMs;
		const loadedCall = await this.#call(
			(boundedSignal) => this.#references.loadReferences(this.#scope, boundedSignal),
			signal,
			deadline,
		);
		if (!loadedCall.ok) return this.#latch(loadedCall.error);
		const loaded = loadedCall.value;
		if (!loaded.ok) return this.#latch(loaded.error);
		const references = loaded.value;
		if (!isExternalReceiptReferenceSet(references) ||
			references.authorityId !== this.#scope.authorityId ||
			references.tenantId !== this.#scope.tenantId ||
			references.sessionId !== this.#scope.sessionId ||
			references.completeness !== "complete" ||
			duplicateReferenceIds(
				references.workspaceLeases.flatMap((lease) => [lease.leaseId, lease.workspaceId]),
				references.approvalDecisions.flatMap((approval) => [approval.approvalId, approval.receiptId]),
			)) {
			return this.#latch({
				code: "integrity_failed",
				message: "session mutation external reference set is incomplete or invalid",
				retryable: false,
			});
		}

		const auditReceipts: ExternalReceiptAuditReceipt[] = [];
		const leases = [...references.workspaceLeases]
			.sort((left, right) => left.leaseId.localeCompare(right.leaseId));
		for (const lease of leases) {
			if (lease.state !== "active") {
				return this.#latch({
					code: "integrity_failed",
					message: "session mutation workspace lease is not active",
					retryable: false,
				});
			}
			const auditedCall = await this.#call(
				(boundedSignal) => this.#auditor.auditWorkspaceLease(this.#scope.sessionId, lease, boundedSignal),
				signal,
				deadline,
			);
			if (!auditedCall.ok) return this.#latch(auditedCall.error);
			const audited = auditedCall.value;
			if (!audited.ok) return this.#latch(audited.error);
			if (audited.value.status !== "valid" ||
				!auditReceiptMatchesWorkspaceLease(audited.value, this.#scope.sessionId, lease)) {
				return this.#latch({
					code: "integrity_failed",
					message: "session mutation workspace receipt audit is not an exact valid match",
					retryable: false,
				});
			}
			if (auditReceipts.some((receipt) => receipt.auditReceiptId === audited.value.auditReceiptId)) {
				return this.#latch({
					code: "integrity_failed",
					message: "session mutation audit receipt id was reused",
					retryable: false,
				});
			}
			auditReceipts.push(audited.value);
		}

		const approvals = [...references.approvalDecisions]
			.sort((left, right) => left.receiptId.localeCompare(right.receiptId));
		for (const approval of approvals) {
			const auditedCall = await this.#call(
				(boundedSignal) => this.#auditor.auditApprovalDecision(this.#scope.sessionId, approval, boundedSignal),
				signal,
				deadline,
			);
			if (!auditedCall.ok) return this.#latch(auditedCall.error);
			const audited = auditedCall.value;
			if (!audited.ok) return this.#latch(audited.error);
			if (audited.value.status !== "valid" ||
				!auditReceiptMatchesApproval(audited.value, this.#scope.sessionId, approval)) {
				return this.#latch({
					code: "integrity_failed",
					message: "session mutation approval receipt audit is not an exact valid match",
					retryable: false,
				});
			}
			const expired = approval.expiresAt !== undefined &&
				Date.parse(approval.expiresAt) <= this.#clock().getTime();
			if (approval.decision !== "allowed" || expired) {
				return this.#latch({
					code: "integrity_failed",
					message: "session mutation approval receipt is no longer allowed",
					retryable: false,
				});
			}
			if (auditReceipts.some((receipt) => receipt.auditReceiptId === audited.value.auditReceiptId)) {
				return this.#latch({
					code: "integrity_failed",
					message: "session mutation audit receipt id was reused",
					retryable: false,
				});
			}
			auditReceipts.push(audited.value);
		}

		const after = this.#currentHead();
		if (!after || !sameCursor(before, after)) {
			return this.#latch({
				code: "mutation_uncertain",
				message: "session canonical event head changed during external receipt audit",
				retryable: false,
			});
		}
		const body = {
			schemaVersion: 1 as const,
			...this.#scope,
			kind: request.kind,
			correlationId: request.correlationId,
			eventHead: { ...after, stream: { ...after.stream } },
			checkedAt: this.#clock().toISOString(),
			auditReceipts: auditReceipts.map((receipt) => structuredClone(receipt)),
		};
		return { ok: true, value: { ...body, receiptDigest: canonicalDigest(body) } };
	}
}

export class SessionMutationAdmissionError extends Error {
	public readonly lifecycleError: LifecycleError;

	public constructor(error: LifecycleError) {
		super(error.message);
		this.name = "SessionMutationAdmissionError";
		this.lifecycleError = { ...error };
	}
}

export function mutationGatedModelPreparation(
	gate: SessionMutationAdmissionGatePort,
	delegate: NonNullable<AgentLoopConfig["prepareModelRequest"]>,
): NonNullable<AgentLoopConfig["prepareModelRequest"]> {
	return async (request, signal) => {
		if (!request.modelRequestId) {
			throw new SessionMutationAdmissionError({
				code: "invalid_request",
				message: "governed model request is missing its durable correlation id",
				retryable: false,
			});
		}
		const admitted = await gate.revalidate({
			kind: "model_request",
			correlationId: request.modelRequestId,
		}, signal);
		if (!admitted.ok) throw new SessionMutationAdmissionError(admitted.error);
		return delegate(request, signal);
	};
}

export class MutationGatedToolExecutionGateway implements ToolExecutionGatewayPort {
	readonly #gate: SessionMutationAdmissionGatePort;
	readonly #delegate: ToolExecutionGatewayPort;

	public constructor(gate: SessionMutationAdmissionGatePort, delegate: ToolExecutionGatewayPort) {
		this.#gate = gate;
		this.#delegate = delegate;
	}

	public async authorize(
		request: Parameters<ToolExecutionGatewayPort["authorize"]>[0],
		signal?: AbortSignal,
	): Promise<ToolExecutionAuthorizationResult> {
		const admitted = await this.#gate.revalidate({
			kind: "tool_authorize",
			correlationId: request.toolCallId,
		}, signal);
		if (!admitted.ok) {
			return {
				status: "unavailable",
				requestId: createRuntimeId("command", `mutation-gate-${canonicalDigest({
					kind: "tool_authorize",
					toolCallId: request.toolCallId,
					error: admitted.error,
				}).slice(0, 48)}`),
				reason: admitted.error.message,
			};
		}
		return this.#delegate.authorize(request, signal);
	}

	public async execute(
		request: ToolExecutionGatewayExecuteRequest,
		onUpdate: AgentToolUpdateCallback,
		signal?: AbortSignal,
	): Promise<ToolExecutionGatewayExecuteResult> {
		return this.#delegate.execute(request, onUpdate, signal);
	}

	public async start(
		request: Parameters<ToolExecutionGatewayPort["start"]>[0],
		durableStart: Parameters<ToolExecutionGatewayPort["start"]>[1],
		signal?: AbortSignal,
	): ReturnType<ToolExecutionGatewayPort["start"]> {
		const admitted = await this.#gate.revalidate({
			kind: "tool_execute",
			correlationId: request.invocation.toolCallId,
		}, signal);
		if (!admitted.ok) {
			return {
				status: "unavailable",
				grantDigest: request.grant.grantDigest,
				reason: admitted.error.message,
				outcomeCertain: true,
			};
		}
		return this.#delegate.start(request, durableStart, signal);
	}
}
