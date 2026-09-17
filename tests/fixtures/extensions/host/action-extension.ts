/**
 * P4 测试夹具：在事件 handler 内发起运行时动作。
 *
 * 动作只在绑定后合法，因此这里在 `PostToolUse` 里调用，并把 owner 的回执
 * 作为 middleware 结果返回，便于测试断言 receipt 是否原样传达。
 */

import type { ExtensionApi } from "../../../../src/extensions/host/runtime-api.ts";

export default function actionExtension(api: ExtensionApi): void {
	api.on("PostToolUse", async () => {
		const result = await api.setActiveTools(["fixture_echo"]);
		return { replacement: result.ok ? { active: true } : { active: false, code: result.code } };
	});
}
