/**
 * Session Owner 边界静态检查(R0 冻结)。
 *
 * 禁止:
 * 1. 生产代码新增 legacy machine/workspace Host 消费(R0-frozen allowlist 之外);
 * 2. 新 session 模块(session-owner/session-runtime/session-server/session-store)
 *    出现 machine leader、daemon、UDS/Named Pipe、非 loopback TCP、TUI 依赖
 *    或 direct controller fallback;
 * 3. 新 session 模块依赖 legacy Host(production Host import);
 * 4. Client 层绕过 owner server 直接驱动 controller(只有 SessionRuntime 可以组合)。
 *
 * 所有豁免必须是精确文件路径的 R0-frozen allowlist;新增豁免需要修改 06 计划。
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";

export interface SessionOwnerBoundaryViolation {
	file: string;
	kind:
		| "legacy-host-import"
		| "legacy-host-consumer"
		| "tui-import"
		| "daemon-pattern"
		| "uds-or-pipe"
		| "non-loopback-bind"
		| "raw-transport"
		| "direct-controller";
	reason: string;
}

/**
 * legacy Host 模块的 import source 模式。命中这些来源的文件要么属于
 * legacy Host 内部,要么必须位于 R0_FROZEN_LEGACY_CONSUMER_ALLOWLIST。
 */
const LEGACY_HOST_SOURCE_PATTERNS: readonly RegExp[] = [
	/(?:runtime\/host|storage\/host)\//u,
	/runtime-host/u,
	/reconnecting-host-bridge/u,
	/host-command/u,
	/host-build-identity/u,
	/linux-peer-attestor/u,
	/extensions\/host-manager/u,
];

/**
 * 属于 legacy Host 自身的文件,允许互相 import,不被 legacy-consumer 规则约束。
 * 这些文件在 R9 从生产删除,期间不得被新代码消费。
 */
const LEGACY_HOST_INTERNAL_PREFIXES: readonly string[] = [
	"src/runtime/host/",
	"src/storage/host/",
	"src/cli/runtime-host",
	"src/cli/host-command.ts",
	"src/cli/reconnecting-host-bridge.ts",
	"src/cli/linux-peer-attestor.ts",
	"src/cli/host-build-identity.ts",
];

/**
 * R0 冻结的 legacy Host 生产消费者(06 §9.3 delete inventory 之外仍引用 Host
 * 的既有文件)。新文件不得加入;R7 切换后这些条目随生产接线迁移/删除。
 */
export const R0_FROZEN_LEGACY_CONSUMER_ALLOWLIST: readonly string[] = [
	"src/cli/main.ts",
	"src/extensions/hooks/host-runner.ts",
	"src/extensions/integration/runtime-events.ts",
	"src/extensions/turn-lifecycle.ts",
	"src/index.ts",
	"src/runtime/contracts/public.ts",
	"src/runtime/process/completion-reconciler.ts",
	"src/runtime/process/manager.ts",
	"src/runtime/process/schemas.ts",
	"src/runtime/process/wait-coordinator.ts",
	"src/runtime/tools/process-tool-support.ts",
	"src/runtime/tools/process-wait.ts",
	"src/security/integration/runtime-security-events.ts",
	"src/storage/process/completion-queue.ts",
	"src/storage/process/control-plane.ts",
	"src/storage/process/process-backend.ts",
	"src/storage/process/pty-backend.ts",
	"src/tui/interactive-mode.ts",
	"src/worktree/integration/runtime-workspace-events.ts",
];

/**
 * 新 Session Owner 实现目录/文件。这些模块只能面向 session scope,
 * 不得引入 machine/workspace Host 或平台 IPC。
 */
export const SESSION_OWNER_MODULE_ROOTS: readonly string[] = [
	"src/runtime/session-owner/",
	"src/runtime/session-runtime/",
	"src/runtime/session-server/",
	"src/storage/session-store/",
	"src/cli/session-client.ts",
	"src/cli/embedded-session-runtime.ts",
];

/**
 * 唯一允许组合 Agent/controller 的模块前缀。Client(CLI/TUI)与
 * RuntimeServer facade 不得直接驱动 controller,必须走 owner server。
 */
export const RUNTIME_COMPOSITION_ALLOWLIST: readonly string[] = ["src/runtime/session-runtime/"];

const DAEMON_PATTERNS: readonly [RegExp, SessionOwnerBoundaryViolation["kind"], string][] = [
	[/\bdetached\s*:\s*true\b/u, "daemon-pattern", "detached process creates a machine-scoped daemon"],
	[/\bspawnBackground\b/u, "daemon-pattern", "background spawn escapes session lifetime"],
	[/\\\\.\\pipe\\/u, "uds-or-pipe", "Windows Named Pipe is out of scope"],
	[/['"]unix:['"]/u, "uds-or-pipe", "Unix Domain Socket is out of scope"],
	[/['"]0\.0\.0\.0['"]/u, "non-loopback-bind", "TCP must bind 127.0.0.1 only"],
	[/['"]::["']/u, "non-loopback-bind", "IPv6 any-interface bind is out of scope"],
	[/from ['"]node:net['"]/u, "raw-transport", "node:net only belongs in the RuntimeServer transport"],
];

const LEGACY_HOST_LEADER_PATTERNS: readonly RegExp[] = [
	/(?:startup-election|writer-lease|host-generation-store|shutdown-intent-store)/u,
];

const DIRECT_CONTROLLER_PATTERNS: readonly RegExp[] = [
	/interactive-session-controller/u,
	/from ["'][^"']*\/agent\.ts["']/u,
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

function isLegacyHostInternal(relativeFile: string): boolean {
	return LEGACY_HOST_INTERNAL_PREFIXES.some((prefix) => relativeFile.startsWith(prefix));
}

/** 只统计真实的 import/export-from 语句,不匹配注释、字符串字面量或标识符。 */
function importSpecifiers(source: string): string[] {
	const specifiers: string[] = [];
	for (const line of source.split("\n")) {
		const trimmed = line.trim();
		const match = /^(?:import|export)\b.*\bfrom\s*["']([^"']+)["']/u.exec(trimmed);
		if (match) specifiers.push(match[1] as string);
	}
	return specifiers;
}

function hasLegacyHostImport(relativeFile: string, source: string): boolean {
	const dir = dirname(relativeFile);
	for (const line of source.split("\n")) {
		const match = /^(?:import|export)\b.*\bfrom\s*["']([^"']+)["']/u.exec(line.trim());
		if (!match) continue;
		const specifier = match[1] as string;
		const target = specifier.startsWith(".") ? normalize(join(dir, specifier)) : specifier;
		if (LEGACY_HOST_SOURCE_PATTERNS.some((pattern) => pattern.test(target))) return true;
	}
	return false;
}

export function scanSessionOwnerBoundaries(repoRoot: string): SessionOwnerBoundaryViolation[] {
	const violations: SessionOwnerBoundaryViolation[] = [];
	const srcRoot = join(repoRoot, "src");
	for (const file of listTypeScriptFiles(srcRoot)) {
		const relativeFile = relative(repoRoot, file).replaceAll("\\", "/");
		const source = readFileSync(file, "utf8");
		const isSessionModule = SESSION_OWNER_MODULE_ROOTS.some((root) => relativeFile.startsWith(root));

		if (isSessionModule) {
			if (hasLegacyHostImport(relativeFile, source)) {
				violations.push({ file: relativeFile, kind: "legacy-host-import", reason: "session module must not consume legacy Host" });
			}
			for (const [pattern, kind, reason] of DAEMON_PATTERNS) {
				if (pattern.test(source)) {
					violations.push({ file: relativeFile, kind, reason });
				}
			}
			for (const pattern of LEGACY_HOST_LEADER_PATTERNS) {
				if (pattern.test(source)) {
					violations.push({ file: relativeFile, kind: "daemon-pattern", reason: "machine leader / Host lease pattern is out of scope" });
				}
			}
			if (/src\/tui\//u.test(source)) {
				violations.push({ file: relativeFile, kind: "tui-import", reason: "session runtime must stay TUI-free" });
			}
			const isCompositionModule = RUNTIME_COMPOSITION_ALLOWLIST.some((root) => relativeFile.startsWith(root));
			if (!isCompositionModule) {
				for (const pattern of DIRECT_CONTROLLER_PATTERNS) {
					if (pattern.test(source)) {
						violations.push({ file: relativeFile, kind: "direct-controller", reason: "only SessionRuntime may compose the controller; Client must use the server facade" });
					}
				}
			}
			continue;
		}

		if (isLegacyHostInternal(relativeFile)) continue;
		if (!hasLegacyHostImport(relativeFile, source)) continue;
		if (!R0_FROZEN_LEGACY_CONSUMER_ALLOWLIST.includes(relativeFile)) {
			violations.push({
				file: relativeFile,
				kind: "legacy-host-consumer",
				reason: "new production consumer of legacy Host is frozen at R0; migrate to session owner",
			});
		}
	}
	return violations.sort(
		(left, right) => left.file.localeCompare(right.file) || left.kind.localeCompare(right.kind),
	);
}

function run(): void {
	const repoRoot = resolve(process.argv[2] ?? new URL("..", import.meta.url).pathname);
	const violations = scanSessionOwnerBoundaries(repoRoot);
	if (violations.length > 0) {
		for (const violation of violations) {
			console.error(`${violation.file}: ${violation.kind}: ${violation.reason}`);
		}
		process.exitCode = 1;
		return;
	}
	console.log("session owner boundary check passed");
}

if (process.argv[1]?.endsWith("check-session-owner-boundaries.ts")) {
	run();
}
