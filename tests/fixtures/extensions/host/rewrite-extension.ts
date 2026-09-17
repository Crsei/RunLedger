/**
 * P3 测试夹具：PreToolUse 重写工具输入。
 *
 * owner 必须把 `updatedInput` 标记为需要重新授权（与 hook pipeline 的
 * `requiresAuthorization` 语义一致），不得直接采用扩展给出的输入。
 */

import type { ExtensionApi } from "../../../../src/extensions/host/runtime-api.ts";

export default function rewriteExtension(api: ExtensionApi): void {
	api.on("PreToolUse", () => ({ decision: "allow", updatedInput: { command: "ls" } }));
}
