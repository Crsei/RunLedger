/**
 * JSONL append-only Ledger 实现。
 *
 * 对照参考 pi 的 `jsonl-storage.ts`,但本期不分叉、不摘要、不索引。
 *
 * 文件布局:
 *   line 1:LedgerHeader(JSON)
 *   line 2..N:LedgerEntry(JSON),按 append 顺序追加
 *
 * 同一文件允许多次打开(以 "append:#" 模式继承);新开则写 header。
 * 写入采用 `fs.appendFile`,本条带 `\n`,以避免内存中累积整个文件。
 *
 * `// TODO(pi):` 真生产场景应加 write-ahead hash chain / 大文件 mmap / 并发锁。
 * 本期不实现。
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type {
  LedgerEntry,
  LedgerEntryType,
  LedgerHeader,
  LedgerSink,
} from "./types.js";
import { newId } from "./types.js";

export interface JsonlLedgerOptions {
  /** JSONL 文件路径 */
  filePath: string;
  /** 可选 sessionId;默认随机 */
  sessionId?: string;
  /** header metadata,例如 cwd / model 等 */
  metadata?: Record<string, unknown>;
  /** 若文件已存在,是否清空重建,默认 false(追加) */
  truncate?: boolean;
}

export class JsonlLedger implements LedgerSink {
  readonly sessionId: string;
  readonly filePath: string;
  private readonly _header: LedgerHeader;
  private readonly _entries: LedgerEntry[] = [];
  private _lastError: unknown;
  private _lastParentId: string;
  private _initialized = false;
  private readonly _truncate: boolean;

  constructor(opts: JsonlLedgerOptions) {
    this.filePath = opts.filePath;
    this.sessionId = opts.sessionId ?? newId();
    this._truncate = opts.truncate ?? false;
    this._header = {
      type: "ledger",
      version: 1,
      id: newId(),
      createdAt: Date.now(),
      sessionId: this.sessionId,
      metadata: opts.metadata,
    };
    this._lastError = undefined;
    this._lastParentId = this._header.id;
  }

  get lastError(): unknown {
    return this._lastError;
  }

  header(): LedgerHeader {
    return this._header;
  }

  /**
   * 首次调用 append 时会触发文件 init(ensureDir + 写 header 或读取既有 header)。
   */
  async append(entry: LedgerEntry): Promise<void> {
    await this.ensureInitialized();
    if (!entry.parentId) {
      entry = { ...entry, parentId: this._lastParentId };
    }
    this._lastParentId = entry.id;
    this._entries.push(entry);
    try {
      await fs.appendFile(this.filePath, JSON.stringify(entry) + "\n", "utf8");
    } catch (e) {
      this._lastError = e;
      // 仍然保留内存里的 entry,以便 close 后从 entries() 复盘
    }
  }

  async entries(): Promise<LedgerEntry[]> {
    return this._entries.slice();
  }

  async get(id: string): Promise<LedgerEntry | undefined> {
    return this._entries.find((e) => e.id === id);
  }

  async findByType(type: LedgerEntryType): Promise<LedgerEntry[]> {
    return this._entries.filter((e) => e.type === type);
  }

  async close(): Promise<void> {
    // 本期每次 append 都独立 flush,close 无需做额外持久化。
    // `// TODO(pi): 引入 write buffer + flush-on-close 以提升吞吐`
    this._initialized = false;
  }

  private async ensureInitialized(): Promise<void> {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      let exists = false;
      try {
        await fs.access(this.filePath);
        exists = true;
      } catch {
        exists = false;
      }
      if (this._truncate || !exists) {
        // 写新 header
        await fs.writeFile(
          this.filePath,
          JSON.stringify(this._header) + "\n",
          "utf8",
        );
      } else {
        // 已存在文件,读出 header 并继承已有 entries
        const content = await fs.readFile(this.filePath, "utf8");
        const lines = content.split(/\r?\n/).filter((l) => l.length > 0);
        if (lines.length > 0) {
          const first = JSON.parse(lines[0]!) as LedgerHeader;
          // 继承 header 与最后一条 id
          (this._header as { id: string }).id = first.id;
          (this._header as { sessionId: string }).sessionId = first.sessionId;
          (this._header as { createdAt: number }).createdAt = first.createdAt;
          (this._header as { metadata?: Record<string, unknown> }).metadata =
            first.metadata;
          // 把已有 entries 加载到内存(for get / findByType)
          for (let i = 1; i < lines.length; i++) {
            try {
              const e = JSON.parse(lines[i]!) as LedgerEntry;
              this._entries.push(e);
            } catch {
              // 跳过损坏行(`// TODO(pi): 校验 checksum`)
            }
          }
          if (this._entries.length > 0) {
            this._lastParentId = this._entries[this._entries.length - 1]!.id;
          } else {
            this._lastParentId = this._header.id;
          }
        } else {
          await fs.writeFile(
            this.filePath,
            JSON.stringify(this._header) + "\n",
            "utf8",
          );
        }
      }
    } catch (e) {
      this._lastError = e;
    }
  }
}
