/**
 * 扩展动作的 owner 侧回执账本（D4）。
 *
 * 每个动作都是 Session protocol 上的 mutation/read，带 command ID 与 receipt。
 * host 侧的动作帧 `requestId` 由 host 单调分配，但**回执语义**按 `(generation,
 * action, requestId)` 记账：response-loss 后 host 重放同一 requestId 必须得到
 * 同一 receipt，而不是第二次副作用；同 ID 不同请求体是 conflict。
 *
 * 账本在内存中按 generation 隔离且有界：它不是 canonical ledger，canonical
 * 事实仍由 Session 的 durable event/receipt 拥有。本模块不写任何文件。
 */

import { runtimeDigest } from "../../runtime/protocol/foundation.ts";

export type ExtensionActionOutcome = "committed" | "rejected" | "uncertain";

export interface ExtensionActionReceipt {
	readonly requestId: string;
	readonly action: string;
	readonly generation: number;
	/** 已规范化请求体的 digest；用于识别同 ID 异体。 */
	readonly requestDigest: string;
	readonly outcome: ExtensionActionOutcome;
	readonly value?: Record<string, unknown>;
	readonly code?: string;
	readonly message?: string;
	readonly recordedAtMs: number;
}

export type ExtensionActionReplay =
	| { readonly status: "miss" }
	| { readonly status: "hit"; readonly receipt: ExtensionActionReceipt }
	| { readonly status: "conflict"; readonly receipt: ExtensionActionReceipt };

export interface ExtensionActionLedgerOptions {
	/** 每 generation 保留的最大回执数；超出按最旧淘汰。 */
	readonly maxEntries?: number;
	readonly now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 128;

export class ExtensionActionLedger {
	readonly #receipts = new Map<string, ExtensionActionReceipt>();
	readonly #maxEntries: number;
	readonly #now: () => number;

	public constructor(options: ExtensionActionLedgerOptions = {}) {
		this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
		this.#now = options.now ?? Date.now;
	}

	#key(generation: number, action: string, requestId: string): string {
		return `${generation}::${action}::${requestId}`;
	}

	/** 同 ID 同体命中回执；同 ID 异体返回 conflict；未见过返回 miss。 */
	public replay(input: { readonly generation: number; readonly action: string; readonly requestId: string; readonly requestDigest: string }): ExtensionActionReplay {
		const receipt = this.#receipts.get(this.#key(input.generation, input.action, input.requestId));
		if (receipt === undefined) return { status: "miss" };
		if (receipt.requestDigest !== input.requestDigest) return { status: "conflict", receipt };
		return { status: "hit", receipt };
	}

	public record(receipt: Omit<ExtensionActionReceipt, "recordedAtMs">): ExtensionActionReceipt {
		const stored: ExtensionActionReceipt = Object.freeze({ ...receipt, recordedAtMs: this.#now() });
		const key = this.#key(receipt.generation, receipt.action, receipt.requestId);
		// 同 key 重写视为替换，并把该 key 视作最新，避免被淘汰后再记账。
		this.#receipts.delete(key);
		this.#receipts.set(key, stored);
		while (this.#receipts.size > this.#maxEntries) {
			const oldest = this.#receipts.keys().next();
			if (oldest.done === true) break;
			this.#receipts.delete(oldest.value);
		}
		return stored;
	}

	public size(): number {
		return this.#receipts.size;
	}

	public digestOf(value: unknown): string {
		return runtimeDigest(value ?? null).digest;
	}
}
