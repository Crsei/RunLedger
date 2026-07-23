/** production session candidate 与 canonical authority generation transition 的桥。 */

import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import { createIdempotencyKey, type IdempotencyKey } from "../runtime/protocol/v3/coordination.ts";
import {
	createRuntimeId,
	type CommandId,
	type RuntimeInstanceId,
} from "../runtime/protocol/v3/ids.ts";
import { controlPlaneFailure, type ControlPlaneResult } from "../runtime/control-plane/errors.ts";
import type {
	ActivatedRuntimeGenerationTransition,
	CandidateAuthorityBinding,
	PreparedRuntimeGenerationTransition,
	RuntimeGenerationFailureTransition,
	RuntimeGenerationTransitionContext,
	RuntimeGenerationTransitionPort,
	RuntimeWriterFencingReceipt,
} from "../runtime/control-plane/session-registry.ts";
import type { AuthorityRuntimeManager } from "../storage/authority-runtime-manager.ts";
import type { V3SessionManager, V3SessionWriterFenceReceipt } from "../storage/v3-session-manager.ts";
import type { V3CandidateAuthorityBindingPort } from "./v3-session-adapters.ts";
import {
	createProductionCompositionReceipt,
	validateProductionCompositionReceipt,
	type ProductionCompositionReceipt,
} from "./production-composition.ts";

interface CandidateRecord {
	manager: V3SessionManager;
	binding: CandidateAuthorityBinding;
	composition: ProductionCompositionReceipt;
	fencing: V3SessionWriterFenceReceipt;
	replacementId: CommandId;
	idempotencyKey: IdempotencyKey;
}

function sameBinding(left: CandidateAuthorityBinding, right: CandidateAuthorityBinding): boolean {
	return left.runtimeId === right.runtimeId && left.generation === right.generation &&
		left.compositionReceiptId === right.compositionReceiptId &&
		left.compositionDigest === right.compositionDigest &&
		left.fencingIntentDigest === right.fencingIntentDigest;
}

function samePrepared(
	left: PreparedRuntimeGenerationTransition,
	right: PreparedRuntimeGenerationTransition,
): boolean {
	return left.replacementId === right.replacementId &&
		left.candidateRuntimeId === right.candidateRuntimeId &&
		left.candidateGeneration === right.candidateGeneration;
}

function candidateFailure<T>(message: string): ControlPlaneResult<T> {
	return controlPlaneFailure("adapter_contract_violation", message);
}

/**
 * Candidate 先持有真实 session writer lease；这里只传播不含 raw token 的 receipt。
 * generation intent/activate/fail 全部写入 AuthorityRuntimeManager 的同一 Event Store。
 */
export class AuthorityRuntimeGenerationCoordinator
	implements RuntimeGenerationTransitionPort, V3CandidateAuthorityBindingPort {
	readonly #manager: AuthorityRuntimeManager;
	readonly #clock: () => Date;
	readonly #records = new Map<RuntimeInstanceId, CandidateRecord>();
	#baseComposition: ProductionCompositionReceipt | undefined;
	#activeGeneration: number;

	private constructor(manager: AuthorityRuntimeManager, activeGeneration: number, clock: () => Date) {
		this.#manager = manager;
		this.#activeGeneration = activeGeneration;
		this.#clock = clock;
	}

	public static async open(
		manager: AuthorityRuntimeManager,
		clock: () => Date = () => new Date(),
	): Promise<ControlPlaneResult<AuthorityRuntimeGenerationCoordinator>> {
		const replay = await manager.runtimeGenerations().replay();
		if (!replay.ok) return replay;
		if (replay.value.projection?.reconciliationRequired) {
			return controlPlaneFailure(
				"recovery_required",
				"authority runtime generation requires explicit reconciliation",
				false,
				undefined,
				"uncertain",
			);
		}
		return {
			ok: true,
			value: new AuthorityRuntimeGenerationCoordinator(
				manager,
				replay.value.projection?.active?.generation ?? 0,
				clock,
			),
		};
	}

	public bindBaseComposition(receipt: ProductionCompositionReceipt): ControlPlaneResult<void> {
		const identity = this.#manager.identity();
		const validated = validateProductionCompositionReceipt(receipt, {
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			serverInstanceId: receipt.serverInstanceId,
		});
		if (!validated.ok) return validated;
		if (this.#baseComposition && this.#baseComposition.receiptDigest !== receipt.receiptDigest) {
			return controlPlaneFailure("idempotency_conflict", "runtime generation composition was rebound");
		}
		this.#baseComposition = validated.value.receipt;
		return { ok: true, value: undefined };
	}

	public currentGeneration(): number {
		return Math.max(1, this.#activeGeneration);
	}

	public async bind(manager: V3SessionManager): Promise<ControlPlaneResult<CandidateAuthorityBinding>> {
		const base = this.#baseComposition;
		if (!base) return candidateFailure("candidate authority binding requires a validated production composition");
		const identity = this.#manager.identity();
		const candidateIdentity = manager.identity();
		if (
			candidateIdentity.authorityId !== identity.authorityId ||
			candidateIdentity.tenantId !== identity.tenantId ||
			manager.isClosed()
		) return candidateFailure("candidate runtime is outside the authority manager scope");
		const runtimeId = manager.runtimeId();
		const existing = this.#records.get(runtimeId);
		if (existing) return { ok: true, value: structuredClone(existing.binding) };
		const generation = this.#activeGeneration + 1;
		const composition = createProductionCompositionReceipt({
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			serverInstanceId: runtimeId,
			issuerId: base.issuerId,
			runtimeGeneration: generation,
			issuedAt: base.issuedAt,
			expiresAt: base.expiresAt,
			managedPolicyRef: base.managedPolicyRef,
			effectiveRequirements: base.featureRequirements,
			adapters: base.adapters.map((adapter) => ({ ...adapter, generation })),
		});
		if (!composition.ok) return composition;
		const validated = validateProductionCompositionReceipt(composition.value, {
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			serverInstanceId: runtimeId,
			runtimeGeneration: generation,
		});
		if (!validated.ok) return validated;
		const fencing = manager.writerFenceReceipt();
		if (fencing.runtimeId !== runtimeId || fencing.sessionId !== manager.sessionId()) {
			return candidateFailure("candidate writer fencing receipt is uncorrelated");
		}
		const binding: CandidateAuthorityBinding = {
			runtimeId,
			generation,
			compositionReceiptId: validated.value.receipt.receiptId,
			compositionDigest: validated.value.receipt.receiptDigest,
			fencingIntentDigest: canonicalDigest({
				runtimeId,
				generation,
				fencingReceiptId: fencing.receiptId,
				fencingReceiptDigest: fencing.receiptDigest,
			}),
		};
		const replacementDigest = canonicalDigest({
			authorityId: identity.authorityId,
			tenantId: identity.tenantId,
			runtimeId,
			generation,
			compositionDigest: binding.compositionDigest,
			fencingIntentDigest: binding.fencingIntentDigest,
		});
		this.#records.set(runtimeId, {
			manager,
			binding,
			composition: validated.value.receipt,
			fencing,
			replacementId: createRuntimeId("command", `runtime-replacement-${replacementDigest.slice(0, 48)}`),
			idempotencyKey: createIdempotencyKey(`runtime-replacement-${replacementDigest}`),
		});
		return { ok: true, value: structuredClone(binding) };
	}

	#record(context: RuntimeGenerationTransitionContext): ControlPlaneResult<CandidateRecord> {
		const record = this.#records.get(context.candidate.runtimeId);
		if (!record || !sameBinding(record.binding, context.candidate)) {
			return candidateFailure("runtime generation transition references an unknown candidate");
		}
		if (
			context.candidate.generation !== this.#activeGeneration + 1 ||
			(context.previous === null) !== (this.#activeGeneration === 0) ||
			(context.previous && context.previous.generation !== this.#activeGeneration)
		) return candidateFailure("runtime generation transition does not extend current authority");
		return { ok: true, value: record };
	}

	public async prepare(
		context: RuntimeGenerationTransitionContext,
	): Promise<ControlPlaneResult<PreparedRuntimeGenerationTransition>> {
		const found = this.#record(context);
		if (!found.ok) return found;
		const record = found.value;
		const identity = this.#manager.identity();
		const prepared = await this.#manager.runtimeGenerations().prepare({
			principalId: identity.principalId,
			traceId: createRuntimeId("trace"),
			timestamp: this.#clock().toISOString(),
		}, {
			replacementId: record.replacementId,
			idempotencyKey: record.idempotencyKey,
			...(context.previous ? { previousRuntimeId: context.previous.runtimeId } : {}),
			previousGeneration: context.previous?.generation ?? 0,
			candidateRuntimeId: record.binding.runtimeId,
			candidateGeneration: record.binding.generation,
			compositionReceiptId: record.binding.compositionReceiptId,
			compositionDigest: record.binding.compositionDigest,
			fencingIntentDigest: record.binding.fencingIntentDigest,
		});
		if (!prepared.ok) return prepared;
		return {
			ok: true,
			value: {
				replacementId: record.replacementId,
				candidateRuntimeId: record.binding.runtimeId,
				candidateGeneration: record.binding.generation,
				durableCursor: prepared.value.cursor,
			},
		};
	}

	public rotateWriterFence(
		context: RuntimeGenerationTransitionContext & { readonly prepared: PreparedRuntimeGenerationTransition },
	): Promise<ControlPlaneResult<RuntimeWriterFencingReceipt>> {
		const found = this.#record(context);
		if (!found.ok) return Promise.resolve(found);
		const record = found.value;
		if (!samePrepared(context.prepared, {
			replacementId: record.replacementId,
			candidateRuntimeId: record.binding.runtimeId,
			candidateGeneration: record.binding.generation,
			durableCursor: context.prepared.durableCursor,
		})) return Promise.resolve(candidateFailure("writer fencing references another preparation"));
		if (record.manager.isClosed()) {
			return Promise.resolve(controlPlaneFailure(
				"recovery_required",
				"candidate writer fence changed before activation",
				false,
			));
		}
		let current: ReturnType<V3SessionManager["writerFenceReceipt"]>;
		try {
			current = record.manager.writerFenceReceipt();
		} catch {
			return Promise.resolve(controlPlaneFailure(
				"recovery_required",
				"candidate writer fence changed before activation",
				false,
			));
		}
		if (
			current.receiptId !== record.fencing.receiptId ||
			current.receiptDigest !== record.fencing.receiptDigest ||
			canonicalDigest({
				runtimeId: record.binding.runtimeId,
				generation: record.binding.generation,
				fencingReceiptId: current.receiptId,
				fencingReceiptDigest: current.receiptDigest,
			}) !== record.binding.fencingIntentDigest
		) return Promise.resolve(controlPlaneFailure("recovery_required", "candidate writer fence changed before activation", false));
		return Promise.resolve({
			ok: true,
			value: {
				candidateRuntimeId: record.binding.runtimeId,
				candidateGeneration: record.binding.generation,
				receiptId: current.receiptId,
				receiptDigest: current.receiptDigest,
			},
		});
	}

	public async activate(
		context: RuntimeGenerationTransitionContext & {
			readonly prepared: PreparedRuntimeGenerationTransition;
			readonly fencing: RuntimeWriterFencingReceipt;
		},
	): Promise<ControlPlaneResult<ActivatedRuntimeGenerationTransition>> {
		const found = this.#record(context);
		if (!found.ok) return found;
		const record = found.value;
		if (
			context.prepared.replacementId !== record.replacementId ||
			context.fencing.receiptId !== record.fencing.receiptId ||
			context.fencing.receiptDigest !== record.fencing.receiptDigest
		) return candidateFailure("runtime activation receipt is uncorrelated");
		const identity = this.#manager.identity();
		const activated = await this.#manager.runtimeGenerations().activate({
			principalId: identity.principalId,
			traceId: createRuntimeId("trace"),
			timestamp: this.#clock().toISOString(),
		}, {
			replacementId: record.replacementId,
			activeRuntimeId: record.binding.runtimeId,
			activeGeneration: record.binding.generation,
			compositionReceiptId: record.binding.compositionReceiptId,
			compositionDigest: record.binding.compositionDigest,
			fencingReceiptId: record.fencing.receiptId,
			fencingReceiptDigest: record.fencing.receiptDigest,
		});
		if (!activated.ok) return activated;
		this.#activeGeneration = record.binding.generation;
		return {
			ok: true,
			value: {
				replacementId: record.replacementId,
				activeRuntimeId: record.binding.runtimeId,
				activeGeneration: record.binding.generation,
				durableCursor: activated.value.cursor,
			},
		};
	}

	public async recordFailure(failure: RuntimeGenerationFailureTransition): Promise<ControlPlaneResult<void>> {
		const found = this.#record(failure);
		if (!found.ok) return found;
		const identity = this.#manager.identity();
		const recorded = await this.#manager.runtimeGenerations().fail({
			principalId: identity.principalId,
			traceId: createRuntimeId("trace"),
			timestamp: this.#clock().toISOString(),
		}, {
			replacementId: failure.prepared.replacementId,
			candidateRuntimeId: failure.candidate.runtimeId,
			candidateGeneration: failure.candidate.generation,
			error: {
				code: failure.errorCode.slice(0, 128) || "runtime_replacement_failed",
				messageDigest: failure.errorDigest,
				retryable: false,
			},
			outcomeCertain: failure.outcomeCertain,
		});
		return recorded.ok ? { ok: true, value: undefined } : recorded;
	}
}
