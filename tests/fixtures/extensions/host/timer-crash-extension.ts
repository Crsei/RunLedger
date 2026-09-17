/**
 * P1 测试夹具：扩展在 host 进程内留下一个裸 timer，回调抛错。
 *
 * 这是与 omp 相反行为的固定点：进程内 import 时这类错误会触发
 * `uncaughtException` 拆掉整个 session；host 子进程模型下它只让该
 * generation failed，owner 与 session 必须存活（D1/D2）。
 */

import type { ExtensionApi } from "../../../../src/extensions/host/runtime-api.ts";

export default function timerCrashExtension(api: ExtensionApi): void {
	api.on("TurnStart", () => undefined);
	// 2s 的首个 tick：保证 owner 先完成握手并进入 ready，随后的崩溃才是
	// “健康 generation 突然死亡”，而不是启动期竞态。
	setInterval(() => {
		throw new Error("fixture bare timer failure");
	}, 2_000);
}
