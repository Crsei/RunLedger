/** fsync JSONL command journal；restart 后 in-flight claim 保持 uncertain，禁止自动重放。 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalJson } from "../runtime/protocol/v3/canonical-json.ts";
import { parseIdempotencyKey } from "../runtime/protocol/v3/coordination.ts";
import { isRuntimeId, type CommandId } from "../runtime/protocol/v3/ids.ts";
import type { IdempotencyKey } from "../runtime/protocol/v3/coordination.ts";
import type { ControlPlaneErrorShape, ControlPlaneResult } from "../runtime/control-plane/errors.ts";
import { controlPlaneFailure, isControlPlaneError } from "../runtime/control-plane/errors.ts";
import type {
	CommandClaimContext,
	CommandClaimOutcome,
	CommandClaimRequest,
	CommandClaimToken,
	CommandIdempotencyRepository,
	CommittedCommandReceipt,
	RejectedCommandReceipt,
} from "../runtime/control-plane/idempotency.ts";
import { parseJsonlDocument } from "../runtime/control-plane/jsonl-transport.ts";
import {
	CONTROL_PLANE_COMMAND_TYPES,
	isControlPlaneCommandEffect,
	type ControlPlaneCommandEffect,
	type ControlPlaneCommandType,
} from "../runtime/control-plane/types.ts";

const COMMAND_JOURNAL_SCHEMA_VERSION = 1 as const;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const CLAIM_PATTERN = /^claim_[0-9a-f-]{36}$/;

type CommandJournalRecord =
	| { schemaVersion: 1; kind: "claim"; claim: CommandClaimToken }
	| {
			schemaVersion: 1;
			kind: "commit";
			commandId: CommandId;
			claimToken: string;
			result: ControlPlaneCommandEffect;
			committedAt: string;
	  }
	| {
			schemaVersion: 1;
			kind: "reject";
			commandId: CommandId;
			claimToken: string;
			error: ControlPlaneErrorShape;
			rejectedAt: string;
	  }
	| { schemaVersion: 1; kind: "abort"; commandId: CommandId; claimToken: string; abortedAt: string };

type StoredCommand =
	| { state: "claimed"; claim: CommandClaimToken }
	| { state: "committed"; claim: CommandClaimToken; receipt: CommittedCommandReceipt }
	| { state: "rejected"; claim: CommandClaimToken; receipt: RejectedCommandReceipt };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validTimestamp(value: unknown): value is string {
	return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
}

function isCommandType(value: unknown): value is ControlPlaneCommandType {
	return typeof value === "string" && CONTROL_PLANE_COMMAND_TYPES.includes(value as ControlPlaneCommandType);
}

function isClaim(value: unknown): value is CommandClaimToken {
	if (!isRecord(value) || !exactKeys(value, [
		"commandId",
		"idempotencyKey",
		"commandType",
		"requestDigest",
		"claimToken",
		"claimedAt",
	])) return false;
	return (
		isRuntimeId(value.commandId, "command") &&
		typeof value.idempotencyKey === "string" &&
		parseIdempotencyKey(value.idempotencyKey) !== undefined &&
		isCommandType(value.commandType) &&
		typeof value.requestDigest === "string" &&
		DIGEST_PATTERN.test(value.requestDigest) &&
		typeof value.claimToken === "string" &&
		CLAIM_PATTERN.test(value.claimToken) &&
		validTimestamp(value.claimedAt)
	);
}

function isJournalRecord(value: unknown): value is CommandJournalRecord {
	if (!isRecord(value) || value.schemaVersion !== COMMAND_JOURNAL_SCHEMA_VERSION || typeof value.kind !== "string") return false;
	switch (value.kind) {
		case "claim":
			return exactKeys(value, ["schemaVersion", "kind", "claim"]) && isClaim(value.claim);
		case "commit":
			return (
				exactKeys(value, ["schemaVersion", "kind", "commandId", "claimToken", "result", "committedAt"]) &&
				isRuntimeId(value.commandId, "command") &&
				typeof value.claimToken === "string" &&
				CLAIM_PATTERN.test(value.claimToken) &&
				isControlPlaneCommandEffect(value.result) &&
				validTimestamp(value.committedAt)
			);
		case "reject":
			return (
				exactKeys(value, ["schemaVersion", "kind", "commandId", "claimToken", "error", "rejectedAt"]) &&
				isRuntimeId(value.commandId, "command") &&
				typeof value.claimToken === "string" &&
				CLAIM_PATTERN.test(value.claimToken) &&
				isControlPlaneError(value.error) &&
				validTimestamp(value.rejectedAt)
			);
		case "abort":
			return (
				exactKeys(value, ["schemaVersion", "kind", "commandId", "claimToken", "abortedAt"]) &&
				isRuntimeId(value.commandId, "command") &&
				typeof value.claimToken === "string" &&
				CLAIM_PATTERN.test(value.claimToken) &&
				validTimestamp(value.abortedAt)
			);
		default:
			return false;
	}
}

function sameRequest(left: CommandClaimRequest, right: CommandClaimRequest): boolean {
	return (
		left.commandId === right.commandId &&
		left.idempotencyKey === right.idempotencyKey &&
		left.commandType === right.commandType &&
		left.requestDigest === right.requestDigest
	);
}

export class FileCommandIdempotencyRepository implements CommandIdempotencyRepository {
	readonly #filePath: string;
	readonly #clock: () => Date;
	readonly #byCommandId = new Map<CommandId, StoredCommand>();
	readonly #byIdempotencyKey = new Map<IdempotencyKey, StoredCommand>();
	#serial: Promise<void> = Promise.resolve();

	private constructor(filePath: string, clock: () => Date) {
		this.#filePath = filePath;
		this.#clock = clock;
	}

	public static async open(
		filePath: string,
		clock: () => Date = () => new Date(),
	): Promise<ControlPlaneResult<FileCommandIdempotencyRepository>> {
		const repository = new FileCommandIdempotencyRepository(filePath, clock);
		try {
			await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
			const handle = await open(filePath, "a+", 0o600);
			try {
				const stat = await handle.stat();
				if (!stat.isFile()) return controlPlaneFailure("recovery_required", "command journal is not a regular file");
				await handle.sync();
			} finally {
				await handle.close();
			}
			await chmod(filePath, 0o600);
			const source = await readFile(filePath);
			const parsed = parseJsonlDocument(source);
			if (!parsed.ok) return controlPlaneFailure("recovery_required", "command journal framing is corrupted", false);
			for (const input of parsed.value) {
				if (!isJournalRecord(input)) return controlPlaneFailure("recovery_required", "command journal record is invalid", false);
				const applied = repository.#applyReplay(input);
				if (!applied.ok) return applied;
			}
			return { ok: true, value: repository };
		} catch (error) {
			return controlPlaneFailure("adapter_unavailable", "command journal could not be opened", true, {
				errorName: error instanceof Error ? error.name : "UnknownError",
			});
		}
	}

	#applyReplay(record: CommandJournalRecord): ControlPlaneResult<void> {
		if (record.kind === "claim") {
			if (this.#byCommandId.has(record.claim.commandId) || this.#byIdempotencyKey.has(record.claim.idempotencyKey)) {
				return controlPlaneFailure("recovery_required", "command journal contains a duplicate claim");
			}
			const stored: StoredCommand = { state: "claimed", claim: record.claim };
			this.#byCommandId.set(record.claim.commandId, stored);
			this.#byIdempotencyKey.set(record.claim.idempotencyKey, stored);
			return { ok: true, value: undefined };
		}
		const stored = this.#byCommandId.get(record.commandId);
		if (!stored || stored.state !== "claimed" || stored.claim.claimToken !== record.claimToken) {
			return controlPlaneFailure("recovery_required", "command journal terminal record has no matching claim");
		}
		if (record.kind === "abort") {
			this.#byCommandId.delete(record.commandId);
			this.#byIdempotencyKey.delete(stored.claim.idempotencyKey);
			return { ok: true, value: undefined };
		}
		if (record.kind === "reject") {
			const receipt: RejectedCommandReceipt = {
				commandId: stored.claim.commandId,
				idempotencyKey: stored.claim.idempotencyKey,
				commandType: stored.claim.commandType,
				requestDigest: stored.claim.requestDigest,
				error: record.error,
				rejectedAt: record.rejectedAt,
			};
			const rejected: StoredCommand = { state: "rejected", claim: stored.claim, receipt };
			this.#byCommandId.set(stored.claim.commandId, rejected);
			this.#byIdempotencyKey.set(stored.claim.idempotencyKey, rejected);
			return { ok: true, value: undefined };
		}
		if (record.result.type !== stored.claim.commandType) {
			return controlPlaneFailure("recovery_required", "command journal result type does not match its claim");
		}
		const receipt: CommittedCommandReceipt = {
			commandId: stored.claim.commandId,
			idempotencyKey: stored.claim.idempotencyKey,
			commandType: stored.claim.commandType,
			requestDigest: stored.claim.requestDigest,
			result: record.result,
			committedAt: record.committedAt,
		};
		const committed: StoredCommand = { state: "committed", claim: stored.claim, receipt };
		this.#byCommandId.set(stored.claim.commandId, committed);
		this.#byIdempotencyKey.set(stored.claim.idempotencyKey, committed);
		return { ok: true, value: undefined };
	}

	#exclusive<T>(operation: () => Promise<ControlPlaneResult<T>>): Promise<ControlPlaneResult<T>> {
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
		if (!byCommand || !byKey || byCommand !== byKey || !sameRequest(byCommand.claim, request)) return { status: "conflict" };
		if (byCommand.state === "committed") return { status: "duplicate", receipt: byCommand.receipt };
		if (byCommand.state === "rejected") return { status: "rejected", receipt: byCommand.receipt };
		return { status: "in_flight", claim: byCommand.claim };
	}

	async #append(record: CommandJournalRecord): Promise<ControlPlaneResult<void>> {
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			handle = await open(this.#filePath, "a", 0o600);
			await handle.writeFile(`${canonicalJson(record)}\n`, "utf8");
			await handle.sync();
			return { ok: true, value: undefined };
		} catch (error) {
			return controlPlaneFailure("adapter_unavailable", "command journal append was not confirmed durable", false, {
				errorName: error instanceof Error ? error.name : "UnknownError",
			}, "uncertain");
		} finally {
			await handle?.close().catch(() => undefined);
		}
	}

	public lookup(request: CommandClaimRequest): Promise<ControlPlaneResult<CommandClaimOutcome | null>> {
		return this.#exclusive(async () => ({ ok: true, value: this.#find(request) }));
	}

	public claim(request: CommandClaimRequest, _context?: CommandClaimContext): Promise<ControlPlaneResult<CommandClaimOutcome>> {
		return this.#exclusive(async () => {
			const existing = this.#find(request);
			if (existing) return { ok: true, value: existing };
			const claim: CommandClaimToken = {
				...request,
				claimToken: `claim_${randomUUID()}`,
				claimedAt: this.#clock().toISOString(),
			};
			const appended = await this.#append({ schemaVersion: 1, kind: "claim", claim });
			if (!appended.ok) return appended;
			const stored: StoredCommand = { state: "claimed", claim };
			this.#byCommandId.set(claim.commandId, stored);
			this.#byIdempotencyKey.set(claim.idempotencyKey, stored);
			return { ok: true, value: { status: "claimed", claim } };
		});
	}

	public commit(
		claim: CommandClaimToken,
		result: ControlPlaneCommandEffect,
	): Promise<ControlPlaneResult<CommittedCommandReceipt>> {
		return this.#exclusive(async () => {
			const stored = this.#byCommandId.get(claim.commandId);
			if (!stored || !sameRequest(stored.claim, claim) || stored.claim.claimToken !== claim.claimToken) {
				return controlPlaneFailure("idempotency_conflict", "command claim is no longer current");
			}
			if (stored.state === "committed") return { ok: true, value: stored.receipt };
			if (stored.state === "rejected") {
				return controlPlaneFailure("idempotency_conflict", "a rejected command cannot become committed");
			}
			if (result.type !== claim.commandType) return controlPlaneFailure("adapter_contract_violation", "command result type does not match claim");
			const committedAt = this.#clock().toISOString();
			const appended = await this.#append({
				schemaVersion: 1,
				kind: "commit",
				commandId: claim.commandId,
				claimToken: claim.claimToken,
				result,
				committedAt,
			});
			if (!appended.ok) return appended;
			const receipt: CommittedCommandReceipt = {
				commandId: claim.commandId,
				idempotencyKey: claim.idempotencyKey,
				commandType: claim.commandType,
				requestDigest: claim.requestDigest,
				result,
				committedAt,
			};
			const committed: StoredCommand = { state: "committed", claim: stored.claim, receipt };
			this.#byCommandId.set(claim.commandId, committed);
			this.#byIdempotencyKey.set(claim.idempotencyKey, committed);
			return { ok: true, value: receipt };
		});
	}

	public reject(
		claim: CommandClaimToken,
		error: ControlPlaneErrorShape,
	): Promise<ControlPlaneResult<RejectedCommandReceipt>> {
		return this.#exclusive(async () => {
			const stored = this.#byCommandId.get(claim.commandId);
			if (!stored || !sameRequest(stored.claim, claim) || stored.claim.claimToken !== claim.claimToken) {
				return controlPlaneFailure("idempotency_conflict", "command claim is no longer current");
			}
			if (stored.state === "committed") {
				return controlPlaneFailure("idempotency_conflict", "a committed command cannot become rejected");
			}
			if (stored.state === "rejected") return { ok: true, value: stored.receipt };
			const rejectedAt = this.#clock().toISOString();
			const appended = await this.#append({
				schemaVersion: 1,
				kind: "reject",
				commandId: claim.commandId,
				claimToken: claim.claimToken,
				error,
				rejectedAt,
			});
			if (!appended.ok) return appended;
			const receipt: RejectedCommandReceipt = {
				commandId: claim.commandId,
				idempotencyKey: claim.idempotencyKey,
				commandType: claim.commandType,
				requestDigest: claim.requestDigest,
				error: structuredClone(error),
				rejectedAt,
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
		return this.#exclusive(async () => {
			const stored = this.#byCommandId.get(claim.commandId);
			return stored?.state === "claimed" && sameRequest(stored.claim, claim) &&
				stored.claim.claimToken === claim.claimToken
				? { ok: true, value: undefined }
				: controlPlaneFailure("idempotency_conflict", "command claim is no longer unsettled");
		});
	}

	public abort(claim: CommandClaimToken): Promise<ControlPlaneResult<void>> {
		return this.#exclusive(async () => {
			const stored = this.#byCommandId.get(claim.commandId);
			if (!stored || stored.state === "committed" || stored.state === "rejected") {
				return { ok: true, value: undefined };
			}
			if (!sameRequest(stored.claim, claim) || stored.claim.claimToken !== claim.claimToken) {
				return controlPlaneFailure("idempotency_conflict", "cannot abort a stale command claim");
			}
			const appended = await this.#append({
				schemaVersion: 1,
				kind: "abort",
				commandId: claim.commandId,
				claimToken: claim.claimToken,
				abortedAt: this.#clock().toISOString(),
			});
			if (!appended.ok) return appended;
			this.#byCommandId.delete(claim.commandId);
			this.#byIdempotencyKey.delete(claim.idempotencyKey);
			return { ok: true, value: undefined };
		});
	}

	public listInFlight(): Promise<ControlPlaneResult<readonly CommandClaimToken[]>> {
		return this.#exclusive(async () => ({
			ok: true,
			value: [...this.#byCommandId.values()]
				.filter((entry): entry is Extract<StoredCommand, { state: "claimed" }> => entry.state === "claimed")
				.map((entry) => ({ ...entry.claim })),
		}));
	}
}
