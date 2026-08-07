import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IS_WINDOWS } from "../../helpers/platform.ts";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { runtimeDigest, type RuntimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import {
	createBuiltinNoneExecutionDecisionProviders,
	createExecutionConstraintReceipt,
	evaluateExecutionConstraints,
	type ExecutionConstraintInput,
	type ExecutionConstraintSnapshot,
} from "../../../src/runtime/process/execution-decision.ts";
import type { ManagedProcessRequest } from "../../../src/runtime/process/types.ts";
import {
	PipeProcessBackend,
	type PipeCommandDescriptor,
	type PipeProcessBackendOptions,
} from "../../../src/storage/process/process-backend.ts";
import { FileProcessOutputStore, type ProcessOutputSealResult } from "../../../src/storage/process/output-store.ts";

const digest = (seed: string): RuntimeDigest => ({
	algorithm: "sha256",
	digest: seed.repeat(64).slice(0, 64) as RuntimeDigest["digest"],
});

function request(): ManagedProcessRequest {
	return {
		authorityId: createRuntimeId("authority", "backend"),
		tenantId: createRuntimeId("tenant", "backend"),
		workspaceId: createRuntimeId("workspace", "backend"),
		sessionId: createRuntimeId("session", "backend"),
		hostGeneration: 1,
		sessionGeneration: 1,
		requestDigest: digest("a"),
		commandRef: { subjectKind: "content", digest: digest("command"), mediaType: "application/json", size: 1 },
		cwdRef: { subjectKind: "content", digest: digest("cwd"), mediaType: "text/plain", size: 1 },
		backend: "pipe",
		executionMode: "background",
		correlationId: createRuntimeId("command", "backend"),
	};
}

function decisionInput(value: ManagedProcessRequest): ExecutionConstraintInput {
	return {
		authorityId: value.authorityId,
		tenantId: value.tenantId,
		workspaceId: value.workspaceId,
		principalId: createRuntimeId("principal", "backend"),
		executionId: createRuntimeId("execution", "backend"),
		attemptId: createRuntimeId("attempt", "backend"),
		commandId: value.correlationId,
		requestDigest: value.requestDigest,
		policyDigest: digest("policy"),
		modes: {
			permission: "none",
			approval: "none",
			sandbox: "none",
			gateway: "none",
			containment: "none",
		},
	};
}

function executionHandle(value: ManagedProcessRequest, snapshot: ExecutionConstraintSnapshot) {
	return {
		authorityId: value.authorityId,
		tenantId: value.tenantId,
		workspaceId: value.workspaceId,
		sessionId: value.sessionId,
		hostGeneration: value.hostGeneration,
		sessionGeneration: value.sessionGeneration,
		executionId: snapshot.executionId,
		attemptId: snapshot.attemptId,
		revision: 0,
		requestDigest: value.requestDigest,
	};
}

class SealFailureOutputStore extends FileProcessOutputStore {
	public override async seal(): Promise<ProcessOutputSealResult> {
		return { ok: false, code: "output_unavailable" };
	}
}

describe("R6 governed pipe process backend", () => {
	it("runs the final-leaf gate before resolving or spawning a command", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-process-final-leaf-"));
		try {
			const value = { ...request(), correlationId: createRuntimeId("command", "final-leaf") };
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			let resolveCalls = 0;
			const backend = new PipeProcessBackend({
				resolveCommand: () => {
					resolveCalls += 1;
					return { executable: process.execPath, args: ["-e", "process.stdout.write('must-not-run')"], cwd: root };
				},
				createOutputStore: (input) => new FileProcessOutputStore({
					layout,
					workspaceStorageKey: "ws-" + "f".repeat(64),
					executionId: input.handle.executionId,
					attemptId: input.handle.attemptId,
				}),
			});
			const decision = await evaluateExecutionConstraints(decisionInput(value), createBuiltinNoneExecutionDecisionProviders());
			if (!decision.ok) throw new Error("decision failed");
			const handle = executionHandle(value, decision.snapshot);

			await expect(backend.spawn({
				handle,
				request: value,
				spawnClaimDigest: digest("final-leaf-claim"),
				constraintSnapshot: decision.snapshot,
				constraintInput: decisionInput(value),
				launchPlan: { program: process.execPath, arguments: ["-e", "process.stdout.write('must-not-run')"], cwd: root, environment: {} },
				beforeSpawn: async () => { throw new Error("final leaf denied"); },
			})).rejects.toThrow("final leaf denied");
			expect(resolveCalls).toBe(0);
			expect(backend.handles()).toEqual([]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("spawns once behind the audited barrier, streams output privately, and waits without exposing a PID", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-process-backend-"));
		try {
			const value = request();
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const command: PipeCommandDescriptor = {
				executable: process.execPath,
				args: ["-e", "process.stdout.write('hello😀\\n')"],
				cwd: root,
			};
			const options: PipeProcessBackendOptions = {
				resolveCommand: () => command,
				createOutputStore: () => new FileProcessOutputStore({
					layout,
					workspaceStorageKey: "ws-" + "a".repeat(64),
					executionId: createRuntimeId("execution", "backend"),
					attemptId: createRuntimeId("attempt", "backend"),
				}),
			};
			const backend = new PipeProcessBackend(options);
			const decision = await evaluateExecutionConstraints(decisionInput(value), createBuiltinNoneExecutionDecisionProviders());
			if (!decision.ok) throw new Error("decision failed");
			const handle = {
				authorityId: value.authorityId,
				tenantId: value.tenantId,
				workspaceId: value.workspaceId,
				sessionId: value.sessionId,
				hostGeneration: 1,
				sessionGeneration: 1,
				executionId: decision.snapshot.executionId,
				attemptId: decision.snapshot.attemptId,
				revision: 0,
				requestDigest: value.requestDigest,
			};

			const first = await backend.spawn({ handle, request: value, spawnClaimDigest: digest("claim"), constraintSnapshot: decision.snapshot, constraintInput: decisionInput(value) });
			const retried = await backend.spawn({ handle, request: value, spawnClaimDigest: digest("claim"), constraintSnapshot: decision.snapshot, constraintInput: decisionInput(value) });
			expect(first.receipt.receiptDigest).toEqual(retried.receipt.receiptDigest);
			expect(backend.handles()).toEqual([handle]);
			expect(backend.control(handle)).toBeDefined();
			expect(backend.asManagerBackend().control(handle)).toBeDefined();
			expect(JSON.stringify(first.receipt)).not.toMatch(/(?:pid|cwd|command|executable)/iu);

			const terminal = await first.process.wait(2_000);
			expect(terminal.outcome).toBe("completed");
			const output = await first.process.output.read({ sequence: 0, byteOffset: 0 }, 128);
			expect(output.ok).toBe(true);
			if (output.ok) expect(output.page.text).toBe("hello😀\n");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("decodes split UTF-8 bytes independently for stdout and stderr", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-process-split-utf8-"));
		try {
			const value = { ...request(), correlationId: createRuntimeId("command", "split-utf8") };
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const script = [
				"const out=Buffer.from('😀'); const err=Buffer.from('✅');",
				"process.stdout.write(out.subarray(0,2)); process.stderr.write(err.subarray(0,1));",
				"setTimeout(()=>{process.stdout.write(out.subarray(2));process.stderr.write(err.subarray(1));},20);",
			].join("");
			const backend = new PipeProcessBackend({
				resolveCommand: () => ({ executable: process.execPath, args: ["-e", script], cwd: root }),
				createOutputStore: (input) => new FileProcessOutputStore({
					layout,
					workspaceStorageKey: "ws-" + "u".repeat(64),
					executionId: input.handle.executionId,
					attemptId: input.handle.attemptId,
				}),
			});
			const decision = await evaluateExecutionConstraints(decisionInput(value), createBuiltinNoneExecutionDecisionProviders());
			if (!decision.ok) throw new Error("decision failed");
			const handle = executionHandle(value, decision.snapshot);
			const spawned = await backend.spawn({ handle, request: value, spawnClaimDigest: digest("split-claim"), constraintSnapshot: decision.snapshot, constraintInput: decisionInput(value) });
			expect((await spawned.process.wait(2_000)).outcome).toBe("completed");
			const output = await spawned.process.output.read({ sequence: 0, byteOffset: 0 }, 128);
			expect(output).toMatchObject({ ok: true, page: { text: "😀✅" } });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("allows SIGKILL to escalate a prior SIGTERM for an uncooperative child", async () => {
		if (process.platform === "win32") return;
		const root = await mkdtemp(join(tmpdir(), "runledger-process-stop-escalation-"));
		try {
			const value = { ...request(), correlationId: createRuntimeId("command", "stop-escalation") };
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const backend = new PipeProcessBackend({
				resolveCommand: () => ({
					executable: process.execPath,
					args: ["-e", "process.on('SIGTERM',()=>{});process.stdout.write('ready\\n');setTimeout(()=>process.exit(0),1200)"],
					cwd: root,
				}),
				createOutputStore: (input) => new FileProcessOutputStore({
					layout,
					workspaceStorageKey: "ws-" + "k".repeat(64),
					executionId: input.handle.executionId,
					attemptId: input.handle.attemptId,
				}),
			});
			const decision = await evaluateExecutionConstraints(decisionInput(value), createBuiltinNoneExecutionDecisionProviders());
			if (!decision.ok) throw new Error("decision failed");
			const handle = executionHandle(value, decision.snapshot);
			const spawned = await backend.spawn({ handle, request: value, spawnClaimDigest: digest("escalation-claim"), constraintSnapshot: decision.snapshot, constraintInput: decisionInput(value) });
			let ready = false;
			for (let attempt = 0; attempt < 100 && !ready; attempt += 1) {
				const output = await spawned.process.output.read({ sequence: 0, byteOffset: 0 }, 128);
				ready = output.ok && output.page.text.includes("ready\n");
				if (!ready) await new Promise((resolve) => setTimeout(resolve, 10));
			}
			expect(ready).toBe(true);
			expect(spawned.process.stop("SIGTERM")).toMatchObject({ ok: true });
			expect((await spawned.process.wait(80)).outcome).toBe("timed_out");
			expect(spawned.process.stop("SIGKILL")).toMatchObject({ ok: true });
			const terminal = await spawned.process.wait(2_000);
			expect(terminal).toMatchObject({ outcome: "killed", terminal: { signal: "SIGKILL" } });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("refuses a missing or tampered execution snapshot before creating a child", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-process-backend-denied-"));
		try {
			const value = request();
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const options: PipeProcessBackendOptions = {
				resolveCommand: () => ({ executable: process.execPath, args: ["-e", "process.exit(0)"], cwd: root }),
				createOutputStore: () => new FileProcessOutputStore({
					layout,
					workspaceStorageKey: "ws-" + "b".repeat(64),
					executionId: createRuntimeId("execution", "backend-denied"),
					attemptId: createRuntimeId("attempt", "backend-denied"),
				}),
			};
			const backend = new PipeProcessBackend(options);
			const handle = {
				authorityId: value.authorityId,
				tenantId: value.tenantId,
				workspaceId: value.workspaceId,
				sessionId: value.sessionId,
				hostGeneration: 1,
				sessionGeneration: 1,
				executionId: createRuntimeId("execution", "backend-denied"),
				attemptId: createRuntimeId("attempt", "backend-denied"),
				revision: 0,
				requestDigest: value.requestDigest,
			};
			const decision = await evaluateExecutionConstraints(
				{ ...decisionInput(value), executionId: handle.executionId, attemptId: handle.attemptId },
				createBuiltinNoneExecutionDecisionProviders(),
			);
			if (!decision.ok) throw new Error("decision failed");
			await expect(backend.spawn({
				handle,
				request: value,
				spawnClaimDigest: digest("claim"),
				constraintSnapshot: undefined,
			})).rejects.toThrow(/constraint|snapshot/iu);
			await expect(backend.spawn({
				handle,
				request: value,
				spawnClaimDigest: digest("claim"),
				constraintSnapshot: decision.snapshot,
				constraintInput: { ...decisionInput(value), executionId: handle.executionId, attemptId: handle.attemptId, principalId: createRuntimeId("principal", "different") },
			})).rejects.toThrow(/constraint|snapshot/iu);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("settles a POSIX process group without claiming tree cleanup for none mode", async () => {
		if (process.platform === "win32") return;
		const root = await mkdtemp(join(tmpdir(), "runledger-process-group-"));
		try {
			const value = { ...request(), correlationId: createRuntimeId("command", "process-group") };
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const backend = new PipeProcessBackend({
				resolveCommand: () => ({
					executable: process.execPath,
					args: ["-e", "setInterval(() => {}, 1000)"],
					cwd: root,
				}),
				createOutputStore: () => new FileProcessOutputStore({
					layout,
					workspaceStorageKey: "ws-" + "c".repeat(64),
					executionId: createRuntimeId("execution", "process-group"),
					attemptId: createRuntimeId("attempt", "process-group"),
				}),
			});
			const decision = await evaluateExecutionConstraints(
				{ ...decisionInput(value), modes: { ...decisionInput(value).modes, containment: "process_group" } },
				{
					...createBuiltinNoneExecutionDecisionProviders(),
					containment: {
						decide: async (input) => createExecutionConstraintReceipt({
							dimension: "containment",
							mode: input.modes.containment,
							decision: "allow",
							providerId: "test.process-group",
							providerRevision: 1,
							policyDigest: input.policyDigest,
							invocationDigest: input.requestDigest,
							settlement: "unknown",
						}),
					},
				},
			);
			if (!decision.ok) throw new Error("process group decision failed");
			const handle = executionHandle(value, decision.snapshot);
			const spawned = await backend.spawn({ handle, request: value, spawnClaimDigest: digest("claim"), constraintSnapshot: decision.snapshot, constraintInput: { ...decisionInput(value), modes: { ...decisionInput(value).modes, containment: "process_group" } } });
			const stopped = spawned.process.stop();
			const repeated = spawned.process.stop();
			expect(stopped.ok).toBe(true);
			expect(repeated).toEqual(stopped);
			const terminal = await spawned.process.wait(2_000);
			expect(spawned.process.stop()).toEqual(stopped);
			expect(terminal.outcome).toBe("killed");
			expect(terminal.terminal?.containment).toBe("zero_members");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("uses a detached supervisor to settle the full process group", { skip: IS_WINDOWS }, async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-supervisor-"));
		try {
			const value = { ...request(), correlationId: createRuntimeId("command", "supervisor") };
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const backend = new PipeProcessBackend({
				resolveCommand: () => ({ executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: root }),
				createOutputStore: (input) => new FileProcessOutputStore({
					layout,
					workspaceStorageKey: "ws-" + "d".repeat(64),
					executionId: input.handle.executionId,
					attemptId: input.handle.attemptId,
				}),
			});
			const decision = await evaluateExecutionConstraints(
				{ ...decisionInput(value), modes: { ...decisionInput(value).modes, containment: "supervisor" } },
				{
					...createBuiltinNoneExecutionDecisionProviders(),
					containment: {
						decide: async (input) => createExecutionConstraintReceipt({
							dimension: "containment",
							mode: input.modes.containment,
							decision: "allow",
							providerId: "test.supervisor",
							providerRevision: 1,
							policyDigest: input.policyDigest,
							invocationDigest: input.requestDigest,
							settlement: "unknown",
						}),
					},
				},
			);
			if (!decision.ok) throw new Error("supervisor decision failed");
			const handle = executionHandle(value, decision.snapshot);
			const spawned = await backend.spawn({ handle, request: value, spawnClaimDigest: digest("claim"), constraintSnapshot: decision.snapshot, constraintInput: { ...decisionInput(value), modes: { ...decisionInput(value).modes, containment: "supervisor" } } });
			const stopped = spawned.process.stop();
			expect(stopped.ok).toBe(true);
			const terminal = await spawned.process.wait(2_000);
			expect(terminal.outcome).toBe("killed");
			expect(terminal.terminal?.containment).toBe("zero_members");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("kills a supervisor child and its descendant without a false zero-members claim", { skip: IS_WINDOWS }, async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-supervisor-descendant-"));
		try {
			const marker = join(root, "descendant.log");
			const value = { ...request(), correlationId: createRuntimeId("command", "supervisor-descendant") };
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const childScript = `const fs=require("node:fs");setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},"x"),20)`;
			const parentScript = `const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e",${JSON.stringify(childScript)}],{stdio:"ignore"});setInterval(()=>{},1000)`;
			const backend = new PipeProcessBackend({
				resolveCommand: () => ({ executable: process.execPath, args: ["-e", parentScript], cwd: root }),
				createOutputStore: (input) => new FileProcessOutputStore({
					layout,
					workspaceStorageKey: "ws-" + "g".repeat(64),
					executionId: input.handle.executionId,
					attemptId: input.handle.attemptId,
				}),
			});
			const decision = await evaluateExecutionConstraints(
				{ ...decisionInput(value), modes: { ...decisionInput(value).modes, containment: "supervisor" } },
				{
					...createBuiltinNoneExecutionDecisionProviders(),
					containment: {
						decide: async (input) => createExecutionConstraintReceipt({
							dimension: "containment",
							mode: input.modes.containment,
							decision: "allow",
							providerId: "test.supervisor",
							providerRevision: 1,
							policyDigest: input.policyDigest,
							invocationDigest: input.requestDigest,
							settlement: "unknown",
						}),
					},
				},
			);
			if (!decision.ok) throw new Error("supervisor decision failed");
			const handle = executionHandle(value, decision.snapshot);
			const spawned = await backend.spawn({ handle, request: value, spawnClaimDigest: digest("descendant-claim"), constraintSnapshot: decision.snapshot, constraintInput: { ...decisionInput(value), modes: { ...decisionInput(value).modes, containment: "supervisor" } } });
			await new Promise((resolve) => setTimeout(resolve, 100));
			const beforeStop = (await readFile(marker, "utf8").catch(() => "")).length;
			const stopped = spawned.process.stop();
			const terminal = await spawned.process.wait(2_000);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const afterStop = (await readFile(marker, "utf8").catch(() => "")).length;
			expect(stopped.ok).toBe(true);
			expect(terminal.terminal?.containment).toBe("zero_members");
			expect(afterStop).toBeGreaterThanOrEqual(beforeStop);
			await new Promise((resolve) => setTimeout(resolve, 100));
			expect((await readFile(marker, "utf8").catch(() => "")).length).toBe(afterStop);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("stops the root when the durable output budget is exceeded and records the real kill", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-process-output-limit-"));
		try {
			const value = {
				...request(),
				correlationId: createRuntimeId("command", "output-limit"),
				limits: { maxOutputBytes: 8 },
			};
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const backend = new PipeProcessBackend({
				resolveCommand: () => ({
					executable: process.execPath,
					args: ["-e", "process.stdout.write('1234567890'); setInterval(() => {}, 1000)"],
					cwd: root,
				}),
				createOutputStore: (input) => new FileProcessOutputStore({
					layout,
					workspaceStorageKey: "ws-" + "l".repeat(64),
					executionId: input.handle.executionId,
					attemptId: input.handle.attemptId,
					maxBytes: 1024,
				}),
			});
			const decision = await evaluateExecutionConstraints(decisionInput(value), createBuiltinNoneExecutionDecisionProviders());
			if (!decision.ok) throw new Error("decision failed");
			const handle = executionHandle(value, decision.snapshot);
			const spawned = await backend.spawn({ handle, request: value, spawnClaimDigest: digest("limit-claim"), constraintSnapshot: decision.snapshot, constraintInput: decisionInput(value) });
			const terminal = await spawned.process.wait(2_000);
			expect(terminal.outcome).toBe("killed");
			expect(terminal.terminal?.containment).toBe("not_requested");
			const output = await spawned.process.output.read({ sequence: 0, byteOffset: 0 }, 128);
			expect(output).toMatchObject({ ok: true, page: { text: "12345678" } });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("enforces a request duration limit through the backend and settles as timed_out", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-process-duration-limit-"));
		try {
			const value = {
				...request(),
				correlationId: createRuntimeId("command", "duration-limit"),
				timeoutMs: 40,
			};
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const backend = new PipeProcessBackend({
				resolveCommand: () => ({ executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: root }),
				createOutputStore: (input) => new FileProcessOutputStore({
					layout,
					workspaceStorageKey: "ws-" + "m".repeat(64),
					executionId: input.handle.executionId,
					attemptId: input.handle.attemptId,
				}),
			});
			const decision = await evaluateExecutionConstraints(decisionInput(value), createBuiltinNoneExecutionDecisionProviders());
			if (!decision.ok) throw new Error("decision failed");
			const handle = executionHandle(value, decision.snapshot);
		const spawned = await backend.spawn({ handle, request: value, spawnClaimDigest: digest("duration-claim"), constraintSnapshot: decision.snapshot, constraintInput: decisionInput(value) });
			const terminal = await spawned.process.wait(2_000);
			expect(terminal.outcome).toBe("timed_out");
			expect(terminal.terminal?.outcome).toBe("timed_out");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not fabricate a terminal success when sealing durable output fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-process-seal-failure-"));
		try {
			const value = { ...request(), correlationId: createRuntimeId("command", "seal-failure") };
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const backend = new PipeProcessBackend({
				resolveCommand: () => ({ executable: process.execPath, args: ["-e", "process.exit(0)"], cwd: root }),
				createOutputStore: (input) => new SealFailureOutputStore({
					layout,
					workspaceStorageKey: "ws-" + "s".repeat(64),
					executionId: input.handle.executionId,
					attemptId: input.handle.attemptId,
				}),
			});
			const decision = await evaluateExecutionConstraints(decisionInput(value), createBuiltinNoneExecutionDecisionProviders());
			if (!decision.ok) throw new Error("decision failed");
			const handle = executionHandle(value, decision.snapshot);
			const spawned = await backend.spawn({ handle, request: value, spawnClaimDigest: digest("seal-failure-claim"), constraintSnapshot: decision.snapshot, constraintInput: decisionInput(value) });
			const terminal = await spawned.process.wait(2_000);
			expect(terminal.outcome).toBe("uncertain");
			expect(terminal.terminal?.outcome).toBe("uncertain");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
