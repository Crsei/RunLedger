/** Runtime 模块依赖的版本化静态边界检查。 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

export interface RuntimeBoundaryViolation {
	ruleId: string;
	file: string;
	reason: string;
}

interface RuntimeBoundaryRule {
	id: string;
	roots: readonly string[];
	fileNamePattern?: RegExp;
	forbidden: readonly [RegExp, string][];
}

export const RUNTIME_BOUNDARY_MANIFEST = {
	version: 1,
	rules: [
		{
			id: "protocol-is-pure",
			roots: ["src/runtime/protocol/v3"],
			forbidden: [
				[/node:(?:fs|child_process|net|http|https)/, "protocol cannot own raw I/O"],
				[/(?:from\s+|import\s*)["'][^"']*(?:storage|tui|providers?)[^"']*["']/, "protocol cannot depend on storage/UI/provider"],
				[/\bfetch\s*\(/, "protocol cannot perform network I/O"],
			],
		},
		{
			id: "contracts-are-pure",
			roots: [
				"src/runtime/identity",
				"src/runtime/resources",
				"src/runtime/model-routing",
				"src/runtime/modes",
				"src/runtime/context",
			],
			forbidden: [
				[/node:(?:fs|child_process|net|http|https)/, "contract module cannot own raw I/O"],
				[/(?:from\s+|import\s*)["'][^"']*(?:storage|tui|providers?)[^"']*["']/, "contract module cannot depend on storage/UI/provider"],
				[/\bfetch\s*\(/, "contract module cannot perform network I/O"],
			],
		},
		{
			id: "gateway-does-not-depend-on-ui",
			roots: ["src/runtime/gateway", "src/security"],
			forbidden: [[/(?:from\s+|import\s*)["'][^"']*(?:tui|interactive-session-controller)[^"']*["']/, "gateway cannot depend on TUI/controller"]],
		},
		{
			id: "projection-does-not-write-store",
			roots: ["src/runtime/session"],
			fileNamePattern: /(?:reducer|projection)/,
			forbidden: [
				[/(?:from\s+|import\s*)["'][^"']*(?:event-store|jsonl-v3-store)[^"']*["']/, "projection cannot import canonical stores"],
				[/\.append\s*\(/, "projection cannot append canonical events"],
			],
		},
	] satisfies readonly RuntimeBoundaryRule[],
} as const;

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
	for (const rule of RUNTIME_BOUNDARY_MANIFEST.rules) {
		for (const root of rule.roots) {
			for (const file of listTypeScriptFiles(join(repoRoot, root))) {
				if (rule.fileNamePattern && !rule.fileNamePattern.test(basename(file))) continue;
				const source = readFileSync(file, "utf8");
				for (const [pattern, reason] of rule.forbidden) {
					if (pattern.test(source)) {
						violations.push({
							ruleId: rule.id,
							file: relative(repoRoot, file).replaceAll("\\", "/"),
							reason,
						});
					}
				}
			}
		}
	}
	return violations.sort(
		(left, right) => left.file.localeCompare(right.file) || left.ruleId.localeCompare(right.ruleId) || left.reason.localeCompare(right.reason),
	);
}

function run(): void {
	const repoRoot = resolve(process.argv[2] ?? new URL("..", import.meta.url).pathname);
	const violations = scanRuntimeBoundaries(repoRoot);
	if (violations.length > 0) {
		for (const violation of violations) console.error(`${violation.file}: ${violation.ruleId}: ${violation.reason}`);
		process.exitCode = 1;
		return;
	}
	console.log(`runtime boundary check passed (manifest v${RUNTIME_BOUNDARY_MANIFEST.version})`);
}

if (process.argv[1]?.endsWith("check-runtime-boundaries.ts")) run();
