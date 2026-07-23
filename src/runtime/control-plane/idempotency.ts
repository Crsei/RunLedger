/** mutation command 的 durable idempotency/CAS 端口与内存合同实现。 */

import { randomUUID } from "node:crypto";
import type { EventCursor, ExpectedRevision } from "../protocol/v3/events.ts";
import type { CanonicalCommandType } from "../protocol/v3/coordination.ts";
import type {
	AuthorityId,
	CommandId,
	PrincipalId,
	RuntimeInstanceId,
	SessionId,
	TenantId,
	TraceId,
} from "../protocol/v3/ids.ts";
import type { IdempotencyKey } from "../protocol/v3/coordination.ts";
import type { ControlPlaneErrorShape, ControlPlaneResult } from "./errors.ts";
import { controlPlaneFailure } from "./errors.ts";
import type { CanonicalCommandEffect } from "./canonical-command.ts";

export interface CommandClaimRequest {
	commandId: CommandId;
	idempotencyKey: IdempotencyKey;
	commandType: CanonicalCommandType;
	requestDigest: string;
}

export interface CommandClaimContext {
	authorityId: AuthorityId;
	tenantId: TenantId;
	principalId: PrincipalId;
	runtimeId: RuntimeInstanceId;
	runtimeGeneration: number;
	domain: "session" | "daemon" | "lifecycle" | "policy";
	subjectSessionId: SessionId | null;
	domainExpectedRevision: ExpectedRevision | null;
	traceId: TraceId;
}

export interface CommandClaimToken extends CommandClaimRequest {
	claimToken: string;
	claimedAt: string;
}

export interface CommittedCommandReceipt extends CommandClaimRequest {
	result: CanonicalCommandEffect;
	committedAt: string;
	appliedCursor?: EventCursor;
}

export interface RejectedCommandReceipt extends CommandClaimRequest {
	error: ControlPlaneErrorShape;
	rejectedAt: string;
}

export type CommandClaimOutcome =
	| { status: "claimed"; claim: CommandClaimToken }
	| { status: "duplicate"; receipt: CommittedCommandReceipt }
	| { status: "rejected"; receipt: RejectedCommandReceipt }
	| { status: "in_flight"; claim: CommandClaimToken }
	| { status: "conflict" };

/**
 * 实现必须 durable 地记录 claim 后才返回 claimed。进程若在副作用后、commit 前崩溃，
 * 恢复时保留 in_flight/recovery_required，不能自动再次执行 command。
 */
export interface CommandIdempotencyRepository {
	lookup(request: CommandClaimRequest, context?: CommandClaimContext): Promise<ControlPlaneResult<CommandClaimOutcome | null>>;
	claim(request: CommandClaimRequest, context?: CommandClaimContext): Promise<ControlPlaneResult<CommandClaimOutcome>>;
	commit(claim: CommandClaimToken, result: CanonicalCommandEffect): Promise<ControlPlaneResult<CommittedCommandReceipt>>;
	reject(claim: CommandClaimToken, error: ControlPlaneErrorShape): Promise<ControlPlaneResult<RejectedCommandReceipt>>;
	markReconciliationRequired(claim: CommandClaimToken, reasonDigest: string): Promise<ControlPlaneResult<void>>;
	/** legacy/test-only rollback；production canonical repository 会把它持久化为 rejected。 */
	abort(claim: CommandClaimToken): Promise<ControlPlaneResult<void>>;
	listInFlight(): Promise<ControlPlaneResult<readonly CommandClaimToken[]>>;
}

type StoredCommand =
	| { state: "claimed"; claim: CommandClaimToken }
	| { state: "committed"; claim: CommandClaimToken; receipt: CommittedCommandReceipt }
	| { state: "rejected"; claim: CommandClaimToken; receipt: RejectedCommandReceipt };

function sameRequest(left: CommandClaimRequest, right: CommandClaimRequest): boolean {
	return (
		left.commandId === right.commandId &&
		left.idempotencyKey === right.idempotencyKey &&
		left.commandType === right.commandType &&
		left.requestDigest === right.requestDigest
	);
}

export class InMemoryCommandIdempotencyRepository implements CommandIdempotencyRepository {
	readonly #byCommandId = new Map<CommandId, StoredCommand>();
	readonly #byIdempotencyKey = new Map<IdempotencyKey, StoredCommand>();
	readonly #clock: () => Date;
	#serial: Promise<void> = Promise.resolve();

	public constructor(clock: () => Date = () => new Date()) {
		this.#clock = clock;
	}

	#exclusive<T>(operation: () => ControlPlaneResult<T>): Promise<ControlPlaneResult<T>> {
		const result = this.#serial.then(operation);
		this.#serial = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	#find(request: CommandClaimRequest): CommandClaimOutcome | null {
		const byCommand = this.#byCommandId.get(request.commandId);
		const byKey = this.#byIdempotencyKey.get(request.idempotencyKey);
		if (!byCommand && !byKey) return null;
		if (!byCommand || !byKey || byCommand !== byKey || !sameRequest(byCommand.claim, request)) {
			return { status: "conflict" };
		}
		if (byCommand.state === "committed") return { status: "duplicate", receipt: byCommand.receipt };
		if (byCommand.state === "rejected") return { status: "rejected", receipt: byCommand.receipt };
		return { status: "in_flight", claim: byCommand.claim };
	}

	public lookup(request: CommandClaimRequest, _context?: CommandClaimContext): Promise<ControlPlaneResult<CommandClaimOutcome | null>> {
		return this.#exclusive(() => ({ ok: true, value: this.#find(request) }));
	}

	public claim(request: CommandClaimRequest, _context?: CommandClaimContext): Promise<ControlPlaneResult<CommandClaimOutcome>> {
		return this.#exclusive(() => {
			const existing = this.#find(request);
			if (existing) return { ok: true, value: existing };
			const claim: CommandClaimToken = {
				...request,
				claimToken: `claim_${randomUUID()}`,
				claimedAt: this.#clock().toISOString(),
			};
			const stored: StoredCommand = { state: "claimed", claim };
			this.#byCommandId.set(request.commandId, stored);
			this.#byIdempotencyKey.set(request.idempotencyKey, stored);
			return { ok: true, value: { status: "claimed", claim } };
		});
	}

	public reject(
		claim: CommandClaimToken,
		error: ControlPlaneErrorShape,
	): Promise<ControlPlaneResult<RejectedCommandReceipt>> {
		return this.#exclusive(() => {
			const stored = this.#byCommandId.get(claim.commandId);
			if (!stored || !sameRequest(stored.claim, claim) || stored.claim.claimToken !== claim.claimToken) {
				return controlPlaneFailure("idempotency_conflict", "command claim is no longer current");
			}
			if (stored.state === "committed") {
				return controlPlaneFailure("idempotency_conflict", "a committed command cannot become rejected");
			}
			if (stored.state === "rejected") return { ok: true, value: stored.receipt };
			const receipt: RejectedCommandReceipt = {
				commandId: claim.commandId,
				idempotencyKey: claim.idempotencyKey,
				commandType: claim.commandType,
				requestDigest: claim.requestDigest,
				error: structuredClone(error),
				rejectedAt: this.#clock().toISOString(),
			};
			const rejected: StoredCommand = { state: "rejected", claim: stored.claim, receipt };
			this.#byCommandId.set(claim.commandId, rejected);
			this.#byIdempotencyKey.set(claim.idempotencyKey, rejected);
			return { ok: true, value: receipt };
		});
	}

	public markReconciliationRequired(
		claim: CommandClaimToken,
		_reasonDigest: string,
	): Promise<ControlPlaneResult<void>> {
		return this.#exclusive(() => {
			const stored = this.#byCommandId.get(claim.commandId);
			return stored?.state === "claimed" && sameRequest(stored.claim, claim) &&
				stored.claim.claimToken === claim.claimToken
				? { ok: true, value: undefined }
				: controlPlaneFailure("idempotency_conflict", "command claim is no longer unsettled");
		});
	}

	public commit(
		claim: CommandClaimToken,
		result: CanonicalCommandEffect,
	): Promise<ControlPlaneResult<CommittedCommandReceipt>> {
		return this.#exclusive(() => {
			const stored = this.#byCommandId.get(claim.commandId);
			if (!stored || !sameRequest(stored.claim, claim) || stored.claim.claimToken !== claim.claimToken) {
				return controlPlaneFailure("idempotency_conflict", "command claim is no longer current");
			}
			if (stored.state === "committed") return { ok: true, value: stored.receipt };
			if (stored.state === "rejected") {
				return controlPlaneFailure("idempotency_conflict", "a rejected command cannot become committed");
			}
			if (result.type !== claim.commandType) {
				return controlPlaneFailure("adapter_contract_violation", "command result type does not match claim");
			}
			const receipt: CommittedCommandReceipt = {
				commandId: claim.commandId,
				idempotencyKey: claim.idempotencyKey,
				commandType: claim.commandType,
				requestDigest: claim.requestDigest,
				result,
				committedAt: this.#clock().toISOString(),
			};
			const committed: StoredCommand = { state: "committed", claim: stored.claim, receipt };
			this.#byCommandId.set(claim.commandId, committed);
			this.#byIdempotencyKey.set(claim.idempotencyKey, committed);
			return { ok: true, value: receipt };
		});
	}

	public abort(claim: CommandClaimToken): Promise<ControlPlaneResult<void>> {
		return this.#exclusive(() => {
			const stored = this.#byCommandId.get(claim.commandId);
			if (!stored || stored.state === "committed" || stored.state === "rejected") {
				return { ok: true, value: undefined };
			}
			if (!sameRequest(stored.claim, claim) || stored.claim.claimToken !== claim.claimToken) {
				return controlPlaneFailure("idempotency_conflict", "cannot abort a stale command claim");
			}
			this.#byCommandId.delete(claim.commandId);
			this.#byIdempotencyKey.delete(claim.idempotencyKey);
			return { ok: true, value: undefined };
		});
	}

	public listInFlight(): Promise<ControlPlaneResult<readonly CommandClaimToken[]>> {
		return this.#exclusive(() => ({
			ok: true,
			value: [...this.#byCommandId.values()]
				.filter((entry): entry is Extract<StoredCommand, { state: "claimed" }> => entry.state === "claimed")
				.map((entry) => ({ ...entry.claim })),
		}));
	}
}
