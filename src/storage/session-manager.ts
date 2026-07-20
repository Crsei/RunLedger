/**
 * SessionManager —— 在 JsonlLedger 上加 cwd-aware 文件布局与多入口工厂。
 *
 * 对照参考 pi 的 `core/session-manager.ts`(以及 harness 侧 jsonl-storage.ts),
 * 但本 RunLedger 保留扁平 LedgerHeader/LedgerEntry 协议(不分叉、不摘要,
 * 见 AGENTS.md §1.3),SessionManager 只是 JsonlLedger 的薄包装。
 *
 * 本期接口:
 *   - SessionManager.create({cwd, sessionDir?, sessionId?, metadata?, truncate?}) — 新建
 *   - SessionManager.continueRecent(cwd, sessionDir?) — 找最近会话续
 *   - SessionManager.open(path) — 直接打开已知文件
 *   - SessionManager.forkFrom(sourcePath, targetCwd, sessionDir?) — 复制全文件成新文件
 *   - SessionManager.list(cwd, sessionDir?) — 列当前会话目录里所有 *.jsonl
 *   - SessionManager.listAll(sessionDir?) — 不限 cwd 列出全部(本期 = list,无 cwd 过滤版)
 *
 * 文件布局:
 *   <sessionDir>/<ISO-ts-with-:/. -> -替换>_<8-or-32-char-id>.jsonl
 *   第 1 行:LedgerHeader (sessionId + createdAt + 可选 metadata.cwd)
 *   2..N 行:LedgerEntry
 *
 * 持久层完全沿用 JsonlLedger —— SessionManager 不破坏 LedgerSink 协议。
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import * as path from "node:path";
import type { LedgerHeader } from "../runtime/ledger/types.ts";
import { JsonlLedger } from "../runtime/ledger/jsonl-ledger.ts";
import { resolveSessionDir } from "./paths.ts";
import { buildSessionFileName } from "./path-utils.ts";

const SESSION_FILE_GLOB = "*.jsonl";

export interface SessionManagerOptions {
  cwd: string;
  /** 已解析的绝对路径,优先级高于 settings.sessionDir(env 与 settings 在 caller 解析) */
  sessionDir?: string;
  /** 指定 sessionId(否则 JsonlLedger 自生成) */
  sessionId?: string;
  /** header.metadata,create 时写入 metadata.cwd 便于 list 过滤 */
  metadata?: Record<string, unknown>;
  /** 已存在文件是否清空重建;默认 false */
  truncate?: boolean;
}

export interface SessionInfo {
  /** header.sessionId */
  id: string;
  /** 文件绝对路径 */
  filePath: string;
  /** header.createdAt ms */
  createdAt: number;
  /** header.metadata.cwd(可空) */
  cwd?: string;
  /** 文件 mtime ms */
  modifiedMs: number;
}

/**
 * SessionManager 实例本质是 JsonlLedger + cwd / sessionDir 的薄壳;
 * 通过 ledger() 暴露底层 sink 给 Agent 例化使用。
 */
export class SessionManager {
  private readonly _ledger: JsonlLedger;
  private readonly _cwd: string;
  private readonly _sessionDir: string;
  private readonly _filePath: string;

  constructor(
    ledger: JsonlLedger,
    cwd: string,
    sessionDir: string,
    filePath: string,
  ) {
    this._ledger = ledger;
    this._cwd = cwd;
    this._sessionDir = sessionDir;
    this._filePath = filePath;
  }

  /** 返回已 ensureInitialized 的 JsonlLedger(可作 Agent ledger 注入) */
  ledger(): JsonlLedger {
    return this._ledger;
  }

  sessionId(): string {
    return this._ledger.sessionId;
  }

  filePath(): string {
    return this._filePath;
  }

  sessionDir(): string {
    return this._sessionDir;
  }

  cwd(): string {
    return this._cwd;
  }

  /** 释放底层 ledger 资源(JsonlLedger.close noop,留作未来 write buffer 用) */
  async closeAll(): Promise<void> {
    await this._ledger.close();
  }

  /**
   * 新建 session;若同路径已存在且 truncate=false,则继承已有 header 与 entries。
   */
  static async create(opts: SessionManagerOptions): Promise<SessionManager> {
    const sessionDir = opts.sessionDir ?? resolveSessionDir(opts.cwd);
    const filePath = path.join(sessionDir, buildSessionFileName());
    const metadata = { cwd: opts.cwd, ...(opts.metadata ?? {}) };
    const ledger = new JsonlLedger({
      filePath,
      sessionId: opts.sessionId,
      metadata,
      truncate: opts.truncate ?? false,
    });
    // 触发 ensureInitialized 写 header(或读现有 header 继承)
    await ledger.append({
      id: "placeholder",
      sessionId: ledger.sessionId,
      parentId: "init",
      timestamp: Date.now(),
      type: "custom",
      payload: { kind: "session.create" },
    }).catch(() => {
      // 失败以内存 entry 为凭,不影响 caller
    });
    return new SessionManager(ledger, opts.cwd, sessionDir, filePath);
  }

  /**
   * 直接打开已有文件;若不存在则抛 ENOENT(让 caller 处理)。
   * JsonlLedger 在 ensureInitialized 里读取现有 header + entries。
   */
  static async open(filePath: string): Promise<SessionManager> {
    if (!existsSync(filePath)) {
      throw new Error(`session file not found: ${filePath}`);
    }
    const absolute = path.resolve(filePath);
    const sessionDir = path.dirname(absolute);
    const ledger = new JsonlLedger({ filePath: absolute });
    const cd = await readHeader(absolute);
    const headerCwd = cd?.metadata?.cwd;
    return new SessionManager(
      ledger,
      typeof headerCwd === "string" ? headerCwd : "",
      sessionDir,
      absolute,
    );
  }

  /**
   * 找会话目录里 mtime 最大的文件,返回 SessionManager(继承已有 entries)。
   * 若目录或文件都不存在,退化为 SessionManager.create(新会话)。
   */
  static async continueRecent(
    cwd: string,
    sessionDir?: string,
  ): Promise<SessionManager> {
    const dir = sessionDir ?? resolveSessionDir(cwd);
    const recent = await findMostRecentSession(dir, cwd);
    if (!recent) {
      return SessionManager.create({ cwd, sessionDir: dir });
    }
    return SessionManager.open(recent);
  }

  /**
   * 复制源文件全部行(rows)到新文件,在 metadata 标 parentSession=源路径。
   * RunLedger 本期为最小可运行,不做 entries 改写(不重写 parentId 链)。
   */
  static async forkFrom(
    sourcePath: string,
    targetCwd: string,
    sessionDir?: string,
  ): Promise<SessionManager> {
    if (!existsSync(sourcePath)) {
      throw new Error(`fork source not found: ${sourcePath}`);
    }
    const dir = sessionDir ?? resolveSessionDir(targetCwd);
    const targetPath = path.join(dir, buildSessionFileName());
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const content = await fs.readFile(sourcePath, "utf8");
    // 改新 header 段:替换第一行 JSON 中的 metadata.parentSession 字段
    const lines = content.split(/\r?\n/).filter((l) => l.length > 0);
    if (lines.length === 0) {
      await fs.writeFile(targetPath, "", "utf8");
    } else {
      const first = JSON.parse(lines[0]!) as LedgerHeader;
      const mergedMeta: Record<string, unknown> = {
        ...(first.metadata ?? {}),
        cwd: targetCwd,
        parentSession: path.resolve(sourcePath),
      };
      const newHeader: LedgerHeader = {
        ...first,
        id: first.id,
        sessionId: first.sessionId,
        metadata: mergedMeta,
      };
      // 注:fork 本期沿用旧 sessionId/Header id 以保留可追溯性;
      // 新文件与源文件可同时存在,互不影响。
      lines[0] = JSON.stringify(newHeader);
      await fs.writeFile(targetPath, lines.join("\n") + "\n", "utf8");
    }
    return SessionManager.open(targetPath);
  }

  /**
   * 列出某会话目录中所有 *.jsonl header,跳过损坏文件(只记 stderr)。
   * 同 cwd 过滤:仅当 cwd 非空且 header.metadata.cwd 与之相等时保留。
   */
  static async list(cwd: string, sessionDir?: string): Promise<SessionInfo[]> {
    const dir = sessionDir ?? resolveSessionDir(cwd);
    if (!existsSync(dir)) return [];
    const files = (await readdir(dir, { withFileTypes: false }))
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => path.join(dir, f));
    const out: SessionInfo[] = [];
    for (const fp of files) {
      try {
        const header = await readHeader(fp);
        if (!header) continue;
        if (cwd.length > 0 && header.metadata?.cwd !== cwd) continue;
        const st = await stat(fp);
        out.push({
          id: header.sessionId,
          filePath: fp,
          createdAt: header.createdAt,
          cwd: typeof header.metadata?.cwd === "string" ? header.metadata.cwd : undefined,
          modifiedMs: st.mtimeMs,
        });
      } catch (e) {
        process.stderr.write(
          `[runledger] session header parse failed at ${fp}: ${String(e)}\n` +
            `  skip;继续扫余下文件\n`,
        );
      }
    }
    out.sort((a, b) => b.modifiedMs - a.modifiedMs);
    return out;
  }

  /**
   * listAll:本期与 list 等价(没有跨 cwd 列举的场景,所有 sessionDir 都绑定一个 cwd)。
   * 保留接口位与 pi 同名 API 对齐以便未来扩展。
   */
  static async listAll(sessionDir?: string): Promise<SessionInfo[]> {
    if (!sessionDir) {
      throw new Error("listAll 需要显式 sessionDir(本期不支持无 cwd 全扫)");
    }
    return SessionManager.list("", sessionDir);
  }
}

/**
 * 读取 JSONL 文件首行 header,损坏/缺失文件返回 undefined。
 */
async function readHeader(filePath: string): Promise<LedgerHeader | undefined> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
  const newlineIdx = content.indexOf("\n");
  const firstLine = (newlineIdx === -1 ? content : content.slice(0, newlineIdx)).trim();
  if (firstLine.length === 0) return undefined;
  try {
    const parsed = JSON.parse(firstLine) as LedgerHeader;
    if (parsed.type !== "ledger") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/**
 * 扫目录找 mtime 最大的会话文件;按 header.metadata.cwd 过滤。
 * 无可匹配则返回 undefined。
 */
async function findMostRecentSession(
  dir: string,
  cwd: string,
): Promise<string | undefined> {
  if (!existsSync(dir)) return undefined;
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return undefined;
  }
  let bestPath: string | undefined;
  let bestMtime = -1;
  for (const f of files) {
    const fp = path.join(dir, f);
    let header: LedgerHeader | undefined;
    try {
      header = await readHeader(fp);
    } catch {
      continue;
    }
    if (!header) continue;
    if (cwd.length > 0 && header.metadata?.cwd !== cwd) continue;
    let mtime: number;
    try {
      mtime = (await stat(fp)).mtimeMs;
    } catch {
      continue;
    }
    if (mtime > bestMtime) {
      bestMtime = mtime;
      bestPath = fp;
    }
  }
  return bestPath;
}
