import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmbeddedSessionRuntime } from "../../../src/cli/embedded-session-runtime.ts";
import { claimDriver, fetchDomainSnapshot, pauseIfLastAttachment } from "../../../src/cli/main.ts";
import { SessionInteractiveController } from "../../../src/cli/session-interactive-controller.ts";
import { builtinModels } from "../../../src/providers/all.ts";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { standardHarnessProfileRef } from "../../../src/runtime/harness-profiles/index.ts";
import { isValidGoalModeState } from "../../../src/runtime/modes/goal/reducer.ts";
import type { GoalModeState } from "../../../src/runtime/modes/goal/types.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { AuthStorage } from "../../../src/storage/auth-storage.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";

const noPromptTestSecurity = [{
	source: "cli" as const,
	read: async () => ({ status: "available" as const, text: JSON.stringify({ profile: "danger-full-access", approvalPolicy: "never" }) }),
}];

/** 统计 `load()` 触发的完整重放次数；写路径只允许读链尾。 */
function instrumentReplay(store: SessionStore): { readonly fullReplays: () => number } {
	let full = 0;
	const replay = store.replaySessionEvents.bind(store);
	store.replaySessionEvents = (sessionId: string) => {
		full += 1;
		return replay(sessionId);
	};
	return { fullReplays: () => full };
}

describe("goal projection cache and restart parity", () => {
	it("does not replay the goal event stream on inspect or on the write path, and restores the same state", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-goal-cache-"));
		const home = join(root, "home");
		mkdirSync(home);
		const layout = buildRunledgerLayout(home, "posix");
		const db = openSessionDatabase(layout.database);
		installSessionStoreSchema(db);
		const store = new SessionStore(db);
		const ownerStore = new OwnerStore(db);
		const sessionId = createRuntimeId("session", "goal-cache");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "goal-cache"),
			repositoryId: createRuntimeId("repository", "goal-cache"),
			settingsDigest: "d".repeat(64),
			harnessProfile: standardHarnessProfileRef(2),
		});
		const models = builtinModels({ credentials: AuthStorage.create(layout) });
		await models.refresh({ allowNetwork: false });
		const domainOptions = { cwd: root, layout, models, settings: { autoTitle: false }, securitySources: noPromptTestSecurity };
		let embedded: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>> | undefined;
		let client: SessionInteractiveController | undefined;
		try {
			embedded = await createEmbeddedSessionRuntime({ sessionId, store, ownerStore, domain: domainOptions });
			client = new SessionInteractiveController(embedded.handle, await fetchDomainSnapshot(embedded));
			await claimDriver(embedded, client);
			const created = await client.commandSessionDomain("goal.set", {
				objective: "Keep the goal canonical.", budget: { tokenBudget: 100_000 }, setBy: "user",
			}, { correlationId: "create", effectId: "create", expectedRevision: 0 });
			if (!created.ok || !isValidGoalModeState(created.value.state)) throw new Error("goal create failed");

			const counter = instrumentReplay(store);
			let state: GoalModeState = created.value.state;
			for (let index = 0; index < 12; index += 1) {
				const accounted = await client.commandSessionDomain("goal.account_usage", {
					delta: { inputTokens: 10, cacheWriteTokens: 1, outputTokens: 2 },
				}, { correlationId: `usage-${index}`, effectId: `usage-${index}`, expectedRevision: state.revision });
				if (!accounted.ok || !isValidGoalModeState(accounted.value.state)) throw new Error(`goal usage ${index} failed`);
				state = accounted.value.state;
			}
			for (let index = 0; index < 12; index += 1) {
				const inspected = await client.querySessionDomain("goal.inspect", {}, { correlationId: `inspect-${index}`, effectId: `inspect-${index}` });
				// 12 次记账已完成；inspect 只读缓存，不推进状态。
				expect(inspected).toMatchObject({ ok: true, value: { state: { status: "active", usage: { tokensUsed: 12 * 13 } } } });
			}
			// 每次 inspect 都是缓存读取：12 次写入 + 之后的查询都不重放 goal 流。
			expect(counter.fullReplays()).toBe(0);
			expect(state.usage.tokensUsed).toBe(12 * 13);

			// 缓存失效后仍给出同一状态：新 owner 完整重放，与重启前逐字节一致。
			const beforeRestart = state;
			client.dispose();
			client = undefined;
			await embedded.handle.close();
			await pauseIfLastAttachment(embedded, true, true);
			embedded = await createEmbeddedSessionRuntime({ sessionId, store, ownerStore, domain: domainOptions });
			client = new SessionInteractiveController(embedded.handle, await fetchDomainSnapshot(embedded));
			const restored = await client.querySessionDomain("goal.inspect", {}, { correlationId: "restored", effectId: "restored" });
			expect(restored.ok).toBe(true);
			if (!restored.ok) return;
			expect(restored.value.state).toEqual(beforeRestart);
			expect(isValidGoalModeState(restored.value.state)).toBe(true);
		} finally {
			client?.dispose();
			await embedded?.handle.close().catch(() => undefined);
			await embedded?.runtime?.shutdownAfterLastAttachment("paused");
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns the cached idempotent result for a repeated requestId instead of committing twice", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-goal-idempotent-"));
		const home = join(root, "home");
		mkdirSync(home);
		const layout = buildRunledgerLayout(home, "posix");
		const db = openSessionDatabase(layout.database);
		installSessionStoreSchema(db);
		const store = new SessionStore(db);
		const ownerStore = new OwnerStore(db);
		const sessionId = createRuntimeId("session", "goal-idempotent");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "goal-idempotent"),
			repositoryId: createRuntimeId("repository", "goal-idempotent"),
			settingsDigest: "d".repeat(64),
			harnessProfile: standardHarnessProfileRef(2),
		});
		const models = builtinModels({ credentials: AuthStorage.create(layout) });
		await models.refresh({ allowNetwork: false });
		let embedded: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>> | undefined;
		let client: SessionInteractiveController | undefined;
		try {
			embedded = await createEmbeddedSessionRuntime({
				sessionId, store, ownerStore,
				domain: { cwd: root, layout, models, settings: { autoTitle: false }, securitySources: noPromptTestSecurity },
			});
			client = new SessionInteractiveController(embedded.handle, await fetchDomainSnapshot(embedded));
			await claimDriver(embedded, client);
			const context = { correlationId: "same", effectId: "same", expectedRevision: 0 };
			const first = await client.commandSessionDomain("goal.set", { objective: "same objective", setBy: "user" }, context);
			const second = await client.commandSessionDomain("goal.set", { objective: "same objective", setBy: "user" }, context);
			expect(first.ok).toBe(true);
			expect(second).toEqual(first);
			// 同一 requestId 不得二次提交：只有一条 set 事件。
			const transitions = store.replaySessionEvents(sessionId).filter((event) => event.eventType === "goal.transitioned");
			expect(transitions).toHaveLength(1);
			// 同一 requestId 携带不同 payload 必须报幂等冲突，而不是静默返回旧结果。
			const conflicting = await client.commandSessionDomain("goal.set", { objective: "different objective", setBy: "user" }, context);
			expect(conflicting).toMatchObject({ ok: false, code: "goal_idempotency_conflict" });
		} finally {
			client?.dispose();
			await embedded?.handle.close().catch(() => undefined);
			await embedded?.runtime?.shutdownAfterLastAttachment("paused");
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
