/**
 * `runledger workspace` 子命令 —— 只读展示 workspace/path 能力矩阵。
 *
 * 输出基于真实 runner 证据（P1 fixtures + verification gaps），绝不把
 * worktree/permission 描述为 OS sandbox enforced；不连接 Host、不修改状态。
 */

import { runtimeWorkspacePlatform } from "../workspace/runtime-platform.ts";
import { workspaceCapabilityMatrix, type PlatformCapabilityRow } from "../workspace/capability.ts";

const USAGE = `usage: runledger workspace <capability>

commands:
  capability   显示各平台 path/Git/Shell/process/cleanup 适配证据状态（只读）
`;

function rowText(row: PlatformCapabilityRow): string {
	const flag = (value: boolean): string => (value ? "available" : "unsupported");
	return [
		`${row.platform.padEnd(9)} path=${row.path.padEnd(10)} git=${row.git.padEnd(10)} process=${row.process.padEnd(10)} cleanup=${row.cleanup.padEnd(10)} adapter=${flag(row.adapterAvailable)}`,
		`           note: ${row.note}`,
	].join("\n");
}

export async function runWorkspaceCommand(argv: readonly string[]): Promise<void> {
	const sub = argv[0];
	if (sub === "--help" || sub === "-h" || sub === undefined) {
		process.stdout.write(USAGE);
		return;
	}
	if (sub !== "capability") {
		process.stderr.write(`[runledger] unknown workspace command: ${sub}\n\n${USAGE}`);
		process.exit(2);
	}
	process.stdout.write("workspace capability (per real-runner evidence; 不构成 OS sandbox/containment 承诺)\n");
	for (const row of workspaceCapabilityMatrix()) process.stdout.write(`${rowText(row)}\n`);
	process.stdout.write(`current runner: ${runtimeWorkspacePlatform()} (${workspaceCapabilityMatrix().find((row) => row.platform === runtimeWorkspacePlatform())?.adapterAvailable ? "verified" : "unverified"})\n`);
	process.stdout.write("证据与缺口: development-doc/worktree-sandbox-permisson/evidence-verification-gaps.md\n");
}
