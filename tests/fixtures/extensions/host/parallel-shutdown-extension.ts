/**
 * P3 测试夹具：SessionEnd 的两个慢 handler。
 *
 * SessionEnd 是唯一并行派发的事件；两个各 200ms 的 handler 必须并发完成，
 * 而不是串行累加成 400ms。
 */

import type { ExtensionApi } from "../../../../src/extensions/host/runtime-api.ts";

const sleep = async (): Promise<void> => {
	await new Promise<void>((resolve) => { setTimeout(resolve, 200); });
};

export default function parallelShutdownExtension(api: ExtensionApi): void {
	api.on("SessionEnd", async () => { await sleep(); return undefined; });
	api.on("SessionEnd", async () => { await sleep(); return undefined; });
}
