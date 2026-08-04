/** Durable, bounded completion Queue owned by the Runtime Host. */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalJson } from "../../runtime/protocol/canonical-json.ts";
import { runtimeDigest, type RuntimeDigest } from "../../runtime/protocol/foundation.ts";
import type { QueueItemId } from "../../runtime/protocol/ids.ts";
import { RUNTIME_HOST_BOUNDS } from "../../runtime/host/types.ts";
import type { ProcessCompletionEnvelope } from "../../runtime/process/types.ts";
import type { RunledgerLayout } from "../../runtime/contracts/storage-layout.ts";

export interface CompletionQueueItem {
	readonly itemId: QueueItemId;
	readonly envelope: ProcessCompletionEnvelope;
	readonly payloadDigest: RuntimeDigest;
	readonly revision: number;
	readonly status: "pending" | "claimed" | "consumed" | "cancelled" | "suppressed";
}

export interface ProcessCompletionQueueOptions {
	readonly layout: RunledgerLayout;
	readonly workspaceStorageKey: string;
	readonly maxItems?: number;
	readonly maxBytes?: number;
}

export type CompletionQueueErrorCode =
	| "queue_capacity_exceeded"
	| "queue_unavailable"
	| "delivery_key_conflict"
	| "delivery_suppressed"
	| "queue_item_not_found"
	| "queue_item_not_claimed"
	| "queue_revision_conflict";

export type CompletionQueueMutationResult =
	| { readonly ok: true; readonly item: CompletionQueueItem }
	| { readonly ok: false; readonly code: CompletionQueueErrorCode };

type QueueRecord =
	| { readonly type: "enqueued"; readonly item: CompletionQueueItem }
	| { readonly type: "suppressed_delivery"; readonly deliveryKey: string; readonly payloadDigest: RuntimeDigest }
	| { readonly type: "claimed" | "requeued" | "consumed" | "cancelled" | "suppressed"; readonly itemId: QueueItemId; readonly revision: number };

export type CompletionQueueSuppressionResult =
	| { readonly ok: true; readonly suppressed: boolean }
	| { readonly ok: false; readonly code: Extract<CompletionQueueErrorCode, "delivery_key_conflict" | "queue_unavailable"> };

export class JsonlProcessCompletionQueue {
	private readonly queuePath: string;
	private readonly maxItems: number;
	private readonly maxBytes: number;
	private tail: Promise<void> = Promise.resolve();

	public constructor(options: ProcessCompletionQueueOptions) {
		this.queuePath = join(options.layout.state, "processes", options.workspaceStorageKey, "queue", "completion.jsonl");
		this.maxItems = options.maxItems ?? RUNTIME_HOST_BOUNDS.maxCompletionBatchMembers;
		this.maxBytes = options.maxBytes ?? RUNTIME_HOST_BOUNDS.maxCompletionBatchBytes;
		if (!Number.isSafeInteger(this.maxItems) || this.maxItems < 1 || this.maxItems > RUNTIME_HOST_BOUNDS.maxCompletionBatchMembers) throw new Error("maxItems is outside queue bounds");
		if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > RUNTIME_HOST_BOUNDS.maxCompletionBatchBytes) throw new Error("maxBytes is outside queue bounds");
	}

	public async enqueue(envelope: ProcessCompletionEnvelope): Promise<CompletionQueueMutationResult> {
		return this.serial(async () => {
			try {
				const items = await this.load();
				const payloadDigest = runtimeDigest({ ...envelope, origin: "automatic_follow_up" as const });
				const existing = items.find((item) => item.envelope.deliveryKey === envelope.deliveryKey);
				if (existing) {
					return existing.payloadDigest.digest === payloadDigest.digest
						? { ok: true, item: existing }
						: { ok: false, code: "delivery_key_conflict" };
				}
				const suppressedDigest = await this.suppressedDeliveryDigest(envelope.deliveryKey);
				if (suppressedDigest !== undefined) {
					return suppressedDigest.digest === payloadDigest.digest
						? { ok: false, code: "delivery_suppressed" }
						: { ok: false, code: "delivery_key_conflict" };
				}
				const active = items.filter((item) => item.status === "pending" || item.status === "claimed");
				if (active.length >= this.maxItems) return { ok: false, code: "queue_capacity_exceeded" };
				const activeBytes = active.reduce((sum, item) => sum + Buffer.byteLength(canonicalJson(item.envelope), "utf8"), 0);
				if (activeBytes + Buffer.byteLength(canonicalJson(envelope), "utf8") > this.maxBytes) return { ok: false, code: "queue_capacity_exceeded" };
				const item: CompletionQueueItem = {
					itemId: `queue_${canonicalJson(envelope.deliveryKey).slice(1, -1).replace(/[^A-Za-z0-9._~-]/g, "_").slice(0, 120)}` as QueueItemId,
					envelope,
					payloadDigest,
					revision: 0,
					status: "pending",
				};
				await this.append({ type: "enqueued", item });
				return { ok: true, item };
			} catch {
				return { ok: false, code: "queue_unavailable" };
			}
		});
	}

	public async suppressDelivery(envelope: ProcessCompletionEnvelope): Promise<CompletionQueueSuppressionResult> {
		return this.serial(async () => {
			try {
				const items = await this.load();
				const payloadDigest = runtimeDigest({ ...envelope, origin: "automatic_follow_up" as const });
				const existing = items.find((item) => item.envelope.deliveryKey === envelope.deliveryKey);
				if (existing !== undefined && existing.payloadDigest.digest !== payloadDigest.digest) {
					return { ok: false, code: "delivery_key_conflict" };
				}
				const priorSuppression = await this.suppressedDeliveryDigest(envelope.deliveryKey);
				if (priorSuppression !== undefined) {
					if (priorSuppression.digest !== payloadDigest.digest) return { ok: false, code: "delivery_key_conflict" };
					return { ok: true, suppressed: true };
				}
				if (existing?.status === "consumed") return { ok: true, suppressed: false };
				await this.append({ type: "suppressed_delivery", deliveryKey: envelope.deliveryKey, payloadDigest });
				if (existing !== undefined && existing.status !== "suppressed") {
					await this.append({ type: "suppressed", itemId: existing.itemId, revision: existing.revision + 1 });
				}
				return { ok: true, suppressed: true };
			} catch {
				return { ok: false, code: "queue_unavailable" };
			}
		});
	}

	public async claim(maxItems = this.maxItems, sessionId?: string): Promise<
		| { readonly ok: true; readonly items: readonly CompletionQueueItem[] }
		| { readonly ok: false; readonly code: CompletionQueueErrorCode }
	> {
		return this.serial(async () => {
			try {
				if (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > this.maxItems) return { ok: false, code: "queue_capacity_exceeded" };
				const items = await this.load();
				const selected = items.filter((item) => item.status === "pending" && matchesSession(item, sessionId)).slice(0, maxItems);
				const claimed: CompletionQueueItem[] = [];
				for (const item of selected) {
					const next = { ...item, revision: item.revision + 1, status: "claimed" as const };
					await this.append({ type: "claimed", itemId: item.itemId, revision: next.revision });
					claimed.push(next);
				}
				return { ok: true, items: claimed };
			} catch {
				return { ok: false, code: "queue_unavailable" };
			}
		});
	}

	public async consume(itemId: QueueItemId, expectedRevision?: number): Promise<CompletionQueueMutationResult> {
		return this.transition(itemId, "consumed", expectedRevision);
	}

	public async requeueClaimed(itemId: QueueItemId, expectedRevision?: number): Promise<CompletionQueueMutationResult> {
		return this.transition(itemId, "requeued", expectedRevision);
	}

	public async cancel(itemId: QueueItemId, expectedRevision?: number): Promise<CompletionQueueMutationResult> {
		return this.transition(itemId, "cancelled", expectedRevision);
	}

	public async suppress(itemId: QueueItemId, expectedRevision?: number): Promise<CompletionQueueMutationResult> {
		return this.transition(itemId, "suppressed", expectedRevision);
	}

	public async pending(sessionId?: string): Promise<readonly CompletionQueueItem[]> {
		return this.serial(async () => {
			try {
				return (await this.load()).filter((item) => item.status === "pending" && matchesSession(item, sessionId));
			} catch {
				return [];
			}
		});
	}

	/** Returns durable claims so a restarted Host can reconcile response loss. */
	public async claimed(sessionId?: string): Promise<readonly CompletionQueueItem[]> {
		return this.serial(async () => {
			try {
				return (await this.load()).filter((item) => item.status === "claimed" && matchesSession(item, sessionId));
			} catch {
				return [];
			}
		});
	}

	private async transition(
		itemId: QueueItemId,
		type: "consumed" | "requeued" | "cancelled" | "suppressed",
		expectedRevision?: number,
	): Promise<CompletionQueueMutationResult> {
		return this.serial(async () => {
			try {
				const items = await this.load();
				const item = items.find((candidate) => candidate.itemId === itemId);
				if (!item) return { ok: false, code: "queue_item_not_found" };
				if (expectedRevision !== undefined && expectedRevision !== item.revision) return { ok: false, code: "queue_revision_conflict" };
				if (type === "consumed" && item.status === "consumed") return { ok: true, item };
				if (type === "requeued" && item.status === "pending") return { ok: true, item };
				if (type === "consumed" && item.status !== "claimed") return { ok: false, code: "queue_item_not_claimed" };
				const nextStatus = type === "requeued" ? "pending" : type;
				const next = { ...item, revision: item.revision + 1, status: nextStatus } as CompletionQueueItem;
				await this.append({ type, itemId, revision: next.revision });
				return { ok: true, item: next };
			} catch {
				return { ok: false, code: "queue_unavailable" };
			}
		});
	}

	private async load(): Promise<CompletionQueueItem[]> {
		let content: string;
		try {
			content = await readFile(this.queuePath, "utf8");
		} catch (error) {
			if (isNotFound(error)) return [];
			throw error;
		}
		const items = new Map<QueueItemId, CompletionQueueItem>();
		for (const line of content.split(/\r?\n/u).filter((value) => value.length > 0)) {
			const record = JSON.parse(line) as QueueRecord;
			if (record.type === "enqueued") items.set(record.item.itemId, record.item);
			else if (record.type === "suppressed_delivery") continue;
			else {
				const prior = items.get(record.itemId);
				if (!prior || record.revision <= prior.revision) continue;
				const status = record.type === "claimed" ? "claimed" : record.type === "requeued" ? "pending" : record.type;
				items.set(record.itemId, { ...prior, status, revision: record.revision });
			}
		}
		return [...items.values()];
	}

	private async suppressedDeliveryDigest(deliveryKey: string): Promise<RuntimeDigest | undefined> {
		let content: string;
		try {
			content = await readFile(this.queuePath, "utf8");
		} catch (error) {
			if (isNotFound(error)) return undefined;
			throw error;
		}
		let digest: RuntimeDigest | undefined;
		for (const line of content.split(/\r?\n/u).filter((value) => value.length > 0)) {
			const record = JSON.parse(line) as QueueRecord;
			if (record.type === "suppressed_delivery" && record.deliveryKey === deliveryKey) digest = record.payloadDigest;
		}
		return digest;
	}

	private async append(record: QueueRecord): Promise<void> {
		await mkdir(join(this.queuePath, ".."), { recursive: true, mode: 0o700 });
		await appendFile(this.queuePath, `${canonicalJson(record)}\n`, { encoding: "utf8", mode: 0o600 });
	}

	private async serial<T>(task: () => Promise<T>): Promise<T> {
		const previous = this.tail;
		let release: (() => void) | undefined;
		this.tail = new Promise<void>((resolve) => { release = resolve; });
		await previous;
		try {
			return await task();
		} finally {
			release?.();
		}
	}
}

function matchesSession(item: CompletionQueueItem, sessionId: string | undefined): boolean {
	return sessionId === undefined || item.envelope.handle.sessionId === sessionId;
}

function isNotFound(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
