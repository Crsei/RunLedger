/**
 * R7:SQLite-backed LedgerSink(06 §7.1)。
 *
 * - 生产写入从 JSONL 迁移到 SQLite:每个 LedgerEntry 作为一个 owner-fenced
 *   durable event(类型 `ledger.<type>`,payload 是 canonical LedgerEntry);
 * - SessionReplay 直接复用 session-codec 的 replaySession(只消费
 *   message/custom 投影,checkpoint 可删);
 * - 本适配层让 InteractiveSessionController 的域装配在 SessionRuntime 内
 *   直接可用,不经过 JSONL lockfile 或 legacy SessionManager。
 */

import type { SessionStore } from "../../storage/session-store/session-store.ts";
import type { LedgerEntry, LedgerEntryType, LedgerHeader, LedgerSink } from "../ledger/types.ts";
import type { OwnerFence } from "../session-owner/types.ts";
import { newId } from "../ledger/types.ts";

export interface SqliteLedgerSinkOptions {
	readonly store: SessionStore;
	readonly fence: () => OwnerFence;
}

/** 生产 SQLite LedgerSink:append 即 owner-fenced durable event。 */
export class SqliteLedgerSink implements LedgerSink {
	public readonly sessionId: string;
	public readonly lastError: undefined;
	private readonly store: SessionStore;
	private readonly fence: () => OwnerFence;

	public constructor(options: SqliteLedgerSinkOptions) {
		this.sessionId = options.fence().sessionId;
		this.store = options.store;
		this.fence = options.fence;
	}

	public append(entry: LedgerEntry): void {
		const tail = this.store.replaySessionEvents(this.sessionId).at(-1);
		this.store.appendEvent(this.fence(), {
			eventId: createLedgerEventId(this.sessionId, entry.id),
			ownerGeneration: this.fence().generation,
			eventType: `ledger.${entry.type}`,
			payloadJson: JSON.stringify(entry),
			createdAtMs: entry.timestamp,
			expectedPreviousEventHash: tail?.currentEventHash ?? null,
		});
	}

	public entries(): LedgerEntry[] {
		return this.store
			.replaySessionEvents(this.sessionId)
			.filter((event) => event.eventType.startsWith("ledger."))
			.map((event) => JSON.parse(event.payloadJson) as LedgerEntry);
	}

	public get(id: string): LedgerEntry | undefined {
		return this.entries().find((entry) => entry.id === id);
	}

	public findByType(type: LedgerEntryType): LedgerEntry[] {
		return this.entries().filter((entry) => entry.type === type);
	}

	public header(): LedgerHeader | undefined {
		return undefined;
	}

	public close(): void {
		// SQLite 生命周期由 SessionStore 持有。
	}

	public highWaterMark(): number {
		return this.entries().length;
	}
}

export function createLedgerEventId(sessionId: string, entryId: string): string {
	return `event_ledger_${sessionId.slice(-12)}_${entryId.replace(/[^A-Za-z0-9._~-]/g, "_").slice(-64)}`;
}
