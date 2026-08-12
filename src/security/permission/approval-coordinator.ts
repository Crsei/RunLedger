/** ask -> exact prompt -> one-shot Runtime approval receipt。 */

import {
	canonicalDigest,
	createRuntimeId,
	isApprovalReceiptRef,
	runtimeDigest,
} from "../../runtime/contracts/public.ts";
import type {
	ApprovalId,
	ApprovalReceiptRef,
	ApprovalTicket,
	PrincipalId,
	RuntimeDigest,
	SessionId,
} from "../../runtime/contracts/public.ts";
import type {
	AuthorizationRequest,
	AuthorizationResult,
	PermissionPrompt,
	PermissionPromptResponse,
	PermissionPrompter,
	SecurityAccessEvaluation,
	SecurityResult,
} from "../types.ts";
import {
	execPrefixRuleMatches,
	isDangerousExecCommand,
	validateExecPrefixRule,
	type ExecPrefixRule,
} from "./exec-prefix-rule.ts";
import { normalizeNetworkApprovalKey, type NetworkApprovalKey } from "../network/network-approval.ts";

export const SYSTEM_APPROVAL_PRINCIPAL_ID = createRuntimeId("principal", "runledger-system-approval");

export interface ApprovalStateStorePort {
	read(approvalId: ApprovalId): Promise<ApprovalReceiptRef | undefined>;
	commit(receipt: ApprovalReceiptRef, expectedRevision: number): Promise<SecurityResult<ApprovalReceiptRef>>;
}

export interface ExecPrefixApproval {
	readonly rule: ExecPrefixRule;
	readonly receipt: ApprovalReceiptRef;
}

export interface NetworkApprovalRule {
	readonly sessionId: SessionId;
	readonly policyDigest: RuntimeDigest;
	readonly key: NetworkApprovalKey;
}

export interface NetworkRuleApproval {
	readonly rule: NetworkApprovalRule;
	readonly receipt: ApprovalReceiptRef;
}

export interface ApprovalAmendmentStateStorePort extends ApprovalStateStorePort {
	findExecPrefixApproval(input: { readonly sessionId: SessionId; readonly policyDigest: RuntimeDigest; readonly command: string }): Promise<ExecPrefixApproval | undefined>;
	commitWithExecPrefixRule(receipt: ApprovalReceiptRef, expectedRevision: number, rule: ExecPrefixRule): Promise<SecurityResult<ExecPrefixApproval>>;
	findNetworkApproval(input: { readonly sessionId: SessionId; readonly policyDigest: RuntimeDigest; readonly key: NetworkApprovalKey }): Promise<NetworkRuleApproval | undefined>;
	commitWithNetworkRule(receipt: ApprovalReceiptRef, expectedRevision: number, rule: NetworkApprovalRule): Promise<SecurityResult<NetworkRuleApproval>>;
}

export interface ApprovalAuditPort {
	requested(input: { readonly request: AuthorizationRequest; readonly ticket: ApprovalTicket }): Promise<void>;
	decided(input: { readonly request: AuthorizationRequest; readonly ticket: ApprovalTicket; readonly receipt: ApprovalReceiptRef }): Promise<void>;
	revoked(input: { readonly request: AuthorizationRequest; readonly receipt: ApprovalReceiptRef }): Promise<void>;
}

export class MemoryApprovalStateStore implements ApprovalAmendmentStateStorePort {
	readonly #receipts = new Map<ApprovalId, ApprovalReceiptRef>();
	readonly #execPrefixApprovals: ExecPrefixApproval[] = [];
	readonly #networkApprovals: NetworkRuleApproval[] = [];

	public async read(approvalId: ApprovalId): Promise<ApprovalReceiptRef | undefined> {
		const receipt = this.#receipts.get(approvalId);
		return receipt ? structuredClone(receipt) : undefined;
	}

	public async commit(receipt: ApprovalReceiptRef, expectedRevision: number): Promise<SecurityResult<ApprovalReceiptRef>> {
		const checked = this.#validateCommit(receipt, expectedRevision);
		if (!checked.ok) return checked;
		const stored = structuredClone(receipt);
		this.#receipts.set(receipt.approvalId, stored);
		return { ok: true, value: structuredClone(stored) };
	}

	public async findExecPrefixApproval(input: { readonly sessionId: SessionId; readonly policyDigest: RuntimeDigest; readonly command: string }): Promise<ExecPrefixApproval | undefined> {
		const approval = this.#execPrefixApprovals.find((candidate) => execPrefixRuleMatches(candidate.rule, input.command, input.sessionId, input.policyDigest));
		return approval === undefined ? undefined : structuredClone(approval);
	}

	public async commitWithExecPrefixRule(receipt: ApprovalReceiptRef, expectedRevision: number, rule: ExecPrefixRule): Promise<SecurityResult<ExecPrefixApproval>> {
		const checked = this.#validateCommit(receipt, expectedRevision);
		if (!checked.ok) return checked;
		const approval: ExecPrefixApproval = { receipt: structuredClone(receipt), rule: structuredClone(rule) };
		this.#receipts.set(receipt.approvalId, approval.receipt);
		this.#execPrefixApprovals.push(approval);
		return { ok: true, value: structuredClone(approval) };
	}

	public async findNetworkApproval(input: { readonly sessionId: SessionId; readonly policyDigest: RuntimeDigest; readonly key: NetworkApprovalKey }): Promise<NetworkRuleApproval | undefined> {
		const approval = this.#networkApprovals.find((candidate) => candidate.rule.sessionId === input.sessionId &&
			candidate.rule.policyDigest.digest === input.policyDigest.digest &&
			canonicalDigest(candidate.rule.key) === canonicalDigest(input.key));
		return approval === undefined ? undefined : structuredClone(approval);
	}

	public async commitWithNetworkRule(receipt: ApprovalReceiptRef, expectedRevision: number, rule: NetworkApprovalRule): Promise<SecurityResult<NetworkRuleApproval>> {
		const checked = this.#validateCommit(receipt, expectedRevision);
		if (!checked.ok) return checked;
		const approval: NetworkRuleApproval = { receipt: structuredClone(receipt), rule: structuredClone(rule) };
		this.#receipts.set(receipt.approvalId, approval.receipt);
		this.#networkApprovals.push(approval);
		return { ok: true, value: structuredClone(approval) };
	}

	#validateCommit(receipt: ApprovalReceiptRef, expectedRevision: number): SecurityResult<true> {
		if (!isApprovalReceiptRef(receipt)) return failure("approval receipt failed Runtime validation", "approval_stale");
		const current = this.#receipts.get(receipt.approvalId);
		const currentRevision = current?.decisionRevision ?? 0;
		if (currentRevision !== expectedRevision || receipt.decisionRevision !== expectedRevision + 1) {
			return failure("approval receipt CAS conflict", "approval_stale");
		}
		if (current && (
			current.requestDigest.digest !== receipt.requestDigest.digest ||
			current.scope !== receipt.scope ||
			current.principalId !== receipt.principalId
		)) return failure("approval receipt binding changed", "approval_stale");
		return { ok: true, value: true };
	}
}

export interface ApprovalCoordinatorOptions {
	readonly prompter: PermissionPrompter;
	readonly store?: ApprovalStateStorePort;
	/** Host-owned canonical event sink; omitted only for isolated unit tests. */
	readonly audit?: ApprovalAuditPort;
	readonly clock?: () => Date;
	readonly timeoutMs?: number;
}

export interface ApprovalRevalidation {
	readonly argumentsDigest: RuntimeDigest;
	readonly cwd: string;
	readonly policyDigest: RuntimeDigest;
}

export type ApprovalRevalidationPort = () => ApprovalRevalidation | Promise<ApprovalRevalidation>;

type PromptRace =
	| { readonly kind: "response"; readonly response: PermissionPromptResponse }
	| { readonly kind: "abort" }
	| { readonly kind: "timeout" }
	| { readonly kind: "channel" };

function supportsAmendments(store: ApprovalStateStorePort): store is ApprovalAmendmentStateStorePort {
	return "findExecPrefixApproval" in store && typeof store.findExecPrefixApproval === "function" &&
		"commitWithExecPrefixRule" in store && typeof store.commitWithExecPrefixRule === "function" &&
		"findNetworkApproval" in store && typeof store.findNetworkApproval === "function" &&
		"commitWithNetworkRule" in store && typeof store.commitWithNetworkRule === "function";
}

function isAllowResponse(response: PermissionPromptResponse): boolean {
	return response.decision === "allow-once" || response.decision === "allow-session" ||
		response.decision === "allow-with-prefix-rule" || response.decision === "allow-with-network-rule";
}

function failure(message: string, code: "approval_stale" | "approval_cancelled" | "approval_expired"): SecurityResult<never> {
	return { ok: false, error: { code, message, retryable: false } };
}

function requestDigest(request: AuthorizationRequest): RuntimeDigest {
	return runtimeDigest({
		requestId: request.requestId,
		sessionId: request.sessionId,
		toolCallId: request.toolCallId,
		argumentsDigest: request.argumentsDigest,
		cwd: request.cwd,
		requests: request.requests,
		policyDigest: request.snapshot.policyDigest,
	});
}

function normalizedRequestSet(request: AuthorizationRequest): readonly AuthorizationRequest["requests"][number][] {
	return [...request.requests].sort((left, right) => canonicalDigest(left).localeCompare(canonicalDigest(right)));
}

export function sessionApprovalRequestDigest(request: AuthorizationRequest): RuntimeDigest {
	return runtimeDigest({
		sessionId: request.sessionId,
		argumentsDigest: request.argumentsDigest,
		cwd: request.cwd,
		requests: normalizedRequestSet(request),
		policyDigest: request.snapshot.policyDigest,
	});
}

function promptSummary(request: AuthorizationRequest): string {
	const summary = request.requests.map((item) => {
		switch (item.kind) {
			case "filesystem": return `${item.operation} filesystem target`;
			case "shell": return `shell command (${item.analysis})`;
			case "network": return `${item.operation} network host ${item.host}`;
			case "worktree": return `worktree ${item.operation}`;
			case "tool": return `tool ${item.toolName}`;
		}
	}).join(", ");
	return `${request.toolName}: ${summary}`.slice(0, 512);
}

function createTicket(request: AuthorizationRequest, now: Date, timeoutMs: number, scope: "once" | "session" = "once"): ApprovalTicket {
	const digest = scope === "session" ? sessionApprovalRequestDigest(request) : requestDigest(request);
	const approvalId = createRuntimeId("approval", `${scope}-${digest.digest.slice(0, 48)}`);
	return {
		approvalId,
		requestDigest: digest,
		scope,
		status: "pending",
		principalId: request.workspace.principalId,
		createdAt: now.toISOString(),
		...(scope === "once" ? { expiresAt: new Date(now.getTime() + timeoutMs).toISOString() } : {}),
	};
}

function approvalDecision(response: PermissionPromptResponse, reason: "timeout" | "abort" | "channel" | "response"): ApprovalReceiptRef["decision"] {
	if (reason === "timeout") return "expired";
	if (reason === "abort" || reason === "channel") return "cancelled";
	if (response.decision === "allow-once" || response.decision === "allow-session" || response.decision === "allow-with-prefix-rule" || response.decision === "allow-with-network-rule") return "allowed";
	if (response.decision === "deny") return "denied";
	return "cancelled";
}

export function createApprovalReceipt(
	ticket: ApprovalTicket,
	response: PermissionPromptResponse,
	reason: "timeout" | "abort" | "channel" | "response" = "response",
	decidedAt = new Date().toISOString(),
	): ApprovalReceiptRef {
	const principalId = reason === "response" ? response.decidedBy : SYSTEM_APPROVAL_PRINCIPAL_ID;
	const decision = approvalDecision(response, reason);
	const body: Omit<ApprovalReceiptRef, "receiptId" | "receiptDigest"> = {
		approvalId: ticket.approvalId,
		requestDigest: ticket.requestDigest,
		scope: ticket.scope,
		decision,
		decisionRevision: 1,
		principalId,
		decidedAt,
		...(ticket.expiresAt === undefined ? {} : { expiresAt: ticket.expiresAt }),
	};
	const receiptDigest = runtimeDigest(body);
	return {
		...body,
		receiptId: createRuntimeId("receipt", `approval-${canonicalDigest({ ...body, receiptDigest }).slice(0, 48)}`),
		receiptDigest,
	};
}

export function createApprovalSupersessionReceipt(
	current: ApprovalReceiptRef,
	decision: Extract<ApprovalReceiptRef["decision"], "expired" | "revoked" | "cancelled" | "denied">,
	decidedAt: string,
	principalId: PrincipalId = SYSTEM_APPROVAL_PRINCIPAL_ID,
): ApprovalReceiptRef {
	const body: Omit<ApprovalReceiptRef, "receiptId" | "receiptDigest"> = {
		approvalId: current.approvalId,
		requestDigest: current.requestDigest,
		scope: current.scope,
		decision,
		decisionRevision: current.decisionRevision + 1,
		principalId,
		decidedAt,
		...(current.expiresAt === undefined ? {} : { expiresAt: current.expiresAt }),
	};
	const receiptDigest = runtimeDigest(body);
	return {
		...body,
		receiptId: createRuntimeId("receipt", `approval-${canonicalDigest({ ...body, receiptDigest }).slice(0, 48)}`),
		receiptDigest,
	};
}

export class HeadlessDenyPrompter implements PermissionPrompter {
	public async request(_prompt: PermissionPrompt, _signal?: AbortSignal): Promise<PermissionPromptResponse> {
		return { decision: "deny", decidedBy: SYSTEM_APPROVAL_PRINCIPAL_ID, reason: "approval channel is headless" };
	}
}

export class ApprovalCoordinator {
	readonly #prompter: PermissionPrompter;
	readonly #store: ApprovalStateStorePort;
	readonly #audit?: ApprovalAuditPort;
	readonly #clock: () => Date;
	readonly #timeoutMs: number;
	readonly #pending = new Map<string, Promise<SecurityResult<AuthorizationResult>>>();

	public constructor(options: ApprovalCoordinatorOptions) {
		this.#prompter = options.prompter;
		this.#store = options.store ?? new MemoryApprovalStateStore();
		this.#audit = options.audit;
		this.#clock = options.clock ?? (() => new Date());
		this.#timeoutMs = Math.max(1, options.timeoutMs ?? 30_000);
	}

	public authorize(
		request: AuthorizationRequest,
		evaluation: SecurityAccessEvaluation,
		revalidate: ApprovalRevalidationPort,
		signal?: AbortSignal,
	): Promise<SecurityResult<AuthorizationResult>> {
		if (evaluation.decision === "deny") return Promise.resolve({ ok: true, value: { outcome: "deny", decisionSource: "builtin", requests: request.requests, policyDigest: request.snapshot.policyDigest, reason: evaluation.reason } });
		if (evaluation.decision === "allow") return Promise.resolve({ ok: true, value: { outcome: "allow", decisionSource: "builtin", requests: request.requests, policyDigest: request.snapshot.policyDigest, reason: evaluation.reason } });
		const key = `${request.sessionId}/${request.toolCallId}`;
		const existing = this.#pending.get(key);
		if (existing) return existing;
		const pending = this.#coordinate(request, evaluation, revalidate, signal);
		this.#pending.set(key, pending);
		void pending.finally(() => {
			if (this.#pending.get(key) === pending) this.#pending.delete(key);
		});
		return pending;
	}

	/** Consumes an exact allow-once receipt after the authorized effect settles. */
	public async consumeAllowOnce(
		request: AuthorizationRequest,
		receipt: ApprovalReceiptRef,
	): Promise<SecurityResult<ApprovalReceiptRef>> {
		let current: ApprovalReceiptRef | undefined;
		try {
			current = await this.#store.read(receipt.approvalId);
		} catch {
			return failure("approval receipt is unavailable during revocation", "approval_stale");
		}
		if (current === undefined || current.receiptDigest.digest !== receipt.receiptDigest.digest || current.requestDigest.digest !== requestDigest(request).digest) {
			return failure("approval receipt changed before revocation", "approval_stale");
		}
		if (current.decision === "revoked") return { ok: true, value: current };
		if (current.scope !== "once" || current.decision !== "allowed") {
			return failure("only an allowed once receipt can be revoked", "approval_stale");
		}
		const revoked = createApprovalSupersessionReceipt(current, "revoked", this.#clock().toISOString(), current.principalId);
		const committed = await this.#store.commit(revoked, current.decisionRevision);
		if (!committed.ok) return committed;
		try {
			await this.#audit?.revoked({ request, receipt: committed.value });
		} catch {
			return failure("approval revocation audit is uncertain", "approval_stale");
		}
		return committed;
	}

	async #racePrompt(prompt: PermissionPrompt, signal?: AbortSignal): Promise<PromptRace> {
		if (signal?.aborted) return { kind: "abort" };
		const controller = new AbortController();
		let timeoutId: ReturnType<typeof setTimeout> | undefined;
		let abortListener: (() => void) | undefined;
		const abort = new Promise<PromptRace>((resolve) => {
			abortListener = () => {
				controller.abort(signal?.reason);
				resolve({ kind: "abort" });
			};
			signal?.addEventListener("abort", abortListener, { once: true });
		});
		const timeout = new Promise<PromptRace>((resolve) => {
			timeoutId = setTimeout(() => {
				controller.abort("approval timeout");
				resolve({ kind: "timeout" });
			}, this.#timeoutMs);
		});
		const promptResult = this.#prompter.request(prompt, controller.signal)
			.then((response): PromptRace => ({ kind: "response", response }))
			.catch((): PromptRace => ({ kind: "channel" }));
		const result = await Promise.race([promptResult, abort, timeout]);
		if (timeoutId !== undefined) clearTimeout(timeoutId);
		if (abortListener && signal) signal.removeEventListener("abort", abortListener);
		if (result.kind !== "response") controller.abort(result.kind);
		return result;
	}

	async #coordinate(
		request: AuthorizationRequest,
		evaluation: SecurityAccessEvaluation,
		revalidate: ApprovalRevalidationPort,
		signal?: AbortSignal,
	): Promise<SecurityResult<AuthorizationResult>> {
		const shellRequest = request.requests.length === 1 && request.requests[0]?.kind === "shell" ? request.requests[0] : undefined;
		const networkRequest = request.requests.length === 1 && request.requests[0]?.kind === "network" ? request.requests[0] : undefined;
		if (shellRequest !== undefined && supportsAmendments(this.#store)) {
			let amendment: ExecPrefixApproval | undefined;
			try {
				amendment = await this.#store.findExecPrefixApproval({ sessionId: request.sessionId, policyDigest: request.snapshot.policyDigest, command: shellRequest.command });
			} catch {
				return failure("exec prefix approval store is unavailable", "approval_stale");
			}
			if (amendment !== undefined && amendment.receipt.decision === "allowed") {
				const current = await this.#revalidateBinding(request, revalidate);
				if (!current.ok) return current;
				return {
					ok: true,
					value: {
						outcome: "allow",
						decisionSource: "session",
						requests: request.requests,
						policyDigest: request.snapshot.policyDigest,
						reason: "matched an approved session exec prefix rule",
					},
				};
			}
		}
		if (networkRequest?.protocol !== undefined && supportsAmendments(this.#store)) {
			const key = normalizeNetworkApprovalKey({ host: networkRequest.host, protocol: networkRequest.protocol, ...(networkRequest.port === undefined ? {} : { port: networkRequest.port }) });
			if (key === undefined) return failure("network approval key is invalid", "approval_stale");
			let amendment: NetworkRuleApproval | undefined;
			try {
				amendment = await this.#store.findNetworkApproval({ sessionId: request.sessionId, policyDigest: request.snapshot.policyDigest, key });
			} catch {
				return failure("network approval store is unavailable", "approval_stale");
			}
			if (amendment?.receipt.decision === "allowed") {
				const current = await this.#revalidateBinding(request, revalidate);
				if (!current.ok) return current;
				return { ok: true, value: { outcome: "allow", decisionSource: "session", requests: request.requests, policyDigest: request.snapshot.policyDigest, reason: "matched an approved session network rule" } };
			}
		}
		const sessionTicket = createTicket(request, this.#clock(), this.#timeoutMs, "session");
		const sessionReplay = await this.#replayDurableDecision(request, evaluation, sessionTicket, revalidate);
		if (sessionReplay !== undefined) return sessionReplay;
		const ticket = createTicket(request, this.#clock(), this.#timeoutMs, "once");
		const replayed = await this.#replayDurableDecision(request, evaluation, ticket, revalidate);
		if (replayed !== undefined) return replayed;
		const prompt: PermissionPrompt = {
			requestId: request.requestId,
			sessionId: request.sessionId,
			toolCallId: request.toolCallId,
			toolName: request.toolName,
			summary: promptSummary(request),
			requests: request.requests,
			argumentsDigest: request.argumentsDigest,
			cwd: request.cwd,
			policyDigest: request.snapshot.policyDigest,
			createdAt: ticket.createdAt,
			expiresAt: ticket.expiresAt ?? ticket.createdAt,
		};
		try {
			await this.#audit?.requested({ request, ticket });
		} catch {
			return failure("approval request audit is unavailable", "approval_stale");
		}
		const raced = await this.#racePrompt(prompt, signal);
		let response: PermissionPromptResponse = raced.kind === "response"
			? raced.response
			: { decision: raced.kind === "timeout" ? "cancel" : "cancel", decidedBy: SYSTEM_APPROVAL_PRINCIPAL_ID };
		if (response.decision === "allow-session" && request.requests.some((item) => item.kind === "shell" && isDangerousExecCommand(item.command))) {
			response = { decision: "allow-once", decidedBy: response.decidedBy };
		}
		let prefixRule: ExecPrefixRule | undefined;
		let networkRule: NetworkApprovalRule | undefined;
		if (response.decision === "allow-with-prefix-rule") {
			if (shellRequest === undefined) return this.#commitDenied(request, ticket, response, "abort", "exec prefix approval requires exactly one shell request");
			const validated = validateExecPrefixRule(shellRequest.command, response.prefixRule, request.sessionId, request.snapshot.policyDigest);
			if (!validated.ok) return this.#commitDenied(request, ticket, response, "abort", validated.error.message);
			prefixRule = validated.value;
		}
		if (response.decision === "allow-with-network-rule") {
			if (networkRequest?.protocol === undefined) return this.#commitDenied(request, ticket, response, "abort", "network approval requires exactly one protocol-bound network request");
			const requestedKey = normalizeNetworkApprovalKey({ host: networkRequest.host, protocol: networkRequest.protocol, ...(networkRequest.port === undefined ? {} : { port: networkRequest.port }) });
			const responseKey = normalizeNetworkApprovalKey({ host: response.host, protocol: response.protocol, ...(response.port === undefined ? {} : { port: response.port }) });
			if (requestedKey === undefined || responseKey === undefined || canonicalDigest(requestedKey) !== canonicalDigest(responseKey)) {
				return this.#commitDenied(request, ticket, response, "abort", "network policy amendment does not match the exact approved endpoint");
			}
			networkRule = { sessionId: request.sessionId, policyDigest: request.snapshot.policyDigest, key: requestedKey };
		}
		if (raced.kind === "response" && isAllowResponse(response)) {
			let current: ApprovalRevalidation;
			try {
				current = await revalidate();
			} catch {
					return this.#commitDenied(request, ticket, response, "abort", "approval revalidation failed");
			}
			if (current.argumentsDigest.digest !== request.argumentsDigest.digest || current.cwd !== request.cwd || current.policyDigest.digest !== request.snapshot.policyDigest.digest) {
					return this.#commitDenied(request, ticket, response, "abort", "approval binding changed before execution");
			}
		}
		const selectedTicket = response.decision === "allow-session" || response.decision === "allow-with-prefix-rule" || response.decision === "allow-with-network-rule" ? sessionTicket : ticket;
		const receipt = createApprovalReceipt(
			selectedTicket,
			response,
			raced.kind === "response" ? "response" : raced.kind,
			raced.kind === "timeout" ? ticket.expiresAt ?? this.#clock().toISOString() : this.#clock().toISOString(),
		);
		let committedReceipt: ApprovalReceiptRef;
		if (prefixRule !== undefined) {
			if (!supportsAmendments(this.#store)) return failure("approval store cannot atomically persist exec prefix amendments", "approval_stale");
			const committed = await this.#store.commitWithExecPrefixRule(receipt, 0, prefixRule);
			if (!committed.ok) return committed;
			committedReceipt = committed.value.receipt;
		} else if (networkRule !== undefined) {
			if (!supportsAmendments(this.#store)) return failure("approval store cannot atomically persist network amendments", "approval_stale");
			const committed = await this.#store.commitWithNetworkRule(receipt, 0, networkRule);
			if (!committed.ok) return committed;
			committedReceipt = committed.value.receipt;
		} else {
			const committed = await this.#store.commit(receipt, 0);
			if (!committed.ok) return committed;
			committedReceipt = committed.value;
		}
		try {
			await this.#audit?.decided({ request, ticket: selectedTicket, receipt: committedReceipt });
		} catch {
			return failure("approval decision audit is uncertain", "approval_stale");
		}
		const outcome = committedReceipt.decision === "allowed" ? "allow" : "deny";
		return {
			ok: true,
			value: {
				outcome,
				decisionSource: "approval",
				requests: request.requests,
				policyDigest: request.snapshot.policyDigest,
				approval: committedReceipt,
				reason: outcome === "allow" ? evaluation.reason : `approval ${committedReceipt.decision}`,
			},
		};
	}

	/**
	 * A response may be lost after the receipt commit but before the caller
	 * receives it.  The receipt is the retry fence: replay the exact decision
	 * instead of prompting or executing a second authorization attempt.
	 */
	async #replayDurableDecision(
		request: AuthorizationRequest,
		evaluation: SecurityAccessEvaluation,
		ticket: ApprovalTicket,
		revalidate: ApprovalRevalidationPort,
	): Promise<SecurityResult<AuthorizationResult> | undefined> {
		let existing: ApprovalReceiptRef | undefined;
		try {
			existing = await this.#store.read(ticket.approvalId);
		} catch {
			return failure("approval receipt is unavailable during recovery", "approval_stale");
		}
		if (existing === undefined) return undefined;
		if (
			existing.requestDigest.digest !== ticket.requestDigest.digest ||
			existing.scope !== ticket.scope
		) return failure("durable approval receipt is bound to a different request", "approval_stale");

		const now = this.#clock().getTime();
		if (existing.decision === "allowed" && existing.expiresAt !== undefined && Date.parse(existing.expiresAt) <= now) {
			const expired = createApprovalSupersessionReceipt(existing, "expired", this.#clock().toISOString());
			const committed = await this.#store.commit(expired, existing.decisionRevision);
			if (!committed.ok) return committed;
			try {
				await this.#audit?.decided({ request, ticket, receipt: committed.value });
			} catch {
				return failure("approval expiry audit is uncertain", "approval_stale");
			}
			existing = committed.value;
		}

		if (existing.decision === "allowed") {
			const current = await this.#revalidateBinding(request, revalidate);
			if (!current.ok) return current;
		}
		const outcome = existing.decision === "allowed" ? "allow" : "deny";
		return {
			ok: true,
			value: {
				outcome,
				decisionSource: "approval",
				requests: request.requests,
				policyDigest: request.snapshot.policyDigest,
				approval: existing,
				reason: outcome === "allow" ? evaluation.reason : `approval ${existing.decision}`,
			},
		};
	}

	async #revalidateBinding(request: AuthorizationRequest, revalidate: ApprovalRevalidationPort): Promise<SecurityResult<true>> {
		let current: ApprovalRevalidation;
		try {
			current = await revalidate();
		} catch {
			return failure("approval revalidation failed", "approval_stale");
		}
		if (current.argumentsDigest.digest !== request.argumentsDigest.digest || current.cwd !== request.cwd || current.policyDigest.digest !== request.snapshot.policyDigest.digest) {
			return failure("approval binding changed before replay", "approval_stale");
		}
		return { ok: true, value: true };
	}

	async #commitDenied(
		request: AuthorizationRequest,
		ticket: ApprovalTicket,
		response: PermissionPromptResponse,
		reason: "abort" | "timeout" | "channel",
		message: string,
	): Promise<SecurityResult<AuthorizationResult>> {
		const receipt = createApprovalReceipt(ticket, response, reason, this.#clock().toISOString());
		const committed = await this.#store.commit(receipt, 0);
		if (!committed.ok) return committed;
		try {
			await this.#audit?.decided({ request, ticket, receipt: committed.value });
		} catch {
			return failure("approval decision audit is uncertain", "approval_stale");
		}
		return {
			ok: true,
			value: {
				outcome: "deny",
				decisionSource: "approval",
				requests: request.requests,
				policyDigest: request.snapshot.policyDigest,
				approval: committed.value,
				reason: message,
			},
		};
	}
}
