import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createEmbeddedSessionRuntime } from "../../../src/cli/embedded-session-runtime.ts";
import { claimDriver, fetchDomainSnapshot, pauseIfLastAttachment } from "../../../src/cli/main.ts";
import { SessionInteractiveController } from "../../../src/cli/session-interactive-controller.ts";
import { builtinModels } from "../../../src/providers/all.ts";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { standardHarnessProfileRef } from "../../../src/runtime/harness-profiles/index.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import type { SessionDomainPort } from "../../../src/runtime/session-runtime/session-runtime.ts";
import type { SessionGoalContinuationController } from "../../../src/runtime/session-runtime/goal-continuation-controller.ts";
import type { AgentRunTerminationReason } from "../../../src/runtime/types.ts";
import { AuthStorage } from "../../../src/storage/auth-storage.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";

async function harness() {
	const root = mkdtempSync(join(tmpdir(), "runledger-goal-budget-"));
	const home = join(root, "home"); mkdirSync(home);
	const layout = buildRunledgerLayout(home, "posix");
	const db = openSessionDatabase(layout.database); installSessionStoreSchema(db);
	const store = new SessionStore(db);
	const sessionId = createRuntimeId("session", "goal-budget");
	store.createSession({ sessionId, workspaceId: createRuntimeId("workspace", "goal-budget"), repositoryId: createRuntimeId("repository", "goal-budget"), settingsDigest: "d".repeat(64), harnessProfile: standardHarnessProfileRef() });
	const models = builtinModels({ credentials: AuthStorage.create(layout) }); await models.refresh({ allowNetwork: false });
	const options = { sessionId, store, ownerStore: new OwnerStore(db), domain: { cwd: root, layout, models, settings: { autoTitle: false },
		securitySources: [{ source: "cli" as const, read: async () => ({ status: "available" as const, text: JSON.stringify({ profile: "danger-full-access", approvalPolicy: "never" }) }) }],
	} };
	let embedded = await createEmbeddedSessionRuntime(options);
	let client = new SessionInteractiveController(embedded.handle, await fetchDomainSnapshot(embedded));
	await claimDriver(embedded, client);
	const internals = () => embedded.runtime as unknown as { domain: SessionDomainPort; goalContinuation: SessionGoalContinuationController };
	const goal = () => internals().domain.goalRuntime!;
	let serial = 0;
	const mutate = async (operation: string, payload: Record<string, unknown> = {}) => {
		const id = `command-${++serial}`;
		const result = await client.commandSessionDomain(operation, payload, { correlationId: id, effectId: id, expectedRevision: goal().inspect().state.revision });
		expect(result.ok, JSON.stringify(result)).toBe(true);
	};
	return { goal, mutate, internals, store, sessionId, warnings: () => client.warnings,
		restart: async () => {
			client.dispose(); await embedded.handle.close(); await pauseIfLastAttachment(embedded, true, true);
			embedded = await createEmbeddedSessionRuntime(options);
			client = new SessionInteractiveController(embedded.handle, await fetchDomainSnapshot(embedded)); await claimDriver(embedded, client);
		},
		cleanup: async () => { client.dispose(); await embedded.handle.close(); await embedded.runtime?.shutdownAfterLastAttachment("paused"); db.close(); rmSync(root, { recursive: true, force: true }); },
	};
}

describe("goal run-budget pause through the production Owner", () => {
	it("reports pause persistence failure without pretending canonical state changed", async () => {
		const h = await harness();
		try {
			await h.mutate("goal.set", { objective: "persist failure", setBy: "user" });
			const pause = vi.spyOn(h.goal(), "pauseAfterRunBudget").mockResolvedValue(false);
			const scheduler = h.internals().goalContinuation;
			scheduler.handleDomainAgentEvent({ type: "agent_start", timestamp: 0, runId: "failed-pause" });
			scheduler.handleDomainAgentEvent({ type: "agent_end", timestamp: 1, runId: "failed-pause", stopReason: "stop", terminationReason: "model_turn_limit" });
			await expect.poll(() => h.warnings().some(warning => warning.includes("saving the paused state failed"))).toBe(true);
			expect(h.goal().inspect().state.status).toBe("active");
			await (scheduler as unknown as { fire(generation: number): Promise<void>; generation: number }).fire((scheduler as unknown as { generation: number }).generation);
			expect(h.goal().inspect().state.continuations).toBe(0);
			expect(pause).toHaveBeenCalledTimes(1);
			pause.mockRestore();
		} finally { await h.cleanup(); }
	});

	it("serializes usage before a durable pause for every termination reason and restores continuation history", async () => {
		const h = await harness();
		try {
			await h.mutate("goal.set", { objective: "Finish safely", setBy: "user" });
			await h.goal().recordContinuation();
			const reasons: AgentRunTerminationReason[] = ["model_turn_limit", "tool_turn_limit", "active_duration_limit", "repeated_tool_failure", "approval_expiration_limit"];
			for (const reason of reasons) {
				const scheduler = h.internals().goalContinuation;
				scheduler.handleDomainAgentEvent({ type: "agent_start", timestamp: 0, runId: reason });
				const usage = h.goal().accountUsage({ inputTokens: 3, outputTokens: 2 });
				scheduler.handleDomainAgentEvent({ type: "agent_end", timestamp: 1, runId: reason, stopReason: "stop", terminationReason: reason, activeDurationMs: 10 });
				await usage;
				await expect.poll(() => h.goal().inspect().state.status).toBe("paused");
				expect(h.goal().inspect().state.pauseReason).toBe(`run_budget:${reason}`);
				const revision = h.goal().inspect().state.revision;
				scheduler.handleDomainAgentEvent({ type: "agent_end", timestamp: 1, runId: reason, stopReason: "stop", terminationReason: reason });
				await h.goal().pauseAfterRunBudget(h.goal().controlRevision(), reason, reason);
				expect(h.goal().inspect().state.revision).toBe(revision);
				if (reason !== reasons.at(-1)) await h.mutate("goal.resume");
			}
			const before = h.goal().inspect().state;
			expect(before.usage).toMatchObject({ tokensUsed: 25, activeDurationMs: 50 });
			await h.restart();
			expect(h.goal().inspect().state).toEqual(before);
			expect(h.store.replaySessionEvents(h.sessionId).filter(event => event.eventType === "goal.transitioned" && JSON.parse(event.payloadJson).operation === "goal.pause")).toHaveLength(5);
		} finally { await h.cleanup(); }
	});

	it("does not let an old run pause a replacement or a goal explicitly paused and resumed", async () => {
		const h = await harness();
		try {
			await h.mutate("goal.set", { objective: "same text", setBy: "user" });
			let revision = h.goal().controlRevision();
			await h.mutate("goal.replace", { objective: "same text", setBy: "user" });
			expect(await h.goal().pauseAfterRunBudget(revision, "model_turn_limit", "old-run")).toBe(true);
			expect(h.goal().inspect().state.status).toBe("active");
			revision = h.goal().controlRevision();
			await h.mutate("goal.pause", { reason: "user_requested" });
			await h.mutate("goal.resume");
			expect(await h.goal().pauseAfterRunBudget(revision, "tool_turn_limit", "old-run")).toBe(true);
			expect(h.goal().inspect().state.status).toBe("active");
			await h.mutate("goal.drop");
			await h.goal().pauseAfterRunBudget(h.goal().controlRevision(), "tool_turn_limit", "old-run");
			expect(h.goal().inspect().state.status).toBe("dropped");
		} finally { await h.cleanup(); }
	});
});
