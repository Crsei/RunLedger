/** 工具与扩展执行边界的静态检查；所有豁免都必须是精确的 canonical adapter 文件。 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export interface ExecutionBoundaryViolation {
	file: string;
	kind: "raw-fs" | "raw-process" | "raw-network" | "raw-background";
}

/**
 * 这些文件是 canonical state adapter，直接使用 fs 只为实现 durable store；
 * 它们不向工具、扩展或进程执行面暴露 raw I/O。没有 runtime tool legacy 豁免。
 */
export const CANONICAL_STORAGE_ADAPTER_ALLOWLIST: readonly string[] = [
	"src/worktree/persisted-binding.ts",
	"src/worktree/registry.ts",
];

/**
 * R0 之后只有这里列出的 backend 文件可以直接持有 child_process/PTY 句柄。
 * native PTY adapter 也必须保持在精确文件路径内；新增条目不能豁免整个目录。
 */
export const MANAGED_PROCESS_BACKEND_ALLOWLIST: readonly string[] = [
	// The Linux peer adapter invokes the compiled SO_PEERCRED helper. It is a
	// production capability adapter, not a tool/TUI process escape hatch.
	"src/cli/linux-peer-attestor.ts",
	"src/cli/runtime-host-production.ts",
	"src/storage/process/node-pty-adapter.ts",
	"src/storage/process/process-backend.ts",
	"src/storage/process/supervisor-runner.ts",
];

/** Exact files allowed to create detached Host/supervisor process boundaries. */
export const RUNTIME_HOST_LAUNCHER_ALLOWLIST: readonly string[] = [
	"src/cli/runtime-host-production.ts",
	"src/storage/process/supervisor-runner.ts",
];

const BOUNDARY_PATTERNS: readonly [RegExp, ExecutionBoundaryViolation["kind"]][] = [
	[/from [\"'](?:node:)?fs(?:\/promises)?[\"']/, "raw-fs"],
	[/from [\"']node:child_process[\"']/, "raw-process"],
	[/\bfetch\s*\(/, "raw-network"],
];

const MANAGED_PROCESS_ROOTS = [
	"src/runtime/tools",
	"src/runtime/process",
	"src/storage/process",
	"src/tui",
	"src/cli",
] as const;

const RAW_BACKGROUND_PATTERNS: readonly RegExp[] = [
	/\bspawnBackground\b/u,
	/\bdetached\s*:\s*true\b/u,
	/\blogPath\b/u,
	/(?:^|[\\/])tmp[\\/]bash-/u,
];

function listTypeScriptFiles(directory: string): string[] {
	try {
		return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
			const entryPath = join(directory, entry.name);
			if (entry.isDirectory()) return listTypeScriptFiles(entryPath);
			return entry.isFile() && entry.name.endsWith(".ts") ? [entryPath] : [];
		});
	} catch {
		return [];
	}
}

export function scanExecutionBoundaries(repoRoot: string): ExecutionBoundaryViolation[] {
	const violations: ExecutionBoundaryViolation[] = [];
	const roots = ["src/runtime/tools", "src/security", "src/worktree", "src/extensions"];
	for (const root of roots) {
		for (const file of listTypeScriptFiles(join(repoRoot, root))) {
			const source = readFileSync(file, "utf8");
			for (const [pattern, kind] of BOUNDARY_PATTERNS) {
				if (!pattern.test(source)) continue;
				const relativeFile = relative(repoRoot, file).replaceAll("\\", "/");
				if (!CANONICAL_STORAGE_ADAPTER_ALLOWLIST.includes(relativeFile)) violations.push({ file: relativeFile, kind });
			}
		}
	}
	for (const root of MANAGED_PROCESS_ROOTS) {
		for (const file of listTypeScriptFiles(join(repoRoot, root))) {
			const relativeFile = relative(repoRoot, file).replaceAll("\\", "/");
			const source = readFileSync(file, "utf8");
			if (BOUNDARY_PATTERNS[1][0].test(source) && !MANAGED_PROCESS_BACKEND_ALLOWLIST.includes(relativeFile)) {
				violations.push({ file: relativeFile, kind: "raw-process" });
			}
			if (RAW_BACKGROUND_PATTERNS.some((pattern) => pattern.test(source)) &&
				!RUNTIME_HOST_LAUNCHER_ALLOWLIST.includes(relativeFile) &&
				!MANAGED_PROCESS_BACKEND_ALLOWLIST.includes(relativeFile)) {
				violations.push({ file: relativeFile, kind: "raw-background" });
			}
		}
	}
	return violations.sort((left, right) => left.file.localeCompare(right.file) || left.kind.localeCompare(right.kind));
}

function run(): void {
	const repoRoot = resolve(process.argv[2] ?? new URL("..", import.meta.url).pathname);
	const violations = scanExecutionBoundaries(repoRoot);
	if (violations.length > 0) {
		for (const violation of violations) {
			console.error(`${violation.file}: ${violation.kind} bypass`);
		}
		process.exitCode = 1;
		return;
	}
	console.log("execution boundary check passed");
}

if (process.argv[1]?.endsWith("check-execution-boundaries.ts")) {
	run();
}
