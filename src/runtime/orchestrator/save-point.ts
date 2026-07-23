/** Operation save-point：活跃执行固定依赖，变更只在 awaited settlement 后生效。 */

import { canonicalDigest } from "../protocol/v3/canonical-json.ts";
import type { IdempotencyKey } from "../protocol/v3/coordination.ts";
import { createRuntimeId, type CommandId } from "../protocol/v3/ids.ts";
import type {
	DurableJournalSnapshot,
	DurableJournalTransaction,
	DurableOrchestratorJournalPort,
	OperationBindings,
	OperationMutation,
	OperationSavePoint,
	OrchestratorResult,
	SavePointJournalRecord,
} from "./types.ts";

export interface OperationSettlement {
	operationId: CommandId;
	savePoint: OperationSavePoint;
	outcome: "succeeded" | "failed" | "cancelled" | "uncertain";
	resultDigest: string;
}

export type OperationSettlementListener = (settlement: OperationSettlement) => void | Promise<void>;

export interface SavePointCoordinatorOptions {
	initialBindings: OperationBindings;
	journal: DurableOrchestratorJournalPort<SavePointJournalRecord>;
	clock?: () => Date;
}

interface SavePointProjection {
	journalRevision: number;
	transactions: DurableJournalSnapshot<SavePointJournalRecord>["transactions"];
	bindings: OperationBindings;
	active?: OperationSavePoint;
	pending: readonly OperationMutation[];
}

function cloneBindings(bindings: OperationBindings): OperationBindings {
	const cloned: OperationBindings = {
		model: { ...bindings.model },
		tools: { ...bindings.tools, toolIdentityDigests: [...bindings.tools.toolIdentityDigests] },
		resources: { ...bindings.resources },
		config: { ...bindings.config },
		capabilities: bindings.capabilities.map((capability) => ({ ...capability })),
	};
	if (bindings.workspace) cloned.workspace = { ...bindings.workspace };
	return cloned;
}

function cloneMutation(mutation: OperationMutation): OperationMutation {
	if (mutation.kind === "capabilities") {
		return { ...mutation, value: mutation.value.map((capability) => ({ ...capability })) };
	}
	if (mutation.kind === "workspace") {
		return mutation.value
			? { ...mutation, value: { ...mutation.value } }
			: { mutationId: mutation.mutationId, kind: "workspace" };
	}
	if (mutation.kind === "model") return { ...mutation, value: { ...mutation.value } };
	if (mutation.kind === "tools") {
		return { ...mutation, value: { ...mutation.value, toolIdentityDigests: [...mutation.value.toolIdentityDigests] } };
	}
	if (mutation.kind === "resources") return { ...mutation, value: { ...mutation.value } };
	return { ...mutation, value: { ...mutation.value } };
}

function applyMutation(bindings: OperationBindings, mutation: OperationMutation): OperationBindings {
	const next = cloneBindings(bindings);
	if (mutation.kind === "model") next.model = { ...mutation.value };
	else if (mutation.kind === "tools") {
		next.tools = { ...mutation.value, toolIdentityDigests: [...mutation.value.toolIdentityDigests] };
	} else if (mutation.kind === "resources") next.resources = { ...mutation.value };
	else if (mutation.kind === "config") next.config = { ...mutation.value };
	else if (mutation.kind === "workspace") {
		if (mutation.value) next.workspace = { ...mutation.value };
		else delete next.workspace;
	} else next.capabilities = mutation.value.map((capability) => ({ ...capability }));
	return next;
}

function reduceSavePoints(
	initialBindings: OperationBindings,
	snapshot: DurableJournalSnapshot<SavePointJournalRecord>,
): OrchestratorResult<SavePointProjection> {
	let bindings = cloneBindings(initialBindings);
	let active: OperationSavePoint | undefined;
	let pending: OperationMutation[] = [];
	for (const transaction of snapshot.transactions) {
		for (const record of transaction.records) {
			if (record.kind === "save_point.created") {
				if (active) {
					return {
						ok: false,
						error: { code: "invalid_input", message: "journal contains overlapping operations", retryable: false },
					};
				}
				if (record.savePoint.bindingsDigest !== canonicalDigest(record.savePoint.bindings)) {
					return {
						ok: false,
						error: { code: "invalid_input", message: "save-point bindings digest mismatch", retryable: false },
					};
				}
				active = { ...record.savePoint, bindings: cloneBindings(record.savePoint.bindings) };
			} else if (record.kind === "save_point.mutation_queued") {
				if (!active || active.operationId !== record.operationId) {
					return {
						ok: false,
						error: { code: "invalid_input", message: "mutation is not bound to the active operation", retryable: false },
					};
				}
				if (!pending.some((mutation) => mutation.mutationId === record.mutation.mutationId)) {
					pending.push(cloneMutation(record.mutation));
				}
			} else if (record.kind === "save_point.settled") {
				if (
					!active ||
					active.operationId !== record.operationId ||
					active.savePointId !== record.savePointId
				) {
					return {
						ok: false,
						error: { code: "invalid_input", message: "settlement does not match the active operation", retryable: false },
					};
				}
				active = undefined;
			} else if (record.kind === "save_point.mutations_applied") {
				if (active) {
					return {
						ok: false,
						error: { code: "invalid_input", message: "mutations applied before operation settlement", retryable: false },
					};
				}
				const expectedIds = pending.map((mutation) => mutation.mutationId);
				if (
					expectedIds.length !== record.mutationIds.length ||
					expectedIds.some((id, index) => record.mutationIds[index] !== id)
				) {
					return {
						ok: false,
						error: { code: "invalid_input", message: "safe-point mutation order mismatch", retryable: false },
					};
				}
				if (record.bindingsDigest !== canonicalDigest(record.bindings)) {
					return {
						ok: false,
						error: { code: "invalid_input", message: "applied bindings digest mismatch", retryable: false },
					};
				}
				bindings = cloneBindings(record.bindings);
				pending = [];
			} else {
				if (active || pending.length === 0) {
					return {
						ok: false,
						error: { code: "invalid_input", message: "mutation discard is not at an uncertain safe point", retryable: false },
					};
				}
				const expectedIds = pending.map((mutation) => mutation.mutationId);
				if (
					expectedIds.length !== record.mutationIds.length ||
					expectedIds.some((id, index) => record.mutationIds[index] !== id) ||
					!/^[a-f0-9]{64}$/u.test(record.reconciliationReceiptDigest)
				) {
					return {
						ok: false,
						error: { code: "invalid_input", message: "discarded mutation reconciliation is invalid", retryable: false },
					};
				}
				pending = [];
			}
		}
	}
	return {
		ok: true,
		value: { journalRevision: snapshot.revision, transactions: snapshot.transactions, bindings, active, pending },
	};
}

export class SavePointCoordinator {
	private readonly initialBindings: OperationBindings;
	private readonly journal: DurableOrchestratorJournalPort<SavePointJournalRecord>;
	private readonly clock: () => Date;
	private projection: SavePointProjection;
	private readonly listeners = new Set<OperationSettlementListener>();
	private serial: Promise<void> = Promise.resolve();

	public constructor(
		options: SavePointCoordinatorOptions,
		projection: SavePointProjection,
	) {
		this.initialBindings = cloneBindings(options.initialBindings);
		this.journal = options.journal;
		this.clock = options.clock ?? (() => new Date());
		this.projection = projection;
	}

	public subscribe(listener: OperationSettlementListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private exclusive<T>(operation: () => Promise<OrchestratorResult<T>>): Promise<OrchestratorResult<T>> {
		const result = this.serial.then(operation);
		this.serial = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async refresh(): Promise<OrchestratorResult<void>> {
		const loaded = await this.journal.load();
		if (!loaded.ok) return loaded;
		const reduced = reduceSavePoints(this.initialBindings, loaded.value);
		if (!reduced.ok) return reduced;
		this.projection = reduced.value;
		return { ok: true, value: undefined };
	}

	private async append(
		idempotencyKey: IdempotencyKey,
		records: readonly SavePointJournalRecord[],
	): Promise<OrchestratorResult<void>> {
		const transaction: DurableJournalTransaction<SavePointJournalRecord> = {
			transactionId: createRuntimeId("command"),
			idempotencyKey,
			transactionDigest: canonicalDigest(records),
			committedAt: this.clock().toISOString(),
			records,
		};
		const appended = await this.journal.append(this.projection.journalRevision, transaction);
		if (!appended.ok) return appended;
		if (appended.value.status === "conflict") {
			return {
				ok: false,
				error: { code: "journal_conflict", message: "save-point journal revision changed", retryable: true },
			};
		}
		return this.refresh();
	}

	private previous(
		idempotencyKey: IdempotencyKey,
	): DurableJournalTransaction<SavePointJournalRecord> | undefined {
		return this.projection.transactions.find((transaction) => transaction.idempotencyKey === idempotencyKey);
	}

	public begin(operationId: CommandId, idempotencyKey: IdempotencyKey): Promise<OrchestratorResult<OperationSavePoint>> {
		return this.exclusive(async () => {
			const refreshed = await this.refresh();
			if (!refreshed.ok) return refreshed;
			const previous = this.previous(idempotencyKey);
			if (previous) {
				const record = previous.records.find(
					(entry): entry is Extract<SavePointJournalRecord, { kind: "save_point.created" }> =>
						entry.kind === "save_point.created",
				);
				return record && record.savePoint.operationId === operationId
					? { ok: true, value: record.savePoint }
					: { ok: false, error: { code: "idempotency_conflict", message: "begin key was reused", retryable: false } };
			}
			if (this.projection.active) {
				if (this.projection.active.operationId === operationId) {
					return { ok: true, value: this.projection.active };
				}
				return {
					ok: false,
					error: { code: "operation_active", message: "another operation is still active", retryable: true },
				};
			}
			if (this.projection.pending.length > 0) {
				return {
					ok: false,
					error: {
						code: "operation_active",
						message: "pending mutations must be applied at a safe point before a new operation",
						retryable: true,
					},
				};
			}
			const bindings = cloneBindings(this.projection.bindings);
			const savePoint: OperationSavePoint = {
				savePointId: createRuntimeId("checkpoint"),
				operationId,
				bindings,
				bindingsDigest: canonicalDigest(bindings),
				createdAt: this.clock().toISOString(),
			};
			const appended = await this.append(idempotencyKey, [{ kind: "save_point.created", savePoint }]);
			if (!appended.ok) return appended;
			return this.projection.active
				? { ok: true, value: this.projection.active }
				: {
						ok: false,
						error: { code: "journal_unavailable", message: "save-point append was not observable", retryable: true },
					};
		});
	}

	public queueMutation(
		operationId: CommandId,
		mutation: OperationMutation,
		idempotencyKey: IdempotencyKey,
	): Promise<OrchestratorResult<void>> {
		return this.exclusive(async () => {
			const refreshed = await this.refresh();
			if (!refreshed.ok) return refreshed;
			const previous = this.previous(idempotencyKey);
			if (previous) {
				const record = previous.records.find(
					(entry): entry is Extract<SavePointJournalRecord, { kind: "save_point.mutation_queued" }> =>
						entry.kind === "save_point.mutation_queued",
				);
				return record &&
					record.operationId === operationId &&
					record.mutation.mutationId === mutation.mutationId &&
					canonicalDigest(record.mutation) === canonicalDigest(mutation)
					? { ok: true, value: undefined }
					: { ok: false, error: { code: "idempotency_conflict", message: "mutation key was reused", retryable: false } };
			}
			if (!this.projection.active || this.projection.active.operationId !== operationId) {
				return {
					ok: false,
					error: { code: "operation_not_active", message: "mutation requires the matching active operation", retryable: false },
				};
			}
			if (this.projection.pending.some((entry) => entry.mutationId === mutation.mutationId)) {
				return { ok: true, value: undefined };
			}
			return this.append(idempotencyKey, [
				{
					kind: "save_point.mutation_queued",
					operationId,
					mutation: cloneMutation(mutation),
					queuedAt: this.clock().toISOString(),
				},
			]);
		});
	}

	public settle(
		settlement: OperationSettlement,
		idempotencyKey: IdempotencyKey,
	): Promise<OrchestratorResult<void>> {
		return this.exclusive(async () => {
			const refreshed = await this.refresh();
			if (!refreshed.ok) return refreshed;
			const previous = this.previous(idempotencyKey);
			if (previous) {
				const record = previous.records.find(
					(entry): entry is Extract<SavePointJournalRecord, { kind: "save_point.settled" }> =>
						entry.kind === "save_point.settled",
				);
				return record &&
					record.operationId === settlement.operationId &&
					record.savePointId === settlement.savePoint.savePointId &&
					record.outcome === settlement.outcome &&
					record.resultDigest === settlement.resultDigest
					? { ok: true, value: undefined }
					: { ok: false, error: { code: "idempotency_conflict", message: "settlement key was reused", retryable: false } };
			}
			const active = this.projection.active;
			if (!active || active.operationId !== settlement.operationId || active.savePointId !== settlement.savePoint.savePointId) {
				return {
					ok: false,
					error: { code: "operation_not_active", message: "settlement does not match the active save-point", retryable: false },
				};
			}
			for (const listener of this.listeners) {
				try {
					await listener(settlement);
				} catch (error) {
					return {
						ok: false,
						error: {
							code: "settlement_failed",
							message: "operation listener did not settle",
							retryable: true,
							details: { errorName: error instanceof Error ? error.name : "UnknownError" },
						},
					};
				}
			}
			return this.append(idempotencyKey, [
				{
					kind: "save_point.settled",
					operationId: active.operationId,
					savePointId: active.savePointId,
					outcome: settlement.outcome,
					resultDigest: settlement.resultDigest,
					settledAt: this.clock().toISOString(),
				},
			]);
		});
	}

	public applyPendingAtSafePoint(idempotencyKey: IdempotencyKey): Promise<OrchestratorResult<OperationBindings>> {
		return this.exclusive(async () => {
			const refreshed = await this.refresh();
			if (!refreshed.ok) return refreshed;
			const previous = this.previous(idempotencyKey);
			if (previous) {
				const record = previous.records.find(
					(entry): entry is Extract<SavePointJournalRecord, { kind: "save_point.mutations_applied" }> =>
						entry.kind === "save_point.mutations_applied",
				);
				return record
					? { ok: true, value: cloneBindings(record.bindings) }
					: { ok: false, error: { code: "idempotency_conflict", message: "safe-point key was reused", retryable: false } };
			}
			if (this.projection.active) {
				return {
					ok: false,
					error: { code: "operation_active", message: "active operation has not reached a safe point", retryable: true },
				};
			}
			if (this.projection.pending.length === 0) {
				return { ok: true, value: cloneBindings(this.projection.bindings) };
			}
			let bindings = cloneBindings(this.projection.bindings);
			for (const mutation of this.projection.pending) bindings = applyMutation(bindings, mutation);
			const appended = await this.append(idempotencyKey, [
				{
					kind: "save_point.mutations_applied",
					mutationIds: this.projection.pending.map((mutation) => mutation.mutationId),
					bindings,
					bindingsDigest: canonicalDigest(bindings),
					appliedAt: this.clock().toISOString(),
				},
			]);
			if (!appended.ok) return appended;
			return { ok: true, value: cloneBindings(this.projection.bindings) };
		});
	}

	public discardPendingAfterReconciliation(
		operationId: CommandId,
		reconciliationReceiptDigest: string,
		idempotencyKey: IdempotencyKey,
	): Promise<OrchestratorResult<OperationBindings>> {
		return this.exclusive(async () => {
			const refreshed = await this.refresh();
			if (!refreshed.ok) return refreshed;
			const previous = this.previous(idempotencyKey);
			if (previous) {
				const record = previous.records.find(
					(entry): entry is Extract<SavePointJournalRecord, { kind: "save_point.mutations_discarded" }> =>
						entry.kind === "save_point.mutations_discarded",
				);
				return record &&
					record.operationId === operationId &&
					record.reconciliationReceiptDigest === reconciliationReceiptDigest
					? { ok: true, value: cloneBindings(this.projection.bindings) }
					: { ok: false, error: { code: "idempotency_conflict", message: "discard key was reused", retryable: false } };
			}
			if (
				this.projection.active ||
				this.projection.pending.length === 0 ||
				!/^[a-f0-9]{64}$/u.test(reconciliationReceiptDigest)
			) {
				return {
					ok: false,
					error: {
						code: "operation_not_active",
						message: "uncertain mutation discard requires pending mutations and a reconciliation receipt",
						retryable: false,
					},
				};
			}
			const appended = await this.append(idempotencyKey, [{
				kind: "save_point.mutations_discarded",
				operationId,
				mutationIds: this.projection.pending.map((mutation) => mutation.mutationId),
				reconciliationReceiptDigest,
				discardedAt: this.clock().toISOString(),
			}]);
			return appended.ok
				? { ok: true, value: cloneBindings(this.projection.bindings) }
				: appended;
		});
	}

	public activeSavePoint(): OperationSavePoint | undefined {
		return this.projection.active
			? { ...this.projection.active, bindings: cloneBindings(this.projection.active.bindings) }
			: undefined;
	}

	public bindings(): OperationBindings {
		return cloneBindings(this.projection.bindings);
	}

	public pendingMutationCount(): number {
		return this.projection.pending.length;
	}
}

export async function openSavePointCoordinator(
	options: SavePointCoordinatorOptions,
): Promise<OrchestratorResult<SavePointCoordinator>> {
	const loaded = await options.journal.load();
	if (!loaded.ok) return loaded;
	const projection = reduceSavePoints(options.initialBindings, loaded.value);
	if (!projection.ok) return projection;
	return { ok: true, value: new SavePointCoordinator(options, projection.value) };
}
