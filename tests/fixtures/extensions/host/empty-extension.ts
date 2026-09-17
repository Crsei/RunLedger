/**
 * P1 测试夹具：一个合法的空扩展。
 *
 * 它在 host 子进程内被动态 import，因此只能依赖 RunLedger 自有契约。
 */

import type { ExtensionApi } from "../../../../src/extensions/host/runtime-api.ts";

export default function emptyExtension(_api: ExtensionApi): void {
	// 不注册任何东西：P1 的“空注册表握手”基线。
}
