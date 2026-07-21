/**
 * 内存 Ledger 实现,主要供单测使用。
 *
 * 对照参考 pi 的 `memory-storage.ts`。
 */

import type { LedgerEntry, LedgerEntryType, LedgerHeader, LedgerSink } from "./types.js";
import { newId } from "./types.js";

export class MemoryLedger implements LedgerSink {
  readonly sessionId: string;
  private readonly _entries: LedgerEntry[] = [];
  private readonly _header: LedgerHeader;
  private _lastError: unknown;
  private _lastParentId: string;

  constructor(opts?: { sessionId?: string; metadata?: Record<string, unknown> }) {
    this.sessionId = opts?.sessionId ?? newId();
    const now = Date.now();
    this._header = {
      type: "ledger",
      version: 2,
      id: newId(),
      createdAt: now,
      sessionId: this.sessionId,
      metadata: opts?.metadata,
    };
    this._lastParentId = this._header.id;
    this._lastError = undefined;
  }

  get lastError(): unknown {
    return this._lastError;
  }

  header(): LedgerHeader {
    return this._header;
  }

  /**
   * V2 high-water mark:返回已 append 的 entry 数。
   * 写过的 entry 不会再被修改(append-only),所以此值单调递增。
   */
  highWaterMark(): number {
    return this._entries.length;
  }

  append(entry: LedgerEntry): void {
    // 在 sink 层做 parentId 自动继承:扁平 ledger 中 parentId 永远指向前一条(*)。
    // 调用方传入的 parentId 会被覆盖,除非显式传 null。
    if (!entry.parentId) {
      entry = { ...entry, parentId: this._lastParentId };
    }
    this._lastParentId = entry.id;
    this._entries.push(entry);
  }

  entries(): LedgerEntry[] {
    return this._entries.slice();
  }

  get(id: string): LedgerEntry | undefined {
    return this._entries.find((e) => e.id === id);
  }

  findByType(type: LedgerEntryType): LedgerEntry[] {
    return this._entries.filter((e) => e.type === type);
  }

  close(): void {
    // 内存 ledger 无资源
  }
}
