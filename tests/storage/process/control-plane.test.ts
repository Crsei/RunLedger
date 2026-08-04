import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { runtimeDigest, type RuntimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { AuditedProcessManager, ProcessManager, type BackendSpawnPort, type BackendSpawnReceipt } from "../../../src/runtime/process/manager.ts";
import type { ExecutionConstraintInput } from "../../../src/runtime/process/execution-decision.ts";
import type { ManagedProcessRequest } from "../../../src/runtime/process/types.ts";
import { JsonlProcessJournal } from "../../../src/storage/process/recovery-store.ts";
import { FileProcessOutputStore } from "../../../src/storage/process/output-store.ts";
import { JsonlProcessCompletionQueue } from "../../../src/storage/process/completion-queue.ts";
import { ManagedProcessControlPlane } from "../../../src/storage/process/control-plane.ts";
import { ManagedProcessOutputMaterializer } from "../../../src/runtime/process/output-artifact.ts";
import type { ProcessOutputMaterializationRecord } from "../../../src/runtime/process/output-artifact.ts";
import { PipeProcessBackend } from "../../../src/storage/process/process-backend.ts";

const digest = (seed: string): RuntimeDigest => runtimeDigest(seed);

function request(): ManagedProcessRequest {
	return {
		authorityId: createRuntimeId("authority", "control-plane"),
		tenantId: createRuntimeId("tenant", "control-plane"),
		workspaceId: createRuntimeId("workspace", "control-plane"),
		sessionId: createRuntimeId("session", "control-plane"),
		hostGeneration: 1,
		sessionGeneration: 1,
		requestDigest: digest("request"),
		commandRef: { subjectKind: "content", digest: digest("command"), mediaType: "text/plain", size: 1 },
		cwdRef: { subjectKind: "content", digest: digest("cwd"), mediaType: "text/plain", size: 1 },
		backend: "pipe",
		executionMode: "background",
		correlationId: createRuntimeId("command", "control-plane"),
	};
}

function decisionInput(value: ManagedProcessRequest): ExecutionConstraintInput {
	return {
		authorityId: value.authorityId,
		tenantId: value.tenantId,
		workspaceId: value.workspaceId,
		principalId: createRuntimeId("principal", "control-plane"),
		executionId: createRuntimeId("execution", "placeholder"),
		attemptId: createRuntimeId("attempt", "placeholder"),
		commandId: value.correlationId,
		requestDigest: value.requestDigest,
		policyDigest: digest("policy"),
		modes: { permission: "none", approval: "none", sandbox: "none", gateway: "none", containment: "none" },
	};
}

describe("R8 managed process control plane", () => {
	it("reads immediately, bounds wait, fences observer mutations, and enqueues one terminal follow-up", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-control-plane-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const options = { layout, workspaceStorageKey: "ws-" + "a".repeat(64) };
			const journal = new JsonlProcessJournal(options);
			const output = new FileProcessOutputStore({
				layout,
				workspaceStorageKey: options.workspaceStorageKey,
				executionId: createRuntimeId("execution", "control-plane"),
				attemptId: createRuntimeId("attempt", "control-plane_1"),
			});
			await output.append("ready\n");
			let waits = 0;
			let writes = 0;
			const backend = {
				spawn: async (): Promise<BackendSpawnReceipt> => ({ receiptDigest: digest("receipt") }),
				control: () => ({
					output,
					wait: async () => {
						waits += 1;
						return waits === 1
							? { outcome: "timed_out" as const }
							: {
								outcome: "completed" as const,
								terminal: { outcome: "completed" as const, exitCode: 0, durationMs: 4, containment: "not_requested" as const },
							};
					},
					write: async () => { writes += 1; return { ok: true as const, receiptDigest: digest("write") }; },
					eof: async () => ({ ok: true as const, receiptDigest: digest("eof") }),
					stop: () => ({ ok: true as const, receiptDigest: digest("stop") }),
				}),
			} satisfies BackendSpawnPort & { control: (handle: unknown) => unknown };
			const processManager = new ProcessManager(journal, backend);
			const plane = new ManagedProcessControlPlane({
				manager: processManager,
				auditedManager: new AuditedProcessManager(processManager),
				backend,
				completionQueue: new JsonlProcessCompletionQueue(options),
				policyDigest: digest("delivery-policy"),
				budgetDigest: digest("delivery-budget"),
			});
			const created = await plane.create(request(), decisionInput(request()));
			expect(created.ok).toBe(true);
			if (!created.ok) return;
			const page = await plane.processOutput(created.handle, { sequence: 0, byteOffset: 0 }, 32);
			expect(page).toMatchObject({ ok: true, page: { text: "ready\n" } });
			expect(await processManager.query(created.handle)).toMatchObject({
				ok: true,
				summary: { outputCursor: { sequence: 1, byteOffset: 6 }, outputSize: 6 },
			});
			const checkpointEvents = journal.eventsFor(created.handle).length;
			await plane.processOutput(created.handle, { sequence: 0, byteOffset: 0 }, 32);
			expect(journal.eventsFor(created.handle)).toHaveLength(checkpointEvents);
			expect(await plane.processWait(created.handle, 10, "driver")).toMatchObject({ ok: true, outcome: "timed_out" });
			expect(await plane.write(created.handle, "observer", "x")).toEqual({ ok: false, code: "observer_mutation_forbidden" });
			expect(await plane.write(created.handle, "driver", "x")).toMatchObject({ ok: true });
			expect(await plane.stop(created.handle, "driver")).toMatchObject({ ok: true, operation: "stop" });
			expect(journal.eventsFor(created.handle).some((event) => event.type === "process.termination_requested")).toBe(true);
		const terminal = await plane.processWait(created.handle, 10, "driver");
			expect(terminal).toMatchObject({ ok: true, outcome: "terminal" });
		const duplicate = await plane.processWait(created.handle, 10, "driver");
			expect(duplicate).toMatchObject({ ok: true, outcome: "terminal" });
			expect((await new JsonlProcessCompletionQueue(options).pending())).toHaveLength(0);
			expect(waits).toBe(2);
			expect(writes).toBe(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("composes the real pipe backend behind the same Host control port", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-control-plane-pipe-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const options = { layout, workspaceStorageKey: "ws-" + "b".repeat(64) };
			const backend = new PipeProcessBackend({
				resolveCommand: () => ({ executable: process.execPath, args: ["-e", "process.stdout.write('integrated\\n')"], cwd: root }),
				createOutputStore: (input) => new FileProcessOutputStore({
					layout,
					workspaceStorageKey: options.workspaceStorageKey,
					executionId: input.handle.executionId,
					attemptId: input.handle.attemptId,
				}),
			});
			const managerBackend = backend.asManagerBackend();
			const journal = new JsonlProcessJournal(options);
			const manager = new ProcessManager(journal, managerBackend);
			const plane = new ManagedProcessControlPlane({
				manager,
				auditedManager: new AuditedProcessManager(manager),
				backend: managerBackend,
				completionQueue: new JsonlProcessCompletionQueue(options),
				policyDigest: digest("pipe-policy"),
				budgetDigest: digest("pipe-budget"),
			});
			const created = await plane.create(request(), decisionInput(request()));
			expect(created.ok).toBe(true);
			if (!created.ok) return;
			const terminal = await plane.processWait(created.handle, 2_000, "driver");
			expect(terminal).toMatchObject({ ok: true, outcome: "terminal", summary: { state: "completed" } });
			const page = await plane.processOutput(created.handle, { sequence: 0, byteOffset: 0 }, 128);
			expect(page).toMatchObject({ ok: true, page: { text: "integrated\n" } });
			const lifecycleProcess = plane.createLifecycleProcess(created.handle, 10);
			await lifecycleProcess.drain();
			await lifecycleProcess.checkpoint();
			await lifecycleProcess.seal();
			await lifecycleProcess.settle();
			expect(await new JsonlProcessCompletionQueue(options).pending()).toHaveLength(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("settles a backend terminal watcher into one durable automatic Queue item", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-control-plane-watcher-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const options = { layout, workspaceStorageKey: "ws-" + "c".repeat(64) };
			const journal = new JsonlProcessJournal(options);
			const output = new FileProcessOutputStore({
				layout,
				workspaceStorageKey: options.workspaceStorageKey,
				executionId: createRuntimeId("execution", "watcher"),
				attemptId: createRuntimeId("attempt", "watcher_1"),
			});
			await output.append("watched output\n");
				let artifactCalls = 0;
				let completionDeliveries = 0;
				const materializationRecords: ProcessOutputMaterializationRecord[] = [];
			let terminalListener: ((terminal: { readonly outcome: "completed"; readonly exitCode: number; readonly durationMs: number; readonly containment: "not_requested" }) => void) | undefined;
			const backend = {
				spawn: async (): Promise<BackendSpawnReceipt> => ({ receiptDigest: digest("watcher-receipt") }),
				control: () => ({
					output,
					onTerminal: (listener: typeof terminalListener) => {
						terminalListener = listener;
						return () => { terminalListener = undefined; };
					},
					wait: async () => ({ outcome: "timed_out" as const }),
					write: async () => ({ ok: true as const, receiptDigest: digest("watcher-write") }),
					eof: async () => ({ ok: true as const, receiptDigest: digest("watcher-eof") }),
					stop: () => ({ ok: true as const, receiptDigest: digest("watcher-stop") }),
				}),
			} satisfies BackendSpawnPort & { control: (handle: unknown) => unknown };
			const manager = new ProcessManager(journal, backend);
			const queue = new JsonlProcessCompletionQueue(options);
			const plane = new ManagedProcessControlPlane({
				manager,
				auditedManager: new AuditedProcessManager(manager),
				backend,
				completionQueue: queue,
				completionAgent: {
					isTurnActive: () => false,
					hasPendingUserInput: () => false,
					hasDurableDelivery: async () => "absent" as const,
					deliverCompletionBatch: async () => {
						completionDeliveries += 1;
						return { ok: true as const };
					},
				},
				policyDigest: digest("watcher-policy"),
				budgetDigest: digest("watcher-budget"),
					outputMaterializer: new ManagedProcessOutputMaterializer({
					mode: "events_and_artifacts",
					artifactStore: {
						put: async (input) => {
							artifactCalls += 1;
							return {
								storage: "artifact" as const,
								artifactId: "artifact_" + "c".repeat(64),
								digest: "c".repeat(64),
								mediaType: input.mediaType,
								size: input.bytes.byteLength,
							};
						},
						},
					}),
					onOutputMaterialized: async ({ record }) => {
						materializationRecords.push(record);
					},
				});
			const value = request();
			const created = await plane.create(value, decisionInput(value));
			expect(created.ok).toBe(true);
			if (!created.ok) return;
			expect(terminalListener).toBeTypeOf("function");
			terminalListener?.({ outcome: "completed", exitCode: 0, durationMs: 1, containment: "not_requested" });
			for (let attempt = 0; attempt < 100 && materializationRecords.length === 0; attempt += 1) {
				await new Promise<void>((resolve) => setTimeout(resolve, 5));
			}
				expect((await manager.query(created.handle)).summary.state).toBe("completed");
				expect(artifactCalls).toBe(1);
				expect(materializationRecords).toHaveLength(1);
				expect(materializationRecords[0]?.materialization.artifactRef?.storage).toBe("artifact");
				expect(completionDeliveries).toBe(0);
			expect(await queue.pending()).toHaveLength(1);
			expect(await plane.reconcileCompletions()).toMatchObject({ ok: true, outcome: "delivered", delivered: 1 });
			expect(completionDeliveries).toBe(1);
		expect(await plane.processWait(created.handle, 10, "driver")).toEqual(expect.objectContaining({ ok: true, outcome: "terminal" }));
			expect(await queue.pending()).toHaveLength(0);
			terminalListener?.({ outcome: "completed", exitCode: 0, durationMs: 1, containment: "not_requested" });
			await new Promise<void>((resolve) => setTimeout(resolve, 25));
			expect(await new JsonlProcessCompletionQueue(options).pending()).toHaveLength(0);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("seals private output through the lifecycle port and does not enqueue after Artifact failure", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-control-plane-seal-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const options = { layout, workspaceStorageKey: "ws-" + "d".repeat(64) };
			const journal = new JsonlProcessJournal(options);
			const output = new FileProcessOutputStore({
				layout,
				workspaceStorageKey: options.workspaceStorageKey,
				executionId: createRuntimeId("execution", "seal"),
				attemptId: createRuntimeId("attempt", "seal_1"),
			});
			await output.append("sealed output\n");
			let sealCalls = 0;
			const outputPort = {
				read: output.read.bind(output),
				head: output.head.bind(output),
				seal: async () => {
					sealCalls += 1;
					return output.seal();
				},
			};
			const backend = {
				spawn: async (): Promise<BackendSpawnReceipt> => ({ receiptDigest: digest("seal-receipt") }),
				control: () => ({
					output: outputPort,
					wait: async () => ({ outcome: "timed_out" as const }),
					write: async () => ({ ok: true as const, receiptDigest: digest("seal-write") }),
					eof: async () => ({ ok: true as const, receiptDigest: digest("seal-eof") }),
					stop: () => ({ ok: true as const, receiptDigest: digest("seal-stop") }),
				}),
			} satisfies BackendSpawnPort & { control: (handle: unknown) => unknown };
			const manager = new ProcessManager(journal, backend);
			const plane = new ManagedProcessControlPlane({
				manager,
				auditedManager: new AuditedProcessManager(manager),
				backend,
				completionQueue: new JsonlProcessCompletionQueue(options),
				policyDigest: digest("seal-policy"),
				budgetDigest: digest("seal-budget"),
			});
			const created = await plane.create({ ...request(), correlationId: createRuntimeId("command", "seal") }, decisionInput(request()));
			expect(created.ok).toBe(true);
		if (!created.ok) return;
		await plane.createLifecycleProcess(created.handle, 10).seal();
			expect(sealCalls).toBe(1);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("keeps terminal delivery pending when Artifact materialization fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-control-plane-artifact-failure-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const options = { layout, workspaceStorageKey: "ws-" + "f".repeat(64) };
			const journal = new JsonlProcessJournal(options);
			const output = new FileProcessOutputStore({
				layout,
				workspaceStorageKey: options.workspaceStorageKey,
				executionId: createRuntimeId("execution", "artifact-failure"),
				attemptId: createRuntimeId("attempt", "artifact-failure_1"),
			});
			await output.append("artifact failure\n");
			let terminalListener: ((terminal: { readonly outcome: "completed"; readonly exitCode: number; readonly durationMs: number; readonly containment: "not_requested" }) => void) | undefined;
			const backend = {
				spawn: async (): Promise<BackendSpawnReceipt> => ({ receiptDigest: digest("artifact-failure-receipt") }),
				control: () => ({
					output,
					onTerminal: (listener: typeof terminalListener) => {
						terminalListener = listener;
						return () => { terminalListener = undefined; };
					},
					wait: async () => ({ outcome: "timed_out" as const }),
					write: async () => ({ ok: true as const, receiptDigest: digest("artifact-failure-write") }),
					eof: async () => ({ ok: true as const, receiptDigest: digest("artifact-failure-eof") }),
					stop: () => ({ ok: true as const, receiptDigest: digest("artifact-failure-stop") }),
				}),
			} satisfies BackendSpawnPort & { control: (handle: unknown) => unknown };
			const manager = new ProcessManager(journal, backend);
			const queue = new JsonlProcessCompletionQueue(options);
			let artifactAttempts = 0;
			const plane = new ManagedProcessControlPlane({
				manager,
				auditedManager: new AuditedProcessManager(manager),
				backend,
				completionQueue: queue,
				policyDigest: digest("artifact-failure-policy"),
				budgetDigest: digest("artifact-failure-budget"),
				outputMaterializer: new ManagedProcessOutputMaterializer({
					mode: "events_and_artifacts",
					artifactStore: {
						put: async (input) => {
							artifactAttempts += 1;
							if (artifactAttempts === 1) throw new Error("artifact store unavailable");
							return {
								storage: "artifact" as const,
								artifactId: "artifact_" + "f".repeat(64),
								digest: "f".repeat(64),
								mediaType: input.mediaType,
								size: input.bytes.byteLength,
							};
						},
					},
				}),
			});
			const value = { ...request(), correlationId: createRuntimeId("command", "artifact-failure") };
			const created = await plane.create(value, decisionInput(value));
			expect(created.ok).toBe(true);
			if (!created.ok) return;
			expect(terminalListener).toBeTypeOf("function");
			terminalListener?.({ outcome: "completed", exitCode: 0, durationMs: 1, containment: "not_requested" });
			for (let attempt = 0; attempt < 100 && artifactAttempts === 0; attempt += 1) {
				await new Promise<void>((resolve) => setTimeout(resolve, 5));
			}
			expect((await manager.query(created.handle)).summary.state).toBe("completed");
			expect(await queue.pending()).toEqual([]);
			expect(artifactAttempts).toBe(1);
		const retry = await plane.processWait(created.handle, 10, "driver");
			expect(retry).toEqual(expect.objectContaining({ ok: true, outcome: "terminal" }));
			expect(artifactAttempts).toBe(2);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
