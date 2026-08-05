/** 多平台 workspace 适配的静态边界：业务层不得新增散落的 process.platform 分支。 */

/**
 * 规则（01 计划 §2 原则 7、P3"加静态边界"）：
 * 1. `src/**` 中 `process.platform` 只允许出现在精确 allowlist 文件里；
 * 2. 新代码只允许 `src/workspace/factory.ts` 拥有平台分支；
 * 3. `src/workspace` 纯模块（P3 层）不得 import node:fs / node:child_process / node:os，
 *    保证纯适配器无 filesystem/process side effect；native/** 除外；
 * 4. 不允许用目录级豁免。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export interface PlatformBoundaryViolation {
	file: string;
	kind: "platform-branch" | "pure-side-effect";
	detail: string;
}

/**
 * 既有平台的既存分支点：逐文件精确豁免，不豁免目录。
 * P6 迁移后以下文件不再直接读取运行时平台（消费 workspace/runtime-platform.ts）：
 * session-manager / migration / worktree-registry-store / runledger-home /
 * trace-composition / policy-filesystem / persisted-binding（runtime-host-process
 * 仅 execution-decision 调用点迁移，PTY/containment 分支仍是它自己的 backend 能力）。
 */
const LEGACY_PLATFORM_BRANCH_ALLOWLIST: readonly string[] = [
	"src/cli/linux-peer-attestor.ts",
	"src/cli/runtime-host-production.ts",
	"src/cli/runtime-host-process.ts",
	"src/cli/runtime-host-security.ts",
	"src/cli/runtime-host-transport.ts",
	"src/cli/runtime-host.ts",
	"src/runtime/execution-env.ts",
	"src/runtime/host/peer-attestation.ts",
	"src/runtime/local-identity.ts",
	"src/runtime/process/execution-decision.ts",
	"src/security/sandbox/factory.ts",
	"src/storage/process/node-pty-adapter.ts",
	"src/storage/process/process-backend.ts",
	"src/storage/process/supervisor-runner.ts",
	"src/utils/shell.ts",
];

/** 新增平台分支的合法位置：平台检测/装配 factory 与运行时平台单点。 */
const WORKSPACE_FACTORY_ALLOWLIST: readonly string[] = [
	"src/workspace/factory.ts",
	"src/workspace/runtime-platform.ts",
];

/** P3 纯适配器层：不允许出现 fs/child_process/os 副作用 import。 */
const PURE_WORKSPACE_MODULES: readonly string[] = [
	"src/workspace/types.ts",
	"src/workspace/path-adapter.ts",
	"src/workspace/git-porcelain.ts",
	"src/workspace/process-capability.ts",
];

const PLATFORM_BRANCH_PATTERN = /\bprocess\.platform\b/u;
const SIDE_EFFECT_IMPORT_PATTERN = /from\s+["'](?:node:)?(?:fs|child_process|os)["']/u;

function scanFiles(dir: string, out: string[]): void {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) scanFiles(full, out);
		else if (full.endsWith(".ts")) out.push(full);
	}
}

export function checkPlatformBoundaries(): readonly PlatformBoundaryViolation[] {
	const violations: PlatformBoundaryViolation[] = [];
	const files: string[] = [];
	scanFiles(resolve("src"), files);
	for (const full of files) {
		const file = relative(resolve("."), full);
		const content = readFileSync(full, "utf8");
		if (PLATFORM_BRANCH_PATTERN.test(content)) {
			const allowed = LEGACY_PLATFORM_BRANCH_ALLOWLIST.includes(file) || WORKSPACE_FACTORY_ALLOWLIST.includes(file);
			if (!allowed) violations.push({ file, kind: "platform-branch", detail: "process.platform outside the platform-boundary allowlist" });
		}
		if (PURE_WORKSPACE_MODULES.includes(file) && SIDE_EFFECT_IMPORT_PATTERN.test(content)) {
			violations.push({ file, kind: "pure-side-effect", detail: "pure workspace adapter imports fs/child_process/os" });
		}
	}
	return violations;
}

function main(): void {
	const violations = checkPlatformBoundaries();
	for (const violation of violations) console.error(`[platform-boundary] ${violation.kind}: ${violation.file} — ${violation.detail}`);
	if (violations.length > 0) {
		process.exitCode = 1;
		return;
	}
	console.log("platform boundary check passed");
}

if (process.argv[1]?.endsWith("check-platform-boundaries.ts")) {
	main();
}
