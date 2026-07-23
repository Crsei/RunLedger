/** Handoff target-first commit 与 source fencing 协调器；不提供 transport fallback。 */

import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withDurableStateLock } from "../durable-state-lock.ts";
import { canonicalDigest, canonicalJson } from "../protocol/v3/canonical-json.ts";
import {
	isRuntimeId,
	type AuthorityId,
	type ReceiptId,
	type RuntimeInstanceId,
	type TenantId,
} from "../protocol/v3/ids.ts";
import {
	transferSessionHandoff,
	type ExecutorPortResult,
	type SessionHandoffPort,
} from "./ports.ts";
import type { SessionHandoffManifest, SessionHandoffReceipt } from "./types.ts";

export interface DurableSessionHandoffIntent {
	manifest: SessionHandoffManifest;
	sourceRuntimeGeneration: number;
	targetAuthorityId: AuthorityId;
	targetTenantId: TenantId;
	targetRuntimeId: RuntimeInstanceId;
	targetRuntimeGeneration: number;
	attestationReceiptId: ReceiptId;
	attestationReceiptDigest: string;
	sourceFenceIntentDigest: string;
	intentDigest: string;
}

export interface DurableSessionHandoffTerminal {
	intentDigest: string;
	transferReceipt: Extract<SessionHandoffReceipt, { status: "accepted" }>;
	terminalDigest: string;
}

export type SessionHandoffAuthorityState =
	| "intent_recorded"
	| "transfer_pending"
	| "target_committed"
	| "source_fence_pending"
	| "completed"
	| "failed"
	| "reconciliation_required";

export interface SessionHandoffAuthorityRecordBody {
	schemaVersion: 1;
	intent: DurableSessionHandoffIntent;
	state: SessionHandoffAuthorityState;
	revision: number;
	previousRecordDigest: string | null;
	requestedEventDigest?: string;
	commitEventDigest?: string;
	terminal?: DurableSessionHandoffTerminal;
	sourceFenceReceipt?: { receiptId: ReceiptId; receiptDigest: string };
	reasonDigest?: string;
	updatedAt: string;
}

export interface SessionHandoffAuthorityRecord extends SessionHandoffAuthorityRecordBody {
	recordDigest: string;
}

export interface SessionHandoffAuthorityPort {
	prepare(
		intent: DurableSessionHandoffIntent,
	): Promise<ExecutorPortResult<{
		kind: "created" | "replayed";
		record: SessionHandoffAuthorityRecord;
	}>>;
	compareAndSet(
		current: SessionHandoffAuthorityRecord,
		candidate: SessionHandoffAuthorityRecord,
	): Promise<ExecutorPortResult<SessionHandoffAuthorityRecord>>;
}

export interface SessionHandoffLifecycleEventPort {
	recordRequested(intent: DurableSessionHandoffIntent): Promise<ExecutorPortResult<{ eventDigest: string }>>;
	recordCommitted(
		intent: DurableSessionHandoffIntent,
		terminal: DurableSessionHandoffTerminal,
	): Promise<ExecutorPortResult<{ eventDigest: string }>>;
	recordFailed(
		intent: DurableSessionHandoffIntent,
		error: { reasonDigest: string; outcomeCertain: boolean },
	): Promise<ExecutorPortResult<{ eventDigest: string }>>;
}

export interface SessionHandoffAttestorPort {
	verify(intent: DurableSessionHandoffIntent): Promise<ExecutorPortResult<{ receiptDigest: string }>>;
}

export interface RuntimeGenerationReadPort {
	current(
		authorityId: AuthorityId,
		tenantId: TenantId,
		runtimeId: RuntimeInstanceId,
	): Promise<ExecutorPortResult<number>>;
}

export interface SourceRuntimeFencePort {
	fenceAndDrain(
		intent: DurableSessionHandoffIntent,
		terminal: DurableSessionHandoffTerminal,
	): Promise<ExecutorPortResult<{ receiptId: ReceiptId; receiptDigest: string }>>;
}

export interface DurableSessionHandoffResult {
	terminal: DurableSessionHandoffTerminal;
	commitEventDigest: string;
	sourceFenceReceipt: { receiptId: ReceiptId; receiptDigest: string };
}

const transitions: Readonly<Record<SessionHandoffAuthorityState, readonly SessionHandoffAuthorityState[]>> = {
	intent_recorded: ["transfer_pending", "failed"],
	transfer_pending: ["target_committed", "failed", "reconciliation_required"],
	target_committed: ["source_fence_pending"],
	source_fence_pending: ["completed", "reconciliation_required"],
	completed: [],
	failed: [],
	reconciliation_required: [],
};

function failure(
	code: "handoff_rejected" | "conflict" | "reconciliation_required" | "external_gap" | "durable_write_failed",
	reason: string,
	outcomeCertain = true,
	retryable = false,
): ExecutorPortResult<never> {
	return {
		ok: false,
		error: {
			code,
			retryable,
			reasonDigest: /^[a-f0-9]{64}$/.test(reason) ? reason : canonicalDigest(reason),
			outcomeCertain,
		},
	};
}

function validIntent(intent: DurableSessionHandoffIntent): boolean {
	const { intentDigest: _intentDigest, ...body } = intent;
	return intent.sourceRuntimeGeneration > 0 &&
		intent.targetRuntimeGeneration > 0 &&
		intent.targetTenantId === intent.manifest.tenantId &&
		isRuntimeId(intent.targetAuthorityId, "authority") &&
		isRuntimeId(intent.targetRuntimeId, "runtime") &&
		isRuntimeId(intent.attestationReceiptId, "receipt") &&
		/^[a-f0-9]{64}$/.test(intent.attestationReceiptDigest) &&
		/^[a-f0-9]{64}$/.test(intent.sourceFenceIntentDigest) &&
		intent.intentDigest === canonicalDigest(body);
}

function validTerminal(
	terminal: DurableSessionHandoffTerminal,
	intent: DurableSessionHandoffIntent,
): boolean {
	const { terminalDigest: _terminalDigest, ...body } = terminal;
	return terminal.intentDigest === intent.intentDigest &&
		terminal.transferReceipt.status === "accepted" &&
		terminal.transferReceipt.manifestDigest === intent.manifest.manifestDigest &&
		terminal.terminalDigest === canonicalDigest(body);
}

function recordBody(record: SessionHandoffAuthorityRecord): SessionHandoffAuthorityRecordBody {
	const { recordDigest: _recordDigest, ...body } = record;
	return body;
}

function withDigest(body: SessionHandoffAuthorityRecordBody): SessionHandoffAuthorityRecord {
	return { ...body, recordDigest: canonicalDigest(body) };
}

function validRecord(value: unknown): value is SessionHandoffAuthorityRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Partial<SessionHandoffAuthorityRecord>;
	if (
		record.schemaVersion !== 1 ||
		!record.intent ||
		!validIntent(record.intent) ||
		!Object.hasOwn(transitions, record.state ?? "") ||
		!Number.isSafeInteger(record.revision) ||
		(record.revision ?? 0) < 1 ||
		(record.previousRecordDigest !== null && !/^[a-f0-9]{64}$/.test(record.previousRecordDigest ?? "")) ||
		typeof record.updatedAt !== "string" ||
		!Number.isFinite(Date.parse(record.updatedAt)) ||
		!/^[a-f0-9]{64}$/.test(record.recordDigest ?? "") ||
		(record.terminal !== undefined && !validTerminal(record.terminal, record.intent)) ||
		(record.sourceFenceReceipt !== undefined && (
			!isRuntimeId(record.sourceFenceReceipt.receiptId, "receipt") ||
			!/^[a-f0-9]{64}$/.test(record.sourceFenceReceipt.receiptDigest)
		))
	) return false;
	if (
		(record.state === "target_committed" || record.state === "source_fence_pending" || record.state === "completed") &&
		!record.terminal
	) return false;
	if (record.state === "completed" && (!record.sourceFenceReceipt || !record.commitEventDigest)) return false;
	return record.recordDigest === canonicalDigest(recordBody(record as SessionHandoffAuthorityRecord));
}

function transition(
	current: SessionHandoffAuthorityRecord,
	state: SessionHandoffAuthorityState,
	patch: Partial<Pick<
		SessionHandoffAuthorityRecordBody,
		"requestedEventDigest" | "commitEventDigest" | "terminal" | "sourceFenceReceipt" | "reasonDigest"
	>>,
	updatedAt: string,
): ExecutorPortResult<SessionHandoffAuthorityRecord> {
	if (!transitions[current.state].includes(state)) {
		return failure("conflict", `invalid handoff authority transition ${current.state} -> ${state}`);
	}
	const candidate = withDigest({
		...recordBody(current),
		...patch,
		state,
		revision: current.revision + 1,
		previousRecordDigest: current.recordDigest,
		updatedAt,
	});
	return validRecord(candidate)
		? { ok: true, value: candidate }
		: failure("conflict", "handoff authority transition is invalid");
}

export function createDurableSessionHandoffIntent(
	body: Omit<DurableSessionHandoffIntent, "intentDigest">,
): ExecutorPortResult<DurableSessionHandoffIntent> {
	const intent = { ...body, intentDigest: canonicalDigest(body) };
	return validIntent(intent)
		? { ok: true, value: intent }
		: failure("handoff_rejected", "session handoff intent is invalid");
}

export class MemorySessionHandoffAuthority implements SessionHandoffAuthorityPort {
	readonly #records = new Map<string, SessionHandoffAuthorityRecord>();
	readonly #clock: () => Date;

	public constructor(clock: () => Date = () => new Date()) {
		this.#clock = clock;
	}

	public async prepare(
		intent: DurableSessionHandoffIntent,
	): Promise<ExecutorPortResult<{ kind: "created" | "replayed"; record: SessionHandoffAuthorityRecord }>> {
		if (!validIntent(intent)) return failure("handoff_rejected", "session handoff intent is invalid");
		const existing = this.#records.get(intent.manifest.manifestDigest);
		if (existing) {
			return existing.intent.intentDigest === intent.intentDigest
				? { ok: true, value: { kind: "replayed", record: structuredClone(existing) } }
				: failure("conflict", "handoff manifest was reused with changed intent");
		}
		const record = withDigest({
			schemaVersion: 1,
			intent,
			state: "intent_recorded",
			revision: 1,
			previousRecordDigest: null,
			updatedAt: this.#clock().toISOString(),
		});
		this.#records.set(intent.manifest.manifestDigest, structuredClone(record));
		return { ok: true, value: { kind: "created", record } };
	}

	public async compareAndSet(
		current: SessionHandoffAuthorityRecord,
		candidate: SessionHandoffAuthorityRecord,
	): Promise<ExecutorPortResult<SessionHandoffAuthorityRecord>> {
		if (!validRecord(current) || !validRecord(candidate)) {
			return failure("conflict", "handoff authority CAS record is invalid");
		}
		const key = current.intent.manifest.manifestDigest;
		const stored = this.#records.get(key);
		if (!stored || stored.recordDigest !== current.recordDigest ||
			candidate.previousRecordDigest !== current.recordDigest) {
			return failure("conflict", "handoff authority CAS expectation is stale");
		}
		this.#records.set(key, structuredClone(candidate));
		return { ok: true, value: structuredClone(candidate) };
	}
}

export class FileSessionHandoffAuthority implements SessionHandoffAuthorityPort {
	readonly #root: string;
	readonly #clock: () => Date;

	public constructor(root: string, clock: () => Date = () => new Date()) {
		this.#root = resolve(root);
		this.#clock = clock;
	}

	#path(intent: DurableSessionHandoffIntent): string {
		const scope = canonicalDigest({
			authorityId: intent.manifest.authorityId,
			tenantId: intent.manifest.tenantId,
		});
		return join(this.#root, scope, `${intent.manifest.manifestDigest}.json`);
	}

	async #read(path: string): Promise<ExecutorPortResult<SessionHandoffAuthorityRecord | undefined>> {
		try {
			const bytes = await readFile(path);
			if (bytes.byteLength > 16 * 1024 * 1024) {
				return failure("durable_write_failed", "handoff authority record exceeds limit");
			}
			const value: unknown = JSON.parse(bytes.toString("utf8"));
			return validRecord(value)
				? { ok: true, value }
				: failure("durable_write_failed", "handoff authority record failed integrity validation");
		} catch (error) {
			if (error instanceof SyntaxError) {
				return failure("durable_write_failed", "handoff authority record is not valid JSON");
			}
			const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
			return code === "ENOENT"
				? { ok: true, value: undefined }
				: failure("durable_write_failed", "handoff authority record could not be read", false, true);
		}
	}

	async #write(path: string, record: SessionHandoffAuthorityRecord): Promise<ExecutorPortResult<SessionHandoffAuthorityRecord>> {
		const directory = dirname(path);
		const temporary = `${path}.${crypto.randomUUID()}.tmp`;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			await mkdir(directory, { recursive: true, mode: 0o700 });
			handle = await open(temporary, "wx", 0o600);
			await handle.writeFile(canonicalJson(record), "utf8");
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
			return { ok: true, value: record };
		} catch {
			if (handle) await handle.close().catch(() => undefined);
			await unlink(temporary).catch(() => undefined);
			return failure("durable_write_failed", "handoff authority record could not be published", false, true);
		}
	}

	public async prepare(
		intent: DurableSessionHandoffIntent,
	): Promise<ExecutorPortResult<{ kind: "created" | "replayed"; record: SessionHandoffAuthorityRecord }>> {
		if (!validIntent(intent)) return failure("handoff_rejected", "session handoff intent is invalid");
		const path = this.#path(intent);
		try {
			return await withDurableStateLock(path, async () => {
				const existing = await this.#read(path);
				if (!existing.ok) return existing;
				if (existing.value) {
					return existing.value.intent.intentDigest === intent.intentDigest
						? { ok: true, value: { kind: "replayed" as const, record: existing.value } }
						: failure("conflict", "handoff manifest was reused with changed intent");
				}
				const record = withDigest({
					schemaVersion: 1,
					intent,
					state: "intent_recorded",
					revision: 1,
					previousRecordDigest: null,
					updatedAt: this.#clock().toISOString(),
				});
				const written = await this.#write(path, record);
				return written.ok
					? { ok: true, value: { kind: "created" as const, record: written.value } }
					: written;
			});
		} catch {
			return failure("durable_write_failed", "handoff authority state lock is unavailable", false, true);
		}
	}

	public async compareAndSet(
		current: SessionHandoffAuthorityRecord,
		candidate: SessionHandoffAuthorityRecord,
	): Promise<ExecutorPortResult<SessionHandoffAuthorityRecord>> {
		if (!validRecord(current) || !validRecord(candidate)) {
			return failure("conflict", "handoff authority CAS record is invalid");
		}
		const path = this.#path(current.intent);
		try {
			return await withDurableStateLock(path, async () => {
				const stored = await this.#read(path);
				if (!stored.ok || !stored.value || stored.value.recordDigest !== current.recordDigest ||
					candidate.previousRecordDigest !== current.recordDigest) {
					return failure("conflict", "handoff authority CAS expectation is stale");
				}
				return this.#write(path, candidate);
			});
		} catch {
			return failure("durable_write_failed", "handoff authority state lock is unavailable", false, true);
		}
	}
}

export class DurableSessionHandoffCoordinator {
	readonly #authority: SessionHandoffAuthorityPort;
	readonly #lifecycle: SessionHandoffLifecycleEventPort;
	readonly #transport: SessionHandoffPort;
	readonly #attestor: SessionHandoffAttestorPort;
	readonly #generations: RuntimeGenerationReadPort;
	readonly #sourceFence: SourceRuntimeFencePort;
	readonly #clock: () => Date;

	public constructor(options: {
		authority: SessionHandoffAuthorityPort;
		lifecycle: SessionHandoffLifecycleEventPort;
		transport: SessionHandoffPort;
		attestor: SessionHandoffAttestorPort;
		generations: RuntimeGenerationReadPort;
		sourceFence: SourceRuntimeFencePort;
		clock?: () => Date;
	}) {
		this.#authority = options.authority;
		this.#lifecycle = options.lifecycle;
		this.#transport = options.transport;
		this.#attestor = options.attestor;
		this.#generations = options.generations;
		this.#sourceFence = options.sourceFence;
		this.#clock = options.clock ?? (() => new Date());
	}

	async #set(
		current: SessionHandoffAuthorityRecord,
		state: SessionHandoffAuthorityState,
		patch: Parameters<typeof transition>[2] = {},
	): Promise<ExecutorPortResult<SessionHandoffAuthorityRecord>> {
		const candidate = transition(current, state, patch, this.#clock().toISOString());
		return candidate.ok ? this.#authority.compareAndSet(current, candidate.value) : candidate;
	}

	#completed(record: SessionHandoffAuthorityRecord): ExecutorPortResult<DurableSessionHandoffResult> {
		return record.terminal && record.commitEventDigest && record.sourceFenceReceipt
			? {
				ok: true,
				value: {
					terminal: record.terminal,
					commitEventDigest: record.commitEventDigest,
					sourceFenceReceipt: record.sourceFenceReceipt,
				},
			}
			: failure("reconciliation_required", "completed handoff record is incomplete", false);
	}

	public async handoff(
		intent: DurableSessionHandoffIntent,
		signal?: AbortSignal,
	): Promise<ExecutorPortResult<DurableSessionHandoffResult>> {
		if (!validIntent(intent)) return failure("handoff_rejected", "session handoff intent is invalid");
		if (intent.targetTenantId !== intent.manifest.tenantId) {
			return failure("handoff_rejected", "cross-tenant handoff is not automatically authorized");
		}
		const prepared = await this.#authority.prepare(intent);
		if (!prepared.ok) return prepared;
		let record = prepared.value.record;
		if (record.state === "completed") return this.#completed(record);
		if (record.state === "failed") return failure("handoff_rejected", record.reasonDigest ?? record.recordDigest);
		if (record.state === "reconciliation_required") {
			return failure("reconciliation_required", record.reasonDigest ?? record.recordDigest, false);
		}
		if (record.state === "transfer_pending" || record.state === "source_fence_pending") {
			const reconciled = await this.#set(record, "reconciliation_required", {
				reasonDigest: canonicalDigest(`handoff restarted from uncertain ${record.state}`),
			});
			return failure(
				"reconciliation_required",
				reconciled.ok ? reconciled.value.recordDigest : record.recordDigest,
				false,
			);
		}
		if (record.state === "intent_recorded") {
			const sourceGeneration = await this.#generations.current(
				intent.manifest.authorityId,
				intent.manifest.tenantId,
				intent.manifest.sourceRuntimeId,
			);
			if (!sourceGeneration.ok) return sourceGeneration;
			if (sourceGeneration.value !== intent.sourceRuntimeGeneration) {
				return failure("handoff_rejected", "source runtime generation is stale");
			}
			const attestation = await this.#attestor.verify(intent);
			if (!attestation.ok) return failure("external_gap", attestation.error.reasonDigest);
			if (attestation.value.receiptDigest !== intent.attestationReceiptDigest) {
				return failure("handoff_rejected", "handoff attestation receipt is uncorrelated");
			}
			const requested = await this.#lifecycle.recordRequested(intent);
			if (!requested.ok) return requested;
			const pending = await this.#set(record, "transfer_pending", {
				requestedEventDigest: requested.value.eventDigest,
			});
			if (!pending.ok) return pending;
			record = pending.value;

			const transferred = await transferSessionHandoff(this.#transport, intent.manifest, signal);
			if (!transferred.ok) {
				const certain = transferred.error.outcomeCertain === true;
				const terminalState = certain ? "failed" : "reconciliation_required";
				const terminalRecord = await this.#set(record, terminalState, {
					reasonDigest: transferred.error.reasonDigest,
				});
				await this.#lifecycle.recordFailed(intent, {
					reasonDigest: transferred.error.reasonDigest,
					outcomeCertain: certain,
				});
				return terminalRecord.ok && !certain
					? failure("reconciliation_required", terminalRecord.value.recordDigest, false)
					: transferred;
			}
			if (transferred.value.status !== "accepted") {
				return failure("handoff_rejected", "handoff target did not accept the manifest");
			}
			const terminalBody = {
				intentDigest: intent.intentDigest,
				transferReceipt: transferred.value,
			};
			const terminal: DurableSessionHandoffTerminal = {
				...terminalBody,
				terminalDigest: canonicalDigest(terminalBody),
			};
			const targetCommitted = await this.#set(record, "target_committed", { terminal });
			if (!targetCommitted.ok) {
				return failure("reconciliation_required", targetCommitted.error.reasonDigest, false);
			}
			record = targetCommitted.value;
		}
		if (record.state !== "target_committed" || !record.terminal) {
			return failure("reconciliation_required", "handoff target terminal state is unavailable", false);
		}
		const terminal = record.terminal;
		const committed = await this.#lifecycle.recordCommitted(intent, terminal);
		if (!committed.ok) return committed;
		const fencePending = await this.#set(record, "source_fence_pending", {
			commitEventDigest: committed.value.eventDigest,
		});
		if (!fencePending.ok) return fencePending;
		record = fencePending.value;
		const sourceFence = await this.#sourceFence.fenceAndDrain(intent, terminal);
		if (!sourceFence.ok) {
			const reconciled = await this.#set(record, "reconciliation_required", {
				reasonDigest: sourceFence.error.reasonDigest,
			});
			return reconciled.ok
				? failure("reconciliation_required", reconciled.value.recordDigest, false)
				: failure("reconciliation_required", record.recordDigest, false);
		}
		const completed = await this.#set(record, "completed", {
			sourceFenceReceipt: sourceFence.value,
		});
		return completed.ok ? this.#completed(completed.value) : completed;
	}
}
