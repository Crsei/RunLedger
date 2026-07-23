/**
 * 工具执行边界的 Phase 0 静态检查。
 *
 * 随安全专项 Phase 5 工具迁移逐项删除 legacy allowlist。该检查已接入
 * `npm run check`，当前允许名单必须精确到文件，不能豁免整个目录。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export interface ExecutionBoundaryViolation {
	file: string;
	kind: "raw-fs" | "raw-process" | "raw-network";
}

export const LEGACY_RUNTIME_TOOL_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
	"src/runtime/tools": [
		"bash.ts",
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

const BOUNDARY_PATTERNS: readonly [RegExp, ExecutionBoundaryViolation["kind"]][] = [
	[/from [\"']node:fs(?:\/promises)?[\"']/, "raw-fs"],
	[/from [\"']node:child_process[\"']/, "raw-process"],
	[/\bfetch\s*\(/, "raw-network"],
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
