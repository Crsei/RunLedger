/**
 * P1 测试夹具：工厂直接抛错。
 *
 * owner 必须把该 generation 记为 failed 并让 session 继续，而不是把异常
 * 变成 session 级失败（D2）。
 */

import type { ExtensionApi } from "../../../../src/extensions/host/runtime-api.ts";

export default function throwingFactory(_api: ExtensionApi): void {
	throw new Error("fixture factory failed on purpose");
}
