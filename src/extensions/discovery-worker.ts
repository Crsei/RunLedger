/** Extension discovery 共用的有界 worker pool。 */

import { DEFAULT_EXTENSION_LIMITS } from "./diagnostics.ts";

export interface ExtensionDiscoveryTask<T> {
	rootPriority: number;
	canonicalPath: string;
	entryName: string;
	run(): Promise<T>;
}

function compareTasks<T>(
	left: ExtensionDiscoveryTask<T>,
	right: ExtensionDiscoveryTask<T>,
): number {
	return left.rootPriority - right.rootPriority ||
		left.canonicalPath.localeCompare(right.canonicalPath) ||
		left.entryName.localeCompare(right.entryName);
}

/**
 * 任务先稳定排序，再由固定数量 worker 消费；返回顺序永远与排序后任务一致，
 * 不受单个目录或配置解析耗时影响。
 */
export async function runBoundedDiscovery<T>(
	tasks: readonly ExtensionDiscoveryTask<T>[],
	maxConcurrency = DEFAULT_EXTENSION_LIMITS.maxConcurrentScans,
): Promise<readonly T[]> {
	if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
		throw new RangeError("extension discovery concurrency must be a positive integer");
	}
	const ordered = [...tasks].sort(compareTasks);
	const results: T[] = new Array<T>(ordered.length);
	let cursor = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const index = cursor;
			if (index >= ordered.length) return;
			cursor += 1;
			const task = ordered[index];
			if (!task) return;
			results[index] = await task.run();
		}
	};
	await Promise.all(
		Array.from(
			{ length: Math.min(maxConcurrency, ordered.length) },
			() => worker(),
		),
	);
	return results;
}
