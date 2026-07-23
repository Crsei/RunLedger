import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, realpath, rename, rm, stat, lstat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { canonicalDigest } from "../../src/runtime/protocol/v3/canonical-json.ts";
import { createRuntimeId } from "../../src/runtime/protocol/v3/ids.ts";
import type { HookCommandExecution, HookCommandExecutorPort, HookCommandRequest } from "../../src/extensions/hooks/types.ts";
import type {
	McpAuxiliaryAuthorizationPort,
	McpAuxiliaryAuthorizationReceipt,
	McpOperationAuthorizationPort,
	McpOperationAuthorizationReceipt,
	McpStateEventSinkPort,
} from "../../src/extensions/mcp/connection-manager.ts";
import type { McpServerDescriptor, McpToolDefinition } from "../../src/extensions/mcp/types.ts";
import type { ExtensionStoragePort, ExtensionStorageResult } from "../../src/extensions/storage-port.ts";

export const TEST_SCOPE = Object.freeze({
	authorityId: createRuntimeId("authority", "extensions-test"),
	tenantId: createRuntimeId("tenant", "extensions-test"),
	principalId: createRuntimeId("principal", "extensions-test"),
});

export async function makeExtensionTempDir(label: string): Promise<string> {
	return mkdtemp(join(tmpdir(), `runledger-${label}-`));
}

export async function removeExtensionTempDir(path: string): Promise<void> {
	await rm(path, { recursive: true, force: true });
}

function storageError(error: unknown): ExtensionStorageResult<never> {
	const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
	if (code === "ENOENT") return { ok: false, code: "missing", message: "path is missing" };
	if (code === "EACCES" || code === "EPERM") return { ok: false, code: "denied", message: "path access denied" };
	return { ok: false, code: "io", message: error instanceof Error ? error.message : "storage operation failed" };
}

export class NodeTestExtensionStorage implements ExtensionStoragePort {
	public async realpath(path: string) {
		try {
			return { ok: true as const, value: await realpath(path) };
		} catch (error) {
			return storageError(error);
		}
	}

	public async stat(path: string, options?: { followSymlinks?: boolean }) {
		try {
			const value = options?.followSymlinks === false ? await lstat(path) : await stat(path);
			const kind = value.isFile() ? "file" as const : value.isDirectory() ? "directory" as const : value.isSymbolicLink() ? "symlink" as const : "other" as const;
			return { ok: true as const, value: { kind, size: value.size } };
		} catch (error) {
			return storageError(error);
		}
	}

	public async readDirectory(path: string) {
		try {
			const entries = await readdir(path, { withFileTypes: true });
			return {
				ok: true as const,
				value: entries.map((entry) => ({
					name: entry.name,
					kind: entry.isFile() ? "file" as const : entry.isDirectory() ? "directory" as const : entry.isSymbolicLink() ? "symlink" as const : "other" as const,
				})),
			};
		} catch (error) {
			return storageError(error);
		}
	}

	public async readFile(path: string, maxBytes: number) {
		try {
			const info = await stat(path);
			if (info.size > maxBytes) return { ok: false as const, code: "oversize" as const, message: "file exceeds byte bound" };
			const value = await readFile(path);
			if (value.byteLength > maxBytes) return { ok: false as const, code: "oversize" as const, message: "file exceeds byte bound" };
			return { ok: true as const, value };
		} catch (error) {
			return storageError(error);
		}
	}

	public async writeFileAtomic(path: string, bytes: Uint8Array, options: { fileMode: 0o600; directoryMode: 0o700 }) {
		const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
		try {
			await mkdir(dirname(path), { recursive: true, mode: options.directoryMode });
			await writeFile(temporary, bytes, { mode: options.fileMode });
			await rename(temporary, path);
			return { ok: true as const, value: undefined };
		} catch (error) {
			await rm(temporary, { force: true }).catch(() => undefined);
			return storageError(error);
		}
	}
}

export class NodeTestHookExecutor implements HookCommandExecutorPort {
	public async execute(request: HookCommandRequest, signal?: AbortSignal): Promise<HookCommandExecution> {
		const startedAt = Date.now();
		return new Promise((resolve) => {
			let settled = false;
			let timedOut = false;
			let stdout = Buffer.alloc(0);
			let stderr = Buffer.alloc(0);
			const child = spawn(request.command, [...request.args], {
				cwd: request.cwd,
				env: { ...process.env, ...request.environment },
				stdio: ["pipe", "pipe", "pipe"],
			});
			const finish = (execution: Omit<HookCommandExecution, "durationMs">) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				resolve({ ...execution, durationMs: Date.now() - startedAt });
			};
			const abort = () => {
				child.kill("SIGKILL");
				finish({ status: "aborted", exitCode: null, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
			};
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, request.timeoutMs);
			signal?.addEventListener("abort", abort, { once: true });
			child.stdout.on("data", (chunk: Buffer) => {
				stdout = Buffer.concat([stdout, chunk]).subarray(0, request.maxStdoutBytes + 1);
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr = Buffer.concat([stderr, chunk]).subarray(0, request.maxStderrBytes + 1);
			});
			child.on("error", (error) => finish({ status: "failed", exitCode: null, stdout: stdout.toString("utf8"), stderr: error.message }));
			child.on("close", (exitCode) => finish({ status: timedOut ? "timed_out" : "completed", exitCode, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") }));
			child.stdin.end(request.stdin);
			if (signal?.aborted) abort();
		});
	}
}

export class FakeMcpAuthorization implements McpOperationAuthorizationPort, McpAuxiliaryAuthorizationPort {
	public enabled = true;
	public stale = false;

	public async authorize(
		input: { server: McpServerDescriptor; tool: McpToolDefinition; rawInput: unknown } | { server: McpServerDescriptor; operation: McpAuxiliaryAuthorizationReceipt["operation"]; request: unknown },
	): Promise<McpOperationAuthorizationReceipt | McpAuxiliaryAuthorizationReceipt | undefined> {
		if (!this.enabled) return undefined;
		const expiresAt = this.stale ? "2000-01-01T00:00:00.000Z" : "2999-01-01T00:00:00.000Z";
		if ("tool" in input) {
			return {
				receiptId: "mcp-tool-test",
				serverId: input.server.descriptor.identity.qualifiedId,
				toolName: input.tool.rawName,
				inputDigest: canonicalDigest(input.rawInput),
				configDigest: input.server.descriptor.manifest.combinedDigest,
				expiresAt,
			};
		}
		return {
			receiptId: "mcp-aux-test",
			serverId: input.server.descriptor.identity.qualifiedId,
			operation: input.operation,
			requestDigest: canonicalDigest(input.request),
			configDigest: input.server.descriptor.manifest.combinedDigest,
			expiresAt,
		};
	}
}

export class FakeMcpEventSink implements McpStateEventSinkPort {
	public durable = true;
	public readonly states: Array<Parameters<McpStateEventSinkPort["record"]>[0]> = [];
	public readonly tools: Array<Parameters<McpStateEventSinkPort["recordTool"]>[0]> = [];

	public async record(input: Parameters<McpStateEventSinkPort["record"]>[0]): Promise<boolean> {
		this.states.push(input);
		return this.durable;
	}

	public async recordTool(input: Parameters<McpStateEventSinkPort["recordTool"]>[0]): Promise<boolean> {
		this.tools.push(input);
		return this.durable;
	}
}
