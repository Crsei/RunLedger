/**
 * 进程边界测试：真实 host 子进程的存活/崩溃语义。
 *
 * 进程创建仍然经过 `ExtensionHostSupervisor` 的受注入 process port：本文件
 * 只把该 port 换成 `node:child_process` 的实现，协议、握手、注册表校验、
 * 失败收敛与回收路径全部是生产代码。它不是生产闭环证据——governed
 * managed process 的真实接线与 `dist` 产物由 `npm run build` 与 P7 的
 * 真实 `runledger` smoke 覆盖。
 *
 * 这一组用例固定 P1 的核心 RED：扩展的裸 timer 抛错只能让该 generation
 * failed，不能拆掉 owner/session（与 omp 的进程内 import 相反）。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import type { ExecutionHandleRef, ManagedProcessSummary, ProcessState, ProcessTerminalState } from "../../../src/runtime/process/types.ts";
import type { OutputCursor } from "../../../src/runtime/process/output.ts";
import type { ControlPlaneMutationResult, ControlPlaneOutputResult, ControlPlaneWaitResult } from "../../../src/storage/process/control-plane.ts";
import { ExtensionHostSupervisor } from "../../../src/extensions/host/supervisor.ts";
import type { ExtensionHostManagedProcessPort } from "../../../src/extensions/host/channel.ts";
import { EXTENSION_DEFAULT_HOST_LIMITS } from "../../../src/contracts/extensions/registry.ts";
import type { ExtensionHostBootstrap } from "../../../src/extensions/host/bootstrap.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const fixtureRoot = join(repoRoot, "tests", "fixtures", "extensions", "host");
const distEntry = join(repoRoot, "dist", "extensions", "host", "entry.js");
const srcEntry = join(repoRoot, "src", "extensions", "host", "entry.ts");
const useDist = existsSync(distEntry);

interface SpawnEntry {
	readonly child: ReturnType<typeof spawn>;
	stdout: string;
	stderr: string;
	exited: boolean;
	exitCode: number | null;
	cursor: { sequence: number; byteOffset: number };
}

function handle(executionId: string): ExecutionHandleRef {
	return {
		authorityId: "authority_test" as ExecutionHandleRef["authorityId"],
		tenantId: "tenant_test" as ExecutionHandleRef["tenantId"],
		workspaceId: "workspace_test" as ExecutionHandleRef["workspaceId"],
		sessionId: "session_test" as ExecutionHandleRef["sessionId"],
		hostGeneration: 1,
		sessionGeneration: 1,
		executionId: executionId as ExecutionHandleRef["executionId"],
		attemptId: "attempt_test" as ExecutionHandleRef["attemptId"],
		revision: 1,
		requestDigest: runtimeDigest("extension-host-process-test"),
	};
}

function summary(entry: SpawnEntry, state: ProcessState): ManagedProcessSummary {
	return {
		handle: handle("summary"),
		state,
		outputCursor: { sequence: entry.cursor.sequence, byteOffset: entry.cursor.byteOffset },
		outputSize: Buffer.byteLength(entry.stdout, "utf8"),
		capabilities: { canWrite: true, canEof: true, canResize: false, canStop: true, canReadOutput: true },
		...(entry.exited
			? {
					terminal: {
						state: state as ProcessTerminalState,
						...(entry.exitCode === null ? {} : { exitCode: entry.exitCode }),
						evidenceRef: { subjectKind: "content", digest: runtimeDigest(`${entry.cursor.byteOffset}`) },
					},
				}
			: {}),
	};
}

/** 测试用 process port：只替换“如何启动进程”，其余仍走 supervisor/channel/client。 */
class SpawnManagedProcess implements ExtensionHostManagedProcessPort {
	readonly #entries = new Map<string, SpawnEntry>();
	#sequence = 0;

	public exited(): number {
		let count = 0;
		for (const entry of this.#entries.values()) if (entry.exited) count += 1;
		return count;
	}

	public async start(input: { readonly command: string; readonly cwd: string; readonly timeoutMs: number }): Promise<{ readonly ok: true; readonly handle: ExecutionHandleRef; readonly summary: { readonly state: string } }> {
		this.#sequence += 1;
		const executionId = `execution-${this.#sequence}`;
		const child = spawn("/bin/sh", ["-c", input.command], { cwd: input.cwd, stdio: ["pipe", "pipe", "pipe"] });
		const entry: SpawnEntry = { child, stdout: "", stderr: "", exited: false, exitCode: null, cursor: { sequence: 0, byteOffset: 0 } };
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => { entry.stdout += chunk; });
		child.stderr?.on("data", (chunk: string) => { entry.stderr += chunk; });
		child.on("close", (code) => { entry.exited = true; entry.exitCode = code; });
		this.#entries.set(executionId, entry);
		return { ok: true, handle: handle(executionId), summary: { state: "running" } };
	}

	#entry(target: ExecutionHandleRef): SpawnEntry {
		const entry = this.#entries.get(target.executionId);
		if (entry === undefined) throw new Error(`unknown execution handle: ${target.executionId}`);
		return entry;
	}

	public async processOutput(target: ExecutionHandleRef, cursor: OutputCursor, maxBytes: number, stream = "stdout"): Promise<ControlPlaneOutputResult> {
		const entry = this.#entry(target);
		const buffer = stream === "stderr" ? entry.stderr : entry.stdout;
		// 夹具输出全是 ASCII，因此 UTF-16 偏移与 UTF-8 字节偏移一致。
		const text = buffer.slice(cursor.byteOffset, cursor.byteOffset + maxBytes);
		const next: OutputCursor = { sequence: cursor.sequence + 1, byteOffset: cursor.byteOffset + text.length };
		entry.cursor.sequence = next.sequence;
		entry.cursor.byteOffset = Math.max(entry.cursor.byteOffset, next.byteOffset);
		return { ok: true, page: { handle: target, startCursor: cursor, endCursor: next, nextCursor: next, text, truncated: false }, head: next };
	}

	public async processWait(target: ExecutionHandleRef, timeoutMs: number, _actor: "driver" | "observer"): Promise<ControlPlaneWaitResult> {
		const entry = this.#entry(target);
		const deadline = Date.now() + Math.min(timeoutMs, 200);
		while (!entry.exited && Date.now() < deadline) await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
		if (entry.exited) {
			return {
				ok: true,
				outcome: "terminal",
				summary: summary(entry, entry.exitCode === 0 ? "completed" : "failed"),
				nextCursor: { sequence: entry.cursor.sequence, byteOffset: entry.cursor.byteOffset },
			};
		}
		return { ok: true, outcome: "running", summary: summary(entry, "running"), nextCursor: { sequence: entry.cursor.sequence, byteOffset: entry.cursor.byteOffset } };
	}

	public async write(target: ExecutionHandleRef, _actor: "driver" | "observer", input: string): Promise<ControlPlaneMutationResult> {
		const entry = this.#entry(target);
		if (entry.exited) return { ok: false, code: "process_not_found" };
		entry.child.stdin?.write(input);
		return { ok: true, operation: "write", receiptDigest: runtimeDigest(input), summary: summary(entry, "running") };
	}

	public async stop(target: ExecutionHandleRef, _actor: "driver" | "observer", signal: NodeJS.Signals = "SIGTERM"): Promise<ControlPlaneMutationResult> {
		const entry = this.#entry(target);
		entry.child.kill(signal);
		return { ok: true, operation: "stop", receiptDigest: runtimeDigest(signal), summary: summary(entry, "killed") };
	}

	public async resize(): Promise<ControlPlaneMutationResult> {
		return { ok: false, code: "mutation_rejected" };
	}
}

function bootstrapFor(entrypointFile: string): ExtensionHostBootstrap {
	return {
		packageId: "fixture-plugin@local",
		digest: "e".repeat(64),
		generation: 1,
		apiVersion: "1.0.0",
		limits: EXTENSION_DEFAULT_HOST_LIMITS,
		rootPath: fixtureRoot,
		entrypoint: join(fixtureRoot, entrypointFile),
	};
}

function createSupervisor(port: SpawnManagedProcess, audits: string[]) {
	return new ExtensionHostSupervisor({
		managedProcess: port,
		startCommand: {
			runtimeCommand: process.execPath,
			runtimeArgs: useDist ? [] : ["--no-warnings", "--experimental-strip-types"],
			hostEntrypoint: useDist ? distEntry : srcEntry,
		},
		apiVersion: "1.0.0",
		actionHandler: async () => ({ ok: true }),
		audit: async (event) => { audits.push(event.eventType); },
	});
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise<void>((resolve) => { setTimeout(resolve, 20); });
	}
	throw new Error("condition timed out");
}

describe("extension host process boundary", () => {
	it("starts a real host process, completes the handshake and reaps it on stop", async () => {
		const port = new SpawnManagedProcess();
		const audits: string[] = [];
		const supervisor = createSupervisor(port, audits);
		const status = await supervisor.start({
			generation: 1,
			packageId: "fixture-plugin@local",
			digest: "e".repeat(64),
			rootPath: fixtureRoot,
			entrypoint: bootstrapFor("empty-extension.ts").entrypoint,
		});
		expect(status.status).toBe("ready");
		if (status.status === "ready") {
			expect(status.hostPid).toBeGreaterThan(0);
			const client = supervisor.client();
			if (client === undefined) throw new Error("ready supervisor must expose a client");
			const state = client.state();
			if (state.status !== "ready") throw new Error("client must be ready");
			expect(state.registry.tools).toEqual([]);
		}
		expect(audits).toContain("extension.host.started");
		await supervisor.stop("owner-request");
		await waitForCondition(() => port.exited() > 0);
		expect(supervisor.status()).toEqual({ status: "stopped", generation: 1, reason: "owner-request" });
		expect(audits).toContain("extension.host.stopped");
	}, 30_000);

	it("keeps the session alive when the extension factory throws in the host process", async () => {
		const port = new SpawnManagedProcess();
		const audits: string[] = [];
		const supervisor = createSupervisor(port, audits);
		const status = await supervisor.start({
			generation: 2,
			packageId: "fixture-plugin@local",
			digest: "e".repeat(64),
			rootPath: fixtureRoot,
			entrypoint: bootstrapFor("throwing-factory-extension.ts").entrypoint,
		});
		expect(status.status).toBe("failed");
		if (status.status === "failed") {
			expect(status.code).toBe("extension_factory_failed");
			expect(status.generation).toBe(2);
		}
		expect(audits).toContain("extension.host.failed");
		expect(supervisor.activeGeneration()).toBeUndefined();
		// owner 仍然可用：随后启动一个健康 generation 必须成功。
		const recovered = await supervisor.start({
			generation: 3,
			packageId: "fixture-plugin@local",
			digest: "e".repeat(64),
			rootPath: fixtureRoot,
			entrypoint: bootstrapFor("empty-extension.ts").entrypoint,
		});
		expect(recovered.status).toBe("ready");
		await supervisor.stop("owner-request");
	}, 30_000);

	it("fails only the generation when an extension leaves a throwing bare timer", async () => {
		const port = new SpawnManagedProcess();
		const audits: string[] = [];
		const supervisor = createSupervisor(port, audits);
		const status = await supervisor.start({
			generation: 4,
			packageId: "fixture-plugin@local",
			digest: "e".repeat(64),
			rootPath: fixtureRoot,
			entrypoint: bootstrapFor("timer-crash-extension.ts").entrypoint,
		});
		expect(status.status).toBe("ready");
		await waitForCondition(() => port.exited() > 0);
		await waitForCondition(() => supervisor.status().status === "failed", 5_000).catch(async () => { await supervisor.reconcile(); });
		await supervisor.reconcile();
		const failed = supervisor.status();
		expect(failed.status).toBe("failed");
		if (failed.status === "failed") {
			expect(failed.generation).toBe(4);
			expect(failed.retainedGeneration).toBe(4);
		}
		expect(audits).toContain("extension.host.failed");
		// session 存活证据：进程边界测试文件本身没有因为 host 崩溃而失败，
		// 且可以继续启动新 generation。
		const recovered = await supervisor.start({
			generation: 5,
			packageId: "fixture-plugin@local",
			digest: "e".repeat(64),
			rootPath: fixtureRoot,
			entrypoint: bootstrapFor("empty-extension.ts").entrypoint,
		});
		expect(recovered.status).toBe("ready");
		await supervisor.stop("owner-request");
	}, 30_000);

	it("projects the real host registry back to the owner", async () => {
		const port = new SpawnManagedProcess();
		const supervisor = createSupervisor(port, []);
		const status = await supervisor.start({
			generation: 6,
			packageId: "fixture-plugin@local",
			digest: "e".repeat(64),
			rootPath: fixtureRoot,
			entrypoint: bootstrapFor("registrations-extension.ts").entrypoint,
		});
		expect(status.status).toBe("ready");
		const client = supervisor.client();
		if (client === undefined) throw new Error("ready supervisor must expose a client");
		const state = client.state();
		if (state.status !== "ready") throw new Error("client must be ready");
		expect(state.registry.tools.map((tool) => tool.name)).toEqual(["fixture_echo"]);
		expect(state.registry.tools[0]?.approvalClass).toBe("read-only");
		expect(state.registry.commands.map((command) => command.name)).toEqual(["fixture_command"]);
		expect(state.registry.flags.map((flag) => flag.name)).toEqual(["fixture-flag"]);
		expect(state.registry.subscriptions).toEqual([{ name: "PreToolUse" }]);
		const outcome = await supervisor.dispatchEvent({ name: "PreToolUse", cancelable: true, payload: { toolName: "fixture_echo" }, deadlineMs: 1_000 });
		expect(outcome).toEqual({ ok: true, value: { allow: true } });
		await supervisor.stop("owner-request");
	}, 30_000);
});
