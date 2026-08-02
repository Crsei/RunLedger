import { describe, expect, it } from "vitest";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import type { RuntimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import {
	ProcessManager,
	type BackendSpawnPort,
	type BackendSpawnReceipt,
	type ProcessJournal,
} from "../../../src/runtime/process/manager.ts";
import { createProcessEvent, type ProcessEvent } from "../../../src/runtime/process/events.ts";
import type { ExecutionHandleRef, ManagedProcessRequest } from "../../../src/runtime/process/types.ts";
import { projectProcessEvents } from "../../../src/runtime/process/state-machine.ts";

const digest = (seed: string): RuntimeDigest => ({
	algorithm: "sha256",
	digest: seed.repeat(64).slice(0, 64) as RuntimeDigest["digest"],
});

function request(seed: string, executionMode: ManagedProcessRequest["executionMode"] = "foreground"): ManagedProcessRequest {
	return {
		authorityId: createRuntimeId("authority", seed),
		tenantId: createRuntimeId("tenant", seed),
		workspaceId: createRuntimeId("workspace", seed),
		sessionId: createRuntimeId("session", seed),
		hostGeneration: 1,
		sessionGeneration: 1,
		requestDigest: digest(seed === "manager" ? "a" : "b"),
		commandRef: { subjectKind: "content", digest: digest("c"), mediaType: "text/plain", size: 1 },
		cwdRef: { subjectKind: "content", digest: digest("d"), mediaType: "text/plain", size: 1 },
		backend: "pipe",
		executionMode,
		correlationId: createRuntimeId("command", seed),
	};
}

class FakeJournal implements ProcessJournal {
	public readonly events: ProcessEvent[] = [];
	private readonly claims = new Set<string>();
	private readonly receipts = new Map<string, BackendSpawnReceipt>();

	public async append(event: ProcessEvent): Promise<void> {
		this.events.push(event);
	}

	public findIntent(commandId: ManagedProcessRequest["correlationId"]): ProcessEvent | undefined {
		return this.events.find((event) => event.type === "process.execution_requested" && event.commandId === commandId);
	}

	public eventsFor(handle: ExecutionHandleRef): readonly ProcessEvent[] {
		return this.events.filter((event) => event.executionId === handle.executionId && event.attemptId === handle.attemptId);
	}

	public recordSpawnClaim(handle: ExecutionHandleRef): void {
		this.claims.add(handle.executionId);
	}

	public hasSpawnClaim(handle: ExecutionHandleRef): boolean {
		return this.claims.has(handle.executionId);
	}

	public spawnReceipt(handle: ExecutionHandleRef): BackendSpawnReceipt | undefined {
		return this.receipts.get(handle.executionId);
	}

	public recordSpawnReceipt(handle: ExecutionHandleRef, receipt: BackendSpawnReceipt): void {
		this.receipts.set(handle.executionId, receipt);
	}
}

class FakeBackend implements BackendSpawnPort {
	public spawnCount = 0;
	public loseNextResponse = false;
	private readonly journal: FakeJournal;
	private readonly receipts = new Map<string, BackendSpawnReceipt>();

	public constructor(journal: FakeJournal) {
		this.journal = journal;
	}

	public async spawn(input: Parameters<BackendSpawnPort["spawn"]>[0]): Promise<BackendSpawnReceipt> {
		const prior = this.receipts.get(input.handle.executionId);
		if (prior) return prior;
		if (!this.journal.findIntent(input.request.correlationId)) throw new Error("intent was not durable before spawn");
		this.spawnCount += 1;
		const receipt = { receiptDigest: digest("e") };
		this.receipts.set(input.handle.executionId, receipt);
		if (this.loseNextResponse) {
			this.loseNextResponse = false;
			throw new Error("response_lost_after_spawn");
		}
		return receipt;
	}
}

describe("R5 managed process manager", () => {
	it("durably records intent before spawn and makes create idempotent", async () => {
		const journal = new FakeJournal();
		const backend = new FakeBackend(journal);
		const manager = new ProcessManager(journal, backend);
		const first = await manager.create(request("manager"));
		if (!first.ok) throw new Error("first create failed");
		const retried = await manager.create(request("manager"));
		expect(retried).toEqual(first);
		expect(backend.spawnCount).toBe(1);
		expect(journal.events.map((event) => event.type)).toEqual([
			"process.execution_requested",
			"process.execution_starting",
			"process.execution_started",
		]);
	});

	it("rejects a reused command ID whose request digest changed", async () => {
		const journal = new FakeJournal();
		const backend = new FakeBackend(journal);
		const manager = new ProcessManager(journal, backend);
		expect((await manager.create(request("manager"))).ok).toBe(true);
		const conflicting = { ...request("manager"), requestDigest: digest("different") };
		expect(await manager.create(conflicting)).toEqual({ ok: false, code: "command_id_conflict" });
		expect(backend.spawnCount).toBe(1);
	});

	it("uses the same safe handle shape for foreground and background execution", async () => {
		const foregroundJournal = new FakeJournal();
		const foregroundManager = new ProcessManager(foregroundJournal, new FakeBackend(foregroundJournal));
		const foreground = await foregroundManager.create(request("foreground"));
		const backgroundJournal = new FakeJournal();
		const background = await new ProcessManager(backgroundJournal, new FakeBackend(backgroundJournal)).create(request("background", "background"));
		if (!foreground.ok || !background.ok) throw new Error("create failed");
		expect(Object.keys(foreground.handle).sort()).toEqual(Object.keys(background.handle).sort());
		expect(background.summary.state).toBe("backgrounded");
	});

	it("does not spawn twice after a started response is lost and rebuilds from journal", async () => {
		const journal = new FakeJournal();
		const backend = new FakeBackend(journal);
		backend.loseNextResponse = true;
		const manager = new ProcessManager(journal, backend);
		const first = await manager.create(request("recovery"));
		expect(first).toMatchObject({ ok: false, code: "uncertain_outcome" });
		const recovered = await manager.create(request("recovery"));
		expect(recovered.ok).toBe(true);
		expect(backend.spawnCount).toBe(1);
		if (!recovered.ok) return;
		const rebuilt = await new ProcessManager(journal, backend).create(request("recovery"));
		expect(rebuilt).toEqual(recovered);
	});

	it("rejects mutation after an immutable terminal event", async () => {
		const journal = new FakeJournal();
		const manager = new ProcessManager(journal, new FakeBackend(journal));
		const created = await manager.create(request("terminal"));
		if (!created.ok) throw new Error("create failed");
		const previous = journal.events.at(-1);
		if (!previous) throw new Error("missing started event");
		await journal.append(createProcessEvent({
			handle: created.handle,
			sequence: previous.sequence + 1,
			revision: previous.revision + 1,
			type: "process.execution_terminal",
			previousState: "running",
			nextState: "completed",
			previousEventHash: previous.eventHash,
			commandId: createRuntimeId("command", "terminal"),
		}));
		const projection = projectProcessEvents(journal.events);
		expect(projection).toMatchObject({ ok: true, state: { state: "completed" } });
		expect(manager.mutate(created.handle, "write")).toEqual({ ok: false, code: "terminal_state_immutable" });
	});
});
