import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { canonicalDigest } from "../../../src/runtime/protocol/canonical-json.ts";
import type { RuntimeDigest } from "../../../src/runtime/protocol/foundation.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import {
	ProcessManager,
	type BackendSpawnPort,
	type BackendSpawnReceipt,
} from "../../../src/runtime/process/manager.ts";
import type { ManagedProcessRequest } from "../../../src/runtime/process/types.ts";
import { JsonlProcessJournal } from "../../../src/storage/process/recovery-store.ts";
import { createManagedProcessRecoveryPort } from "../../../src/runtime/host/lifecycle.ts";

const digest = (seed: string): RuntimeDigest => ({
	algorithm: "sha256",
	digest: canonicalDigest(seed) as RuntimeDigest["digest"],
});

function request(): ManagedProcessRequest {
	return {
		authorityId: createRuntimeId("authority", "recovery-store"),
		tenantId: createRuntimeId("tenant", "recovery-store"),
		workspaceId: createRuntimeId("workspace", "recovery-store"),
		sessionId: createRuntimeId("session", "recovery-store"),
		hostGeneration: 1,
		sessionGeneration: 1,
		requestDigest: digest("a"),
		commandRef: { subjectKind: "content", digest: digest("command"), mediaType: "text/plain", size: 1 },
		cwdRef: { subjectKind: "content", digest: digest("cwd"), mediaType: "text/plain", size: 1 },
		backend: "pipe",
		executionMode: "background",
		correlationId: createRuntimeId("command", "recovery-store"),
	};
}

class CountingBackend implements BackendSpawnPort {
	public spawnCount = 0;
	public loseNextResponse = false;

	public async spawn(): Promise<BackendSpawnReceipt> {
		this.spawnCount += 1;
		if (this.loseNextResponse) {
			this.loseNextResponse = false;
			throw new Error("response_lost_after_spawn");
		}
		return { receiptDigest: digest("receipt") };
	}
}

describe("R7 durable process recovery journal", () => {
	it("reloads intent, event chain, claim, receipt, and capacity without spawning again", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-process-recovery-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const options = { layout, workspaceStorageKey: "ws-" + "a".repeat(64) };
			const firstJournal = new JsonlProcessJournal(options);
			const firstBackend = new CountingBackend();
			const first = await new ProcessManager(firstJournal, firstBackend).create(request());
			const requestValue = request();
			const identityDigest = canonicalDigest({ commandId: requestValue.correlationId, requestDigest: requestValue.requestDigest });
			firstJournal.eventsFor({
				authorityId: requestValue.authorityId,
				tenantId: requestValue.tenantId,
				workspaceId: requestValue.workspaceId,
				sessionId: requestValue.sessionId,
				hostGeneration: 1,
				sessionGeneration: 1,
				executionId: createRuntimeId("execution", identityDigest),
				attemptId: createRuntimeId("attempt", `${identityDigest}_1`),
				revision: 0,
				requestDigest: requestValue.requestDigest,
			});
			expect(first.ok).toBe(true);
			expect(firstBackend.spawnCount).toBe(1);

			const secondJournal = new JsonlProcessJournal(options);
			const secondBackend = new CountingBackend();
			const second = await new ProcessManager(secondJournal, secondBackend).create(request());
			expect(second).toEqual(first);
			expect(secondBackend.spawnCount).toBe(0);
			if (!first.ok) return;
			expect(secondJournal.eventsFor(first.handle)).toHaveLength(3);
			expect(secondJournal.hasSpawnClaim(first.handle)).toBe(true);
			expect(secondJournal.spawnReceipt(first.handle)).toEqual({ receiptDigest: digest("receipt") });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not expose the private journal locator through a public process result", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-process-recovery-shape-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const journal = new JsonlProcessJournal({ layout, workspaceStorageKey: "ws-" + "b".repeat(64) });
			const result = await new ProcessManager(journal, new CountingBackend()).create({ ...request(), correlationId: createRuntimeId("command", "recovery-shape") });
			expect(JSON.stringify(result)).not.toMatch(/(?:absolutePath|spool|journal|pid|commandRef|cwdRef)/iu);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("projects an in-flight process to uncertain after Host restart without reattaching by PID", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-process-recovery-uncertain-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const options = { layout, workspaceStorageKey: "ws-" + "c".repeat(64) };
			const journal = new JsonlProcessJournal(options);
			const first = await new ProcessManager(journal, new CountingBackend()).create(request());
			expect(first.ok).toBe(true);
			if (!first.ok) return;
			const recoveredJournal = new JsonlProcessJournal(options);
			const recoveredManager = new ProcessManager(recoveredJournal, new CountingBackend());
			const recovered = await createManagedProcessRecoveryPort(recoveredManager)();
			expect(recovered).toEqual([{ id: first.handle.executionId, state: "uncertain" }]);
			expect(recoveredManager.query(first.handle)).toMatchObject({ ok: true, summary: { state: "uncertain" } });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("does not respawn a durable claim after a cross-instance spawn response loss", async () => {
		const root = await mkdtemp(join(tmpdir(), "runledger-process-recovery-claim-"));
		try {
			const layout = buildRunledgerLayout(join(root, "home"), "posix");
			const options = { layout, workspaceStorageKey: "ws-" + "d".repeat(64) };
			const firstJournal = new JsonlProcessJournal(options);
			const firstBackend = new CountingBackend();
			firstBackend.loseNextResponse = true;
			const first = await new ProcessManager(firstJournal, firstBackend).create(request());
			expect(first).toEqual({ ok: false, code: "uncertain_outcome" });
			expect(firstBackend.spawnCount).toBe(1);

			const secondJournal = new JsonlProcessJournal(options);
			const secondBackend = new CountingBackend();
			const second = await new ProcessManager(secondJournal, secondBackend).create(request());
			expect(second).toEqual({ ok: false, code: "uncertain_outcome" });
			expect(secondBackend.spawnCount).toBe(0);

			const recoveredManager = new ProcessManager(secondJournal, secondBackend);
			const recovered = await createManagedProcessRecoveryPort(recoveredManager)();
			expect(recovered).toHaveLength(1);
			expect(recovered[0]?.state).toBe("uncertain");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
