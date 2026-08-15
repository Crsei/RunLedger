/** 工具与扩展执行边界的静态检查；所有豁免都必须是精确的 canonical adapter 文件。 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ExecutionBoundaryViolation {
	file: string;
	kind: "raw-fs" | "raw-process" | "raw-network" | "raw-background" | "provider-execution-port" | "multi-agent-raw-boundary";
}

/**
 * 这些文件是 canonical state adapter，直接使用 fs 只为实现 durable store；
 * 它们不向工具、扩展或进程执行面暴露 raw I/O。没有 runtime tool legacy 豁免。
 */
export const CANONICAL_STORAGE_ADAPTER_ALLOWLIST: readonly string[] = [];

/** Session Security 可触碰 raw I/O 的唯一精确 final-leaf adapter。 */
export const EXECUTION_FINAL_LEAF_ADAPTER_ALLOWLIST: readonly string[] = [
	"src/security/integration/session-local-leaves.ts",
];

/** Bash AST 自包含 parser asset verification；不向工具或扩展暴露 raw I/O。 */
export const BASH_AST_ASSET_ALLOWLIST: readonly string[] = [
	"src/security/permission/bash-ast/assets.ts",
	"src/security/permission/bash-ast/worker.ts",
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
	// Session-scoped worktree composition 的单一 bounded Git spawn adapter。
	"src/cli/session-git-command.ts",
	"src/storage/process/node-pty-adapter.ts",
	"src/storage/process/process-backend.ts",
	"src/storage/process/supervisor-runner.ts",
];

/** Exact files allowed to create detached Host/supervisor process boundaries. */
export const RUNTIME_HOST_LAUNCHER_ALLOWLIST: readonly string[] = [
	"src/cli/runtime-host-production.ts",
	"src/storage/process/supervisor-runner.ts",
];

/**
 * 工具默认本地 IO 的唯一构造点。`src/runtime/tools` 中只有该文件可以调用
 * `localExecutionEnv`（低层库默认，供测试与直接库使用）；生产工具集必须经
 * `createStdlibTools(requireExecutionEnv: true)` 注入 governed ExecutionEnv。
 * 其他工具文件出现 `localExecutionEnv(` 调用即视为 raw-I/O 旁路。
 */
export const TOOLS_LOCAL_ENV_DEFAULT_ALLOWLIST: readonly string[] = [
	"src/runtime/tools/local-defaults.ts",
];

/** 旧 Anthropic helper 只保留给历史/demo 入口，不属于 Session Owner child composition。 */
export const MULTI_AGENT_LEGACY_HELPER_ALLOWLIST: readonly string[] = [
	"src/runtime/agents/create-anthropic-agent.ts",
];

const BOUNDARY_PATTERNS: readonly [RegExp, ExecutionBoundaryViolation["kind"]][] = [
	[/from [\"'](?:node:)?fs(?:\/promises)?[\"']/, "raw-fs"],
	[/from [\"']node:child_process[\"']/, "raw-process"],
	[/\bfetch\s*\(/, "raw-network"],
];

/** 非 import 行上的 `localExecutionEnv(` 调用（工具文件里默认 ops 的唯一合法来源被 allowlist 豁免）。 */
const LOCAL_ENV_CALL_PATTERN = /(?:^|[^.\w])localExecutionEnv\s*\(/u;

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

/**
 * Discovery Provider 实现不得持有 TrustStore/ExtensionStateStore/Gateway/
 * MCP client/process handle（02 计划 §5）。只允许导入类型、diagnostics 与
 * observation/skill schema；任何 execution/state 端口 import 都是违反。
 */
const PROVIDER_EXECUTION_PORT_PATTERNS: readonly [RegExp, ExecutionBoundaryViolation["kind"]][] = [
	[/from ["'][^"']*(?:trust-store|state-store)[^"']*["']/u, "provider-execution-port"],
	[/from ["'][^"']*(?:connection-manager|attempt-gateway|session-runtime|tool-registry|agent-loop)[^"']*["']/u, "provider-execution-port"],
	[/from ["'][^"']*\/mcp\/[^"']*["']/u, "provider-execution-port"],
	[/from ["']node:child_process["']/u, "provider-execution-port"],
	// 路径/设置 authority：provider 不得自行调用 homedir/cwd/env/Bun.Glob（02 计划 D6）。
	[/\bos\.homedir\s*\(/u, "provider-execution-port"],
	[/\bprocess\.cwd\s*\(/u, "provider-execution-port"],
	[/\bprocess\.env\b/u, "provider-execution-port"],
	[/\bBun\.Glob\b/u, "provider-execution-port"],
];

const PROVIDER_DIRECTORY_PATTERN = /^src\/extensions\/[^/]+\/providers\//u;

const MULTI_AGENT_SYMBOL_BOUNDARY_PATTERNS: readonly RegExp[] = [
	/['"](?:\.\/)?create-anthropic-agent\.ts['"]/u,
	/\blocalExecutionEnv\s*\(/u,
	/\bAllowAllToolAuthorizationPolicy\b/u,
];
const MULTI_AGENT_STDLIB_FACTORY_PATTERN = /\b(?:createStdlibTools|stdlibTools)\s*\(/u;
const MULTI_AGENT_SESSION_DOMAIN_FILE = "src/runtime/session-runtime/domain.ts";

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

export function findProviderExecutionPortViolations(relativeFile: string, source: string): ExecutionBoundaryViolation[] {
	if (!PROVIDER_DIRECTORY_PATTERN.test(relativeFile)) return [];
	const violations: ExecutionBoundaryViolation[] = [];
	for (const [pattern] of PROVIDER_EXECUTION_PORT_PATTERNS) {
		if (pattern.test(source)) violations.push({ file: relativeFile, kind: "provider-execution-port" });
	}
	return violations;
}

export function findMultiAgentBoundaryViolations(relativeFile: string, source: string): ExecutionBoundaryViolation[] {
	const isAgentProductionFile = relativeFile.startsWith("src/runtime/agents/") && !MULTI_AGENT_LEGACY_HELPER_ALLOWLIST.includes(relativeFile);
	if (!isAgentProductionFile && relativeFile !== MULTI_AGENT_SESSION_DOMAIN_FILE) return [];
	const violations = MULTI_AGENT_SYMBOL_BOUNDARY_PATTERNS
		.filter((pattern) => pattern.test(source))
		.map(() => ({ file: relativeFile, kind: "multi-agent-raw-boundary" as const }));
	if (MULTI_AGENT_STDLIB_FACTORY_PATTERN.test(source) && hasUngovernedMultiAgentStdlibFactory(relativeFile, source)) {
		violations.push({ file: relativeFile, kind: "multi-agent-raw-boundary" });
	}
	return violations;
}

function hasUngovernedMultiAgentStdlibFactory(relativeFile: string, source: string): boolean {
	if (relativeFile !== MULTI_AGENT_SESSION_DOMAIN_FILE) return true;
	if (/\bstdlibTools\s*\(/u.test(source)) return true;
	const call = source.match(/\bcreateStdlibTools\s*\(/u);
	if (call?.index === undefined) return false;
	return !/requireExecutionEnv\s*:\s*true/u.test(source.slice(call.index, call.index + 2_000));
}

export function scanExecutionBoundaries(repoRoot: string): ExecutionBoundaryViolation[] {
	const violations: ExecutionBoundaryViolation[] = [];
	const roots = ["src/runtime/tools", "src/security", "src/worktree", "src/extensions"];
	for (const root of roots) {
		for (const file of listTypeScriptFiles(join(repoRoot, root))) {
			const source = readFileSync(file, "utf8");
			const relativeFile = relative(repoRoot, file).replaceAll("\\", "/");
			for (const [pattern, kind] of BOUNDARY_PATTERNS) {
				if (!pattern.test(source)) continue;
				if (!CANONICAL_STORAGE_ADAPTER_ALLOWLIST.includes(relativeFile) && !EXECUTION_FINAL_LEAF_ADAPTER_ALLOWLIST.includes(relativeFile) && !BASH_AST_ASSET_ALLOWLIST.includes(relativeFile)) {
					violations.push({ file: relativeFile, kind });
				}
			}
			violations.push(...findProviderExecutionPortViolations(relativeFile, source));
			if (root === "src/runtime/tools" && !TOOLS_LOCAL_ENV_DEFAULT_ALLOWLIST.includes(relativeFile)) {
				const localEnvCalls = source
					.split("\n")
					.filter((line) => {
						const trimmed = line.trim();
						return !trimmed.startsWith("import") && !trimmed.startsWith("*") && !trimmed.startsWith("//") && LOCAL_ENV_CALL_PATTERN.test(line);
					});
				if (localEnvCalls.length > 0) violations.push({ file: relativeFile, kind: "raw-fs" });
			}
		}
	}
	for (const root of MANAGED_PROCESS_ROOTS) {
		for (const file of listTypeScriptFiles(join(repoRoot, root))) {
			const relativeFile = relative(repoRoot, file).replaceAll("\\", "/");
			const source = readFileSync(file, "utf8");
			if (BOUNDARY_PATTERNS[1][0].test(source) &&
				!MANAGED_PROCESS_BACKEND_ALLOWLIST.includes(relativeFile) &&
				!EXECUTION_FINAL_LEAF_ADAPTER_ALLOWLIST.includes(relativeFile) &&
				!BASH_AST_ASSET_ALLOWLIST.includes(relativeFile)) {
				violations.push({ file: relativeFile, kind: "raw-process" });
			}
			if (RAW_BACKGROUND_PATTERNS.some((pattern) => pattern.test(source)) &&
				!RUNTIME_HOST_LAUNCHER_ALLOWLIST.includes(relativeFile) &&
				!MANAGED_PROCESS_BACKEND_ALLOWLIST.includes(relativeFile)) {
				violations.push({ file: relativeFile, kind: "raw-background" });
			}
		}
	}
	for (const file of listTypeScriptFiles(join(repoRoot, "src/runtime/agents"))) {
		const relativeFile = relative(repoRoot, file).replaceAll("\\", "/");
		violations.push(...findMultiAgentBoundaryViolations(relativeFile, readFileSync(file, "utf8")));
	}
	const sessionDomainPath = join(repoRoot, MULTI_AGENT_SESSION_DOMAIN_FILE);
	try {
		violations.push(...findMultiAgentBoundaryViolations(MULTI_AGENT_SESSION_DOMAIN_FILE, readFileSync(sessionDomainPath, "utf8")));
	} catch {
		// Synthetic boundary tests and library consumers may not have the production file.
	}
	return violations.sort((left, right) => left.file.localeCompare(right.file) || left.kind.localeCompare(right.kind));
}

function run(): void {
	const repoRoot = resolve(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
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
