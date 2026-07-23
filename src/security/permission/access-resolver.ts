/** stdlib tool normalized args -> AccessRequest[] 的单一分类器。 */

import { analyzeShellCommand } from "./shell-analyzer.ts";
import type { AccessRequest, BrowserAccessOperation, SecurityResult } from "../types.ts";

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Readonly<Record<string, unknown>>
		: undefined;
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

const BROWSER_OPERATIONS = new Set<BrowserAccessOperation>([
	"navigate", "dom", "script", "download", "upload", "cookie",
]);

export function resolveBrowserAccessRequests(
	operationValue: string,
	argumentsValue: unknown,
	resourceDigest: string,
): SecurityResult<readonly AccessRequest[]> {
	const args = record(argumentsValue);
	if (!args) return failure("browser arguments must be an object");
	const operation = BROWSER_OPERATIONS.has(operationValue as BrowserAccessOperation)
		? operationValue as BrowserAccessOperation
		: "unknown";
	const requests: AccessRequest[] = [{ kind: "browser", operation, resourceDigest }];
	if (["navigate", "download", "upload"].includes(operation)) {
		const url = text(args.url);
		if (!url) return failure(`browser ${operation} requires a URL`);
		try {
			const parsed = new URL(url);
			requests.push({ kind: "network", operation: "connect", host: parsed.hostname, ...(parsed.port ? { port: Number(parsed.port) } : {}) });
		} catch {
			return failure(`browser ${operation} URL is invalid`);
		}
	}
	if (operation === "download") {
		const path = pathFrom(args);
		if (!path) return failure("browser download requires a target path");
		requests.push({ kind: "filesystem", operation: "write", path });
	}
	if (operation === "upload") {
		const path = pathFrom(args);
		if (!path) return failure("browser upload requires a source path");
		requests.push({ kind: "filesystem", operation: "read", path });
	}
	if (operation === "cookie") {
		requests.push({
			kind: "credential",
			operation: "resolve",
			credentialKind: "browser-cookie",
			audience: text(args.origin) ?? text(args.url) ?? "unknown-origin",
		});
	}
	return { ok: true, value: requests };
}

export function resolveToolAccessRequests(
	toolName: string,
	argumentsValue: unknown,
	cwd: string,
): SecurityResult<readonly AccessRequest[]> {
	const args = record(argumentsValue);
	if (!args) return failure("tool arguments must be an object");
	if (["read", "ls", "grep", "find", "glob"].includes(toolName)) {
		const path = pathFrom(args) ?? cwd;
		return { ok: true, value: [{ kind: "filesystem", operation: "read", path }] };
	}
	if (["write", "edit", "multi_edit", "multi-edit", "notebook_edit"].includes(toolName)) {
		const path = pathFrom(args);
		return path
			? { ok: true, value: [{ kind: "filesystem", operation: "write", path }] }
			: failure(`${toolName} requires a target path`);
	}
	if (toolName === "bash") {
		const command = text(args.command) ?? text(args.cmd);
		if (!command) return failure("bash requires a command");
		const analysis = analyzeShellCommand(command);
		return { ok: true, value: [{ kind: "shell", command, cwd, analysis: analysis.analysis }] };
	}
	if (toolName === "web_fetch" || toolName === "web-fetch") {
		const url = text(args.url);
		if (!url) return failure("web fetch requires a URL");
		try {
			const parsed = new URL(url);
			return { ok: true, value: [{ kind: "network", operation: "fetch", host: parsed.hostname, ...(parsed.port ? { port: Number(parsed.port) } : {}) }] };
		} catch {
			return failure("web fetch URL is invalid");
		}
	}
	if (toolName.startsWith("worktree_")) {
		const operation = toolName.slice("worktree_".length);
		if (!["create", "remove", "apply", "gc"].includes(operation)) return failure("worktree operation is unknown");
		return {
			ok: true,
			value: [{
				kind: "worktree",
				operation: operation as "create" | "remove" | "apply" | "gc",
				target: text(args.target) ?? text(args.path) ?? cwd,
			}],
		};
	}
	return { ok: true, value: [{ kind: "tool", toolName }] };
}
