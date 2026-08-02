/**
 * 工具执行边界的 Phase 0 静态检查。
 *
 * TODO(security-phase-0): 随 Phase 5 工具迁移逐项删除 legacy allowlist，并把
 * 结果接入 npm check。当前允许名单必须精确到文件，不能豁免整个目录。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export interface ExecutionBoundaryViolation {
	file: string;
	kind: "raw-fs" | "raw-process" | "raw-network" | "raw-background";
}

export const LEGACY_RUNTIME_TOOL_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
	"src/runtime/tools": [
		"edit.ts",
		"glob.ts",
		"ls.ts",
		"multi-edit.ts",
		"read.ts",
		"tool-support.ts",
		"web-fetch.ts",
		"write.ts",
	],
};

/**
 * R0 之后只有这里列出的 backend 文件可以直接持有 child_process/PTY 句柄。
 * 当前没有生产 backend，因此保持为空；新增条目必须是精确文件路径。
 */
export const MANAGED_PROCESS_BACKEND_ALLOWLIST: readonly string[] = [];

const BOUNDARY_PATTERNS: readonly [RegExp, ExecutionBoundaryViolation["kind"]][] = [
	[/from [\"']node:fs(?:\/promises)?[\"']/, "raw-fs"],
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
				const allowed = (LEGACY_RUNTIME_TOOL_ALLOWLIST[root] ?? []).includes(relativeFile.slice(`${root}/`.length));
				if (!allowed) violations.push({ file: relativeFile, kind });
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
			if (RAW_BACKGROUND_PATTERNS.some((pattern) => pattern.test(source))) {
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
