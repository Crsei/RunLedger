import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPosixNodePtyAdapter } from "../../../src/storage/process/node-pty-adapter.ts";
import type { PtyAdapterProcess } from "../../../src/storage/process/pty-backend.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { runtimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import type { ManagedProcessRequest } from "../../../src/runtime/process/types.ts";
import type { ExecutionConstraintSnapshot } from "../../../src/runtime/process/execution-decision.ts";
import { createBuiltinNoneExecutionDecisionProviders, evaluateExecutionConstraints } from "../../../src/runtime/process/execution-decision.ts";
import type { ExecutionHandleRef } from "../../../src/runtime/process/types.ts";

function request(cwd: string): ManagedProcessRequest {
	return {
		authorityId: createRuntimeId("authority", "node-pty-adapter"),
		tenantId: createRuntimeId("tenant", "node-pty-adapter"),
		workspaceId: createRuntimeId("workspace", "node-pty-adapter"),
		sessionId: createRuntimeId("session", "node-pty-adapter"),
		hostGeneration: 1,
		sessionGeneration: 1,
		requestDigest: runtimeDigest("node-pty-request"),
		commandRef: { subjectKind: "content", digest: runtimeDigest("command"), mediaType: "text/plain", size: 1 },
		cwdRef: { subjectKind: "content", digest: runtimeDigest("cwd"), mediaType: "text/plain", size: 1 },
		backend: "pty",
		executionMode: "background",
		correlationId: createRuntimeId("command", "node-pty-adapter"),
		limits: { maxInputFrameBytes: 4 * 1024, maxOutputBytes: 64 * 1024 },
	};
}

	async function snapshot(value: ManagedProcessRequest, handle: ExecutionHandleRef): Promise<ExecutionConstraintSnapshot> {
		const decision = await evaluateExecutionConstraints({
			authorityId: value.authorityId,
			tenantId: value.tenantId,
			workspaceId: value.workspaceId,
			principalId: createRuntimeId("principal", "node-pty-adapter"),
			executionId: handle.executionId,
			attemptId: handle.attemptId,
			commandId: value.correlationId,
			requestDigest: value.requestDigest,
			policyDigest: runtimeDigest("node-pty-policy"),
			modes: { permission: "none", approval: "none", sandbox: "none", gateway: "none", containment: "none" },
		}, createBuiltinNoneExecutionDecisionProviders());
		if (!decision.ok) throw new Error("failed to build PTY constraint snapshot");
		return decision.snapshot;
}

async function waitWithTimeout(process: PtyAdapterProcess): Promise<{ readonly exitCode: number | null; readonly signal: string | null }> {
		return Promise.race([
			process.wait(),
			new Promise<never>((_, reject) => setTimeout(() => reject(new Error("node-pty adapter timed out")), 5_000)),
		]);
}

describe("R6 POSIX node-pty adapter", () => {
	it("runs a real PTY with UTF-8 output and resize without exposing the native handle", async () => {
		if (process.platform === "win32") return;
		const root = await mkdtemp(join(tmpdir(), "runledger-node-pty-"));
		try {
			const value = request(root);
			const handle = {
				authorityId: value.authorityId,
				tenantId: value.tenantId,
				workspaceId: value.workspaceId,
				sessionId: value.sessionId,
				hostGeneration: 1,
				sessionGeneration: 1,
				executionId: createRuntimeId("execution", "node-pty-adapter"),
				attemptId: createRuntimeId("attempt", "node-pty-adapter_1"),
				revision: 0,
				requestDigest: value.requestDigest,
			};
			const adapter = createPosixNodePtyAdapter();
			expect(adapter.capabilities).toEqual({ canResize: true, containment: "none" });
			const child = await adapter.spawn({
				command: { executable: process.execPath, args: ["-e", "process.stdout.write('node-pty✅\\n')"], cwd: root },
				handle,
				request: value,
				constraintSnapshot: await snapshot(value, handle),
			});
			let output = "";
			child.onOutput((chunk) => { output += new TextDecoder().decode(chunk); });
			await child.resize(100, 30);
			const exit = await waitWithTimeout(child);
			expect(exit.exitCode).toBe(0);
			expect(output).toContain("node-pty✅");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
