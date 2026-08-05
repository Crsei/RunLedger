import { describe, expect, it } from "vitest";
import type { ExecutionHandleRef } from "../../src/runtime/process/types.ts";
import type { OutputCursor } from "../../src/runtime/process/output.ts";
import type { ControlPlaneMutationResult, ControlPlaneOutputResult, ControlPlaneWaitResult } from "../../src/storage/process/control-plane.ts";
import type { HookCommandRunnerRequest } from "../../src/extensions/hooks/types.ts";
import { createHostManagedHookRunner } from "../../src/extensions/hooks/host-runner.ts";

function handle(): ExecutionHandleRef {
	return {
		authorityId: "authority_test" as ExecutionHandleRef["authorityId"],
		tenantId: "tenant_test" as ExecutionHandleRef["tenantId"],
		workspaceId: "workspace_test" as ExecutionHandleRef["workspaceId"],
		sessionId: "session_test" as ExecutionHandleRef["sessionId"],
		hostGeneration: 1,
		sessionGeneration: 1,
		executionId: "execution_hook" as ExecutionHandleRef["executionId"],
		attemptId: "attempt_hook" as ExecutionHandleRef["attemptId"],
		revision: 1,
		requestDigest: { algorithm: "sha256", digest: "a".repeat(64) },
	};
}

class FakeManagedProcess {
	readonly starts: Array<{ readonly command: string; readonly cwd: string; readonly stdin?: string }> = [];
	readonly stops: string[] = [];
	private readonly execution = handle();
	private readonly finishOnOutput: boolean;
	private outputRead = false;
	private stopped = false;

	public constructor(finishOnOutput = true) {
		this.finishOnOutput = finishOnOutput;
	}

	public async start(input: { readonly command: string; readonly cwd: string; readonly timeoutMs: number; readonly stdin?: string; readonly signal?: AbortSignal }): Promise<{ readonly ok: true; readonly handle: ExecutionHandleRef; readonly summary: { readonly state: string } }> {
		this.starts.push({ command: input.command, cwd: input.cwd, ...(input.stdin === undefined ? {} : { stdin: input.stdin }) });
		return { ok: true, handle: this.execution, summary: { state: "running" } };
	}

	public async processOutput(_handle: ExecutionHandleRef, cursor: OutputCursor, _maxBytes: number): Promise<ControlPlaneOutputResult> {
		const text = cursor.byteOffset === 0 ? '{"decision":"allow"}\n' : "";
		this.outputRead = true;
		const next = cursor.byteOffset === 0 ? { sequence: 1, byteOffset: Buffer.byteLength(text, "utf8") } : cursor;
		return {
			ok: true,
			page: { handle: this.execution, startCursor: cursor, endCursor: next, nextCursor: next, text, truncated: false },
			head: next,
		};
	}

	public async processWait(_handle: ExecutionHandleRef, _timeoutMs: number, _actor: "driver" | "observer"): Promise<ControlPlaneWaitResult> {
		await new Promise<void>((resolve) => setTimeout(resolve, 2));
		return (this.stopped || (this.finishOnOutput && this.outputRead))
			? { ok: true, outcome: "terminal", summary: { handle: this.execution, state: "completed", outputCursor: { sequence: 1, byteOffset: 21 }, outputSize: 21, capabilities: { canWrite: false, canEof: false, canResize: false, canStop: false, canReadOutput: true }, terminal: { state: "completed", exitCode: 0, evidenceRef: { subjectKind: "content", digest: { algorithm: "sha256", digest: "b".repeat(64) } } } }, nextCursor: { sequence: 1, byteOffset: 21 } }
			: { ok: true, outcome: "running", summary: { handle: this.execution, state: "running", outputCursor: { sequence: 1, byteOffset: 21 }, outputSize: 21, capabilities: { canWrite: false, canEof: false, canResize: false, canStop: true, canReadOutput: true } }, nextCursor: { sequence: 1, byteOffset: 21 } };
	}

	public async stop(_handle: ExecutionHandleRef, _actor: "driver" | "observer", signal?: NodeJS.Signals): Promise<ControlPlaneMutationResult> {
		this.stops.push(signal ?? "SIGTERM");
		this.stopped = true;
		return { ok: true, operation: "stop", receiptDigest: { algorithm: "sha256", digest: "c".repeat(64) }, summary: { handle: this.execution, state: "killed", outputCursor: { sequence: 1, byteOffset: 21 }, outputSize: 21, capabilities: { canWrite: false, canEof: false, canResize: false, canStop: false, canReadOutput: true } } };
	}

	public async write(): Promise<ControlPlaneMutationResult> {
		return { ok: false, code: "mutation_rejected" };
	}
	public async resize(): Promise<ControlPlaneMutationResult> {
		return { ok: false, code: "mutation_rejected" };
	}
}

function request(overrides: Partial<HookCommandRunnerRequest> = {}): HookCommandRunnerRequest {
	return {
		command: "./guard.sh",
		args: ["--mode", "safe value"],
		env: { SAFE_VALUE: "yes", RUNLEDGER_FORBIDDEN: "caller" },
		stdin: "{}",
		timeoutMs: 100,
		signal: new AbortController().signal,
		cwd: "/tmp/plugin/hooks",
		...overrides,
	};
}

describe("Host-managed hook runner", () => {
	it("uses the managed process facade with bounded shell quoting and filtered environment", async () => {
		const process = new FakeManagedProcess();
		const runner = createHostManagedHookRunner({ managedProcess: process });
		const result = await runner.run(request());
		expect(result).toEqual({ exitCode: 0, stdout: '{"decision":"allow"}\n', stderr: "" });
		expect(process.starts[0]).toMatchObject({ cwd: "/tmp/plugin/hooks", stdin: "{}" });
		expect(process.starts[0]?.command).toContain("'/tmp/plugin/hooks/guard.sh' '--mode' 'safe value'");
		expect(process.starts[0]?.command).toContain("SAFE_VALUE='yes'");
		expect(process.starts[0]?.command).not.toContain("RUNLEDGER_FORBIDDEN");
	});

	it("stops and reaps a managed hook when the pipeline aborts", async () => {
		const process = new FakeManagedProcess(false);
		const runner = createHostManagedHookRunner({ managedProcess: process, stopTimeoutMs: 50 });
		const controller = new AbortController();
		const pending = runner.run(request({ signal: controller.signal, timeoutMs: 10_000 }));
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
		controller.abort();
		await pending;
		expect(process.stops).toEqual(["SIGTERM"]);
	});
});
