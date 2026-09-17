/**
 * P1 测试夹具：注册面样本。
 *
 * 用于验证真实 host 子进程把注册表序列化回 owner 后仍是 bounded、确定的
 * 形状（工具/命令/flag/订阅）。
 */

import type { ExtensionApi } from "../../../../src/extensions/host/runtime-api.ts";

export default function registrationsExtension(api: ExtensionApi): void {
	api.registerTool({
		name: "fixture_echo",
		description: "echoes bounded input",
		parameters: { type: "object", properties: { value: { type: "string" } } },
		approvalClass: "read-only",
		handler: () => ({ echoed: true }),
	});
	api.registerCommand({ name: "fixture_command", description: "runs a fixture command" });
	api.registerFlag({ name: "fixture-flag", description: "toggles a fixture", type: "boolean" });
	api.on("PreToolUse", () => ({ allow: true }));
}
