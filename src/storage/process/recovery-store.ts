/** Canonical process event/recovery journal。
 *
 * 这是 Host 重启时重建 ProcessJournal 的最小实现。文件位置属于 private
 * state；public manager result 只返回 safe handle/summary。内存 Map 只是已
 * hydrate 的 routing cache，构造新实例会重新读取 event/recovery records。
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../../runtime/protocol/canonical-json.ts";
import type { ExecutionHandleRef, ManagedProcessRequest, ProcessState } from "../../runtime/process/types.ts";
import type { RuntimeDigest } from "../../runtime/protocol/foundation.ts";
import type { CommandId } from "../../runtime/protocol/ids.ts";
import type { ExecutionConstraintSnapshot } from "../../runtime/process/execution-decision.ts";
import { projectProcessEvents } from "../../runtime/process/state-machine.ts";
import { isProcessEvent, type ProcessEvent } from "../../runtime/process/events.ts";
import type {
	BackendSpawnReceipt,
	ProcessJournal,
} from "../../runtime/process/manager.ts";
import type { RunledgerLayout } from "../../runtime/contracts/storage-layout.ts";

export interface JsonlProcessJournalOptions {
	readonly layout: RunledgerLayout;
	readonly workspaceStorageKey: string;
}

type RecoveryRecord =
	| { readonly type: "spawn_claim"; readonly handle: ExecutionHandleRef }
	| { readonly type: "spawn_receipt"; readonly handle: ExecutionHandleRef; readonly receipt: BackendSpawnReceipt }
	| { readonly type: "constraint_snapshot"; readonly commandId: ManagedProcessRequest["correlationId"]; readonly snapshot: ExecutionConstraintSnapshot }
	| {
			readonly type: "command_mutation_intent";
			readonly commandId: CommandId;
			readonly operation: ProcessCommandMutationOperation;
			readonly payloadDigest: RuntimeDigest;
			readonly payloadSize: number;
	  }
	| {
			readonly type: "command_mutation_receipt";
			readonly commandId: CommandId;
			readonly operation: ProcessCommandMutationOperation;
			readonly payloadDigest: RuntimeDigest;
			readonly receiptDigest: RuntimeDigest;
	  };

export type ProcessCommandMutationOperation = "write" | "eof";

export interface ProcessCommandMutationState {
	readonly commandId: CommandId;
	readonly operation: ProcessCommandMutationOperation;
	readonly payloadDigest: RuntimeDigest;
	readonly payloadSize: number;
	readonly receiptDigest?: RuntimeDigest;
}

const TERMINAL_STATES: ReadonlySet<ProcessState> = new Set([
	"completed",
	"failed",
	"timed_out",
	"killed",
	"lost",
	"uncertain",
]);

export class JsonlProcessJournal implements ProcessJournal {
	private readonly root: string;
	private readonly recoveryPath: string;
	private readonly eventsByHandle = new Map<string, ProcessEvent[]>();
	private readonly intents = new Map<string, ProcessEvent>();
	private readonly claims = new Set<string>();
	private readonly receipts = new Map<string, BackendSpawnReceipt>();
	private readonly constraintSnapshots = new Map<string, ExecutionConstraintSnapshot>();
	private readonly commandMutations = new Map<string, ProcessCommandMutationState>();
	private readonly reservations = new Map<string, ExecutionHandleRef>();

	public constructor(options: JsonlProcessJournalOptions) {
		this.root = join(options.layout.state, "processes", options.workspaceStorageKey, "journal");
		this.recoveryPath = join(this.root, "recovery.jsonl");
		this.loadEvents();
		this.loadRecoveryRecords();
		this.hydrateReservations();
	}

	public async append(event: ProcessEvent): Promise<void> {
		if (!isProcessEvent(event)) throw new Error("invalid process event");
		const key = processKey(event);
		const events = this.eventsByHandle.get(key) ?? [];
		const duplicate = events.find((existing) => existing.eventId === event.eventId);
		if (duplicate) {
			if (duplicate.eventHash.digest !== event.eventHash.digest) throw new Error("process event id conflict");
			return;
		}
		const projected = projectProcessEvents([...events, event]);
		if (!projected.ok) {
			throw new Error(`invalid process event chain: ${projected.code}`);
		}
		mkdirSync(this.rootFor(event), { recursive: true, mode: 0o700 });
		appendFileSync(this.eventPath(event), `${canonicalJson(event)}\n`, { encoding: "utf8", mode: 0o600 });
		events.push(event);
		this.eventsByHandle.set(key, events);
		if (event.type === "process.execution_requested" && event.commandId) this.intents.set(event.commandId, event);
	}

	public findIntent(commandId: ManagedProcessRequest["correlationId"]): ProcessEvent | undefined {
		return this.intents.get(commandId);
	}

	public eventsFor(handle: ExecutionHandleRef): readonly ProcessEvent[] {
		return this.eventsByHandle.get(processKey(handle))?.slice() ?? [];
	}

	public handles(): readonly ExecutionHandleRef[] {
		return [...this.eventsByHandle.values()]
			.map((events) => events.slice().sort((left, right) => left.sequence - right.sequence).at(-1))
			.filter((event): event is ProcessEvent => event !== undefined)
			.map(handleFromEvent);
	}

	public recordSpawnClaim(handle: ExecutionHandleRef): void {
		const key = processKey(handle);
		if (this.claims.has(key)) return;
		this.ensureRoot();
		this.appendRecovery({ type: "spawn_claim", handle });
		this.claims.add(key);
	}

	public hasSpawnClaim(handle: ExecutionHandleRef): boolean {
		return this.claims.has(processKey(handle));
	}

	public spawnReceipt(handle: ExecutionHandleRef): BackendSpawnReceipt | undefined {
		return this.receipts.get(processKey(handle));
	}

	public recordSpawnReceipt(handle: ExecutionHandleRef, receipt: BackendSpawnReceipt): void {
		const key = processKey(handle);
		const prior = this.receipts.get(key);
		if (prior) {
			if (prior.receiptDigest.digest !== receipt.receiptDigest.digest) throw new Error("spawn receipt conflict");
			return;
		}
		this.ensureRoot();
		this.appendRecovery({ type: "spawn_receipt", handle, receipt });
		this.receipts.set(key, receipt);
	}

	public constraintSnapshot(commandId: ManagedProcessRequest["correlationId"]): ExecutionConstraintSnapshot | undefined {
		return this.constraintSnapshots.get(commandId);
	}

	public recordConstraintSnapshot(commandId: ManagedProcessRequest["correlationId"], snapshot: ExecutionConstraintSnapshot): void {
		const prior = this.constraintSnapshots.get(commandId);
		if (prior) {
			if (prior.snapshotDigest.digest !== snapshot.snapshotDigest.digest) throw new Error("constraint snapshot conflict");
			return;
		}
		this.ensureRoot();
		this.appendRecovery({ type: "constraint_snapshot", commandId, snapshot });
		this.constraintSnapshots.set(commandId, snapshot);
	}

	/**
	 * Durable barrier for create's initial stdin/EOF mutations. A pending intent
	 * is deliberately not replayable: after a response loss the next Host must
	 * report uncertainty instead of sending the same bytes a second time.
	 */
	public commandMutation(commandId: CommandId, operation: ProcessCommandMutationOperation): ProcessCommandMutationState | undefined {
		return this.commandMutations.get(commandMutationKey(commandId, operation));
	}

	public recordCommandMutationIntent(
		commandId: CommandId,
		operation: ProcessCommandMutationOperation,
		payloadDigest: RuntimeDigest,
		payloadSize: number,
	): void {
		if (!Number.isSafeInteger(payloadSize) || payloadSize < 0) throw new Error("command mutation payload size is invalid");
		const key = commandMutationKey(commandId, operation);
		const prior = this.commandMutations.get(key);
		if (prior) {
			if (prior.payloadDigest.digest !== payloadDigest.digest || prior.payloadSize !== payloadSize) throw new Error("command mutation intent conflict");
			return;
		}
		this.ensureRoot();
		this.appendRecovery({ type: "command_mutation_intent", commandId, operation, payloadDigest, payloadSize });
		this.commandMutations.set(key, { commandId, operation, payloadDigest, payloadSize });
	}

	public recordCommandMutationReceipt(commandId: CommandId, operation: ProcessCommandMutationOperation, receiptDigest: RuntimeDigest): void {
		const key = commandMutationKey(commandId, operation);
		const prior = this.commandMutations.get(key);
		if (!prior) throw new Error("command mutation intent is missing");
		if (prior.receiptDigest) {
			if (prior.receiptDigest.digest !== receiptDigest.digest) throw new Error("command mutation receipt conflict");
			return;
		}
		this.ensureRoot();
		this.appendRecovery({
			type: "command_mutation_receipt",
			commandId,
			operation,
			payloadDigest: prior.payloadDigest,
			receiptDigest,
		});
		this.commandMutations.set(key, { ...prior, receiptDigest });
	}

	public reserveProcessCapacity(
		handle: ExecutionHandleRef,
		limits: { readonly maxPerSession: number; readonly maxPerHost: number },
	): "reserved" | "already_reserved" | "session_capacity_exceeded" | "host_capacity_exceeded" {
		const key = processKey(handle);
		if (this.reservations.has(key)) return "already_reserved";
		const sessionCount = [...this.reservations.values()].filter((reserved) => (
			reserved.authorityId === handle.authorityId &&
			reserved.tenantId === handle.tenantId &&
			reserved.workspaceId === handle.workspaceId &&
			reserved.sessionId === handle.sessionId &&
			reserved.hostGeneration === handle.hostGeneration &&
			reserved.sessionGeneration === handle.sessionGeneration
		)).length;
		if (sessionCount >= limits.maxPerSession) return "session_capacity_exceeded";
		if (this.reservations.size >= limits.maxPerHost) return "host_capacity_exceeded";
		this.reservations.set(key, handle);
		return "reserved";
	}

	public releaseProcessCapacity(handle: ExecutionHandleRef): void {
		this.reservations.delete(processKey(handle));
	}

	private loadEvents(): void {
		for (const executionEntry of readDirectories(this.root)) {
			for (const attemptEntry of readFiles(join(this.root, executionEntry))) {
				const filePath = join(this.root, executionEntry, attemptEntry);
				for (const line of readLines(filePath)) {
					const parsed = JSON.parse(line) as unknown;
					if (!isProcessEvent(parsed)) throw new Error(`invalid process event record: ${filePath}`);
					const key = processKey(parsed);
					const events = this.eventsByHandle.get(key) ?? [];
					events.push(parsed);
					this.eventsByHandle.set(key, events);
					if (parsed.type === "process.execution_requested" && parsed.commandId) this.intents.set(parsed.commandId, parsed);
				}
			}
		}
		for (const events of this.eventsByHandle.values()) {
			const projected = projectProcessEvents(events.slice().sort((left, right) => left.sequence - right.sequence));
			if (!projected.ok) throw new Error(`invalid process event chain: ${projected.code}`);
		}
	}

	private loadRecoveryRecords(): void {
		for (const line of readLines(this.recoveryPath)) {
			const record = JSON.parse(line) as RecoveryRecord;
			if (record.type === "constraint_snapshot") {
				this.constraintSnapshots.set(record.commandId, record.snapshot);
				continue;
			}
			if (record.type === "command_mutation_intent") {
				const key = commandMutationKey(record.commandId, record.operation);
				const prior = this.commandMutations.get(key);
				if (prior && (prior.payloadDigest.digest !== record.payloadDigest.digest || prior.payloadSize !== record.payloadSize)) {
					throw new Error("command mutation intent conflict");
				}
				this.commandMutations.set(key, {
					commandId: record.commandId,
					operation: record.operation,
					payloadDigest: record.payloadDigest,
					payloadSize: record.payloadSize,
					...(prior?.receiptDigest === undefined ? {} : { receiptDigest: prior.receiptDigest }),
				});
				continue;
			}
			if (record.type === "command_mutation_receipt") {
				const key = commandMutationKey(record.commandId, record.operation);
				const prior = this.commandMutations.get(key);
				if (!prior || prior.payloadDigest.digest !== record.payloadDigest.digest) throw new Error("command mutation receipt without matching intent");
				if (prior.receiptDigest && prior.receiptDigest.digest !== record.receiptDigest.digest) throw new Error("command mutation receipt conflict");
				this.commandMutations.set(key, { ...prior, receiptDigest: record.receiptDigest });
				continue;
			}
			const key = processKey(record.handle);
			if (record.type === "spawn_claim") this.claims.add(key);
			if (record.type === "spawn_receipt") this.receipts.set(key, record.receipt);
		}
	}

	private hydrateReservations(): void {
		for (const events of this.eventsByHandle.values()) {
			const sorted = events.slice().sort((left, right) => left.sequence - right.sequence);
			const last = sorted.at(-1);
			if (!last || TERMINAL_STATES.has(last.nextState)) continue;
			this.reservations.set(processKey(last), handleFromEvent(last));
		}
	}

	private appendRecovery(record: RecoveryRecord): void {
		appendFileSync(this.recoveryPath, `${canonicalJson(record)}\n`, { encoding: "utf8", mode: 0o600 });
	}

	private ensureRoot(): void {
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
	}

	private rootFor(event: ProcessEvent): string {
		return join(this.root, event.executionId);
	}

	private eventPath(event: ProcessEvent): string {
		return join(this.rootFor(event), `${event.attemptId}.jsonl`);
	}
}

function commandMutationKey(commandId: CommandId, operation: ProcessCommandMutationOperation): string {
	return `${commandId}:${operation}`;
}

function processKey(value: Pick<ExecutionHandleRef, "authorityId" | "tenantId" | "workspaceId" | "sessionId" | "hostGeneration" | "sessionGeneration" | "executionId" | "attemptId">): string {
	return JSON.stringify([
		value.authorityId,
		value.tenantId,
		value.workspaceId,
		value.sessionId,
		value.hostGeneration,
		value.sessionGeneration,
		value.executionId,
		value.attemptId,
	]);
}

function handleFromEvent(event: ProcessEvent): ExecutionHandleRef {
	return {
		authorityId: event.authorityId,
		tenantId: event.tenantId,
		workspaceId: event.workspaceId,
		sessionId: event.sessionId,
		hostGeneration: event.hostGeneration,
		sessionGeneration: event.sessionGeneration,
		executionId: event.executionId,
		attemptId: event.attemptId,
		revision: event.revision,
		requestDigest: event.requestDigest,
	};
}

function readDirectories(directory: string): string[] {
	try {
		return readdirSync(directory, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch (error) {
		if (isNotFound(error)) return [];
		throw error;
	}
}

function readFiles(directory: string): string[] {
	try {
		return readdirSync(directory, { withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => entry.name);
	} catch (error) {
		if (isNotFound(error)) return [];
		throw error;
	}
}

function readLines(filePath: string): string[] {
	try {
		return readFileSync(filePath, "utf8").split(/\r?\n/u).filter((line) => line.length > 0);
	} catch (error) {
		if (isNotFound(error)) return [];
		throw error;
	}
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
