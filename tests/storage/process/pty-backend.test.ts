import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { runtimeDigest, type RuntimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import {
	createBuiltinNoneExecutionDecisionProviders,
	evaluateExecutionConstraints,
	type ExecutionConstraintInput,
} from "../../../src/runtime/process/execution-decision.ts";
import type { ManagedProcessRequest } from "../../../src/runtime/process/types.ts";
import {
	PtyProcessBackend,
	type PtyAdapter,
	type PtyAdapterProcess,
	type PtyCommandDescriptor,
} from "../../../src/storage/process/pty-backend.ts";
import { FileProcessOutputStore } from "../../../src/storage/process/output-store.ts";

const digest = (seed: string): RuntimeDigest => runtimeDigest(seed);

function request(): ManagedProcessRequest {
	return {
		authorityId: createRuntimeId("authority", "pty"),
		tenantId: createRuntimeId("tenant", "pty"),
		workspaceId: createRuntimeId("workspace", "pty"),
		sessionId: createRuntimeId("session", "pty"),
		hostGeneration: 1,
		sessionGeneration: 1,
		requestDigest: digest("request"),
		commandRef: { subjectKind: "content", digest: digest("command"), mediaType: "text/plain", size: 1 },
		cwdRef: { subjectKind: "content", digest: digest("cwd"), mediaType: "text/plain", size: 1 },
		backend: "pty",
		executionMode: "background",
		correlationId: createRuntimeId("command", "pty"),
	};
}

function decisionInput(value: ManagedProcessRequest): ExecutionConstraintInput {
	return {
		authorityId: value.authorityId,
		tenantId: value.tenantId,
		workspaceId: value.workspaceId,
		principalId: createRuntimeId("principal", "pty"),
		executionId: createRuntimeId("execution", "pty"),
		attemptId: createRuntimeId("attempt", "pty"),
		commandId: value.correlationId,
		requestDigest: value.requestDigest,
		policyDigest: digest("policy"),
		modes: { permission: "none", approval: "none", sandbox: "none", gateway: "none", containment: "none" },
	};
}

class FakePtyProcess implements PtyAdapterProcess {
	private readonly listeners = new Set<(chunk: Uint8Array) => void>();
	private finished = false;
	private resolveWait: ((value: { readonly exitCode: number | null; readonly signal: string | null }) => void) | undefined;
	public stopCount = 0;

	public onOutput(listener: (chunk: Uint8Array) => void): () => void {
		this.listeners.add(listener);
		queueMicrotask(() => listener(new TextEncoder().encode("pty😀\n")));
		return () => this.listeners.delete(listener);
	}

	public async write(_input: string): Promise<void> {}

	public async eof(): Promise<void> {
		this.finish(0, null);
	}

	public async resize(columns: number, rows: number): Promise<void> {
		if (columns !== 80 || rows !== 24) throw new Error("unexpected resize");
	}

	public stop(_signal: NodeJS.Signals): boolean {
		this.stopCount += 1;
		this.finish(null, "SIGTERM");
		return true;
	}

	public wait(): Promise<{ readonly exitCode: number | null; readonly signal: string | null }> {
		if (this.finished) return Promise.resolve({ exitCode: 0, signal: null });
		return new Promise((resolve) => { this.resolveWait = resolve; });
	}

	private finish(exitCode: number | null, signal: string | null): void {
		if (this.finished) return;
		this.finished = true;
		this.resolveWait?.({ exitCode, signal });
	}
}

class FakePtyAdapter implements PtyAdapter {
	public spawnCount = 0;
	public lastProcess: FakePtyProcess | undefined;

	public async spawn(_input: { readonly command: PtyCommandDescriptor }): Promise<PtyAdapterProcess> {
		this.spawnCount += 1;
		this.lastProcess = new FakePtyProcess();
		return this.lastProcess;
	}
}

describe("R6 governed PTY backend", () => {
	it("keeps PTY capabilities behind an injected adapter and persists private UTF-8 output", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-pty-backend-"));
		try {
			const value = request();
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const adapter = new FakePtyAdapter();
			const command: PtyCommandDescriptor = { executable: "fake", args: [], cwd: root };
			const backend = new PtyProcessBackend({
				adapter,
				resolveCommand: () => command,
				createOutputStore: () => new FileProcessOutputStore({
					layout,
					workspaceStorageKey: "ws-" + "e".repeat(64),
					executionId: createRuntimeId("execution", "pty"),
					attemptId: createRuntimeId("attempt", "pty"),
				}),
			});
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
			const first = await backend.spawn({ handle, request: value, spawnClaimDigest: digest("claim"), constraintSnapshot: decision.snapshot });
			expect(backend.control(handle)).toBeDefined();
			expect(backend.asManagerBackend().control(handle)).toBeDefined();
			await expect(first.process.resize(80, 24)).resolves.toMatchObject({ ok: true });
			await expect(first.process.eof()).resolves.toMatchObject({ ok: true });
			const terminal = await first.process.wait(2_000);
			expect(terminal.outcome).toBe("completed");
			expect(first.receipt.evidenceRef?.subjectKind).toBe("receipt");
			expect(adapter.spawnCount).toBe(1);
			const output = await first.process.output.read({ sequence: 0, byteOffset: 0 }, 128);
			expect(output).toMatchObject({ ok: true, page: { text: "pty😀\n" } });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("stops an injected PTY when its output budget is exceeded", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-pty-output-limit-"));
		try {
			const value = { ...request(), correlationId: createRuntimeId("command", "pty-output-limit"), limits: { maxOutputBytes: 4 } };
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const backend = new PtyProcessBackend({
				adapter: new FakePtyAdapter(),
				resolveCommand: () => ({ executable: "fake", args: [], cwd: root }),
				createOutputStore: (input) => new FileProcessOutputStore({
					layout,
					workspaceStorageKey: "ws-" + "o".repeat(64),
					executionId: input.handle.executionId,
					attemptId: input.handle.attemptId,
					maxBytes: 1024,
				}),
			});
			const decision = await evaluateExecutionConstraints(decisionInput(value), createBuiltinNoneExecutionDecisionProviders());
			if (!decision.ok) throw new Error("decision failed");
			const handle = { ...decision.snapshot, revision: 0, requestDigest: value.requestDigest };
			const spawned = await backend.spawn({ handle, request: value, spawnClaimDigest: digest("pty-limit-claim"), constraintSnapshot: decision.snapshot });
			const terminal = await spawned.process.wait(2_000);
			expect(terminal.outcome).toBe("killed");
			const output = await spawned.process.output.read({ sequence: 0, byteOffset: 0 }, 128);
			expect(output).toMatchObject({ ok: true, page: { text: "pty" } });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("makes repeated stop calls idempotent across the PTY control surface", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-pty-stop-idempotency-"));
		try {
			const value = { ...request(), correlationId: createRuntimeId("command", "pty-stop-idempotency") };
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const adapter = new FakePtyAdapter();
			const backend = new PtyProcessBackend({
				adapter,
				resolveCommand: () => ({ executable: "fake", args: [], cwd: root }),
				createOutputStore: (input) => new FileProcessOutputStore({
					layout,
					workspaceStorageKey: "ws-" + "i".repeat(64),
					executionId: input.handle.executionId,
					attemptId: input.handle.attemptId,
				}),
			});
			const decision = await evaluateExecutionConstraints(decisionInput(value), createBuiltinNoneExecutionDecisionProviders());
			if (!decision.ok) throw new Error("decision failed");
			const handle = { ...decision.snapshot, revision: 0, requestDigest: value.requestDigest };
			const spawned = await backend.spawn({ handle, request: value, spawnClaimDigest: digest("pty-stop-claim"), constraintSnapshot: decision.snapshot });

			const first = spawned.process.stop();
			const second = spawned.process.stop();
			const terminal = await spawned.process.wait(2_000);
			const afterTerminal = spawned.process.stop();

			expect(first).toEqual(second);
			expect(afterTerminal).toEqual(first);
			expect(adapter.lastProcess?.stopCount).toBe(1);
			expect(terminal.outcome).toBe("killed");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
