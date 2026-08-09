/** S3:Session Event Store-backed approval receipt 与可重连 reverse request。 */

import {
	createRuntimeId,
	isApprovalReceiptRef,
	type ApprovalId,
	type ApprovalReceiptRef,
	type ConnectionId,
} from "../contracts/public.ts";
import type { SessionFrameEnvelope } from "../session-server/protocol.ts";
import type { OwnerFence } from "../session-owner/types.ts";
import {
	verifyOwnerFence,
	type SessionStore,
} from "../../storage/session-store/session-store.ts";
import type {
	ApprovalAuditPort,
	ApprovalStateStorePort,
} from "../../security/permission/approval-coordinator.ts";
import type {
	PermissionPrompt,
	PermissionPrompter,
	PermissionPromptResponse,
	SecurityResult,
} from "../../security/types.ts";
import type { ReverseRequestSender } from "./credential-reverse-request.ts";

export const APPROVAL_REVERSE_REQUEST_KIND = "approval_prompt" as const;

export interface SessionApprovalPorts {
	readonly prompter: PermissionPrompter;
	readonly stateStore: ApprovalStateStorePort;
	readonly audit: ApprovalAuditPort;
}

export interface SessionApprovalPortsOptions {
	readonly store: SessionStore;
	readonly fence: OwnerFence;
	readonly sender: ReverseRequestSender;
	readonly driverConnectionId: () => ConnectionId | undefined;
	readonly pollIntervalMs?: number;
}

export function createSessionApprovalPorts(options: SessionApprovalPortsOptions): SessionApprovalPorts {
	const stateStore = new SessionApprovalStateStore(options.store, options.fence);
	return {
		prompter: new SessionReverseApprovalPrompter(options),
		stateStore,
		audit: new SessionApprovalAudit(options.store, options.fence),
	};
}

class SessionApprovalStateStore implements ApprovalStateStorePort {
	readonly #store: SessionStore;
	readonly #fence: OwnerFence;

	public constructor(store: SessionStore, fence: OwnerFence) {
		this.#store = store;
		this.#fence = fence;
	}

	public async read(approvalId: ApprovalId): Promise<ApprovalReceiptRef | undefined> {
		const events = this.#store.replaySessionEvents(this.#fence.sessionId);
		for (let index = events.length - 1; index >= 0; index -= 1) {
			const event = events[index]!;
			if (event.eventType !== "approval.decided" && event.eventType !== "approval.revoked") continue;
			let payload: unknown;
			try { payload = JSON.parse(event.payloadJson) as unknown; } catch { continue; }
			const receipt = recordValue(payload).receipt;
			if (isApprovalReceiptRef(receipt) && receipt.approvalId === approvalId) return receipt;
		}
		return undefined;
	}

	public async commit(receipt: ApprovalReceiptRef, expectedRevision: number): Promise<SecurityResult<ApprovalReceiptRef>> {
		if (!isApprovalReceiptRef(receipt)) return approvalFailure("approval receipt failed Runtime validation");
		const current = await this.read(receipt.approvalId);
		if ((current?.decisionRevision ?? 0) !== expectedRevision || receipt.decisionRevision !== expectedRevision + 1) {
			return approvalFailure("approval receipt CAS conflict");
		}
		if (current !== undefined && (
			current.requestDigest.digest !== receipt.requestDigest.digest ||
			current.scope !== receipt.scope ||
			current.principalId !== receipt.principalId
		)) return approvalFailure("approval receipt binding changed");
		appendApprovalEvent(
			this.#store,
			this.#fence,
			receipt.decision === "revoked" ? "approval.revoked" : "approval.decided",
			`decision-${receipt.approvalId}-${receipt.decisionRevision}`,
			{ receipt },
		);
		return { ok: true, value: receipt };
	}
}

class SessionApprovalAudit implements ApprovalAuditPort {
	readonly #store: SessionStore;
	readonly #fence: OwnerFence;

	public constructor(store: SessionStore, fence: OwnerFence) {
		this.#store = store;
		this.#fence = fence;
	}

	public async requested(input: Parameters<ApprovalAuditPort["requested"]>[0]): Promise<void> {
		appendApprovalEvent(this.#store, this.#fence, "approval.requested", `request-${input.ticket.approvalId}`, {
			ticket: input.ticket,
			toolName: input.request.toolName,
			argumentsDigest: input.request.argumentsDigest,
			policyDigest: input.request.snapshot.policyDigest,
		});
	}

	/** decision/revocation 由 stateStore.commit 与 receipt 同一 durable append 完成。 */
	public async decided(_input: Parameters<ApprovalAuditPort["decided"]>[0]): Promise<void> {}
	public async revoked(_input: Parameters<ApprovalAuditPort["revoked"]>[0]): Promise<void> {}
}

class SessionReverseApprovalPrompter implements PermissionPrompter {
	readonly #options: SessionApprovalPortsOptions;
	readonly #pollIntervalMs: number;

	public constructor(options: SessionApprovalPortsOptions) {
		this.#options = options;
		this.#pollIntervalMs = Math.max(1, Math.min(250, options.pollIntervalMs ?? 25));
	}

	public async request(prompt: PermissionPrompt, signal?: AbortSignal): Promise<PermissionPromptResponse> {
		const deadline = Date.parse(prompt.expiresAt);
		if (!Number.isFinite(deadline)) throw new Error("approval expiry is invalid");
		while (Date.now() < deadline) {
			this.#assertFence();
			if (signal?.aborted) throw new Error("approval request aborted");
			const connectionId = this.#options.driverConnectionId();
			if (connectionId === undefined) {
				await waitForDriver(Math.min(this.#pollIntervalMs, Math.max(1, deadline - Date.now())), signal);
				continue;
			}
			try {
				const frame = await this.#options.sender.requestToConnection(connectionId, {
					kind: APPROVAL_REVERSE_REQUEST_KIND,
					body: {
						requestType: "permission",
						toolName: prompt.toolName,
						summary: prompt.summary,
						cwd: prompt.cwd,
						expiresAt: prompt.expiresAt,
					},
				}, Math.max(1, deadline - Date.now()));
				this.#assertFence();
				const decision = frame.body.ok === true ? frame.body.decision : undefined;
				if (decision !== "allow-once" && decision !== "deny" && decision !== "cancel") {
					throw new Error("approval reverse response is invalid");
				}
				const decidedBy = createRuntimeId("principal", `session-driver-${connectionId.slice(-64)}`);
				return decision === "deny"
					? { decision, decidedBy, reason: "driver denied the request" }
					: { decision, decidedBy };
			} catch (error) {
				this.#assertFence();
				if (signal?.aborted) throw error;
				if (Date.now() >= deadline) break;
				await waitForDriver(Math.min(this.#pollIntervalMs, Math.max(1, deadline - Date.now())), signal);
			}
		}
		throw new Error("approval reverse request timed out");
	}

	#assertFence(): void {
		if (!verifyOwnerFence(this.#options.store.database(), this.#options.fence)) {
			throw new Error("approval response belongs to a stale or fenced owner generation");
		}
	}
}

function appendApprovalEvent(
	store: SessionStore,
	fence: OwnerFence,
	eventType: "approval.requested" | "approval.decided" | "approval.revoked",
	seed: string,
	payload: Record<string, unknown>,
): void {
	const duplicate = store.replaySessionEvents(fence.sessionId).find((event) => event.eventId === createRuntimeId("event", `approval-${seed}`));
	if (duplicate !== undefined) return;
	const tail = store.replaySessionEvents(fence.sessionId).at(-1);
	store.appendEvent(fence, {
		eventId: createRuntimeId("event", `approval-${seed}`),
		ownerGeneration: fence.generation,
		eventType,
		payloadJson: JSON.stringify(payload),
		createdAtMs: Date.now(),
		expectedPreviousEventHash: tail?.currentEventHash ?? null,
	});
}

function approvalFailure(message: string): SecurityResult<never> {
	return { ok: false, error: { code: "approval_stale", message, retryable: false } };
}

function recordValue(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function waitForDriver(delayMs: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(finish, delayMs);
		const abort = (): void => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			reject(new Error("approval request aborted"));
		};
		function finish(): void {
			signal?.removeEventListener("abort", abort);
			resolve();
		}
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});
}
