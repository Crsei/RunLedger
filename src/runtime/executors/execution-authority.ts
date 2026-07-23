/** Remote execution 的 durable authority 与 effect-once 协调器。 */

import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withDurableStateLock } from "../durable-state-lock.ts";
import { canonicalDigest, canonicalJson } from "../protocol/v3/canonical-json.ts";
import {
	isRuntimeId,
	type AgentId,
	type AuthorityId,
	type CommandId,
	type RuntimeInstanceId,
	type TenantId,
} from "../protocol/v3/ids.ts";
import type {
	AcceptedRemoteExecution,
	ExecutorPortError,
	ExecutorPortResult,
	FailClosedRemoteExecutorGateway,
} from "./ports.ts";
import type { RemoteExecutorInvocation } from "./types.ts";

export const REMOTE_EXECUTION_AUTHORITY_SCHEMA_VERSION = 1 as const;
export const REMOTE_EXECUTION_STATES = [
	"prepared",
	"effect_pending",
	"terminal_pending",
	"succeeded",
	"failed",
	"cancelled",
	"reconciliation_required",
] as const;
export type RemoteExecutionState = (typeof REMOTE_EXECUTION_STATES)[number];

export interface RemoteExecutionAuthorityRecordBody {
	schemaVersion: typeof REMOTE_EXECUTION_AUTHORITY_SCHEMA_VERSION;
	authorityId: AuthorityId;
	tenantId: TenantId;
	requestId: CommandId;
	runtimeId: RuntimeInstanceId;
	runtimeGeneration: number;
	agentId: AgentId;
	requestDigest: string;
	invocation: RemoteExecutorInvocation;
	state: RemoteExecutionState;
	revision: number;
	previousRecordDigest: string | null;
	requestedEventDigest?: string;
	terminalEventDigest?: string;
	effect?: AcceptedRemoteExecution;
	error?: ExecutorPortError;
	updatedAt: string;
}

export interface RemoteExecutionAuthorityRecord extends RemoteExecutionAuthorityRecordBody {
	recordDigest: string;
}

export type RemoteExecutionAuthorityErrorCode =
	| "invalid_record"
	| "not_found"
	| "conflict"
	| "corrupt_record"
	| "durable_write_failed";

export type RemoteExecutionAuthorityResult<T> =
	| { ok: true; value: T }
	| {
			ok: false;
			error: {
				code: RemoteExecutionAuthorityErrorCode;
				message: string;
				retryable: boolean;
			};
	  };

export interface RemoteExecutionAuthorityRepository {
	load(
		authorityId: AuthorityId,
		tenantId: TenantId,
		requestId: CommandId,
	): Promise<RemoteExecutionAuthorityResult<RemoteExecutionAuthorityRecord>>;
	prepare(
		record: RemoteExecutionAuthorityRecord,
	): Promise<RemoteExecutionAuthorityResult<{ kind: "created" | "replay"; record: RemoteExecutionAuthorityRecord }>>;
	compareAndSet(
		current: RemoteExecutionAuthorityRecord,
		candidate: RemoteExecutionAuthorityRecord,
	): Promise<RemoteExecutionAuthorityResult<RemoteExecutionAuthorityRecord>>;
}

export interface RemoteExecutionCanonicalEventPort {
	recordRequested(
		record: RemoteExecutionAuthorityRecord,
	): Promise<ExecutorPortResult<{ eventDigest: string }>>;
	recordTerminal(
		record: RemoteExecutionAuthorityRecord,
	): Promise<ExecutorPortResult<{ eventDigest: string }>>;
}

export interface DurableRemoteExecutionServiceOptions {
	repository: RemoteExecutionAuthorityRepository;
	gateway: Pick<FailClosedRemoteExecutorGateway, "execute">;
	events: RemoteExecutionCanonicalEventPort;
	runtimeId: RuntimeInstanceId;
	runtimeGeneration: number;
	agentId: AgentId;
	clock?: () => Date;
}

const stateTransitions: Readonly<Record<RemoteExecutionState, readonly RemoteExecutionState[]>> = {
	prepared: ["effect_pending"],
	effect_pending: ["terminal_pending", "failed", "cancelled", "reconciliation_required"],
	terminal_pending: ["succeeded", "failed", "cancelled", "reconciliation_required"],
	succeeded: [],
	failed: [],
	cancelled: [],
	reconciliation_required: [],
};

function authorityFailure<T>(
	code: RemoteExecutionAuthorityErrorCode,
	message: string,
	retryable = false,
): RemoteExecutionAuthorityResult<T> {
	return { ok: false, error: { code, message, retryable } };
}

function executorFailure(
	code: ExecutorPortError["code"],
	reason: string,
	retryable = false,
	outcomeCertain = true,
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

function recordBody(record: RemoteExecutionAuthorityRecord): RemoteExecutionAuthorityRecordBody {
	const { recordDigest: _recordDigest, ...body } = record;
	return body;
}

function withDigest(body: RemoteExecutionAuthorityRecordBody): RemoteExecutionAuthorityRecord {
	return { ...body, recordDigest: canonicalDigest(body) };
}

function recordKey(authorityId: AuthorityId, tenantId: TenantId, requestId: CommandId): string {
	return `${authorityId}\u0000${tenantId}\u0000${requestId}`;
}

function isDigest(value: unknown): value is string {
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isRemoteExecutionAuthorityRecord(value: unknown): value is RemoteExecutionAuthorityRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Partial<RemoteExecutionAuthorityRecord>;
	if (
		record.schemaVersion !== REMOTE_EXECUTION_AUTHORITY_SCHEMA_VERSION ||
		!isRuntimeId(record.authorityId, "authority") ||
		!isRuntimeId(record.tenantId, "tenant") ||
		!isRuntimeId(record.requestId, "command") ||
		!isRuntimeId(record.runtimeId, "runtime") ||
		!isRuntimeId(record.agentId, "agent") ||
		!Number.isSafeInteger(record.runtimeGeneration) ||
		(record.runtimeGeneration ?? 0) < 1 ||
		!Number.isSafeInteger(record.revision) ||
		(record.revision ?? 0) < 1 ||
		!isDigest(record.requestDigest) ||
		!REMOTE_EXECUTION_STATES.includes(record.state as RemoteExecutionState) ||
		typeof record.updatedAt !== "string" ||
		!Number.isFinite(Date.parse(record.updatedAt)) ||
		!isDigest(record.recordDigest) ||
		(record.previousRecordDigest !== null && !isDigest(record.previousRecordDigest)) ||
		record.invocation?.authorityId !== record.authorityId ||
		record.invocation.tenantId !== record.tenantId ||
		record.invocation.requestId !== record.requestId
	) return false;
	return record.recordDigest === canonicalDigest(recordBody(record as RemoteExecutionAuthorityRecord));
}

function candidateRecord(
	current: RemoteExecutionAuthorityRecord,
	state: RemoteExecutionState,
	updatedAt: string,
	patch: Partial<Pick<
		RemoteExecutionAuthorityRecordBody,
		"requestedEventDigest" | "terminalEventDigest" | "effect" | "error"
	>> = {},
): RemoteExecutionAuthorityResult<RemoteExecutionAuthorityRecord> {
	if (!stateTransitions[current.state].includes(state)) {
		return authorityFailure("conflict", `invalid remote execution transition ${current.state} -> ${state}`);
	}
	return {
		ok: true,
		value: withDigest({
			...recordBody(current),
			...patch,
			state,
			revision: current.revision + 1,
			previousRecordDigest: current.recordDigest,
			updatedAt,
		}),
	};
}

export class MemoryRemoteExecutionAuthorityRepository implements RemoteExecutionAuthorityRepository {
	readonly #records = new Map<string, RemoteExecutionAuthorityRecord>();

	public async load(
		authorityId: AuthorityId,
		tenantId: TenantId,
		requestId: CommandId,
	): Promise<RemoteExecutionAuthorityResult<RemoteExecutionAuthorityRecord>> {
		const record = this.#records.get(recordKey(authorityId, tenantId, requestId));
		return record
			? { ok: true, value: structuredClone(record) }
			: authorityFailure("not_found", "remote execution authority record was not found");
	}

	public async prepare(
		record: RemoteExecutionAuthorityRecord,
	): Promise<RemoteExecutionAuthorityResult<{ kind: "created" | "replay"; record: RemoteExecutionAuthorityRecord }>> {
		if (!isRemoteExecutionAuthorityRecord(record) || record.state !== "prepared" || record.revision !== 1) {
			return authorityFailure("invalid_record", "remote execution prepared record is invalid");
		}
		const key = recordKey(record.authorityId, record.tenantId, record.requestId);
		const existing = this.#records.get(key);
		if (existing) {
			if (existing.requestDigest !== record.requestDigest) {
				return authorityFailure("conflict", "remote execution requestId was reused with changed input");
			}
			return { ok: true, value: { kind: "replay", record: structuredClone(existing) } };
		}
		this.#records.set(key, structuredClone(record));
		return { ok: true, value: { kind: "created", record: structuredClone(record) } };
	}

	public async compareAndSet(
		current: RemoteExecutionAuthorityRecord,
		candidate: RemoteExecutionAuthorityRecord,
	): Promise<RemoteExecutionAuthorityResult<RemoteExecutionAuthorityRecord>> {
		if (!isRemoteExecutionAuthorityRecord(current) || !isRemoteExecutionAuthorityRecord(candidate)) {
			return authorityFailure("invalid_record", "remote execution CAS record is invalid");
		}
		const key = recordKey(current.authorityId, current.tenantId, current.requestId);
		const stored = this.#records.get(key);
		if (!stored || stored.recordDigest !== current.recordDigest || candidate.previousRecordDigest !== current.recordDigest) {
			return authorityFailure("conflict", "remote execution CAS expectation is stale");
		}
		this.#records.set(key, structuredClone(candidate));
		return { ok: true, value: structuredClone(candidate) };
	}
}

export class FileRemoteExecutionAuthorityRepository implements RemoteExecutionAuthorityRepository {
	readonly #root: string;
	readonly #maxBytes: number;

	public constructor(root: string, maxBytes = 8 * 1024 * 1024) {
		this.#root = resolve(root);
		this.#maxBytes = Math.max(1024, Math.min(64 * 1024 * 1024, Math.trunc(maxBytes)));
	}

	#path(authorityId: AuthorityId, tenantId: TenantId, requestId: CommandId): string {
		const scope = canonicalDigest({ authorityId, tenantId });
		return join(this.#root, scope, `${canonicalDigest({ authorityId, tenantId, requestId })}.json`);
	}

	async #read(path: string): Promise<RemoteExecutionAuthorityResult<RemoteExecutionAuthorityRecord>> {
		try {
			const bytes = await readFile(path);
			if (bytes.byteLength > this.#maxBytes) return authorityFailure("corrupt_record", "remote execution record exceeds limit");
			const value: unknown = JSON.parse(bytes.toString("utf8"));
			return isRemoteExecutionAuthorityRecord(value)
				? { ok: true, value }
				: authorityFailure("corrupt_record", "remote execution record failed integrity validation");
		} catch (error) {
			if (error instanceof SyntaxError) {
				return authorityFailure("corrupt_record", "remote execution record is not valid JSON");
			}
			const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
			return code === "ENOENT"
				? authorityFailure("not_found", "remote execution authority record was not found")
				: authorityFailure("durable_write_failed", "remote execution record could not be read", true);
		}
	}

	async #write(path: string, record: RemoteExecutionAuthorityRecord): Promise<RemoteExecutionAuthorityResult<void>> {
		const directory = dirname(path);
		const temporary = `${path}.${canonicalDigest({ recordDigest: record.recordDigest, nonce: crypto.randomUUID() })}.tmp`;
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
			return { ok: true, value: undefined };
		} catch {
			if (handle) await handle.close().catch(() => undefined);
			await unlink(temporary).catch(() => undefined);
			return authorityFailure("durable_write_failed", "remote execution record could not be published", true);
		}
	}

	public load(
		authorityId: AuthorityId,
		tenantId: TenantId,
		requestId: CommandId,
	): Promise<RemoteExecutionAuthorityResult<RemoteExecutionAuthorityRecord>> {
		return this.#read(this.#path(authorityId, tenantId, requestId));
	}

	public async prepare(
		record: RemoteExecutionAuthorityRecord,
	): Promise<RemoteExecutionAuthorityResult<{ kind: "created" | "replay"; record: RemoteExecutionAuthorityRecord }>> {
		if (!isRemoteExecutionAuthorityRecord(record) || record.state !== "prepared" || record.revision !== 1) {
			return authorityFailure("invalid_record", "remote execution prepared record is invalid");
		}
		const path = this.#path(record.authorityId, record.tenantId, record.requestId);
		try {
			return await withDurableStateLock(path, async () => {
				const existing = await this.#read(path);
				if (existing.ok) {
					if (existing.value.requestDigest !== record.requestDigest) {
						return authorityFailure("conflict", "remote execution requestId was reused with changed input");
					}
					return { ok: true, value: { kind: "replay", record: existing.value } };
				}
				if (existing.error.code !== "not_found") return existing;
				const written = await this.#write(path, record);
				return written.ok
					? { ok: true, value: { kind: "created", record } }
					: written;
			});
		} catch {
			return authorityFailure("durable_write_failed", "remote execution state lock is unavailable", true);
		}
	}

	public async compareAndSet(
		current: RemoteExecutionAuthorityRecord,
		candidate: RemoteExecutionAuthorityRecord,
	): Promise<RemoteExecutionAuthorityResult<RemoteExecutionAuthorityRecord>> {
		if (!isRemoteExecutionAuthorityRecord(current) || !isRemoteExecutionAuthorityRecord(candidate)) {
			return authorityFailure("invalid_record", "remote execution CAS record is invalid");
		}
		const path = this.#path(current.authorityId, current.tenantId, current.requestId);
		try {
			return await withDurableStateLock(path, async () => {
				const stored = await this.#read(path);
				if (
					!stored.ok ||
					stored.value.recordDigest !== current.recordDigest ||
					candidate.previousRecordDigest !== current.recordDigest
				) return authorityFailure("conflict", "remote execution CAS expectation is stale");
				const written = await this.#write(path, candidate);
				return written.ok ? { ok: true, value: candidate } : written;
			});
		} catch {
			return authorityFailure("durable_write_failed", "remote execution state lock is unavailable", true);
		}
	}
}

export class DurableRemoteExecutionService {
	readonly #repository: RemoteExecutionAuthorityRepository;
	readonly #gateway: Pick<FailClosedRemoteExecutorGateway, "execute">;
	readonly #events: RemoteExecutionCanonicalEventPort;
	readonly #runtimeId: RuntimeInstanceId;
	readonly #runtimeGeneration: number;
	readonly #agentId: AgentId;
	readonly #clock: () => Date;

	public constructor(options: DurableRemoteExecutionServiceOptions) {
		this.#repository = options.repository;
		this.#gateway = options.gateway;
		this.#events = options.events;
		this.#runtimeId = options.runtimeId;
		this.#runtimeGeneration = options.runtimeGeneration;
		this.#agentId = options.agentId;
		this.#clock = options.clock ?? (() => new Date());
	}

	async #transition(
		current: RemoteExecutionAuthorityRecord,
		state: RemoteExecutionState,
		patch?: Partial<Pick<
			RemoteExecutionAuthorityRecordBody,
			"requestedEventDigest" | "terminalEventDigest" | "effect" | "error"
		>>,
	): Promise<RemoteExecutionAuthorityResult<RemoteExecutionAuthorityRecord>> {
		const candidate = candidateRecord(current, state, this.#clock().toISOString(), patch);
		return candidate.ok ? this.#repository.compareAndSet(current, candidate.value) : candidate;
	}

	async #finishTerminal(
		record: RemoteExecutionAuthorityRecord,
	): Promise<ExecutorPortResult<RemoteExecutionAuthorityRecord>> {
		if (!record.effect) return executorFailure("reconciliation_required", "terminal pending record has no effect", false, false);
		const event = await this.#events.recordTerminal(record);
		if (!event.ok) return event;
		const status = record.effect.result.status;
		const terminalState: RemoteExecutionState =
			status === "succeeded" ? "succeeded" :
			status === "failed" ? "failed" :
			status === "cancelled" ? "cancelled" :
			"reconciliation_required";
		const terminal = await this.#transition(record, terminalState, {
			terminalEventDigest: event.value.eventDigest,
		});
		return terminal.ok
			? terminal
			: executorFailure("durable_write_failed", terminal.error.message, terminal.error.retryable, false);
	}

	public async execute(
		invocation: RemoteExecutorInvocation,
	): Promise<ExecutorPortResult<RemoteExecutionAuthorityRecord>> {
		const requestDigest = canonicalDigest({
			invocation,
			runtimeId: this.#runtimeId,
			runtimeGeneration: this.#runtimeGeneration,
			agentId: this.#agentId,
		});
		const initial = withDigest({
			schemaVersion: REMOTE_EXECUTION_AUTHORITY_SCHEMA_VERSION,
			authorityId: invocation.authorityId,
			tenantId: invocation.tenantId,
			requestId: invocation.requestId,
			runtimeId: this.#runtimeId,
			runtimeGeneration: this.#runtimeGeneration,
			agentId: this.#agentId,
			requestDigest,
			invocation,
			state: "prepared",
			revision: 1,
			previousRecordDigest: null,
			updatedAt: this.#clock().toISOString(),
		});
		const prepared = await this.#repository.prepare(initial);
		if (!prepared.ok) {
			return executorFailure(
				prepared.error.code === "conflict" ? "conflict" : "durable_write_failed",
				prepared.error.message,
				prepared.error.retryable,
			);
		}
		let record = prepared.value.record;
		if (record.requestDigest !== requestDigest) {
			return executorFailure("conflict", "remote execution exact duplicate changed input");
		}
		if (["succeeded", "failed", "cancelled"].includes(record.state)) return { ok: true, value: record };
		if (record.state === "reconciliation_required") {
			return executorFailure("reconciliation_required", record.recordDigest, false, false);
		}
		if (record.state === "terminal_pending") return this.#finishTerminal(record);
		if (record.state === "effect_pending") {
			const reconciled = await this.#transition(record, "reconciliation_required", {
				error: {
					code: "reconciliation_required",
					retryable: false,
					reasonDigest: canonicalDigest("remote execution restarted after effect boundary"),
					outcomeCertain: false,
				},
			});
			return executorFailure(
				"reconciliation_required",
				reconciled.ok ? reconciled.value.recordDigest : record.recordDigest,
				false,
				false,
			);
		}
		const requested = await this.#events.recordRequested(record);
		if (!requested.ok) return requested;
		const effectPending = await this.#transition(record, "effect_pending", {
			requestedEventDigest: requested.value.eventDigest,
		});
		if (!effectPending.ok) {
			return executorFailure("durable_write_failed", effectPending.error.message, effectPending.error.retryable);
		}
		record = effectPending.value;
		let executed: ExecutorPortResult<AcceptedRemoteExecution>;
		try {
			executed = await this.#gateway.execute(invocation);
		} catch {
			executed = executorFailure(
				"reconciliation_required",
				"remote executor threw after effect boundary",
				false,
				false,
			);
		}
		if (!executed.ok) {
			const outcomeCertain = executed.error.outcomeCertain === true;
			const next = await this.#transition(
				record,
				outcomeCertain ? "failed" : "reconciliation_required",
				{ error: { ...executed.error, outcomeCertain } },
			);
			if (!next.ok) {
				return executorFailure("durable_write_failed", next.error.message, next.error.retryable, false);
			}
			return outcomeCertain
				? { ok: true, value: next.value }
				: executorFailure("reconciliation_required", next.value.recordDigest, false, false);
		}
		const pending = await this.#transition(record, "terminal_pending", { effect: executed.value });
		if (!pending.ok) {
			return executorFailure("reconciliation_required", pending.error.message, false, false);
		}
		return this.#finishTerminal(pending.value);
	}
}
