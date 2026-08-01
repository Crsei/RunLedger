/**
 * Runtime contract 目录的静态边界检查。
 *
 * TODO(runtime-phase-0): 将 allowlist/依赖图迁移到版本化 architecture manifest，
 * 并在 CI/npm script 中注册。当前脚本可直接执行，且不修改工作区。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { CONTRACT_DIRECTORY_ALLOWLIST } from "../src/runtime/contracts/inventory.ts";

export interface RuntimeBoundaryViolation {
	file: string;
	reason: string;
}

const FORBIDDEN_IMPORT_PATTERNS: readonly [RegExp, string][] = [
	[/node:(?:fs|child_process|net|http|https)/, "contract module cannot own raw I/O"],
	[/node:os/, "contract module cannot read the host environment"],
	[/from [\"'][^\"']*(?:(?:storage|tui|providers?)\/|(?:storage|tui|providers?)\.ts)[^\"']*[\"']/, "contract module cannot depend on storage/UI/provider"],
	[/\bfetch\s*\(/, "contract module cannot perform network I/O"],
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

export function scanRuntimeBoundaries(repoRoot: string): RuntimeBoundaryViolation[] {
	const violations: RuntimeBoundaryViolation[] = [];
	for (const directory of CONTRACT_DIRECTORY_ALLOWLIST) {
		for (const file of listTypeScriptFiles(join(repoRoot, directory))) {
			const source = readFileSync(file, "utf8");
			for (const [pattern, reason] of FORBIDDEN_IMPORT_PATTERNS) {
				if (pattern.test(source)) {
					violations.push({ file: relative(repoRoot, file), reason });
				}
			}
		}
	}
	return violations.sort((left, right) => left.file.localeCompare(right.file) || left.reason.localeCompare(right.reason));
}

function run(): void {
	const repoRoot = resolve(process.argv[2] ?? new URL("..", import.meta.url).pathname);
	const violations = scanRuntimeBoundaries(repoRoot);
	if (violations.length > 0) {
		for (const violation of violations) {
			console.error(`${violation.file}: ${violation.reason}`);
		}
		process.exitCode = 1;
		return;
	}
	console.log("runtime boundary check passed");
}

if (process.argv[1]?.endsWith("check-runtime-boundaries.ts")) {
	run();
}
