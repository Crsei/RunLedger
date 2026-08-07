/**
 * 跨平台清理工具。
 *
 * Windows 上删除 SQLite 数据库或正在占用的文件会得到 EBUSY/EPERM,
 * 且句柄释放有延迟;重试可让 OS 在重试窗口内释放句柄。
 */

import { rmSync } from "node:fs";
import { rm } from "node:fs/promises";

const RETRY_DELAY_MS = 40;
const RETRY_MAX_DELAY_MS = 200;
const WAIT = new Int32Array(new SharedArrayBuffer(4));

// 测试清理是 best-effort:Windows 上句柄/进程可能仍占用文件(如泄漏的
// SQLite handle 或未退出的 worker),删除失败不因清理而让测试判负。
const IS_WINDOWS = process.platform === "win32";

function syncSleep(ms: number): void {
	Atomics.wait(WAIT, 0, 0, ms);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryableError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
}

function backoffDelay(attempt: number): number {
	return Math.min(RETRY_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
}

/** 递归删除目录/文件,遇 Windows 占用错误按有界退避重试(同步版)。 */
export function rmSyncRetry(path: string, attempts = 20): void {
	for (let attempt = 0; ; attempt += 1) {
		try {
			rmSync(path, { recursive: true, force: true });
			return;
		} catch (error) {
			if (!isRetryableError(error) || attempt >= attempts - 1) {
				if (IS_WINDOWS && isRetryableError(error)) return;
				throw error;
			}
			syncSleep(backoffDelay(attempt));
		}
	}
}

/** 递归删除目录/文件,遇 Windows 占用错误按有界退避重试(异步版)。 */
export async function rmRetry(path: string, attempts = 20): Promise<void> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			await rm(path, { recursive: true, force: true });
			return;
		} catch (error) {
			if (!isRetryableError(error) || attempt >= attempts - 1) {
				if (IS_WINDOWS && isRetryableError(error)) return;
				throw error;
			}
			await sleep(backoffDelay(attempt));
		}
	}
}
