import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmbeddedSessionRuntime } from "../../../src/cli/embedded-session-runtime.ts";
import { SessionInteractiveController } from "../../../src/cli/session-interactive-controller.ts";
import { claimDriver, fetchDomainSnapshot } from "../../../src/cli/main.ts";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { standardHarnessProfileRef } from "../../../src/runtime/harness-profiles/index.ts";
import { isValidGoalModeState } from "../../../src/runtime/modes/goal/reducer.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { AuthStorage } from "../../../src/storage/auth-storage.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { loadProjectSettings } from "../../../src/storage/settings-manager.ts";
import { builtinModels } from "../../../src/providers/all.ts";

const noPromptTestSecurity = [{
	source: "cli" as const,
	read: async () => ({ status: "available" as const, text: JSON.stringify({ profile: "danger-full-access" }) }),
}];

async function openGoalSession(seed: string) {
	const root = mkdtempSync(resolve(tmpdir(), `runledger-goal-${seed}-`));
	const home = resolve(root, "home");
	mkdirSync(home, { recursive: true, mode: 0o700 });
	const layout = buildRunledgerLayout(home, "posix");
	const db = openSessionDatabase(layout.database);
	installSessionStoreSchema(db);
	const store = new SessionStore(db);
	const ownerStore = new OwnerStore(db);
	const sessionId = createRuntimeId("session", `goal-${seed}`);
	store.createSession({
		sessionId,
		workspaceId: createRuntimeId("workspace", `goal-${seed}`),
		repositoryId: createRuntimeId("repository", `goal-${seed}`),
		settingsDigest: "d".repeat(64),
		harnessProfile: standardHarnessProfileRef(),
	});
	const settings = await loadProjectSettings({ layout });
	const models = builtinModels({ credentials: AuthStorage.create(layout) });
	await models.refresh({ allowNetwork: false });
	const embedded = await createEmbeddedSessionRuntime({
		sessionId,
		store,
		ownerStore,
		domain: { cwd: root, layout, settings, models, securitySources: noPromptTestSecurity },
	});
	// mutation 走 owner-fenced domain 路由，必须先成为本 session 的 driver。
	const controller = new SessionInteractiveController(embedded.handle, await fetchDomainSnapshot(embedded));
	await claimDriver(embedded, controller);
	const cleanup = async () => {
		controller.dispose();
		await embedded.handle.close().catch(() => undefined);
		await embedded.runtime?.shutdownAfterLastAttachment("paused");
		db.close();
		rmSync(root, { recursive: true, force: true });
	};
	return { sessionId, store, controller, cleanup };
}

describe("SessionRuntime Goal domain", () => {
	it("serves a canonical goal through the owner-fenced mutation and query path", async () => {
		const { sessionId, store, controller, cleanup } = await openGoalSession("lifecycle");
		try {
			expect(controller.supports("goal.inspect")).toBe(true);

			const inspect = await controller.querySessionDomain("goal.inspect", {}, { correlationId: "c-goal-0", effectId: "e-goal-0" });
			expect(inspect.ok).toBe(true);
			if (!inspect.ok) return;
			const initial = inspect.value.state as { readonly status: string; readonly revision: number };
			expect(initial).toMatchObject({ status: "inactive", revision: 0 });
			expect(isValidGoalModeState(inspect.value.state)).toBe(true);

			const created = await controller.commandSessionDomain("goal.set", {
				objective: "Ship the goal mode adaptation.",
				budget: { tokenBudget: 1_000 },
				setBy: "user",
			}, { correlationId: "c-goal-1", effectId: "e-goal-1", expectedRevision: 0 });
			expect(created.ok, JSON.stringify(created)).toBe(true);
			if (!created.ok) return;
			expect(created.value.state).toMatchObject({ status: "active", revision: 1, objective: "Ship the goal mode adaptation." });

			// 预算耗尽只在完整度确证时成立；partial 下 tokensUsed 是下界。
			const partial = await controller.commandSessionDomain("goal.account_usage", {
				delta: { tokensUnknown: true },
			}, { correlationId: "c-goal-2", effectId: "e-goal-2", expectedRevision: 1 });
			expect(partial.ok).toBe(true);
			const exhausted = await controller.commandSessionDomain("goal.account_usage", {
				delta: { inputTokens: 5_000 },
			}, { correlationId: "c-goal-3", effectId: "e-goal-3", expectedRevision: 2 });
			expect(exhausted.ok).toBe(true);
			if (!exhausted.ok) return;
			expect(exhausted.value.state).toMatchObject({
				status: "active",
				usage: { tokensUsed: 5_000, accountingCompleteness: "partial", unaccountedTurns: 1 },
			});

			// 模型断言完成只登记请求；结算由用户决定。
			const requested = await controller.commandSessionDomain("goal.request_complete", { requestedBy: "agent" }, {
				correlationId: "c-goal-4", effectId: "e-goal-4", expectedRevision: 3,
			});
			expect(requested.ok).toBe(true);
			if (!requested.ok) return;
			expect(requested.value.state).toMatchObject({ status: "active", completion: { requestedBy: "agent" } });

			const settled = await controller.commandSessionDomain("goal.settle_complete", { decision: "approved" }, {
				correlationId: "c-goal-5", effectId: "e-goal-5", expectedRevision: 4,
			});
			expect(settled.ok).toBe(true);
			if (!settled.ok) return;
			expect(settled.value.state).toMatchObject({ status: "complete" });

			// 事件真源：每次转移都落一条 owner-fenced durable event，类型与操作对应。
			const goalEvents = store.replaySessionEvents(sessionId).filter((event) => event.eventType.startsWith("goal."));
			expect(goalEvents.map((event) => event.eventType)).toEqual([
				"goal.transitioned",     // set
				"goal.usage_accounted",  // partial 记账
				"goal.usage_accounted",  // 预算是 1000，5000 只是下界，完整度 partial ⇒ 不判耗尽
				"goal.transitioned",     // request_complete
				"goal.transitioned",     // settle_complete
			]);
			for (const event of goalEvents) {
				expect(JSON.parse(event.payloadJson)).toMatchObject({ schema: "runledger.session-goal.current", sessionId });
			}
		} finally {
			await cleanup();
		}
	});

	it("rejects a stale revision and a second goal on the same session", async () => {
		const { controller, cleanup } = await openGoalSession("conflict");
		try {
			await controller.commandSessionDomain("goal.set", { objective: "first", setBy: "user" }, {
				correlationId: "c-first", effectId: "e-first", expectedRevision: 0,
			});
			const stale = await controller.commandSessionDomain("goal.set", { objective: "second", setBy: "user" }, {
				correlationId: "c-stale", effectId: "e-stale", expectedRevision: 0,
			});
			expect(stale.ok).toBe(false);
			const duplicate = await controller.commandSessionDomain("goal.set", { objective: "second", setBy: "user" }, {
				correlationId: "c-dup", effectId: "e-dup", expectedRevision: 1,
			});
			expect(duplicate.ok).toBe(false);
		} finally {
			await cleanup();
		}
	});
});
