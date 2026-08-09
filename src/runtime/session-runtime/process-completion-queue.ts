/** Owner-fenced Session Event Store completion queue。 */

import { canonicalJson } from "../protocol/canonical-json.ts";
import { runtimeDigest, type RuntimeDigest } from "../protocol/foundation.ts";
import { createRuntimeId, type QueueItemId, type RuntimeInstanceId, type WorkspaceId } from "../protocol/ids.ts";
import type { OwnerFence } from "../session-owner/types.ts";
import type { CompletionQueuePort } from "../process/completion-reconciler.ts";
import type { ExecutionHandleRef, ManagedProcessSummary, ProcessCompletionEnvelope } from "../process/types.ts";
import type { SessionStore } from "../../storage/session-store/session-store.ts";

const SCHEMA = "runledger.session-process-completion.current" as const;
const MAX_ITEMS = 32;
const MAX_BYTES = 256 * 1024;

interface QueueItem {
	readonly itemId: QueueItemId;
	readonly envelope: ProcessCompletionEnvelope;
	readonly payloadDigest: RuntimeDigest;
	readonly revision: number;
	readonly status: "pending" | "suppressed";
}

type QueueResult = { readonly ok: true; readonly item: QueueItem } | { readonly ok: false; readonly code: string };
type QueueRecord =
	| { readonly schema: typeof SCHEMA; readonly kind: "enqueued"; readonly item: SerializedQueueItem }
	| { readonly schema: typeof SCHEMA; readonly kind: "suppressed_delivery"; readonly deliveryKey: string; readonly payloadDigest: RuntimeDigest }
	| { readonly schema: typeof SCHEMA; readonly kind: "suppressed"; readonly itemId: QueueItemId; readonly revision: number };

interface SerializedBinding { readonly ownerRuntimeId: RuntimeInstanceId; readonly ownerGeneration: number }
type SerializedHandle = Omit<ExecutionHandleRef, "authorityId" | "tenantId" | "workspaceId" | "sessionId" | "hostGeneration" | "sessionGeneration">;
type SerializedSummary = Omit<ManagedProcessSummary, "handle"> & { readonly handle: SerializedHandle };
type SerializedEnvelope = Omit<ProcessCompletionEnvelope, "handle" | "summary"> & {
	readonly binding: SerializedBinding;
	readonly handle: SerializedHandle;
	readonly summary: SerializedSummary;
};
type SerializedQueueItem = Omit<QueueItem, "envelope"> & { readonly envelope: SerializedEnvelope };

export class SessionProcessCompletionQueue implements CompletionQueuePort {
	private readonly store: SessionStore;
	private readonly fence: OwnerFence;
	private readonly workspaceId: WorkspaceId;
	private readonly items = new Map<QueueItemId, QueueItem>();
	private readonly suppressed = new Map<string, RuntimeDigest>();

	public constructor(options: { readonly store: SessionStore; readonly fence: OwnerFence; readonly workspaceId: WorkspaceId }) {
		this.store = options.store;
		this.fence = options.fence;
		this.workspaceId = options.workspaceId;
		this.load();
	}

	public async enqueue(envelope: ProcessCompletionEnvelope): Promise<QueueResult> {
		const payloadDigest = runtimeDigest({ ...envelope, origin: "automatic_follow_up" as const });
		const existing = [...this.items.values()].find((item) => item.envelope.deliveryKey === envelope.deliveryKey);
		if (existing !== undefined) return existing.payloadDigest.digest === payloadDigest.digest ? { ok: true, item: existing } : { ok: false, code: "delivery_key_conflict" };
		const suppressed = this.suppressed.get(envelope.deliveryKey);
		if (suppressed !== undefined) return { ok: false, code: suppressed.digest === payloadDigest.digest ? "delivery_suppressed" : "delivery_key_conflict" };
		const active = [...this.items.values()].filter((item) => item.status === "pending");
		if (active.length >= MAX_ITEMS || Buffer.byteLength(canonicalJson(envelope), "utf8") + active.reduce((sum, item) => sum + Buffer.byteLength(canonicalJson(item.envelope), "utf8"), 0) > MAX_BYTES) {
			return { ok: false, code: "queue_capacity_exceeded" };
		}
		const item: QueueItem = {
			itemId: createRuntimeId("queueItem", runtimeDigest(envelope.deliveryKey).digest.slice(0, 64)),
			envelope: { ...envelope, origin: "automatic_follow_up" },
			payloadDigest,
			revision: 0,
			status: "pending",
		};
		this.append("process.completion_enqueued", { schema: SCHEMA, kind: "enqueued", item: serializeItem(item, this.fence) });
		this.items.set(item.itemId, item);
		return { ok: true, item };
	}

	public async pending(sessionId?: string): Promise<readonly QueueItem[]> {
		return [...this.items.values()].filter((item) => item.status === "pending" && (sessionId === undefined || item.envelope.handle.sessionId === sessionId));
	}

	public async suppress(itemId: QueueItemId, expectedRevision?: number): Promise<QueueResult> {
		const item = this.items.get(itemId);
		if (item === undefined) return { ok: false, code: "queue_item_not_found" };
		if (expectedRevision !== undefined && item.revision !== expectedRevision) return { ok: false, code: "queue_revision_conflict" };
		if (item.status === "suppressed") return { ok: true, item };
		const next: QueueItem = { ...item, revision: item.revision + 1, status: "suppressed" };
		this.append("process.completion_suppressed", { schema: SCHEMA, kind: "suppressed", itemId, revision: next.revision });
		this.items.set(itemId, next);
		return { ok: true, item: next };
	}

	public async suppressDelivery(envelope: ProcessCompletionEnvelope): Promise<{ readonly ok: true; readonly suppressed: boolean } | { readonly ok: false; readonly code: string }> {
		const payloadDigest = runtimeDigest({ ...envelope, origin: "automatic_follow_up" as const });
		const prior = this.suppressed.get(envelope.deliveryKey);
		if (prior !== undefined) return prior.digest === payloadDigest.digest ? { ok: true, suppressed: true } : { ok: false, code: "delivery_key_conflict" };
		const existing = [...this.items.values()].find((item) => item.envelope.deliveryKey === envelope.deliveryKey);
		if (existing !== undefined && existing.payloadDigest.digest !== payloadDigest.digest) return { ok: false, code: "delivery_key_conflict" };
		this.append("process.completion_delivery_suppressed", { schema: SCHEMA, kind: "suppressed_delivery", deliveryKey: envelope.deliveryKey, payloadDigest });
		this.suppressed.set(envelope.deliveryKey, payloadDigest);
		if (existing !== undefined && existing.status !== "suppressed") await this.suppress(existing.itemId, existing.revision);
		return { ok: true, suppressed: true };
	}

	private load(): void {
		for (const event of this.store.replaySessionEvents(this.fence.sessionId)) {
			if (!event.eventType.startsWith("process.completion_")) continue;
			let value: unknown;
			try { value = JSON.parse(event.payloadJson); } catch { throw new Error("invalid Session process completion record"); }
			if (!isRecord(value) || value.schema !== SCHEMA || typeof value.kind !== "string") continue;
			if (value.kind === "enqueued" && isRecord(value.item)) {
				const item = restoreItem(value.item, this.fence.sessionId, this.workspaceId);
				this.items.set(item.itemId, item);
			} else if (value.kind === "suppressed_delivery" && typeof value.deliveryKey === "string" && isDigest(value.payloadDigest)) {
				this.suppressed.set(value.deliveryKey, value.payloadDigest);
			} else if (value.kind === "suppressed" && typeof value.itemId === "string" && typeof value.revision === "number") {
				const item = this.items.get(value.itemId as QueueItemId);
				if (item !== undefined && value.revision > item.revision) this.items.set(item.itemId, { ...item, revision: value.revision, status: "suppressed" });
			}
		}
	}

	private append(eventType: string, record: QueueRecord): void {
		const previous = this.store.replaySessionEvents(this.fence.sessionId).at(-1)?.currentEventHash ?? null;
		this.store.appendEvent(this.fence, {
			eventId: createRuntimeId("event", `session-process-completion-${runtimeDigest({ record, previous }).digest.slice(0, 64)}`),
			ownerGeneration: this.fence.generation,
			eventType,
			payloadJson: canonicalJson(record),
			createdAtMs: Date.now(),
			expectedPreviousEventHash: previous,
		});
	}
}

function serializeItem(item: QueueItem, fence: OwnerFence): SerializedQueueItem {
	const binding: SerializedBinding = { ownerRuntimeId: fence.runtimeId, ownerGeneration: item.envelope.handle.hostGeneration };
	return {
		...item,
		envelope: {
			...item.envelope,
			binding,
			handle: stripHandle(item.envelope.handle),
			summary: { ...item.envelope.summary, handle: stripHandle(item.envelope.summary.handle) },
		},
	};
}

function restoreItem(value: Record<string, unknown>, sessionId: OwnerFence["sessionId"], workspaceId: WorkspaceId): QueueItem {
	if (typeof value.itemId !== "string" || !isRecord(value.envelope) || !isDigest(value.payloadDigest) || typeof value.revision !== "number" || (value.status !== "pending" && value.status !== "suppressed")) throw new Error("invalid Session process completion item");
	const envelope = value.envelope;
	if (!isRecord(envelope.binding) || typeof envelope.binding.ownerGeneration !== "number" || !isRecord(envelope.handle) || !isRecord(envelope.summary) || !isRecord(envelope.summary.handle)) throw new Error("invalid Session process completion envelope");
	const identity = legacyIdentity(envelope.binding.ownerGeneration, sessionId, workspaceId);
	return {
		itemId: value.itemId as QueueItemId,
		payloadDigest: value.payloadDigest,
		revision: value.revision,
		status: value.status,
		envelope: {
			...envelope,
			handle: { ...envelope.handle, ...identity },
			summary: { ...envelope.summary, handle: { ...envelope.summary.handle, ...identity } },
		} as unknown as ProcessCompletionEnvelope,
	};
}

function stripHandle(handle: ExecutionHandleRef): SerializedHandle {
	const { authorityId: _authorityId, tenantId: _tenantId, workspaceId: _workspaceId, sessionId: _sessionId, hostGeneration: _hostGeneration, sessionGeneration: _sessionGeneration, ...rest } = handle;
	return rest;
}

function legacyIdentity(ownerGeneration: number, sessionId: OwnerFence["sessionId"], workspaceId: WorkspaceId) {
	return {
		authorityId: createRuntimeId("authority", "session-owner-runtime"),
		tenantId: createRuntimeId("tenant", "local-user"),
		workspaceId,
		sessionId,
		hostGeneration: ownerGeneration,
		sessionGeneration: ownerGeneration,
	};
}

function isDigest(value: unknown): value is RuntimeDigest {
	return isRecord(value) && value.algorithm === "sha256" && typeof value.digest === "string" && /^[a-f0-9]{64}$/u.test(value.digest);
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
