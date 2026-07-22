/** 独立进程 composition root 可包装的单请求入口。 */

import type {
	VerificationCoreResult,
	VerificationRunnerAttempt,
	VerificationRunnerRequest,
} from "../runtime/verification/types.ts";
import type { PortBackedVerificationRunner } from "./runner.ts";

/**
 * 这里只暴露 handler，不读取宿主环境或标准输入，也不创建执行后端。部署层必须显式
 * 注入 Workspace、Capability、Sandbox 与 Artifact adapters。
 */
export async function handleVerificationRunnerRequest(
	runner: PortBackedVerificationRunner,
	request: VerificationRunnerRequest,
	signal?: AbortSignal,
): Promise<VerificationCoreResult<VerificationRunnerAttempt>> {
	return runner.run(request, signal);
}
