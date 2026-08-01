/**
 * Ledger (审计账本) 类型定义。
 *
 * 对照参考 pi 的 `SessionStorage` / `SessionTreeEntry`,但本期只做扁平、append-only 的 ledger,
 * 不分叉、不摘要、不树形。
 *
 * 物理格式 (JSONL):
 *   第 1 行:LedgerHeader
 *   第 2..N 行:LedgerEntry (按时间顺序追加)
 *
 * 每条 LedgerEntry 都带 `id` / `sessionId` / `parentId` / `timestamp` / `type` / `payload`,
 * 即便本期不构建树形结构,也保留 parentId 字段以便未来升级(`// TODO(pi): 分叉 session 树`)。
 */

export type LedgerEntryType =
  | "session"
  | "message"
  | "tool_call"
  | "tool_result"
  | "turn"
  | "agent_event"
  | "custom";

/**
 * 账本文件首行。固定结构,记录 session 元信息。
 */
export interface LedgerHeader {
  type: "ledger";
  id: string;
  createdAt: number;
  sessionId: string;
  /** 可选 metadata,例如 cwd / model / system prompt hash(`// TODO(pi): 完整 metadata`) */
  metadata?: Record<string, unknown>;
}

export class UnsupportedSessionFormatError extends Error {
  readonly code = "unsupported_session_format" as const;
  readonly filePath: string;

  constructor(filePath: string) {
    super(`unsupported session format: ${filePath}`);
    this.name = "UnsupportedSessionFormatError";
    this.filePath = filePath;
  }
}

export function isCurrentLedgerHeader(value: unknown): value is LedgerHeader {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const allowedFields = new Set(["type", "id", "createdAt", "sessionId", "metadata"]);
  return (
    Object.keys(candidate).every((key) => allowedFields.has(key)) &&
    candidate.type === "ledger" &&
    typeof candidate.id === "string" &&
    typeof candidate.createdAt === "number" &&
    Number.isFinite(candidate.createdAt) &&
    typeof candidate.sessionId === "string" &&
    (candidate.metadata === undefined ||
      (typeof candidate.metadata === "object" && candidate.metadata !== null && !Array.isArray(candidate.metadata)))
  );
}

/**
 * 账本条目。所有字段保留位置以便未来升级。
 */
export interface LedgerEntry {
  id: string;
  sessionId: string;
  /** 父条目 id;扁平实现中始终指向前一条;首条 parentId = header.id(`// TODO(pi): 树形升级`) */
  parentId: string;
  timestamp: number;
  type: LedgerEntryType;
  payload: Record<string, unknown>;
}

const LEDGER_ENTRY_TYPES: readonly LedgerEntryType[] = [
  "session",
  "message",
  "tool_call",
  "tool_result",
  "turn",
  "agent_event",
  "custom",
];

export function isCurrentLedgerEntry(value: unknown): value is LedgerEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const allowedFields = new Set(["id", "sessionId", "parentId", "timestamp", "type", "payload"]);
  return (
    Object.keys(candidate).length === allowedFields.size &&
    Object.keys(candidate).every((key) => allowedFields.has(key)) &&
    typeof candidate.id === "string" &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.parentId === "string" &&
    typeof candidate.timestamp === "number" &&
    Number.isFinite(candidate.timestamp) &&
    typeof candidate.type === "string" &&
    (LEDGER_ENTRY_TYPES as readonly string[]).includes(candidate.type) &&
    typeof candidate.payload === "object" &&
    candidate.payload !== null &&
    !Array.isArray(candidate.payload)
  );
}

/**
 * LedgerSink 抽象。事件 sink 接口。
 * 实现方负责把 header 与 entries 持久化(或仅留在内存)。
 *
 * 约定:entry 写入失败以 `lastError` 暴露；持久化格式无法通过 current
 * contract 时必须拒绝并抛出 UnsupportedSessionFormatError。
 */
export interface LedgerSink {
  readonly sessionId: string;
  /** 仅 MemoryLedger / JsonlLedger 内部使用 */
  append(entry: LedgerEntry): Promise<void> | void;
  /** 读取所有已落盘条目(不含 header) */
  entries(): Promise<LedgerEntry[]> | LedgerEntry[];
  /** 按 id 精确查找 */
  get(id: string): Promise<LedgerEntry | undefined> | LedgerEntry | undefined;
  /** 按 type 过滤 */
  findByType(type: LedgerEntryType): Promise<LedgerEntry[]> | LedgerEntry[];
  /** 返回 header(可空,内存 ledger 可能没有) */
  header(): LedgerHeader | undefined;
  /** 关闭资源(文件句柄等) */
  close(): Promise<void> | void;
  /** 最近一次错误(若有) */
  readonly lastError?: unknown;
  /**
   * 单调递增的 turn / entry 序号(本期实现是 entry-based high-water mark)。
   * 默认实现:返回该 ledger 已 append 的 entry 数,即"下次 append 时此值会 +1"。
   * 实现可重写以持久化进 header.metadata.highWaterMark,跨重启继承。
   *
   * 这是 task / turn 系列工具与 lockfile 的 high-water mark 跟踪;
   * 都依赖此值判断"已处理过的 entry 最大序号"。
   */
  highWaterMark?(): number;
}

/**
 * 工具:生成 8 字符随机 id。优先 try uuidv7,失败回退到 crypto.randomUUID 切片(`// TODO(pi): 引入 uuidv7`)。
 */
export function newId(): string {
  const g = globalThis as { crypto?: Crypto };
  if (g.crypto && typeof g.crypto.randomUUID === "function") {
    return g.crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  }
  // 兜底:无 crypto.randomUUID 的运行时(理论上 Node 20+ 都有,这里防御性占位)
  return Math.random().toString(36).slice(2, 10).padEnd(8, "0");
}

// 把全局 Crypto 类型显式注入当前 module 作用域(避免 lib 配置不全时找不到名)
type Crypto = {
  randomUUID(): string;
};
