/** Session Event Store backed process journal。filesystem 只保存 private output。 */

import { canonicalJson } from "../protocol/canonical-json.ts";
import { runtimeDigest, type RuntimeDigest } from "../protocol/foundation.ts";
import { createRuntimeId, type CommandId, type RuntimeInstanceId, type WorkspaceId } from "../protocol/ids.ts";
import type { OwnerFence } from "../session-owner/types.ts";
import { isProcessEvent, type ProcessEvent } from "../process/events.ts";
import type { ExecutionConstraintSnapshot } from "../process/execution-decision.ts";
import type { BackendSpawnReceipt, ProcessJournal } from "../process/manager.ts";
import type { ExecutionHandleRef, ProcessState } from "../process/types.ts";
import { projectProcessEvents } from "../process/state-machine.ts";
import type { SessionStore } from "../../storage/session-store/session-store.ts";

const SCHEMA = "runledger.session-process.current" as const;
const TERMINAL: ReadonlySet<ProcessState> = new Set(["completed", "failed", "timed_out", "killed", "lost", "uncertain"]);

interface SessionProcessBinding {
	readonly ownerRuntimeId: RuntimeInstanceId;
	readonly ownerGeneration: number;
}

type SessionProcessRecord =
	| { readonly schema: typeof SCHEMA; readonly kind: "transition"; readonly binding: SessionProcessBinding; readonly event: SessionProcessEvent }
	| { readonly schema: typeof SCHEMA; readonly kind: "spawn_claim"; readonly binding: SessionProcessBinding; readonly handle: SessionProcessHandle }
	| { readonly schema: typeof SCHEMA; readonly kind: "spawn_receipt"; readonly binding: SessionProcessBinding; readonly handle: SessionProcessHandle; readonly receipt: BackendSpawnReceipt }
	| { readonly schema: typeof SCHEMA; readonly kind: "constraint_snapshot"; readonly snapshot: SessionConstraintSnapshot }
	| { readonly schema: typeof SCHEMA; readonly kind: "domain_revision"; readonly operation: string; readonly effectDigest: RuntimeDigest; readonly revision: number };

type SessionProcessHandle = Omit<ExecutionHandleRef, "authorityId" | "tenantId" | "workspaceId" | "sessionId" | "hostGeneration" | "sessionGeneration">;
type SessionProcessEvent = Omit<ProcessEvent, "authorityId" | "tenantId" | "workspaceId" | "sessionId" | "hostGeneration" | "sessionGeneration">;
type SessionConstraintSnapshot = Omit<ExecutionConstraintSnapshot, "authorityId" | "tenantId" | "workspaceId">;

/** 所有 durable mutation 都消费当前 OwnerFence；旧 generation 只能只读 replay。 */
export class SessionProcessJournal implements ProcessJournal {
	private readonly store: SessionStore;
	private readonly fence: OwnerFence;
	private readonly workspaceId: WorkspaceId;
	private readonly eventsByHandle = new Map<string, ProcessEvent[]>();
	private readonly intents = new Map<CommandId, ProcessEvent>();
	private readonly bindings = new Map<string, SessionProcessBinding>();
	private readonly claims = new Set<string>();
	private readonly receipts = new Map<string, BackendSpawnReceipt>();
	private readonly constraintSnapshots = new Map<CommandId, ExecutionConstraintSnapshot>();
	private readonly reservations = new Map<string, ExecutionHandleRef>();
	private currentDomainRevision = 0;

	public constructor(options: { readonly store: SessionStore; readonly fence: OwnerFence; readonly workspaceId: WorkspaceId }) {
		this.store = options.store;
		this.fence = options.fence;
		this.workspaceId = options.workspaceId;
		this.load();
		this.hydrateReservations();
	}

	public async append(event: ProcessEvent): Promise<void> {
		if (!isProcessEvent(event) || event.sessionId !== this.fence.sessionId || event.workspaceId !== this.workspaceId) throw new Error("invalid Session process event");
		const key = processKey(event);
		const events = this.eventsByHandle.get(key) ?? [];
		const duplicate = events.find((candidate) => candidate.eventId === event.eventId);
		if (duplicate !== undefined) {
			if (duplicate.eventHash.digest !== event.eventHash.digest) throw new Error("Session process event id conflict");
			return;
		}
		const projected = projectProcessEvents([...events, event]);
		if (!projected.ok) throw new Error(`invalid Session process event chain: ${projected.code}`);
		const binding = this.bindings.get(key) ?? {
			ownerRuntimeId: this.fence.runtimeId,
			ownerGeneration: event.hostGeneration,
		};
		this.appendRecord(event.type, event.eventId, { schema: SCHEMA, kind: "transition", binding, event: stripEvent(event) });
		events.push(event);
		this.eventsByHandle.set(key, events);
		this.bindings.set(key, binding);
		if (event.type === "process.execution_requested" && event.commandId !== undefined) this.intents.set(event.commandId, event);
	}

	public findIntent(commandId: CommandId): ProcessEvent | undefined { return this.intents.get(commandId); }
	public eventsFor(handle: ExecutionHandleRef): readonly ProcessEvent[] { return this.eventsByHandle.get(processKey(handle))?.slice() ?? []; }
	public handles(): readonly ExecutionHandleRef[] {
		return [...this.eventsByHandle.values()].flatMap((events) => {
			const event = events.slice().sort((left, right) => left.sequence - right.sequence).at(-1);
			return event === undefined ? [] : [handleFromEvent(event)];
		});
	}

	public recordSpawnClaim(handle: ExecutionHandleRef): void {
		const key = processKey(handle);
		if (this.claims.has(key)) return;
		const binding = this.bindingFor(handle);
		this.appendRecord("process.spawn_claimed", undefined, { schema: SCHEMA, kind: "spawn_claim", binding, handle: stripHandle(handle) });
		this.claims.add(key);
	}

	public hasSpawnClaim(handle: ExecutionHandleRef): boolean { return this.claims.has(processKey(handle)); }
	public spawnReceipt(handle: ExecutionHandleRef): BackendSpawnReceipt | undefined { return this.receipts.get(processKey(handle)); }

	public recordSpawnReceipt(handle: ExecutionHandleRef, receipt: BackendSpawnReceipt): void {
		const key = processKey(handle);
		const prior = this.receipts.get(key);
		if (prior !== undefined) {
			if (prior.receiptDigest.digest !== receipt.receiptDigest.digest) throw new Error("Session process spawn receipt conflict");
			return;
		}
		const binding = this.bindingFor(handle);
		this.appendRecord("process.spawn_receipt_recorded", undefined, { schema: SCHEMA, kind: "spawn_receipt", binding, handle: stripHandle(handle), receipt });
		this.receipts.set(key, receipt);
	}

	public constraintSnapshot(commandId: CommandId): ExecutionConstraintSnapshot | undefined { return this.constraintSnapshots.get(commandId); }

	public recordConstraintSnapshot(commandId: CommandId, snapshot: ExecutionConstraintSnapshot): void {
		const prior = this.constraintSnapshots.get(commandId);
		if (prior !== undefined) {
			if (prior.snapshotDigest.digest !== snapshot.snapshotDigest.digest) throw new Error("Session process constraint snapshot conflict");
			return;
		}
		this.appendRecord("process.constraint_snapshot_recorded", undefined, {
			schema: SCHEMA,
			kind: "constraint_snapshot",
			snapshot: stripSnapshot(snapshot),
		});
		this.constraintSnapshots.set(commandId, snapshot);
	}

	public reserveProcessCapacity(handle: ExecutionHandleRef, limits: { readonly maxPerSession: number; readonly maxPerHost: number }): "reserved" | "already_reserved" | "session_capacity_exceeded" | "host_capacity_exceeded" {
		const key = processKey(handle);
		if (this.reservations.has(key)) return "already_reserved";
		if (this.reservations.size >= limits.maxPerSession) return "session_capacity_exceeded";
		void limits.maxPerHost;
		this.reservations.set(key, handle);
		return "reserved";
	}

	public releaseProcessCapacity(handle: ExecutionHandleRef): void { this.reservations.delete(processKey(handle)); }

	public domainRevision(): number { return this.currentDomainRevision; }

	public commitDomainRevision(operation: string, effectId: string): number {
		const revision = this.currentDomainRevision + 1;
		this.appendRecord("process.domain_revision_committed", undefined, {
			schema: SCHEMA,
			kind: "domain_revision",
			operation,
			effectDigest: runtimeDigest(effectId),
			revision,
		});
		this.currentDomainRevision = revision;
		return revision;
	}

	private load(): void {
		for (const stored of this.store.replaySessionEvents(this.fence.sessionId)) {
			if (!stored.eventType.startsWith("process.")) continue;
			let parsed: unknown;
			try { parsed = JSON.parse(stored.payloadJson); } catch { throw new Error("invalid Session process payload"); }
			if (!isRecord(parsed) || parsed.schema !== SCHEMA || typeof parsed.kind !== "string") continue;
			if (parsed.kind === "domain_revision") {
				if (
					typeof parsed.operation !== "string" || parsed.operation.length === 0 ||
					!isRuntimeDigest(parsed.effectDigest) ||
					typeof parsed.revision !== "number" || !Number.isSafeInteger(parsed.revision) ||
					parsed.revision !== this.currentDomainRevision + 1
				) throw new Error("invalid Session process domain revision");
				this.currentDomainRevision = parsed.revision;
				continue;
			}
			if (parsed.kind === "transition") {
				const binding = parseBinding(parsed.binding);
				if (binding === undefined || !isRecord(parsed.event)) throw new Error("invalid Session process transition");
				const event = restoreEvent(parsed.event, binding, this.fence.sessionId, this.workspaceId);
				if (!isProcessEvent(event)) throw new Error("invalid restored Session process event");
				const key = processKey(event);
				const events = this.eventsByHandle.get(key) ?? [];
				events.push(event);
				this.eventsByHandle.set(key, events);
				this.bindings.set(key, binding);
				if (event.type === "process.execution_requested" && event.commandId !== undefined) this.intents.set(event.commandId, event);
				continue;
			}
			if (parsed.kind === "constraint_snapshot" && isRecord(parsed.snapshot)) {
				const snapshot = restoreSnapshot(parsed.snapshot, this.workspaceId);
				this.constraintSnapshots.set(snapshot.commandId, snapshot);
				continue;
			}
			const binding = parseBinding(parsed.binding);
			if (binding === undefined || !isRecord(parsed.handle)) throw new Error("invalid Session process recovery record");
			const handle = restoreHandle(parsed.handle, binding, this.fence.sessionId, this.workspaceId);
			const key = processKey(handle);
			this.bindings.set(key, binding);
			if (parsed.kind === "spawn_claim") this.claims.add(key);
			else if (parsed.kind === "spawn_receipt" && isRecord(parsed.receipt) && isRuntimeDigest(parsed.receipt.receiptDigest)) this.receipts.set(key, parsed.receipt as unknown as BackendSpawnReceipt);
		}
		for (const events of this.eventsByHandle.values()) {
			const projection = projectProcessEvents(events.slice().sort((left, right) => left.sequence - right.sequence));
			if (!projection.ok) throw new Error(`invalid Session process event chain: ${projection.code}`);
		}
	}

	private hydrateReservations(): void {
		for (const handle of this.handles()) {
			const events = this.eventsFor(handle);
			const projection = projectProcessEvents(events);
			if (projection.ok && !TERMINAL.has(projection.state.state)) this.reservations.set(processKey(handle), handle);
		}
	}

	private bindingFor(handle: ExecutionHandleRef): SessionProcessBinding {
		return this.bindings.get(processKey(handle)) ?? { ownerRuntimeId: this.fence.runtimeId, ownerGeneration: handle.hostGeneration };
	}

	private appendRecord(eventType: string, eventId: string | undefined, record: SessionProcessRecord): void {
		const events = this.store.replaySessionEvents(this.fence.sessionId);
		const previous = events.at(-1)?.currentEventHash ?? null;
		this.store.appendEvent(this.fence, {
			eventId: eventId ?? createRuntimeId("event", `session-process-${runtimeDigest(record).digest.slice(0, 64)}`),
			ownerGeneration: this.fence.generation,
			eventType,
			payloadJson: canonicalJson(record),
			createdAtMs: Date.now(),
			expectedPreviousEventHash: previous,
		});
	}
}

function stripHandle(handle: ExecutionHandleRef): SessionProcessHandle {
	const { authorityId: _authorityId, tenantId: _tenantId, workspaceId: _workspaceId, sessionId: _sessionId, hostGeneration: _hostGeneration, sessionGeneration: _sessionGeneration, ...rest } = handle;
	return rest;
}

function stripEvent(event: ProcessEvent): SessionProcessEvent {
	const { authorityId: _authorityId, tenantId: _tenantId, workspaceId: _workspaceId, sessionId: _sessionId, hostGeneration: _hostGeneration, sessionGeneration: _sessionGeneration, ...rest } = event;
	return rest;
}

function stripSnapshot(snapshot: ExecutionConstraintSnapshot): SessionConstraintSnapshot {
	const { authorityId: _authorityId, tenantId: _tenantId, workspaceId: _workspaceId, ...rest } = snapshot;
	return rest;
}

function restoreEvent(event: Record<string, unknown>, binding: SessionProcessBinding, sessionId: OwnerFence["sessionId"], workspaceId: WorkspaceId): ProcessEvent {
	return { ...event, ...legacyIdentity(binding, sessionId, workspaceId) } as unknown as ProcessEvent;
}

function restoreHandle(handle: Record<string, unknown>, binding: SessionProcessBinding, sessionId: OwnerFence["sessionId"], workspaceId: WorkspaceId): ExecutionHandleRef {
	return { ...handle, ...legacyIdentity(binding, sessionId, workspaceId) } as unknown as ExecutionHandleRef;
}

function restoreSnapshot(snapshot: Record<string, unknown>, workspaceId: WorkspaceId): ExecutionConstraintSnapshot {
	return {
		...snapshot,
		authorityId: createRuntimeId("authority", "session-owner-runtime"),
		tenantId: createRuntimeId("tenant", "local-user"),
		workspaceId,
	} as unknown as ExecutionConstraintSnapshot;
}

function legacyIdentity(binding: SessionProcessBinding, sessionId: OwnerFence["sessionId"], workspaceId: WorkspaceId) {
	return {
		authorityId: createRuntimeId("authority", "session-owner-runtime"),
		tenantId: createRuntimeId("tenant", "local-user"),
		workspaceId,
		sessionId,
		hostGeneration: binding.ownerGeneration,
		sessionGeneration: binding.ownerGeneration,
	};
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

function processKey(value: Pick<ExecutionHandleRef, "sessionId" | "hostGeneration" | "executionId" | "attemptId">): string {
	return JSON.stringify([value.sessionId, value.hostGeneration, value.executionId, value.attemptId]);
}

function parseBinding(value: unknown): SessionProcessBinding | undefined {
	if (!isRecord(value) || typeof value.ownerRuntimeId !== "string" || !value.ownerRuntimeId.startsWith("runtime_") || typeof value.ownerGeneration !== "number" || !Number.isSafeInteger(value.ownerGeneration) || value.ownerGeneration < 0) return undefined;
	return { ownerRuntimeId: value.ownerRuntimeId as RuntimeInstanceId, ownerGeneration: value.ownerGeneration };
}

function isRuntimeDigest(value: unknown): value is RuntimeDigest {
	return isRecord(value) && value.algorithm === "sha256" && typeof value.digest === "string" && /^[a-f0-9]{64}$/u.test(value.digest);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
