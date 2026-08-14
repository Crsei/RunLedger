/** stdlib tool normalized args -> AccessRequest[] 的单一分类器。 */

import type { AccessRequest, SecurityResult } from "../types.ts";
import { analyzeShellCommand } from "./shell-analyzer.ts";
import type {
	BashSecurityAnalyzerMode,
	BashSecurityAnalyzerPort,
} from "./bash-ast/types.ts";

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function failure(message: string): SecurityResult<never> {
	return { ok: false, error: { code: "invalid_request", message, retryable: false } };
}

function pathFrom(args: Readonly<Record<string, unknown>>): string | undefined {
	return text(args.path) ?? text(args.filePath) ?? text(args.directory);
}

export function resolveToolAccessRequests(
	toolName: string,
	argumentsValue: unknown,
	cwd: string,
): SecurityResult<readonly AccessRequest[]> {
	const args = record(argumentsValue);
	if (!args) return failure("tool arguments must be an object");
	if (["read", "ls", "grep", "find", "glob"].includes(toolName)) {
		return { ok: true, value: [{ kind: "filesystem", operation: "read", path: pathFrom(args) ?? cwd }] };
	}
	if (["write", "edit", "multi_edit", "multi-edit", "MultiEdit", "notebook_edit"].includes(toolName)) {
		const path = pathFrom(args);
		return path ? { ok: true, value: [{ kind: "filesystem", operation: "write", path }] } : failure(`${toolName} requires a target path`);
	}
	if (toolName === "bash") {
		const command = text(args.command) ?? text(args.cmd);
		if (!command) return failure("bash requires a command");
		return { ok: true, value: [{ kind: "shell", command, cwd, analysis: analyzeShellCommand(command).analysis }] };
	}
	if (["WebFetch", "web_fetch", "web-fetch"].includes(toolName)) {
		const url = text(args.url);
		if (!url) return failure("web fetch requires a URL");
		try {
			const parsed = new URL(url);
			const port = parsed.port ? Number(parsed.port) : undefined;
			return { ok: true, value: [{ kind: "network", operation: "fetch", host: parsed.hostname, ...(port === undefined ? {} : { port }) }] };
		} catch {
			return failure("web fetch URL is invalid");
		}
	}
	if (toolName.startsWith("worktree_")) {
		const operation = toolName.slice("worktree_".length);
		if (!(["create", "remove", "apply", "gc"] as const).includes(operation as "create" | "remove" | "apply" | "gc")) return failure("worktree operation is unknown");
		return { ok: true, value: [{ kind: "worktree", operation: operation as "create" | "remove" | "apply" | "gc", target: text(args.target) ?? text(args.path) ?? cwd }] };
	}
	return { ok: true, value: [{ kind: "tool", toolName }] };
}

export async function resolveToolAccessRequestsWithBashAnalyzer(
	toolName: string,
	argumentsValue: unknown,
	cwd: string,
	mode: BashSecurityAnalyzerMode,
	analyzer: BashSecurityAnalyzerPort,
): Promise<SecurityResult<readonly AccessRequest[]>> {
	if (toolName !== "bash") return resolveToolAccessRequests(toolName, argumentsValue, cwd);
	const args = record(argumentsValue);
	if (!args) return failure("tool arguments must be an object");
	const command = text(args.command) ?? text(args.cmd);
	if (!command) return failure("bash requires a command");
	let analysis;
	try {
		analysis = await analyzer.analyze(command, mode);
	} catch {
		analysis = mode === "legacy"
			? { mode, legacyKind: "unknown" as const }
			: {
					mode,
					ast: {
						kind: "parse-unavailable" as const,
						reasonCode: "bash_analyzer_failure",
					},
				};
	}
	const shell: AccessRequest = {
		kind: "shell",
		command,
		cwd,
		analysis: analysis.mode === "ast"
			? analysis.ast?.kind === "simple" ? "known" : "unknown"
			: analysis.legacyKind ?? "unknown",
		bashAnalyzerMode: analysis.mode,
		...(analysis.ast === undefined ? {} : { bashAst: analysis.ast }),
		...(analysis.metrics === undefined ? {} : { bashMetrics: analysis.metrics }),
	};
	if (analysis.mode !== "ast" || analysis.ast?.kind !== "simple") {
		return { ok: true, value: [shell] };
	}
	const redirects: AccessRequest[] = analysis.ast.commands.flatMap((item) =>
		item.redirects.map((redirect): AccessRequest => ({
			kind: "filesystem",
			operation: redirect.operation === "read" ? "read" : "write",
			path: redirect.path,
		}))
	);
	return { ok: true, value: [shell, ...redirects] };
}
