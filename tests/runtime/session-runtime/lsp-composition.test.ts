import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { describe, expect, it, vi } from "vitest";
import { createGovernedLinterFactories, createGovernedLspSpawner, createGovernedLspWriteOperations } from "../../../src/runtime/session-runtime/lsp-composition.ts";
import type { FileSystem } from "../../../src/runtime/execution-env.ts";
import type { ExecutionHandleRef, ManagedProcessSummary } from "../../../src/runtime/process/types.ts";
import type { OutputCursor, ProcessOutputStream } from "../../../src/runtime/process/output.ts";
import type { ControlPlaneOutputResult, ControlPlaneWaitResult } from "../../../src/storage/process/control-plane.ts";
import { createSdkMcpClientFactory } from "../../../src/extensions/mcp/sdk-factory.ts";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { StderrDiagnostics } from "../../../src/runtime/process/stderr-diagnostics.ts";

const executionHandle: ExecutionHandleRef = {
	authorityId: "authority_lsp" as ExecutionHandleRef["authorityId"],
	tenantId: "tenant_lsp" as ExecutionHandleRef["tenantId"],
	workspaceId: "workspace_lsp" as ExecutionHandleRef["workspaceId"],
	sessionId: "session_lsp" as ExecutionHandleRef["sessionId"],
	hostGeneration: 1,
	sessionGeneration: 1,
	executionId: "execution_lsp" as ExecutionHandleRef["executionId"],
	attemptId: "attempt_lsp" as ExecutionHandleRef["attemptId"],
	revision: 1,
	requestDigest: runtimeDigest("a"),
};

function processSummary(state: "running" | "completed" | "killed"): ManagedProcessSummary {
	return {
		handle: executionHandle,
		state,
		outputCursor: { sequence: 0, byteOffset: 0 },
		outputSize: 0,
		capabilities: {
			canWrite: state === "running",
			canEof: false,
			canResize: false,
			canStop: state === "running",
			canReadOutput: true,
		},
		...(state === "running" ? {} : {
			terminal: {
				state,
				...(state === "completed" ? { exitCode: 0 } : {}),
				evidenceRef: { subjectKind: "content", digest: runtimeDigest("b") },
			},
		}),
	};
}

class FakeManagedLspProcess {
	readonly starts: Array<{ command: string; cwd: string; timeoutMs: number; signal?: AbortSignal }> = [];
	readonly writes: string[] = [];
	readonly stops: NodeJS.Signals[] = [];

	async start(input: { command: string; cwd: string; timeoutMs: number; signal?: AbortSignal }) {
		this.starts.push(input);
		return { ok: true as const, handle: executionHandle, summary: { state: "running" } };
	}

	async processOutput(_handle: ExecutionHandleRef, cursor: OutputCursor) {
		return {
			ok: true as const,
			page: {
				handle: executionHandle,
				startCursor: cursor,
				endCursor: cursor,
				nextCursor: cursor,
				text: "",
				truncated: false,
			},
			head: cursor,
		};
	}

	async processWait() {
		return {
			ok: true as const,
			outcome: "terminal" as const,
			summary: processSummary("completed"),
			nextCursor: { sequence: 0, byteOffset: 0 },
		};
	}

	async write(_handle: ExecutionHandleRef, _actor: "driver" | "observer", input: string) {
		this.writes.push(input);
		return {
			ok: true as const,
			operation: "write" as const,
			receiptDigest: runtimeDigest("c"),
			summary: processSummary("running"),
		};
	}

	async stop(_handle: ExecutionHandleRef, _actor: "driver" | "observer", signal: NodeJS.Signals = "SIGTERM") {
		this.stops.push(signal);
		return {
			ok: true as const,
			operation: "stop" as const,
			receiptDigest: runtimeDigest("d"),
			summary: processSummary("killed"),
		};
	}

	async resize() {
		return { ok: false as const, code: "mutation_rejected" as const };
	}
}

const memoryFs: FileSystem = {
	readFile: async () => Buffer.from("x"),
	writeFile: async () => undefined,
	stat: async () => ({ size: 0, mtimeMs: 0, isFile: true, isDirectory: false }),
	readdir: async () => [],
	mkdir: async () => undefined,
	rm: async () => undefined,
	rename: async () => undefined,
};

describe("lsp-composition", () => {
	it.each(["lsp", "mcp"])("lets %s stdout progress when stderr never catches up with its moving head", async (protocol) => {
		const base = new FakeManagedLspProcess();
		let stderrPages = 0;
		let stdoutReads = 0;
		let stderrPagesBeforeStdout: number | undefined;
		let stopped = false;
		let head: OutputCursor = { sequence: 0, byteOffset: 0 };
		let stdout = protocol === "lsp" ? "Content-Length: 2\r\n\r\n{}" : "";
		const port = {
			start: base.start.bind(base),
			resize: base.resize.bind(base),
			stop: async () => { stopped = true; return base.stop(executionHandle, "driver", "SIGTERM"); },
			write: async (handle: ExecutionHandleRef, actor: "driver" | "observer", text: string) => {
				const message = JSON.parse(text) as { id?: unknown; method?: string };
				if (message.method === "initialize") stdout += JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "bounded-fixture", version: "1" } } }) + "\n";
				return base.write(handle, actor, text);
			},
			processWait: async (): Promise<ControlPlaneWaitResult> => {
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
				return { ok: true, outcome: stopped || protocol === "lsp" ? "terminal" : "timed_out", summary: processSummary(stopped || protocol === "lsp" ? "completed" : "running"), nextCursor: head };
			},
			processOutput: async (_handle: ExecutionHandleRef, cursor: OutputCursor, _maxBytes: number, stream?: ProcessOutputStream): Promise<ControlPlaneOutputResult> => {
				let text = "";
				if (stream === "stderr") {
					stderrPages += 1;
					// 有限 watchdog 代替真正无限输出，避免错误实现锁死测试 runner。
					if (stderrPages > 32) throw new Error("stderr pump monopolized the output reader");
					text = "continuous diagnostic\n";
				} else {
					stdoutReads += 1;
					stderrPagesBeforeStdout ??= stderrPages;
					text = stdout;
					stdout = "";
				}
				head = { sequence: head.sequence + 1, byteOffset: head.byteOffset + Buffer.byteLength(text) };
				return { ok: true, page: { handle: executionHandle, startCursor: cursor, endCursor: head, nextCursor: head, text, truncated: stream === "stderr" }, head: { sequence: head.sequence + 1, byteOffset: head.byteOffset + 1 } };
			},
		};
		if (protocol === "lsp") {
			const transport = await createGovernedLspSpawner(port).spawn("/fixture/lsp", [], "/workspace");
			expect(await new Response(transport.stdout).text()).toBe("Content-Length: 2\r\n\r\n{}");
			expect(await transport.exited).toBe(0);
		} else {
			const factory = createSdkMcpClientFactory({ managedProcess: port, managedProcessCwd: "/workspace" });
			const client = await factory.connect({ serverId: "mcp-server:bounded", displayName: "bounded", transport: "stdio", enabled: true, trusted: true, required: true, startupTimeoutMs: 1000, toolTimeoutMs: 1000, stdio: { command: "/fixture/mcp" } });
			await client.close();
		}
		expect(stdoutReads).toBeGreaterThan(0);
		expect(stderrPagesBeforeStdout).toBeLessThanOrEqual(4);
	});

	it.each(["'", '"'])("redacts the complete %s-quoted credential across chunks", (quote) => {
		const diagnostics = new StderrDiagnostics();
		diagnostics.append(`password=${quote}first `);
		expect(diagnostics.peek()).not.toContain("first");
		diagnostics.append(`second${quote}\napi_key=${quote}alpha ${quote === '"' ? '\\"' : "\\'"}beta`);
		expect(diagnostics.peek()).not.toContain("second");
		expect(diagnostics.peek()).not.toContain("beta");
		diagnostics.append(`${quote} status=failed\n`);
		expect(diagnostics.peek()).toBe(`password=${quote}[REDACTED]${quote}\napi_key=${quote}[REDACTED]${quote} status=failed\n`);
	});

	it("bounds and sanitizes diagnostic lines across chunks without exposing a truncated credential suffix", () => {
		const diagnostics = new StderrDiagnostics();
		diagnostics.append("\u001b[31mBearer top");
		diagnostics.append("secret\u001b[0m\napi_key='split-");
		diagnostics.append("secret'\n");
		expect(diagnostics.peek()).toBe("Bearer [REDACTED]\napi_key='[REDACTED]'\n");
		diagnostics.append("token=" + "s".repeat(10_000));
		diagnostics.append("private-suffix\n");
		expect(diagnostics.peek()).not.toContain("private-suffix");
		expect(diagnostics.peek()).toContain("[diagnostic line truncated]");
		diagnostics.append("final: missing module 世界\n".repeat(1000));
		expect(diagnostics.peek()).not.toContain("sssss");
		expect(Buffer.byteLength(diagnostics.peek())).toBeLessThanOrEqual(8192);
		expect(diagnostics.peek()).not.toContain("�");
		expect(diagnostics.peek()).toContain("final: missing module 世界");
	});

	it("Biome/SwiftLint factory 通过 Session managed foreground process", async () => {
		const calls: Array<{ command: string; cwd: string; signal?: AbortSignal; maxOutputChars?: number }> = [];
		const managed = {
			exec: async (input: { command: string; cwd: string; timeoutMs: number; signal?: AbortSignal; maxOutputChars?: number }) => {
				calls.push(input);
				return {
					stdout: JSON.stringify({ diagnostics: [{ severity: "warning", description: "managed", location: { span: [0, 1] } }] }),
					stderr: "",
					exitCode: 1,
				};
			},
		};
		const factories = createGovernedLinterFactories(managed, memoryFs);
		const controller = new AbortController();
		const client = factories.biome({ command: "biome", resolvedCommand: "/opt/biome bin", fileTypes: [".ts"], rootMarkers: [] }, "/workspace");
		const diagnostics = await client.lint("/workspace/a.ts", controller.signal);
		expect(diagnostics[0]?.message).toBe("managed");
		expect(calls[0]).toMatchObject({
			command: "'/opt/biome bin' 'lint' '--reporter=json' 'a.ts'",
			cwd: "/workspace",
			signal: controller.signal,
			maxOutputChars: 1024 * 1024,
		});
	});

	it("WorkspaceEdit rename 只委托 governed FileSystem", async () => {
		const calls: string[] = [];
		const fileSystem: FileSystem = {
			...memoryFs,
			rename: async (from, to) => { calls.push(`${from}->${to}`); },
		};
		const ops = createGovernedLspWriteOperations(fileSystem);
		await ops.renameFile("/workspace/old.ts", "/workspace/new.ts");
		expect(calls).toEqual(["/workspace/old.ts->/workspace/new.ts"]);
	});

	it("生产 domain 把 managed process 与 Session scope 注入 LSP", async () => {
		const domainPath = fileURLToPath(new URL("../../../src/runtime/session-runtime/domain.ts", import.meta.url));
		const source = await readFile(domainPath, "utf8");
		expect(source).toContain("spawn: createGovernedLspSpawner(process.toolClient())");
		expect(source).toContain("scope: sessionId");
		expect(source).toContain("linterFactories: createGovernedLinterFactories(process.toolClient(), executionEnv.fs)");
		expect(source).toContain("await shutdownAll(sessionId)");
		expect(source).not.toContain("attachLspSessionCleanup()");
	});

	it("通过 Session managed process 启动，动作 abort 不终止缓存进程", async () => {
		const process = new FakeManagedLspProcess();
		const controller = new AbortController();
		const transport = await createGovernedLspSpawner(process).spawn(
			"/opt/lsp server/bin/lsp",
			["--stdio", "safe value"],
			"/workspace",
			controller.signal,
		);

		expect(process.starts).toHaveLength(1);
		expect(process.starts[0]).toMatchObject({ cwd: "/workspace" });
		expect(process.starts[0]?.command).toBe("'/opt/lsp server/bin/lsp' '--stdio' 'safe value'");
		expect(process.starts[0]?.signal).toBeUndefined();

		await transport.stdin.write("Content-Length: 2\r\n\r\n{}");
		expect(process.writes).toEqual(["Content-Length: 2\r\n\r\n{}"]);

		controller.abort();
		await Promise.resolve();
		expect(process.stops).toEqual([]);

		transport.kill();
		await vi.waitFor(() => expect(process.stops).toContain("SIGTERM"));
	});

	it("write 失败保留 governed FileSystem 错误", async () => {
		const failing: FileSystem = { ...memoryFs, writeFile: async () => { throw new Error("disk full"); } };
		const ops = createGovernedLspWriteOperations(failing);
		await expect(ops.writeFile("/a.ts", "x")).rejects.toThrow("disk full");
	});
});
