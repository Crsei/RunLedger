import { describe, expect, it, vi } from "vitest";
import { createGovernedLinterFactories, createGovernedLspSpawner, createGovernedLspWriteOperations } from "../../../src/runtime/session-runtime/lsp-composition.ts";
import type { FileSystem } from "../../../src/runtime/execution-env.ts";
import type { ExecutionHandleRef, ManagedProcessSummary } from "../../../src/runtime/process/types.ts";
import type { OutputCursor } from "../../../src/runtime/process/output.ts";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

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
	requestDigest: { algorithm: "sha256", digest: "a".repeat(64) },
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
				evidenceRef: { subjectKind: "content", digest: { algorithm: "sha256", digest: "b".repeat(64) } },
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
			receiptDigest: { algorithm: "sha256" as const, digest: "c".repeat(64) },
			summary: processSummary("running"),
		};
	}

	async stop(_handle: ExecutionHandleRef, _actor: "driver" | "observer", signal: NodeJS.Signals = "SIGTERM") {
		this.stops.push(signal);
		return {
			ok: true as const,
			operation: "stop" as const,
			receiptDigest: { algorithm: "sha256" as const, digest: "d".repeat(64) },
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
		expect(process.starts[0]?.command).toBe("'/opt/lsp server/bin/lsp' '--stdio' 'safe value' 2>/dev/null");
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
