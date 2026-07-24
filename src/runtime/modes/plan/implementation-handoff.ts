/** 批准计划到实施 turn/fresh-context fork 的顺序化交接。 */

import { canonicalDigest } from "../../protocol/v3/canonical-json.ts";
import { createRuntimeId, type CommandId, type TraceId } from "../../protocol/v3/ids.ts";
import type { EventCursor } from "../../protocol/v3/events.ts";
import type { ArtifactRef } from "../../protocol/v3/capability.ts";
import type { ControlPlaneResult } from "../../control-plane/errors.ts";
import { controlPlaneFailure } from "../../control-plane/errors.ts";
import type { SessionBootstrap } from "../../control-plane/types.ts";
import {
	isApprovedPlanForkSeed,
	isPlanImplementationHandoffReceipt,
} from "./schema.ts";
import type {
	ApprovedPlanForkSeed,
	ApprovedPlanRef,
	PlanImplementationHandoffReceipt,
	PlanModeState,
} from "./types.ts";
import type { PlanDecisionResult } from "./service.ts";

export interface PlanExitSettlementPort {
	settleExit(traceId: TraceId, commandId?: CommandId): Promise<PlanModeState>;
}

export interface PlanImplementationHandoffStorePort {
	persist(receipt: PlanImplementationHandoffReceipt): Promise<ControlPlaneResult<void>>;
}

export interface PlanImplementationTurnPort {
	enqueue(input: {
		receipt: PlanImplementationHandoffReceipt;
		approvedPlan: ApprovedPlanRef;
		prompt: string;
	}): Promise<ControlPlaneResult<void>>;
}

export interface ApprovedPlanForkPort {
	forkApprovedPlan(seed: ApprovedPlanForkSeed): Promise<ControlPlaneResult<SessionBootstrap>>;
}

export interface PlanImplementationHandoffResult {
	receipt: PlanImplementationHandoffReceipt;
	bootstrap?: SessionBootstrap;
}

function contextSeedDigest(
	approvedPlan: ApprovedPlanRef,
	invariantArtifacts: readonly ArtifactRef[],
	policySnapshotDigest: string,
): string {
	return canonicalDigest({
		approvedPlan: {
			planId: approvedPlan.planId,
			revision: approvedPlan.revision,
			contentDigest: approvedPlan.contentDigest,
			approvalReceiptDigest: approvedPlan.approvalReceipt.receiptDigest,
		},
		invariantArtifacts: invariantArtifacts.map((artifact) => ({
			artifactId: artifact.artifactId,
			storedDigest: artifact.storedDigest,
		})),
		policySnapshotDigest,
	});
}

export function createPlanImplementationHandoffReceipt(input: {
	approvedPlan: ApprovedPlanRef;
	sourceSessionId: PlanImplementationHandoffReceipt["sourceSessionId"];
	action: PlanImplementationHandoffReceipt["action"];
	implementationPromptDigest: string;
	policySnapshotDigest: string;
	contextSeedDigest: string;
	createdAt: string;
}): PlanImplementationHandoffReceipt {
	const body = {
		schemaVersion: 1 as const,
		authorityId: input.approvedPlan.authorityId,
		tenantId: input.approvedPlan.tenantId,
		receiptId: createRuntimeId("receipt", `plan-handoff-${canonicalDigest(input).slice(0, 48)}`),
		sourceSessionId: input.sourceSessionId,
		approvedPlan: input.approvedPlan,
		implementationPromptDigest: input.implementationPromptDigest,
		policySnapshotDigest: input.policySnapshotDigest,
		contextSeedDigest: input.contextSeedDigest,
		action: input.action,
		targetSessionId: input.action === "same_session" ? input.sourceSessionId : null,
		createdAt: input.createdAt,
	};
	const receipt = { ...body, receiptDigest: canonicalDigest(body) } as PlanImplementationHandoffReceipt;
	if (!isPlanImplementationHandoffReceipt(receipt)) throw new TypeError("plan implementation handoff receipt is invalid");
	return receipt;
}

export function createApprovedPlanForkSeed(input: {
	parentCursor: EventCursor;
	approvedPlan: ApprovedPlanRef;
	invariantArtifacts: readonly ArtifactRef[];
	policySnapshotDigest: string;
}): ApprovedPlanForkSeed {
	if (input.parentCursor.stream.scope !== "session") {
		throw new TypeError("approved-plan fork requires a session cursor");
	}
	const body = {
		schemaVersion: 1 as const,
		authorityId: input.approvedPlan.authorityId,
		tenantId: input.approvedPlan.tenantId,
		parentSessionId: input.parentCursor.stream.sessionId,
		parentCursor: input.parentCursor,
		approvedPlan: input.approvedPlan,
		invariantArtifacts: [...input.invariantArtifacts],
		policySnapshotDigest: input.policySnapshotDigest,
	};
	const seed = { ...body, seedDigest: canonicalDigest(body) } as ApprovedPlanForkSeed;
	if (!isApprovedPlanForkSeed(seed)) throw new TypeError("approved-plan fork seed is invalid");
	return seed;
}

export class PlanImplementationHandoffCoordinator {
	readonly #exit: PlanExitSettlementPort;
	readonly #store: PlanImplementationHandoffStorePort;
	readonly #turns: PlanImplementationTurnPort;
	readonly #forks: ApprovedPlanForkPort;
	readonly #clock: () => Date;

	public constructor(options: {
		exit: PlanExitSettlementPort;
		store: PlanImplementationHandoffStorePort;
		turns: PlanImplementationTurnPort;
		forks: ApprovedPlanForkPort;
		clock?: () => Date;
	}) {
		this.#exit = options.exit;
		this.#store = options.store;
		this.#turns = options.turns;
		this.#forks = options.forks;
		this.#clock = options.clock ?? (() => new Date());
	}

	public async handoff(input: {
		decision: PlanDecisionResult;
		sourceCursor: EventCursor;
		implementationPrompt: string;
		policySnapshotDigest: string;
		invariantArtifacts: readonly ArtifactRef[];
		traceId: TraceId;
	}): Promise<ControlPlaneResult<PlanImplementationHandoffResult>> {
		const approvedPlan = input.decision.approvedPlan;
		if (!approvedPlan || input.decision.implementation === "none") {
			return controlPlaneFailure("invalid_request", "plan decision does not authorize implementation");
		}
		if (input.sourceCursor.stream.scope !== "session") {
			return controlPlaneFailure("invalid_request", "implementation handoff requires a session cursor");
		}
		const prompt = input.implementationPrompt.trim();
		if (prompt.length === 0 || prompt.length > 32 * 1024) {
			return controlPlaneFailure("invalid_request", "implementation prompt is empty or oversized");
		}
		const seedDigest = contextSeedDigest(
			approvedPlan,
			input.invariantArtifacts,
			input.policySnapshotDigest,
		);
		const receipt = createPlanImplementationHandoffReceipt({
			approvedPlan,
			sourceSessionId: input.sourceCursor.stream.sessionId,
			action: input.decision.implementation,
			implementationPromptDigest: canonicalDigest(prompt),
			policySnapshotDigest: input.policySnapshotDigest,
			contextSeedDigest: seedDigest,
			createdAt: this.#clock().toISOString(),
		});
		if (receipt.action === "same_session") {
			const settled = await this.#exit.settleExit(input.traceId);
			if (settled.kind !== "inactive" || settled.mode !== "default") {
				return controlPlaneFailure("recovery_required", "approved plan did not durably exit Plan Mode");
			}
			const persisted = await this.#store.persist(receipt);
			if (!persisted.ok) return persisted;
			const enqueued = await this.#turns.enqueue({ receipt, approvedPlan, prompt });
			return enqueued.ok ? { ok: true, value: { receipt } } : enqueued;
		}
		const persisted = await this.#store.persist(receipt);
		if (!persisted.ok) return persisted;
		const seed = createApprovedPlanForkSeed({
			parentCursor: input.sourceCursor,
			approvedPlan,
			invariantArtifacts: input.invariantArtifacts,
			policySnapshotDigest: input.policySnapshotDigest,
		});
		const forked = await this.#forks.forkApprovedPlan(seed);
		return forked.ok
			? { ok: true, value: { receipt, bootstrap: forked.value } }
			: forked;
	}
}
