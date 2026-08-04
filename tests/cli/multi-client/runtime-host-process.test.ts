import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import type { RuntimeHostScope } from "../../../src/runtime/host/types.ts";
import { ProductionManagedProcessPort } from "../../../src/cli/runtime-host-process.ts";
import { MemoryLedger } from "../../../src/runtime/ledger/memory-ledger.ts";
import { createLocalTraceRecorderFactory } from "../../../src/runtime/trace/composition.ts";
import type { ProcessOutputArtifactStore } from "../../../src/runtime/process/output-artifact.ts";
import type { ManagedForegroundBashOperations } from "../../../src/runtime/tools/bash.ts";

function scope(): RuntimeHostScope {
	const digest = (seed: string) => runtimeDigest(seed);
	return {
		authorityId: createRuntimeId("authority", "process"),
		tenantId: createRuntimeId("tenant", "process"),
		workspaceId: createRuntimeId("workspace", "process"),
		repositoryId: createRuntimeId("repository", "process"),
		workspaceStorageKey: "ws-" + "p".repeat(64),
		protocolVersion: 1,
		hostBuildDigest: digest("host"),
		compositionDigest: digest("composition"),
		settingsDigest: digest("settings"),
		modelCatalogDigest: digest("models"),
		tracePolicyDigest: digest("trace"),
		securityAdapterDigest: digest("security"),
		extensionProfileDigest: digest("extension"),
		sessionStorageContractVersion: 1,
		peerAttestor: { kind: "test", generation: 1, configDigest: digest("attestor") },
	};
}

function testPort(options: ConstructorParameters<typeof ProductionManagedProcessPort>[0]): ProductionManagedProcessPort {
	return new ProductionManagedProcessPort({ ...options, allowTestOnlyUnrestrictedExecution: true });
}

describe("production Host managed process port", () => {
	it("fails closed when production composition has no Security/ExecutionGateway", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-process-no-security-"));
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		try {
			const port = new ProductionManagedProcessPort({ layout, scope: scope(), hostGeneration: 1 });
			await expect(port.create({
				sessionId: createRuntimeId("session", "no-security"),
				sessionGeneration: 1,
				commandId: "no-security-command",
				command: "printf must-not-spawn",
				cwd: root,
				timeoutMs: 1_000,
				backend: "pipe",
				executionMode: "foreground",
				principalId: "principal_no-security",
			})).resolves.toMatchObject({ ok: false, code: "execution_constraint_unavailable" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("routes process materialization through the configured Trace mode", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-process-trace-"));
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		try {
			for (const [index, mode] of (["off", "events", "events_and_artifacts"] as const).entries()) {
				const sessionId = createRuntimeId("session", `trace-${mode}`);
				const factory = createLocalTraceRecorderFactory({
					layout,
					config: { mode, failurePolicy: "fail_closed" },
					now: () => new Date("2026-08-04T10:20:30.000Z"),
				});
				const port = testPort({
					layout,
					scope: scope(),
					hostGeneration: index + 1,
					recordingMode: mode,
					traceRecorderFactory: factory,
				});
				const created = await port.create({
					sessionId,
					sessionGeneration: 1,
					commandId: `trace-process-${mode}`,
					command: "printf 'trace-output\\n'",
					cwd: root,
					timeoutMs: 5_000,
					backend: "pipe",
					executionMode: "background",
					principalId: "principal_trace",
				});
				expect(created.ok).toBe(true);
				if (!created.ok) return;
				const waited = await port.toolClient(sessionId, 1, "principal_trace").processWait(created.handle, 5_000, "driver");
				expect(waited).toMatchObject({ ok: true, outcome: "terminal" });

				const traceFiles = await filesUnder(layout.events, (filePath) => filePath.endsWith(".jsonl"));
				const artifactFiles = await filesUnder(layout.artifacts, (filePath) => !filePath.endsWith(".tmp"));
				if (mode === "off") {
					expect(traceFiles).toEqual([]);
					expect(artifactFiles).toEqual([]);
					continue;
				}
				expect(traceFiles).toHaveLength(index === 1 ? 1 : 2);
				const traceEventFiles = await Promise.all(traceFiles.map(async (filePath) => (await readFile(filePath, "utf8"))
					.split(/\r?\n/u)
					.filter((line) => line.length > 0)
					.map((line) => JSON.parse(line) as { outputContent?: { storage?: string }; metadata?: Record<string, unknown> })));
				const materialized = traceEventFiles.flat().filter((event) => event.metadata?.event === "process.output_materialized" && event.metadata.mode === mode);
				expect(materialized).toHaveLength(1);
				expect(materialized[0]?.outputContent?.storage).toBe(mode === "events" ? "digest_only" : "artifact");
				expect(artifactFiles.length).toBe(mode === "events" ? 0 : 1);
			}
		} finally {
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
		}
	});

	it("runs a governed pipe, exposes only safe summaries, and reads durable output after backend rehydrate", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-process-"));
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const sessionId = createRuntimeId("session", "process");
		try {
			const first = testPort({ layout, scope: scope(), hostGeneration: 1 });
			const created = await first.create({
				sessionId,
				sessionGeneration: 1,
				commandId: "process-command",
				command: "printf 'managed✅\\n'",
				cwd: root,
				timeoutMs: 5_000,
				backend: "pipe",
				executionMode: "background",
				principalId: "principal_process",
			});
			expect(created.ok).toBe(true);
			if (created.ok !== true) return;
			expect(JSON.stringify(created)).not.toMatch(/(?:pid|outputPath|command|cwd)/iu);
			const executionId = String((created.handle as { executionId: string }).executionId);
			let output = await first.output(sessionId, executionId, { sequence: 0, byteOffset: 0 }, 1024);
			for (let attempt = 0; attempt < 100 && !String(output.page ?? "").includes("managed✅"); attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				output = await first.output(sessionId, executionId, { sequence: 0, byteOffset: 0 }, 1024);
			}
			expect(output.page).toContain("managed✅");
			const second = testPort({ layout, scope: scope(), hostGeneration: 1 });
			const recovered = await second.output(sessionId, executionId, { sequence: 0, byteOffset: 0 }, 1024);
			expect(recovered.page).toContain("managed✅");
		} finally {
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
		}
	});

	it("does not replay stdin or EOF when the same create command is retried", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-process-idempotency-"));
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const sessionId = createRuntimeId("session", "process-idempotency");
		const input = "only-once\n";
		const createInput = {
			sessionId,
			sessionGeneration: 1,
			commandId: "process-idempotency-command",
			command: "node -e \"process.stdin.setEncoding('utf8');let value='';process.stdin.on('data', chunk => value += chunk);process.stdin.on('end', () => process.stdout.write(value));\"",
			cwd: root,
			timeoutMs: 5_000,
			backend: "pipe" as const,
			executionMode: "background" as const,
			principalId: "principal_process_idempotency",
			stdin: input,
		};
		try {
			const port = testPort({ layout, scope: scope(), hostGeneration: 1 });
			const first = await port.create(createInput);
			expect(first.ok).toBe(true);
			if (!first.ok) return;

			const retry = await port.create(createInput);
			expect(retry).toEqual(first);

			const waited = await port.toolClient(sessionId, 1, createInput.principalId).processWait(first.handle, 5_000, "driver");
			expect(waited).toMatchObject({ ok: true, outcome: "terminal" });
			let output = await port.output(sessionId, first.handle.executionId, { sequence: 0, byteOffset: 0 }, 1024);
			for (let attempt = 0; attempt < 100 && output.page !== input; attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				output = await port.output(sessionId, first.handle.executionId, { sequence: 0, byteOffset: 0 }, 1024);
			}
			expect(output.page).toBe(input);

			const recoveredPort = testPort({ layout, scope: scope(), hostGeneration: 1 });
			const recoveredRetry = await recoveredPort.create(createInput);
			expect(recoveredRetry).toMatchObject({
				ok: true,
				handle: { executionId: first.handle.executionId, attemptId: first.handle.attemptId },
			});
		} finally {
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
		}
	});

	it("exposes production containment capability and rejects strong containment for PTY", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-process-containment-"));
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const sessionId = createRuntimeId("session", "process-containment");
		try {
			const port = testPort({ layout, scope: scope(), hostGeneration: 1 });
			const supervised = await port.create({
				sessionId,
				sessionGeneration: 1,
				commandId: "process-supervisor-command",
				command: "printf 'supervised\\n'; sleep 0.05",
				cwd: root,
				timeoutMs: 5_000,
				backend: "pipe",
				executionMode: "background",
				principalId: "principal_supervisor",
				containment: "supervisor",
			});
			expect(supervised.ok).toBe(true);
			if (!supervised.ok) return;
			const terminal = await port.toolClient(sessionId, 1, "principal_supervisor").processWait(supervised.handle, 5_000, "driver");
			expect(terminal).toMatchObject({ ok: true, outcome: "terminal", summary: { terminal: { state: "completed" } } });

			const ptyRejected = await port.create({
				sessionId,
				sessionGeneration: 1,
				commandId: "process-pty-containment-command",
				command: "printf 'should-not-spawn\\n'",
				cwd: root,
				timeoutMs: 5_000,
				backend: "pty",
				executionMode: "background",
				principalId: "principal_pty_containment",
				containment: "supervisor",
			});
			expect(ptyRejected).toEqual({ ok: false, code: "execution_constraint_unavailable" });
		} finally {
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
		}
	});

	it("exposes retention plan/commit and pins through the production Host facade", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-process-retention-facade-"));
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const sessionId = createRuntimeId("session", "process-retention-facade");
		try {
			const port = testPort({ layout, scope: scope(), hostGeneration: 1 });
			const created = await port.create({
				sessionId,
				sessionGeneration: 1,
				commandId: "process-retention-facade-command",
				command: "printf 'retained\\n'; sleep 0.2",
				cwd: root,
				timeoutMs: 5_000,
				backend: "pipe",
				executionMode: "background",
				principalId: "principal_retention_facade",
			});
			expect(created.ok).toBe(true);
		if (!created.ok) return;
			let page = await port.output(sessionId, created.handle.executionId, { sequence: 0, byteOffset: 0 }, 1024);
			for (let attempt = 0; attempt < 100 && !String(page.page ?? "").includes("retained"); attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 10));
				page = await port.output(sessionId, created.handle.executionId, { sequence: 0, byteOffset: 0 }, 1024);
			}
			expect(page.page).toContain("retained");
			const facade = port as unknown as {
				planRetention(session: string, execution: string, cursor: { readonly sequence: number; readonly byteOffset: number }): Promise<Record<string, unknown>>;
				commitRetention(session: string, execution: string, plan: unknown): Promise<Record<string, unknown>>;
				pinOutput(session: string, execution: string, pinId: string, cursor: { readonly sequence: number; readonly byteOffset: number }): Promise<Record<string, unknown>>;
				unpinOutput(session: string, execution: string, pinId: string): Promise<Record<string, unknown>>;
			};
			expect(typeof facade.planRetention).toBe("function");
			expect(typeof facade.commitRetention).toBe("function");
			expect(typeof facade.pinOutput).toBe("function");
			expect(typeof facade.unpinOutput).toBe("function");
			const plan = await facade.planRetention(sessionId, created.handle.executionId, page.nextCursor);
			expect(plan).toMatchObject({ ok: true, plan: { before: page.nextCursor } });
			expect(await facade.pinOutput(sessionId, created.handle.executionId, "trace-pin", { sequence: 0, byteOffset: 0 })).toEqual({ ok: true });
			const blocked = await facade.commitRetention(sessionId, created.handle.executionId, plan.plan);
			expect(blocked).toEqual({ ok: false, code: "output_retention_blocked" });
			expect(await facade.unpinOutput(sessionId, created.handle.executionId, "trace-pin")).toEqual({ ok: true });
			expect(await facade.commitRetention(sessionId, created.handle.executionId, plan.plan)).toEqual({ ok: true });
		} finally {
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
		}
	});

	it("fails closed during recovery when Artifact materialization fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-process-recovery-artifact-failure-"));
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const sessionId = createRuntimeId("session", "process-recovery-artifact-failure");
		const failingArtifactStore: ProcessOutputArtifactStore = {
			put: async () => { throw new Error("artifact store unavailable"); },
		};
		try {
			const first = testPort({
				layout,
				scope: scope(),
				hostGeneration: 1,
				recordingMode: "events_and_artifacts",
				recordingFailurePolicy: "fail_closed",
				artifactStore: failingArtifactStore,
			});
			const created = await first.create({
				sessionId,
				sessionGeneration: 1,
				commandId: "process-recovery-artifact-failure-command",
				command: "printf 'recovery-artifact\\n'; sleep 1",
				cwd: root,
				timeoutMs: 5_000,
				backend: "pipe",
				executionMode: "background",
				principalId: "principal_recovery_artifact_failure",
			});
			expect(created.ok).toBe(true);
			if (!created.ok) return;
			await new Promise((resolve) => setTimeout(resolve, 20));
			const recovered = testPort({
				layout,
				scope: scope(),
				hostGeneration: 1,
				recordingMode: "events_and_artifacts",
				recordingFailurePolicy: "fail_closed",
				artifactStore: failingArtifactStore,
			});
			await expect(recovered.recoverUnattached()).rejects.toThrow(/Artifact|materialization/iu);
		} finally {
			await new Promise((resolve) => setTimeout(resolve, 1_100));
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
		}
	});

	it("executes foreground Bash through the Host-owned process facade", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-process-foreground-"));
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		try {
			const port = testPort({ layout, scope: scope(), hostGeneration: 1 });
			const client: ManagedForegroundBashOperations = port.toolClient("session_foreground", 1, "principal_foreground");
			const result = await client.exec({
				command: "printf 'foreground✅\\n'",
				cwd: root,
				timeoutMs: 5_000,
				maxOutputChars: 1_024,
			});
			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("foreground✅");
			expect(result.stderr).toBe("");
		} finally {
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
		}
	});

	it("settles a foreground timeout through the Host process manager", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-process-foreground-timeout-"));
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const sessionId = createRuntimeId("session", "process-foreground-timeout");
		try {
			const port = testPort({ layout, scope: scope(), hostGeneration: 1 });
			const result = await port.toolClient(sessionId, 1, "principal_foreground_timeout").exec({
				command: "node -e \"setTimeout(() => {}, 10000)\"",
				cwd: root,
				timeoutMs: 60,
				maxOutputChars: 1_024,
			});
			expect(result.signaled).toBe(true);
			expect(await port.list(sessionId)).toMatchObject([{ state: "timed_out", terminal: { state: "timed_out" } }]);
		} finally {
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
		}
	});

	it("settles a foreground AbortSignal through the Host process manager", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-process-foreground-abort-"));
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const sessionId = createRuntimeId("session", "process-foreground-abort");
		try {
			const port = testPort({ layout, scope: scope(), hostGeneration: 1 });
			const controller = new AbortController();
			setTimeout(() => controller.abort(), 60);
			const result = await port.toolClient(sessionId, 1, "principal_foreground_abort").exec({
				command: "node -e \"setTimeout(() => {}, 10000)\"",
				cwd: root,
				timeoutMs: 5_000,
				maxOutputChars: 1_024,
				signal: controller.signal,
			});
			expect(result.signaled).toBe(true);
			expect(await port.list(sessionId)).toMatchObject([{ state: "killed", terminal: { state: "killed" } }]);
		} finally {
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
		}
	});

	it("drains foreground output across bounded pages without breaking UTF-8 capture", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-process-foreground-pages-"));
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		try {
			const port = testPort({ layout, scope: scope(), hostGeneration: 1 });
			const result = await port.toolClient("session_foreground_pages", 1, "principal_foreground_pages").exec({
				command: "node -e \"process.stdout.write('x'.repeat(100000))\"",
				cwd: root,
				timeoutMs: 5_000,
				maxOutputChars: 100_000,
			});
			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");
			expect(result.stdout).toHaveLength(100_000);
			expect(result.stdout).toBe("x".repeat(100_000));
		} finally {
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
		}
	});

	it("replays one process Trace materialization after Host recovery", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-process-trace-recovery-"));
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const sessionId = createRuntimeId("session", "trace-recovery");
		const factory = createLocalTraceRecorderFactory({
			layout,
			config: { mode: "events_and_artifacts", failurePolicy: "fail_closed" },
			now: () => new Date("2026-08-04T10:20:30.000Z"),
		});
		try {
			const first = testPort({
				layout,
				scope: scope(),
				hostGeneration: 1,
				recordingMode: "events_and_artifacts",
				traceRecorderFactory: factory,
			});
			const created = await first.create({
				sessionId,
				sessionGeneration: 1,
				commandId: "trace-recovery-command",
				command: "printf 'recoverable trace\\n'; sleep 0.2",
				cwd: root,
				timeoutMs: 5_000,
				backend: "pipe",
				executionMode: "background",
				principalId: "principal_trace_recovery",
			});
			expect(created.ok).toBe(true);
			if (!created.ok) return;
			let output = await first.output(sessionId, created.handle.executionId, { sequence: 0, byteOffset: 0 }, 1024);
			for (let attempt = 0; attempt < 100 && !String(output.page ?? "").includes("recoverable trace"); attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, 5));
				output = await first.output(sessionId, created.handle.executionId, { sequence: 0, byteOffset: 0 }, 1024);
			}
			expect(output.page).toContain("recoverable trace");

			const recoveredHost = testPort({
				layout,
				scope: scope(),
				hostGeneration: 1,
				recordingMode: "events_and_artifacts",
				traceRecorderFactory: factory,
			});
			expect(await recoveredHost.recoverUnattached()).toMatchObject([{ id: created.handle.executionId, state: "uncertain", evidence: { id: created.handle.executionId } }]);
			const traceFiles = await filesUnder(layout.events, (filePath) => filePath.endsWith(".jsonl"));
			expect(traceFiles).toHaveLength(1);
			const traceEvents = (await readFile(traceFiles[0]!, "utf8"))
				.split(/\r?\n/u)
				.filter((line) => line.length > 0)
				.map((line) => JSON.parse(line) as { metadata?: Record<string, unknown> });
			expect(traceEvents.filter((event) => event.metadata?.event === "process.output_materialized")).toHaveLength(1);
			expect(await recoveredHost.recoverUnattached()).toEqual([]);
		} finally {
			await new Promise((resolve) => setTimeout(resolve, 300));
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
		}
	});

	it("delivers one terminal completion through the Host-owned bridge after the process becomes idle", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-host-process-completion-"));
		const layout = buildRunledgerLayout(join(root, "home"), "posix");
		const sessionId = createRuntimeId("session", "completion");
		const ledger = new MemoryLedger({ sessionId });
		let prompts = 0;
		try {
			const port = testPort({ layout, scope: scope(), hostGeneration: 1 });
			const remove = port.attachCompletionAgent(sessionId, {
				inFlight: false,
				getSteeringMessages: () => [],
				getFollowUpMessages: () => [],
				ledger,
				prompt: async (input) => {
					prompts += 1;
					await ledger.append({ id: `completion-${prompts}`, parentId: sessionId, sessionId, timestamp: Date.now(), type: "message", payload: { role: "user", content: input } });
				},
			});
			await port.create({
				sessionId,
				sessionGeneration: 1,
				commandId: "completion-process-command",
				command: "printf 'completion\\n'",
				cwd: root,
				timeoutMs: 5_000,
				backend: "pipe",
				executionMode: "background",
				principalId: "principal_completion",
			});
			for (let attempt = 0; attempt < 100 && prompts === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
			expect(prompts).toBe(1);
			remove();
		} finally {
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
		}
	});
});

async function filesUnder(root: string, predicate: (filePath: string) => boolean): Promise<string[]> {
	try {
		const entries = await readdir(root, { withFileTypes: true });
		const files: string[] = [];
		for (const entry of entries) {
			const filePath = join(root, entry.name);
			if (entry.isDirectory()) files.push(...await filesUnder(filePath, predicate));
			else if (entry.isFile() && predicate(filePath)) files.push(filePath);
		}
		return files.sort();
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
}
