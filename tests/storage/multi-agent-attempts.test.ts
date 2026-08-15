import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntimeId, type SessionId } from "../../src/runtime/protocol/ids.ts";
import { canonicalDigest } from "../../src/runtime/protocol/canonical-json.ts";
import type { CommandAttemptBeginInput, OwnerFence } from "../../src/runtime/session-owner/types.ts";
import { openSessionDatabase } from "../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../src/storage/session-store/session-store.ts";
import { createRuntimeHarness, type RuntimeHarness } from "../runtime/session-runtime/harness.ts";

let directory: string;
const runtimes: RuntimeHarness[] = [];

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "runledger-multi-agent-attempts-"));
});

afterEach(async () => {
	for (const runtime of runtimes.splice(0)) {
		await runtime.runtime.shutdownAfterLastAttachment("paused");
		runtime.store.database().close();
		runtime.cleanup();
	}
	rmSync(directory, { recursive: true, force: true });
});

function openStore(): { readonly store: SessionStore; readonly sessionId: SessionId; readonly fence: OwnerFence } {
	const database = openSessionDatabase(join(directory, "state.db"));
	installSessionStoreSchema(database);
	const store = new SessionStore(database);
	const sessionId = createRuntimeId("session", "attempts");
	const runtimeId = createRuntimeId("runtime", "attempts");
	store.createSession({
		sessionId,
		workspaceId: createRuntimeId("workspace", "w"),
		repositoryId: createRuntimeId("repository", "r"),
		settingsDigest: "d".repeat(64),
	});
	database.runSync(
		"INSERT INTO session_owners (session_id, runtime_id, generation, state, updated_at_ms) VALUES (?, ?, 1, 'running', 1)",
		[sessionId, runtimeId],
	);
	return { store, sessionId, fence: { sessionId, runtimeId, generation: 1 } };
}

function requestDigest(seed: string) {
	return { algorithm: "sha256" as const, digest: canonicalDigest({ seed }) as string & { readonly __sha256Digest: true } };
}

function beginInput(sessionId: SessionId, commandSeed: string, attemptSeed: string, seed = commandSeed): CommandAttemptBeginInput {
	return {
		sessionId,
		commandId: createRuntimeId("command", commandSeed),
		attemptId: createRuntimeId("attempt", attemptSeed),
		effectClass: "agent_spawn",
		requestDigest: requestDigest(seed),
		originGeneration: 1,
		createdAtMs: 1,
	};
}

describe("stable bounded child attempt identity", () => {
	it("rolls back both command intent and started receipt when the atomic transaction fails", () => {
		const { store, sessionId, fence } = openStore();
		store.database().execSync(
			"CREATE TRIGGER fail_multi_agent_command AFTER INSERT ON commands BEGIN SELECT RAISE(ABORT, 'injected begin failure'); END;",
		);

		expect(() => store.beginCommandAttempt(fence, beginInput(sessionId, "atomic", "atomic"))).toThrow(/injected begin failure/u);
		expect(store.database().querySingle("SELECT COUNT(*) AS n FROM commands WHERE session_id = ?", [sessionId])?.n).toBe(0);
		expect(store.database().querySingle("SELECT COUNT(*) AS n FROM command_attempt_receipts WHERE session_id = ?", [sessionId])?.n).toBe(0);
		store.database().close();
	});

	it("replays a committed command and reports a digest conflict without starting another attempt", () => {
		const { store, sessionId, fence } = openStore();
		const input = beginInput(sessionId, "replay", "replay");
		const started = store.beginCommandAttempt(fence, input);
		expect(started).toMatchObject({ status: "started", commandId: input.commandId, attemptId: input.attemptId });
		store.appendAttemptReceipt(fence, {
			receiptId: createRuntimeId("receipt", "replay-committed"),
			sessionId,
			commandId: input.commandId,
			attemptId: input.attemptId,
			originGeneration: 1,
			settledGeneration: 1,
			effectClass: input.effectClass,
			outcome: "committed",
			resultDigest: requestDigest("result"),
			createdAtMs: 2,
		});

		const replay = store.beginCommandAttempt(fence, input);
		expect(replay).toMatchObject({ status: "replay_committed", commandId: input.commandId, attemptId: input.attemptId });
		if (replay.status === "replay_committed") expect(replay.receipt.outcome).toBe("committed");

		const conflict = store.beginCommandAttempt(fence, { ...input, requestDigest: requestDigest("different") });
		expect(conflict).toMatchObject({ status: "conflict", commandId: input.commandId });
		expect(store.listAttemptReceipts(sessionId, input.commandId)).toHaveLength(2);
		store.database().close();
	});

	it("returns recovery_required for an existing command whose attempt is not terminal", () => {
		const { store, sessionId, fence } = openStore();
		const input = beginInput(sessionId, "uncertain", "uncertain");
		expect(store.beginCommandAttempt(fence, input)).toMatchObject({ status: "started" });

		const retry = store.beginCommandAttempt(fence, {
			...input,
			attemptId: createRuntimeId("attempt", "uncertain-retry"),
		});
		expect(retry).toMatchObject({ status: "recovery_required", commandId: input.commandId });
		store.database().close();
	});

	it("rejects agent spawn at the recovery barrier while a readonly attempt remains admissible", async () => {
		const runtime = await createRuntimeHarness("agent-spawn-barrier", { crashTakeover: true });
		runtimes.push(runtime);

		const spawn = runtime.runtime.beginAttempt({
			commandId: createRuntimeId("command", "barrier-spawn"),
			attemptId: createRuntimeId("attempt", "barrier-spawn"),
			effectClass: "agent_spawn",
			requestDigest: requestDigest("spawn"),
		});
		const inspect = runtime.runtime.beginAttempt({
			commandId: createRuntimeId("command", "barrier-inspect"),
			attemptId: createRuntimeId("attempt", "barrier-inspect"),
			effectClass: "readonly",
			requestDigest: requestDigest("inspect"),
		});

		expect(spawn).toEqual({ error: "recovery_barrier_active" });
		expect(inspect).toMatchObject({ status: "started", commandId: "command_barrier-inspect", attemptId: "attempt_barrier-inspect" });
		expect(runtime.runtime.sideEffectSpawnCount).toBe(0);
	});
});
