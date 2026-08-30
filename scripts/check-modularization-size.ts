/**
 * 臃肿代码模块化重构计划(S0 §4.1.6)专用 size audit。
 *
 * 只报告计划目标文件与新模块的行数,是趋势检查,不接管领域正确性:
 * - 目标文件行数持续下降(或被 facade/新模块替代后移除);
 * - 新模块行数不应制造新的“上帝文件”。
 *
 * 不接入 `npm run check`:检查链只负责静态边界,行数是诊断信号。
 * scripts/ 在 tsconfig 中 exclude,本文件由 tsx 直接运行。
 */

import { readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../..");

/** 计划 §1.2 目标文件(实施后 facade 可能变薄,新模块在下方单独列出)。 */
const TARGET_FILES = [
	"src/tui/interactive-mode.ts",
	"src/api/openai-codex-responses.ts",
	"src/api/openai-completions.ts",
	"src/api/anthropic-messages.ts",
	"src/tui/opentui/component-runtime.ts",
	"src/cli/runtime-host-service.ts",
	"src/runtime/agent-loop.ts",
	"src/runtime/session-runtime/session-runtime.ts",
	"src/cli/runtime-host-model-context.ts",
	"src/api/bedrock-converse-stream.ts",
	"src/storage/session-store/session-store.ts",
	"src/security/session-composition.ts",
	"src/cli/runtime-host-security.ts",
	"src/cli/runtime-host-process.ts",
	"src/runtime/session-runtime/process-composition.ts",
	"scripts/generate-models.ts",
];

/** 计划各阶段新增模块目录;facade 文件本身在目标文件中列出,此处排除。 */
const NEW_MODULE_ROOTS = [
	"src/storage/session-store",
	"src/security/composition",
	"src/runtime/session-runtime",
	"src/runtime/session-runtime/process",
	"src/runtime/agent-loop",
	"src/tui/opentui/component-runtime",
	"src/tui/interactive",
	"src/api/openai-codex-responses",
	"src/api/openai-completions",
	"src/api/anthropic-messages",
	"src/api/bedrock-converse-stream",
	"scripts/model-generation",
];

const GENERATED_SUFFIX = [".generated.ts", ".models.ts"];

function report(paths: readonly string[], label: string): void {
	const rows = paths
		.map((path) => {
			const absolutePath = resolve(repoRoot, path);
			return { path: relative(repoRoot, absolutePath).split("\\").join("/"), lines: readFileSync(absolutePath, "utf8").split("\n").length };
		})
		.sort((a, b) => b.lines - a.lines);
	const total = rows.reduce((sum, row) => sum + row.lines, 0);
	console.log(`\n== ${label} (${rows.length} files, ${total} lines) ==`);
	for (const row of rows) {
		const flag = row.lines > 400 ? "  <-- over 400-line guardrail" : row.lines > 300 ? "  <-- over 300-line facade guardrail" : "";
		console.log(`${String(row.lines).padStart(6)} ${row.path}${flag}`);
	}
}

function gitPathLines(args: readonly string[]): string[] {
	const output = execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" });
	return output.split(/\r?\n/u).map((path) => path.trim()).filter((path) => path.length > 0);
}

export interface ModularizationSizeAuditDependencies {
	readonly gitPathLines: (args: readonly string[]) => readonly string[];
}

const defaultDependencies: ModularizationSizeAuditDependencies = { gitPathLines };

/** 只返回当前 worktree 相对 HEAD 新增/未跟踪且属于本计划模块根的手写 TS。 */
export function listNewModulePaths(
	dependencies: ModularizationSizeAuditDependencies = defaultDependencies,
): string[] {
	const candidates = new Set([
		...dependencies.gitPathLines(["diff", "--name-only", "--diff-filter=A", "HEAD", "--", ...NEW_MODULE_ROOTS]),
		...dependencies.gitPathLines(["ls-files", "--others", "--exclude-standard", "--", ...NEW_MODULE_ROOTS]),
	]);
	return [...candidates]
		.filter((path) => path.endsWith(".ts"))
		.filter((path) => NEW_MODULE_ROOTS.some((root) => path === root || path.startsWith(`${root}/`)))
		.filter((path) => !GENERATED_SUFFIX.some((suffix) => path.endsWith(suffix)))
		.sort();
}

function run(): void {
	const targets = TARGET_FILES.filter((path) => statSync(join(repoRoot, path), { throwIfNoEntry: false }) !== undefined);
	report(targets, "target files");
	report(listNewModulePaths(), "new modules relative to HEAD");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) run();
