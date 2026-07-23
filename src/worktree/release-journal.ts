/** Workspace release intent/receipt journal 的内存实现与 canonical digest 原语。 */

import { canonicalDigest } from "../runtime/protocol/v3/canonical-json.ts";
import {
	createRuntimeId,
	type CommandId,
	type LeaseId,
	type WorkspaceId,
} from "../runtime/protocol/v3/ids.ts";
import { isWorkspaceReleaseReceiptRef } from "../runtime/protocol/v3/workspace.ts";
import type {
	WorktreeReleaseIntent,
	WorktreeReleaseJournalPort,
	WorktreeReleaseJournalRecord,
} from "./ports.ts";

export class WorktreeReleaseJournalCorruptionError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = "WorktreeReleaseJournalCorruptionError";
	}
}

export function worktreeReleaseIntentDigest(
	intent: Omit<WorktreeReleaseIntent, "intentDigest">,
): string {
	return canonicalDigest(intent);
}

export function worktreeReleaseJournalRecordDigest(
	record: Omit<WorktreeReleaseJournalRecord, "recordDigest">,
): string {
	return canonicalDigest(record);
}

export function worktreeReleaseOperationId(
	workspaceId: WorkspaceId,
	leaseId: LeaseId,
	leaseRevision: number,
): CommandId {
	return createRuntimeId("command", canonicalDigest({
		workspaceId,
		leaseId,
		leaseRevision,
	}).slice(0, 48));
}

function validIntent(intent: WorktreeReleaseIntent): boolean {
	const { intentDigest, ...body } = intent;
	return (
		intent.intentDigest === worktreeReleaseIntentDigest(body) &&
		intent.operationId === worktreeReleaseOperationId(
			intent.workspaceId,
			intent.leaseId,
			intent.leaseRevision,
		) &&
		intent.releasedLeaseDigest === canonicalDigest(intent.releasedLease) &&
		intent.retainedRecordDigest === canonicalDigest(intent.retainedRecord) &&
		intent.releasedLease.state === "released" &&
		intent.retainedRecord.state === "retained" &&
		intent.workspaceId === intent.releasedLease.workspaceId &&
		intent.workspaceId === intent.retainedRecord.workspaceId &&
		intent.leaseId === intent.releasedLease.leaseId &&
		intent.leaseRevision === intent.releasedLease.leaseRevision &&
		intent.authorityId === intent.releasedLease.authorityId &&
		intent.authorityId === intent.retainedRecord.authorityId &&
		intent.tenantId === intent.releasedLease.tenantId &&
		intent.tenantId === intent.retainedRecord.tenantId &&
		intent.principalId === intent.releasedLease.principalId &&
		intent.principalId === intent.retainedRecord.principalId &&
		intent.sessionId === intent.retainedRecord.sessionId &&
		intent.repositoryId === intent.retainedRecord.repositoryId &&
		intent.retainedRecord.lease !== undefined &&
		canonicalDigest(intent.retainedRecord.lease) === intent.releasedLeaseDigest &&
		(intent.checkpoint === undefined || (
			intent.retainedRecord.lastCheckpoint !== undefined &&
			canonicalDigest(intent.checkpoint) === canonicalDigest(intent.retainedRecord.lastCheckpoint)
		))
	);
}

export function isValidWorktreeReleaseJournalRecord(
	record: WorktreeReleaseJournalRecord,
): boolean {
	const { recordDigest, ...body } = record;
	return (
		validIntent(record.intent) &&
		record.recordDigest === worktreeReleaseJournalRecordDigest(body) &&
		(record.receipt === undefined || (
			isWorkspaceReleaseReceiptRef(record.receipt) &&
			record.receipt.receiptId === record.intent.receiptId &&
			record.receipt.requestId === record.intent.requestId &&
			record.receipt.requestDigest === record.intent.requestDigest &&
			record.receipt.callerRequestDigest === record.intent.callerRequestDigest &&
			record.receipt.authorityId === record.intent.authorityId &&
			record.receipt.tenantId === record.intent.tenantId &&
			record.receipt.principalId === record.intent.principalId &&
			record.receipt.sessionId === record.intent.sessionId &&
			record.receipt.agentId === record.intent.agentId &&
			record.receipt.workspaceId === record.intent.workspaceId &&
			record.receipt.repositoryId === record.intent.repositoryId &&
			record.receipt.envelopeDigest === record.intent.envelopeDigest &&
			record.receipt.leaseId === record.intent.leaseId &&
			record.receipt.leaseRevision === record.intent.leaseRevision &&
			record.receipt.releasedLeaseDigest === record.intent.releasedLeaseDigest &&
			record.receipt.retainedRecordDigest === record.intent.retainedRecordDigest &&
			record.receipt.releasedAt === record.intent.releasedAt
		))
	);
}

export class MemoryWorktreeReleaseJournalPort implements WorktreeReleaseJournalPort {
	readonly #records = new Map<CommandId, WorktreeReleaseJournalRecord>();

	public async read(operationId: CommandId): Promise<WorktreeReleaseJournalRecord | undefined> {
		const record = this.#records.get(operationId);
		return record ? structuredClone(record) : undefined;
	}

	public async begin(record: WorktreeReleaseJournalRecord): Promise<"applied" | "replay" | "conflict"> {
		if (!isValidWorktreeReleaseJournalRecord(record) || record.receipt !== undefined) {
			throw new Error("workspace release journal begin record is invalid");
		}
		const current = this.#records.get(record.intent.operationId);
		if (current) {
			return current.intent.requestDigest === record.intent.requestDigest &&
				current.intent.requestId === record.intent.requestId
				? "replay"
				: "conflict";
		}
		if ([...this.#records.values()].some((candidate) =>
			candidate.intent.requestId === record.intent.requestId)) {
			return "conflict";
		}
		this.#records.set(record.intent.operationId, structuredClone(record));
		return "applied";
	}

	public async complete(
		operationId: CommandId,
		expectedRequestDigest: string,
		record: WorktreeReleaseJournalRecord,
	): Promise<"applied" | "replay" | "conflict"> {
		if (
			!isValidWorktreeReleaseJournalRecord(record) ||
			record.receipt === undefined ||
			record.intent.operationId !== operationId ||
			record.intent.requestDigest !== expectedRequestDigest
		) {
			throw new Error("workspace release journal completion record is invalid");
		}
		const current = this.#records.get(operationId);
		if (
			!current ||
			current.intent.requestDigest !== expectedRequestDigest ||
			current.intent.intentDigest !== record.intent.intentDigest
		) return "conflict";
		if (current.receipt) {
			return current.recordDigest === record.recordDigest ? "replay" : "conflict";
		}
		this.#records.set(operationId, structuredClone(record));
		return "applied";
	}
}
