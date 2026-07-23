/** Loop、retry 与 uncertain-operation gate 的 durable control journal。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { IdempotencyKey } from "../protocol/v3/coordination.ts";
import { createRuntimeId, type ArtifactId, type CommandId } from "../protocol/v3/ids.ts";
import type { LoopObservation } from "./loop-breaker.ts";
import type { RetryDecision, RetryFailure, RetryContext } from "./retry-policy.ts";
import type {
	DurableJournalTransaction,
	DurableOrchestratorJournalPort,
	OrchestratorResult,
} from "./types.ts";

export interface DurableLoopObservationEvidence {
	artifactIds: readonly ArtifactId[];
	toolResultDigests: readonly string[];
	diffDigests: readonly string[];
	failureDigests: readonly string[];
	beforeTreeDigest: string;
	afterTreeDigest: string;
}

export type ControlJournalRecord =
	| {
			kind: "control.loop_observed";
			observation: LoopObservation;
			source: "durable_runtime_evidence";
			evidence: DurableLoopObservationEvidence;
			evidenceDigest: string;
			observedAt: string;
	  }
	| {
			kind: "control.retry_decided";
			operationId: CommandId;
			failure: RetryFailure;
			context: RetryContext;
			decision: RetryDecision;
			decisionDigest: string;
			decidedAt: string;
	  }
	| {
			kind: "control.uncertain_operation_gated";
			operationId: CommandId;
			operationIdentityDigest: string;
			reasonDigest: string;
			gatedAt: string;
	  }
	| {
			kind: "control.uncertain_operation_reconciled";
			operationId: CommandId;
			operationIdentityDigest: string;
			reconciliationReceiptDigest: string;
			reconciledAt: string;
	  };

export interface ControlJournalSnapshot {
	revision: number;
	observations: readonly LoopObservation[];
	retryDecisions: readonly Extract<ControlJournalRecord, { kind: "control.retry_decided" }>[];
	uncertainOperations: readonly Extract<
		ControlJournalRecord,
		{ kind: "control.uncertain_operation_gated" }
	>[];
}

export interface DurableControlJournalOptions {
	journal: DurableOrchestratorJournalPort<ControlJournalRecord>;
	clock?: () => Date;
}

const DIGEST = /^[a-f0-9]{64}$/u;

function validDigest(value: string): boolean {
	return DIGEST.test(value);
}

function cloneRecord<T extends ControlJournalRecord>(record: T): T {
	return structuredClone(record);
}

function reduceControlRecords(
	transactions: readonly DurableJournalTransaction<ControlJournalRecord>[],
): OrchestratorResult<ControlJournalSnapshot> {
	const observations: LoopObservation[] = [];
	const retryDecisions: Extract<ControlJournalRecord, { kind: "control.retry_decided" }>[] = [];
	const uncertain = new Map<
		CommandId,
		Extract<ControlJournalRecord, { kind: "control.uncertain_operation_gated" }>
	>();
	for (const transaction of transactions) {
		for (const record of transaction.records) {
			if (record.kind === "control.loop_observed") {
				if (
					record.source !== "durable_runtime_evidence" ||
					record.evidence.artifactIds.length === 0 ||
					record.evidenceDigest !== canonicalDigest(record.evidence) ||
					record.observation.observedAt !== record.observedAt
				) {
					return {
						ok: false,
						error: { code: "invalid_input", message: "durable loop observation evidence is invalid", retryable: false },
					};
				}
				observations.push(structuredClone(record.observation));
			} else if (record.kind === "control.retry_decided") {
				if (record.decisionDigest !== canonicalDigest({
					operationId: record.operationId,
					failure: record.failure,
					context: record.context,
					decision: record.decision,
				})) {
					return {
						ok: false,
						error: { code: "invalid_input", message: "retry decision digest is invalid", retryable: false },
					};
				}
				retryDecisions.push(cloneRecord(record));
			} else if (record.kind === "control.uncertain_operation_gated") {
				if (
					!validDigest(record.operationIdentityDigest) ||
					!validDigest(record.reasonDigest) ||
					uncertain.has(record.operationId)
				) {
					return {
						ok: false,
						error: { code: "invalid_input", message: "uncertain operation gate is invalid", retryable: false },
					};
				}
				uncertain.set(record.operationId, cloneRecord(record));
			} else {
				const active = uncertain.get(record.operationId);
				if (
					!active ||
					active.operationIdentityDigest !== record.operationIdentityDigest ||
					!validDigest(record.reconciliationReceiptDigest)
				) {
					return {
						ok: false,
						error: { code: "invalid_input", message: "uncertain operation reconciliation is invalid", retryable: false },
					};
				}
				uncertain.delete(record.operationId);
			}
		}
	}
	return {
		ok: true,
		value: {
			revision: transactions.length,
			observations,
			retryDecisions,
			uncertainOperations: [...uncertain.values()].map(cloneRecord),
		},
	};
}

export function createDurableLoopObservation(
	input: Omit<LoopObservation, "madeProgress">,
	evidence: DurableLoopObservationEvidence,
): OrchestratorResult<Extract<ControlJournalRecord, { kind: "control.loop_observed" }>> {
	const digestArrays = [
		...evidence.toolResultDigests,
		...evidence.diffDigests,
		...evidence.failureDigests,
		evidence.beforeTreeDigest,
		evidence.afterTreeDigest,
	];
	if (
		evidence.artifactIds.length === 0 ||
		new Set(evidence.artifactIds).size !== evidence.artifactIds.length ||
		!digestArrays.every(validDigest)
	) {
		return {
			ok: false,
			error: { code: "invalid_input", message: "loop observation requires bounded durable Artifact evidence", retryable: false },
		};
	}
	const observation: LoopObservation = {
		...input,
		madeProgress: evidence.beforeTreeDigest !== evidence.afterTreeDigest,
	};
	return {
		ok: true,
		value: {
			kind: "control.loop_observed",
			observation,
			source: "durable_runtime_evidence",
			evidence: structuredClone(evidence),
			evidenceDigest: canonicalDigest(evidence),
			observedAt: observation.observedAt,
		},
	};
}

export class DurableControlJournal {
	readonly #journal: DurableOrchestratorJournalPort<ControlJournalRecord>;
	readonly #clock: () => Date;
	#serial: Promise<void> = Promise.resolve();

	public constructor(options: DurableControlJournalOptions) {
		this.#journal = options.journal;
		this.#clock = options.clock ?? (() => new Date());
	}

	#exclusive<T>(operation: () => Promise<OrchestratorResult<T>>): Promise<OrchestratorResult<T>> {
		const result = this.#serial.then(operation);
		this.#serial = result.then(() => undefined, () => undefined);
		return result;
	}

	public async snapshot(): Promise<OrchestratorResult<ControlJournalSnapshot>> {
		const loaded = await this.#journal.load();
		if (!loaded.ok) return loaded;
		return reduceControlRecords(loaded.value.transactions);
	}

	#append(record: ControlJournalRecord, idempotencyKey: IdempotencyKey): Promise<OrchestratorResult<ControlJournalSnapshot>> {
		return this.#exclusive(async () => {
			for (let attempt = 0; attempt < 32; attempt += 1) {
				const loaded = await this.#journal.load();
				if (!loaded.ok) return loaded;
				const previous = loaded.value.transactions.find(
					(transaction) => transaction.idempotencyKey === idempotencyKey,
				);
				if (previous) {
					return canonicalDigest(previous.records) === canonicalDigest([record])
						? reduceControlRecords(loaded.value.transactions)
						: {
								ok: false,
								error: { code: "idempotency_conflict", message: "control journal key was reused", retryable: false },
							};
				}
				const transaction: DurableJournalTransaction<ControlJournalRecord> = {
					transactionId: createRuntimeId("command"),
					idempotencyKey,
					transactionDigest: canonicalDigest([record]),
					committedAt: this.#clock().toISOString(),
					records: [record],
				};
				const appended = await this.#journal.append(loaded.value.revision, transaction);
				if (!appended.ok) return appended;
				if (appended.value.status === "conflict") continue;
				const refreshed = await this.#journal.load();
				return refreshed.ok ? reduceControlRecords(refreshed.value.transactions) : refreshed;
			}
			return {
				ok: false,
				error: { code: "journal_conflict", message: "control journal CAS did not converge", retryable: true },
			};
		});
	}

	public recordLoopObservation(
		record: Extract<ControlJournalRecord, { kind: "control.loop_observed" }>,
		idempotencyKey: IdempotencyKey,
	): Promise<OrchestratorResult<ControlJournalSnapshot>> {
		return this.#append(record, idempotencyKey);
	}

	public recordRetryDecision(
		operationId: CommandId,
		failure: RetryFailure,
		context: RetryContext,
		decision: RetryDecision,
		idempotencyKey: IdempotencyKey,
	): Promise<OrchestratorResult<ControlJournalSnapshot>> {
		const body = { operationId, failure, context, decision };
		return this.#append({
			kind: "control.retry_decided",
			...body,
			decisionDigest: canonicalDigest(body),
			decidedAt: this.#clock().toISOString(),
		}, idempotencyKey);
	}

	public gateUncertainOperation(
		operationId: CommandId,
		operationIdentityDigest: string,
		reasonDigest: string,
		idempotencyKey: IdempotencyKey,
	): Promise<OrchestratorResult<ControlJournalSnapshot>> {
		return this.#append({
			kind: "control.uncertain_operation_gated",
			operationId,
			operationIdentityDigest,
			reasonDigest,
			gatedAt: this.#clock().toISOString(),
		}, idempotencyKey);
	}

	public reconcileUncertainOperation(
		operationId: CommandId,
		operationIdentityDigest: string,
		reconciliationReceiptDigest: string,
		idempotencyKey: IdempotencyKey,
	): Promise<OrchestratorResult<ControlJournalSnapshot>> {
		return this.#append({
			kind: "control.uncertain_operation_reconciled",
			operationId,
			operationIdentityDigest,
			reconciliationReceiptDigest,
			reconciledAt: this.#clock().toISOString(),
		}, idempotencyKey);
	}
}
