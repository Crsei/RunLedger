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

/**
 * 目录级扫描的实现文件豁免。契约模块是 CONTRACT_INVENTORY.modules 中登记的
 * 精确文件(session-owner/{types,schemas}.ts、session-server/protocol.ts);
 * 同目录下的 transport/server/orchestration 实现允许持有 raw I/O 与 storage
 * 依赖,其边界由 check-session-owner-boundaries 单独约束。
 */
const NON_CONTRACT_IMPLEMENTATION_FILES: readonly string[] = [
	"src/runtime/session-owner/session-owner.ts",
	"src/runtime/session-server/owner-probe.ts",
	"src/runtime/session-server/client-transport.ts",
	"src/runtime/session-server/runtime-server.ts",
	"src/runtime/session-server/driver.ts",
	"src/runtime/session-server/subscription.ts",
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
			const relativeFile = relative(repoRoot, file).replaceAll("\\", "/");
			if (NON_CONTRACT_IMPLEMENTATION_FILES.includes(relativeFile)) continue;
			const source = readFileSync(file, "utf8");
			for (const [pattern, reason] of FORBIDDEN_IMPORT_PATTERNS) {
				if (pattern.test(source)) {
					violations.push({ file: relativeFile, reason });
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
