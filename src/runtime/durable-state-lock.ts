/** 小型 JSON authority store 共用的跨进程互斥边界。 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";

const LOCK_STALE_MS = 30_000;

/**
 * 同一 state key 的 read-check-write 必须处于一个 lock lease 内。
 * 调用方把 acquire/release 失败映射为各自领域的 typed durable failure。
 */
export async function withDurableStateLock<T>(
	statePath: string,
	operation: () => Promise<T>,
): Promise<T> {
	await mkdir(dirname(statePath), { recursive: true, mode: 0o700 });
	const release = await lockfile.lock(statePath, {
		realpath: false,
		lockfilePath: `${statePath}.lock`,
		retries: 0,
		stale: LOCK_STALE_MS,
		update: LOCK_STALE_MS / 2,
	});
	try {
		return await operation();
	} finally {
		await release();
	}
}
