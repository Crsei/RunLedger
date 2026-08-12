/** S3:Session Event Store-backed approval receipt 与可重连 reverse request。 */

import {
	createRuntimeId,
	isApprovalReceiptRef,
	type ApprovalId,
	type ApprovalReceiptRef,
	type ConnectionId,
	type RuntimeDigest,
	type SessionId,
} from "../contracts/public.ts";
import type { SessionFrameEnvelope } from "../session-server/protocol.ts";
import type { OwnerFence } from "../session-owner/types.ts";
import {
	verifyOwnerFence,
	type SessionStore,
} from "../../storage/session-store/session-store.ts";
import type {
	ApprovalAmendmentStateStorePort,
	ApprovalAuditPort,
	ExecPrefixApproval,
	NetworkApprovalRule,
	NetworkRuleApproval,
} from "../../security/permission/approval-coordinator.ts";
import { execPrefixRuleMatches, type ExecPrefixRule } from "../../security/permission/exec-prefix-rule.ts";
import type { NetworkApprovalKey } from "../../security/network/network-approval.ts";
import type {
	PermissionPrompt,
	PermissionPrompter,
	PermissionPromptResponse,
	SecurityResult,
} from "../../security/types.ts";
import type { ReverseRequestSender } from "./credential-reverse-request.ts";
import { decodePermissionPromptResponse } from "../../security/permission/approval-response.ts";

export const APPROVAL_REVERSE_REQUEST_KIND = "approval_prompt" as const;

export interface SessionApprovalPorts {
	readonly prompter: PermissionPrompter;
	readonly stateStore: ApprovalAmendmentStateStorePort;
	readonly audit: ApprovalAuditPort;
}

export interface SessionApprovalPortsOptions {
	readonly store: SessionStore;
	readonly fence: OwnerFence;
	readonly sender: ReverseRequestSender;
	readonly driverConnectionId: () => ConnectionId | undefined;
	readonly pollIntervalMs?: number;
	readonly humanInputWait?: HumanInputWaitPort;
}

export interface HumanInputWaitPort {
	withHumanInputWait<T>(waitId: string, reason: "approval" | "credential", operation: () => Promise<T>): Promise<T>;
}

/** Approval ports 早于 SessionRuntime 装配；绑定前必须拒绝等待，不能绕过计时。 */
export class LateBoundHumanInputWaitPort implements HumanInputWaitPort {
	private current: HumanInputWaitPort | undefined;

	public bind(port: HumanInputWaitPort): void {
		this.current = port;
	}

	public withHumanInputWait<T>(waitId: string, reason: "approval" | "credential", operation: () => Promise<T>): Promise<T> {
		const target = this.current;
		return target === undefined
			? Promise.reject(new Error("human input wait port is unavailable; Runtime is not bound"))
			: target.withHumanInputWait(waitId, reason, operation);
	}
}

export function createSessionApprovalPorts(options: SessionApprovalPortsOptions): SessionApprovalPorts {
	const stateStore = new SessionApprovalStateStore(options.store, options.fence);
	return {
		prompter: new SessionReverseApprovalPrompter(options),
		stateStore,
		audit: new SessionApprovalAudit(options.store, options.fence),
	};
}

class SessionApprovalStateStore implements ApprovalAmendmentStateStorePort {
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
		return this.#commitRecord(receipt, expectedRevision, {});
	}

	public async findExecPrefixApproval(input: { readonly sessionId: SessionId; readonly policyDigest: RuntimeDigest; readonly command: string }): Promise<ExecPrefixApproval | undefined> {
		for (const event of [...this.#store.replaySessionEvents(this.#fence.sessionId)].reverse()) {
			if (event.eventType !== "approval.decided") continue;
			let payload: unknown;
			try { payload = JSON.parse(event.payloadJson) as unknown; } catch { continue; }
			const record = recordValue(payload);
			const receipt = record.receipt;
			const rule = record.execPrefixRule;
			if (isApprovalReceiptRef(receipt) && isExecPrefixRule(rule) && receipt.decision === "allowed" && execPrefixRuleMatches(rule, input.command, input.sessionId, input.policyDigest)) {
				return { receipt, rule };
			}
		}
		return undefined;
	}

	public async commitWithExecPrefixRule(receipt: ApprovalReceiptRef, expectedRevision: number, rule: ExecPrefixRule): Promise<SecurityResult<ExecPrefixApproval>> {
		if (!isExecPrefixRule(rule) || receipt.scope !== "session" || receipt.decision !== "allowed") return approvalFailure("exec prefix amendment failed validation");
		const committed = await this.#commitRecord(receipt, expectedRevision, { execPrefixRule: rule });
		return committed.ok ? { ok: true, value: { receipt: committed.value, rule } } : committed;
	}

	public async findNetworkApproval(input: { readonly sessionId: SessionId; readonly policyDigest: RuntimeDigest; readonly key: NetworkApprovalKey }): Promise<NetworkRuleApproval | undefined> {
		for (const event of [...this.#store.replaySessionEvents(this.#fence.sessionId)].reverse()) {
			if (event.eventType !== "approval.decided") continue;
			let payload: unknown;
			try { payload = JSON.parse(event.payloadJson) as unknown; } catch { continue; }
			const record = recordValue(payload);
			const receipt = record.receipt;
			const rule = record.networkRule;
			if (isApprovalReceiptRef(receipt) && isNetworkApprovalRule(rule) && receipt.decision === "allowed" && rule.sessionId === input.sessionId &&
				rule.policyDigest.digest === input.policyDigest.digest && sameNetworkKey(rule.key, input.key)) return { receipt, rule };
		}
		return undefined;
	}

	public async commitWithNetworkRule(receipt: ApprovalReceiptRef, expectedRevision: number, rule: NetworkApprovalRule): Promise<SecurityResult<NetworkRuleApproval>> {
		if (!isNetworkApprovalRule(rule) || receipt.scope !== "session" || receipt.decision !== "allowed") return approvalFailure("network amendment failed validation");
		const committed = await this.#commitRecord(receipt, expectedRevision, { networkRule: rule });
		return committed.ok ? { ok: true, value: { receipt: committed.value, rule } } : committed;
	}

	async #commitRecord(receipt: ApprovalReceiptRef, expectedRevision: number, amendments: { readonly execPrefixRule?: ExecPrefixRule; readonly networkRule?: NetworkApprovalRule }): Promise<SecurityResult<ApprovalReceiptRef>> {
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
			{ receipt, ...amendments },
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
		const operation = (): Promise<PermissionPromptResponse> => this.#request(prompt, signal);
		return this.#options.humanInputWait === undefined
			? operation()
			: this.#options.humanInputWait.withHumanInputWait(`approval-${prompt.requestId}`, "approval", operation);
	}

	async #request(prompt: PermissionPrompt, signal?: AbortSignal): Promise<PermissionPromptResponse> {
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
							requests: prompt.requests,
						cwd: prompt.cwd,
						expiresAt: prompt.expiresAt,
					},
				}, Math.max(1, deadline - Date.now()));
				this.#assertFence();
					const decidedBy = createRuntimeId("principal", `session-driver-${connectionId.slice(-64)}`);
					const decision = decodePermissionPromptResponse(frame.body, decidedBy);
					if (decision === undefined) {
						throw new Error("approval reverse response is invalid");
					}
					return decision.decision === "deny" && decision.reason === undefined
						? { ...decision, reason: "driver denied the request" }
						: decision;
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

function isExecPrefixRule(value: unknown): value is ExecPrefixRule {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const rule = value as Readonly<Record<string, unknown>>;
	return typeof rule.sessionId === "string" && isDigest(rule.policyDigest) && Array.isArray(rule.prefix) && rule.prefix.length > 0 &&
		rule.prefix.every((token) => typeof token === "string" && /^[A-Za-z0-9_./:@%+=,-]+$/u.test(token));
}

function isNetworkApprovalRule(value: unknown): value is NetworkApprovalRule {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const rule = value as Readonly<Record<string, unknown>>;
	if (typeof rule.sessionId !== "string" || !isDigest(rule.policyDigest) || typeof rule.key !== "object" || rule.key === null || Array.isArray(rule.key)) return false;
	const key = rule.key as Readonly<Record<string, unknown>>;
	return typeof key.host === "string" && (key.protocol === "http" || key.protocol === "https" || key.protocol === "socks5-tcp" || key.protocol === "socks5-udp") && Number.isSafeInteger(key.port);
}

function isDigest(value: unknown): value is ExecPrefixRule["policyDigest"] {
	return typeof value === "object" && value !== null && !Array.isArray(value) &&
		(value as Readonly<Record<string, unknown>>).algorithm === "sha256" &&
		typeof (value as Readonly<Record<string, unknown>>).digest === "string" && /^[a-f0-9]{64}$/u.test((value as Readonly<Record<string, unknown>>).digest as string);
}

function sameNetworkKey(left: NetworkApprovalKey, right: NetworkApprovalKey): boolean {
	return left.host === right.host && left.protocol === right.protocol && left.port === right.port;
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
