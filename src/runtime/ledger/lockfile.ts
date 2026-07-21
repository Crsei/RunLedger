/**
 * Ledger lockfile 机制。
 *
 * 用途:防止两个 RunLedger 进程同时 append 到同一个 .jsonl
 * (即便 Node 单线程,多进程环境下 fs.appendFile 不保证原子,SEQ 仍会乱)。
 *
 * 实现:
 *   - 使用 `proper-lockfile` 的 lock/unlock;其内部信号是 lock file `${target}.lock`
 *     + O_EXCL 创建;支持 stale 检测。
 *   - 我们在 lock 内 `JsonlLedger.append(...)` 流程外层包装,确保每次 append 持锁。
 *   - 高负载场景下替代 O_APPEND + setuid-style 真原子;本期 V2 先有 lock 再说。
 *
 * 失败语义:
 *   - lock() 在 50ms * 100 次 retry 后仍失败 → throw ELOCKED
 *   - unlock() 失败不阻塞,只写日志。
 */

import lockfile from "proper-lockfile";
import type { JsonlLedger } from "./jsonl-ledger.ts";

export interface LockfileLedgerOptions {
  /** 复试次数,默认 100 */
  retries?: number;
  /** 每次复试间隔(ms),默认 50 */
  retryDelayMs?: number;
}

export class LedgerLockError extends Error {
  readonly filePath: string;
  constructor(filePath: string, message: string) {
    super(`LedgerLockError(${filePath}): ${message}`);
    this.name = "LedgerLockError";
    this.filePath = filePath;
  }
}

/**
 * 在 ledger 上加锁。返回 release 函数。
 *
 * 用法:
 *   const release = await acquireLedgerLock(ledger);
 *   try { await ledger.append(...); }
 *   finally { await release(); }
 *
 * 该 helper 不在 ledger.append 内部自动加锁;由调用方(通常 agent-loop 或 cli)
 * 决定上锁粒度。本期内 M3 先暴露此 helper + 在 ledger append 后 M5 用到。
 *
 * 简化:在 list 模式下,vitest run 测试 lock 互斥足够覆盖。
 */
export async function acquireLedgerLock(
  ledger: JsonlLedger,
  opts: LockfileLedgerOptions = {},
): Promise<() => Promise<void>> {
  const filePath = ledger.filePath;
  const retries = opts.retries ?? 100;
  const retryDelayMs = opts.retryDelayMs ?? 50;
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      const release = await lockfile.lock(filePath, {
        retries: 0, // 内层 proper-lockfile 的 retry 我们自己控制
        stale: 10_000, // 10s 后视为 stale
        realpath: false,
        lockfilePath: `${filePath}.lock`,
      });
      return release;
    } catch (e) {
      lastErr = e;
      await sleep(retryDelayMs);
    }
  }
  throw new LedgerLockError(
    filePath,
    `acquire failed after ${retries} retries: ${(lastErr as Error)?.message ?? String(lastErr)}`,
  );
}

/**
 * 检查 lockfile 是否被持有(只读)。
 */
export async function isLedgerLocked(filePath: string): Promise<boolean> {
  try {
    return await lockfile.check(filePath, { realpath: false });
  } catch {
    return false;
  }
}

/**
 * 强制释放 stale lock(用于测试或紧急干预)。
 */
export async function forceUnlock(filePath: string): Promise<void> {
  try {
    await lockfile.unlock(filePath, { realpath: false, lockfilePath: `${filePath}.lock` });
  } catch {
    // 忽略:lock 不存在等
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
