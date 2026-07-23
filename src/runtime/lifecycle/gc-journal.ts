/** GC durable command/mutation-intent journal。 */

import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withDurableStateLock } from "../durable-state-lock.ts";
import { canonicalDigest, canonicalJson } from "../protocol/v3/canonical-json.ts";
import { isRuntimeId } from "../protocol/v3/ids.ts";
import {
	isRuntimeGcReceipt,
	isRuntimeGcMutationRequest,
	type RuntimeGcCommandClaim,
	type RuntimeGcCommandClaimResult,
	type RuntimeGcJournalPort,
	type RuntimeGcMutationRequest,
	type RuntimeGcReceipt,
} from "./gc.ts";
import type { LifecycleResult } from "./recovery.ts";

interface RuntimeGcJournalRecordBody {
	schemaVersion: 1;
	claim: RuntimeGcCommandClaim;
	state: "claimed" | "completed";
	intents: readonly RuntimeGcMutationRequest[];
	receipt?: RuntimeGcReceipt;
	revision: number;
	previousRecordDigest: string | null;
	updatedAt: string;
}

interface RuntimeGcJournalRecord extends RuntimeGcJournalRecordBody {
	recordDigest: string;
}

function failure<T>(
	code: "invalid_request" | "integrity_failed" | "external_unavailable",
	message: string,
	retryable = false,
): LifecycleResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function body(record: RuntimeGcJournalRecord): RuntimeGcJournalRecordBody {
	const { recordDigest: _recordDigest, ...value } = record;
	return value;
}

function withDigest(value: RuntimeGcJournalRecordBody): RuntimeGcJournalRecord {
	return { ...value, recordDigest: canonicalDigest(value) };
}

function validClaim(claim: RuntimeGcCommandClaim): boolean {
	return claim.schemaVersion === 1 &&
		isRuntimeId(claim.authorityId, "authority") &&
		isRuntimeId(claim.tenantId, "tenant") &&
		isRuntimeId(claim.requestId, "command") &&
		/^[a-f0-9]{64}$/.test(claim.requestDigest) &&
		Number.isSafeInteger(claim.graphRevision) &&
		claim.graphRevision >= 0 &&
		/^[a-f0-9]{64}$/.test(claim.graphDigest);
}

function validRecord(value: unknown): value is RuntimeGcJournalRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Partial<RuntimeGcJournalRecord>;
	if (
		record.schemaVersion !== 1 ||
		!record.claim ||
		!validClaim(record.claim) ||
		(record.state !== "claimed" && record.state !== "completed") ||
		!Array.isArray(record.intents) ||
		record.intents.some((intent) => !isRuntimeGcMutationRequest(intent)) ||
		!Number.isSafeInteger(record.revision) ||
		(record.revision ?? 0) < 1 ||
		(record.previousRecordDigest !== null &&
			(typeof record.previousRecordDigest !== "string" ||
				!/^[a-f0-9]{64}$/.test(record.previousRecordDigest))) ||
		typeof record.updatedAt !== "string" ||
		!Number.isFinite(Date.parse(record.updatedAt)) ||
		!record.recordDigest ||
		!/^[a-f0-9]{64}$/.test(record.recordDigest) ||
		(record.state === "completed" && (!record.receipt || !isRuntimeGcReceipt(record.receipt)))
	) return false;
	return record.recordDigest === canonicalDigest(body(record as RuntimeGcJournalRecord));
}

function sameClaim(left: RuntimeGcCommandClaim, right: RuntimeGcCommandClaim): boolean {
	return canonicalDigest(left) === canonicalDigest(right);
}

interface RuntimeGcJournalStorage {
	read(claim: RuntimeGcCommandClaim): Promise<LifecycleResult<RuntimeGcJournalRecord | undefined>>;
	write(
		expected: RuntimeGcJournalRecord | undefined,
		candidate: RuntimeGcJournalRecord,
	): Promise<LifecycleResult<RuntimeGcJournalRecord>>;
}

class MemoryGcJournalStorage implements RuntimeGcJournalStorage {
	readonly #records = new Map<string, RuntimeGcJournalRecord>();

	public async read(claim: RuntimeGcCommandClaim): Promise<LifecycleResult<RuntimeGcJournalRecord | undefined>> {
		return { ok: true, value: structuredClone(this.#records.get(claim.requestId)) };
	}

	public async write(
		expected: RuntimeGcJournalRecord | undefined,
		candidate: RuntimeGcJournalRecord,
	): Promise<LifecycleResult<RuntimeGcJournalRecord>> {
		const current = this.#records.get(candidate.claim.requestId);
		if ((current?.recordDigest ?? null) !== (expected?.recordDigest ?? null)) {
			return failure("integrity_failed", "GC journal CAS expectation is stale");
		}
		this.#records.set(candidate.claim.requestId, structuredClone(candidate));
		return { ok: true, value: structuredClone(candidate) };
	}
}

class FileGcJournalStorage implements RuntimeGcJournalStorage {
	readonly #root: string;

	public constructor(root: string) {
		this.#root = resolve(root);
	}

	#path(claim: RuntimeGcCommandClaim): string {
		const scope = canonicalDigest({ authorityId: claim.authorityId, tenantId: claim.tenantId });
		return join(this.#root, scope, `${canonicalDigest({ requestId: claim.requestId })}.json`);
	}

	public async read(claim: RuntimeGcCommandClaim): Promise<LifecycleResult<RuntimeGcJournalRecord | undefined>> {
		try {
			const bytes = await readFile(this.#path(claim));
			if (bytes.byteLength > 16 * 1024 * 1024) return failure("integrity_failed", "GC journal record exceeds limit");
			const value: unknown = JSON.parse(bytes.toString("utf8"));
			return validRecord(value)
				? { ok: true, value }
				: failure("integrity_failed", "GC journal record failed integrity validation");
		} catch (error) {
			if (error instanceof SyntaxError) return failure("integrity_failed", "GC journal record is not valid JSON");
			const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
			return code === "ENOENT"
				? { ok: true, value: undefined }
				: failure("external_unavailable", "GC journal record could not be read", true);
		}
	}

	public async write(
		expected: RuntimeGcJournalRecord | undefined,
		candidate: RuntimeGcJournalRecord,
	): Promise<LifecycleResult<RuntimeGcJournalRecord>> {
		const path = this.#path(candidate.claim);
		try {
			return await withDurableStateLock(path, async () => {
				const current = await this.read(candidate.claim);
				if (!current.ok) return current;
				if ((current.value?.recordDigest ?? null) !== (expected?.recordDigest ?? null)) {
					return failure("integrity_failed", "GC journal CAS expectation is stale");
				}
				const directory = dirname(path);
				const temporary = `${path}.${canonicalDigest({ digest: candidate.recordDigest, nonce: crypto.randomUUID() })}.tmp`;
				let handle: Awaited<ReturnType<typeof open>> | undefined;
				try {
					await mkdir(directory, { recursive: true, mode: 0o700 });
					handle = await open(temporary, "wx", 0o600);
					await handle.writeFile(canonicalJson(candidate), "utf8");
					await handle.sync();
					await handle.close();
					handle = undefined;
					await rename(temporary, path);
					const directoryHandle = await open(directory, "r");
					try {
						await directoryHandle.sync();
					} finally {
						await directoryHandle.close();
					}
					return { ok: true, value: candidate };
				} catch {
					if (handle) await handle.close().catch(() => undefined);
					await unlink(temporary).catch(() => undefined);
					return failure("external_unavailable", "GC journal record could not be published", true);
				}
			});
		} catch {
			return failure("external_unavailable", "GC journal state lock is unavailable", true);
		}
	}
}

export class DurableRuntimeGcJournal implements RuntimeGcJournalPort {
	readonly #storage: RuntimeGcJournalStorage;
	readonly #clock: () => Date;

	private constructor(storage: RuntimeGcJournalStorage, clock: () => Date) {
		this.#storage = storage;
		this.#clock = clock;
	}

	public static memory(clock: () => Date = () => new Date()): DurableRuntimeGcJournal {
		return new DurableRuntimeGcJournal(new MemoryGcJournalStorage(), clock);
	}

	public static file(root: string, clock: () => Date = () => new Date()): DurableRuntimeGcJournal {
		return new DurableRuntimeGcJournal(new FileGcJournalStorage(root), clock);
	}

	public async claim(claim: RuntimeGcCommandClaim): Promise<LifecycleResult<RuntimeGcCommandClaimResult>> {
		if (!validClaim(claim)) return failure("invalid_request", "GC journal claim is invalid");
		const existing = await this.#storage.read(claim);
		if (!existing.ok) return existing;
		if (existing.value) {
			if (!sameClaim(existing.value.claim, claim)) {
				return failure("integrity_failed", "GC requestId was reused with changed input");
			}
			return existing.value.state === "completed" && existing.value.receipt
				? { ok: true, value: { state: "completed", receipt: existing.value.receipt } }
				: { ok: true, value: { state: "claimed" } };
		}
		const record = withDigest({
			schemaVersion: 1,
			claim,
			state: "claimed",
			intents: [],
			revision: 1,
			previousRecordDigest: null,
			updatedAt: this.#clock().toISOString(),
		});
		const written = await this.#storage.write(undefined, record);
		return written.ok ? { ok: true, value: { state: "claimed" } } : written;
	}

	public async recordMutationIntent(
		claim: RuntimeGcCommandClaim,
		mutation: RuntimeGcMutationRequest,
	): Promise<LifecycleResult<RuntimeGcMutationRequest>> {
		const existing = await this.#storage.read(claim);
		if (!existing.ok) return existing;
		if (!existing.value || !sameClaim(existing.value.claim, claim) || existing.value.state !== "claimed") {
			return failure("integrity_failed", "GC mutation intent requires its active command claim");
		}
		const collision = existing.value.intents.find((intent) => intent.idempotencyKey === mutation.idempotencyKey);
		if (collision) {
			return canonicalDigest(collision) === canonicalDigest(mutation)
				? { ok: true, value: collision }
				: failure("integrity_failed", "GC mutation idempotency key was reused");
		}
		const candidate = withDigest({
			...body(existing.value),
			intents: [...existing.value.intents, mutation],
			revision: existing.value.revision + 1,
			previousRecordDigest: existing.value.recordDigest,
			updatedAt: this.#clock().toISOString(),
		});
		const written = await this.#storage.write(existing.value, candidate);
		return written.ok ? { ok: true, value: mutation } : written;
	}

	public async complete(
		claim: RuntimeGcCommandClaim,
		receipt: RuntimeGcReceipt,
	): Promise<LifecycleResult<RuntimeGcReceipt>> {
		if (!isRuntimeGcReceipt(receipt)) return failure("invalid_request", "GC terminal receipt is invalid");
		const existing = await this.#storage.read(claim);
		if (!existing.ok) return existing;
		if (!existing.value || !sameClaim(existing.value.claim, claim)) {
			return failure("integrity_failed", "GC completion requires its command claim");
		}
		if (existing.value.state === "completed") {
			return existing.value.receipt?.receiptDigest === receipt.receiptDigest
				? { ok: true, value: existing.value.receipt }
				: failure("integrity_failed", "GC completion conflicts with terminal receipt");
		}
		const candidate = withDigest({
			...body(existing.value),
			state: "completed",
			receipt,
			revision: existing.value.revision + 1,
			previousRecordDigest: existing.value.recordDigest,
			updatedAt: this.#clock().toISOString(),
		});
		const written = await this.#storage.write(existing.value, candidate);
		return written.ok ? { ok: true, value: receipt } : written;
	}
}
