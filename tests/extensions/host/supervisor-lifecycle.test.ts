/**
 * supervisor 的 generation/turn 边界语义。
 *
 * 与 `ExtensionSnapshotStore` 相同的纪律：运行中的 turn 不允许交换
 * generation；启动失败只标记该 generation，并保留 last-known-good。
 * 这里用一个只会拒绝启动的 process port，避免与 host-process 用例重复。
 */

import { describe, expect, it } from "vitest";
import { ExtensionHostSupervisor } from "../../../src/extensions/host/supervisor.ts";
import type { ExtensionHostManagedProcessPort } from "../../../src/extensions/host/channel.ts";
import type { ExecutionHandleRef } from "../../../src/runtime/process/types.ts";
import type { ControlPlaneMutationResult } from "../../../src/storage/process/control-plane.ts";

class RejectingProcess implements ExtensionHostManagedProcessPort {
	public readonly attempts: string[] = [];
	readonly #code: string;

	public constructor(code = "process_start_rejected") {
		this.#code = code;
	}

	public async start(input: { readonly command: string }): Promise<{ readonly ok: false; readonly code: string }> {
		this.attempts.push(input.command);
		return { ok: false, code: this.#code };
	}

	public async processOutput(): Promise<never> { throw new Error("not used"); }
	public async processWait(): Promise<never> { throw new Error("not used"); }
	public async write(): Promise<ControlPlaneMutationResult> { return { ok: false, code: "process_not_found" }; }
	public async stop(): Promise<ControlPlaneMutationResult> { return { ok: false, code: "process_not_found" }; }
	public async resize(): Promise<ControlPlaneMutationResult> { return { ok: false, code: "process_not_found" }; }
}

function supervisorFor(port: RejectingProcess, audits: string[]) {
	return new ExtensionHostSupervisor({
		managedProcess: port as unknown as ExtensionHostManagedProcessPort,
		startCommand: { runtimeCommand: "/usr/bin/node", runtimeArgs: [], hostEntrypoint: "/runledger/entry.js" },
		apiVersion: "1.0.0",
		actionHandler: async () => ({ ok: true }),
		audit: async (event) => { audits.push(event.eventType); },
	});
}

const descriptor = (generation: number) => ({
	generation,
	packageId: "sample@local",
	digest: "f".repeat(64),
	rootPath: "/tmp/sample",
	entrypoint: "/tmp/sample/entry.ts",
});

describe("extension host supervisor lifecycle", () => {
	it("starts idle and reports a refused process as a failed generation", async () => {
		const audits: string[] = [];
		const supervisor = supervisorFor(new RejectingProcess(), audits);
		expect(supervisor.status()).toEqual({ status: "idle" });
		expect(supervisor.activeGeneration()).toBeUndefined();

		const status = await supervisor.start(descriptor(1));
		expect(status.status).toBe("failed");
		if (status.status === "failed") expect(status.code).toBe("process_start_rejected");
		expect(audits).toEqual(["extension.host.starting", "extension.host.failed"]);
	});

	it("defers a generation swap while a turn is active and reports it at endTurn", async () => {
		const port = new RejectingProcess();
		const supervisor = supervisorFor(port, []);
		supervisor.beginTurn();
		const status = await supervisor.start(descriptor(2));
		expect(status).toEqual({ status: "idle" });
		expect(port.attempts).toEqual([]);
		// 与 `ExtensionSnapshotStore` 一致：pending 在真正尝试交换（成功）前保持。
		expect(supervisor.endTurn()).toBe(true);
		await supervisor.start(descriptor(2));
		expect(port.attempts).toHaveLength(1);
		expect(supervisor.endTurn()).toBe(false);
	});

	it("keeps a failed stop idempotent and does not invent a stopped status when nothing started", async () => {
		const supervisor = supervisorFor(new RejectingProcess(), []);
		expect(await supervisor.stop("owner-request")).toEqual({ status: "idle" });
		expect(supervisor.client()).toBeUndefined();
	});

	it("describes status for diagnostics without exposing handles", async () => {
		const supervisor = supervisorFor(new RejectingProcess(), []);
		const { describeSupervisorStatus } = await import("../../../src/extensions/host/supervisor.ts");
		expect(describeSupervisorStatus(supervisor.status())).toBe("idle");
		expect(describeSupervisorStatus({ status: "failed", generation: 3, code: "host_exited", message: "gone" })).toBe("failed:3:host_exited");
	});
});
