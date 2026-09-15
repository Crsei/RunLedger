import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmbeddedSessionRuntime } from "../../../src/cli/embedded-session-runtime.ts";
import { claimDriver, fetchDomainSnapshot, pauseIfLastAttachment } from "../../../src/cli/main.ts";
import { SessionInteractiveController } from "../../../src/cli/session-interactive-controller.ts";
import { builtinModels } from "../../../src/providers/all.ts";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { isValidPlanModeState } from "../../../src/runtime/modes/plan/reducer.ts";
import { standardHarnessProfileRef } from "../../../src/runtime/harness-profiles/index.ts";
import type { PlanModeState } from "../../../src/runtime/modes/plan/types.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { AuthStorage } from "../../../src/storage/auth-storage.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";

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

describe("plan projection cache", () => {
	it("does not replay the plan event stream on inspect or on the write path", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-plan-cache-"));
		const home = join(root, "home"); mkdirSync(home);
		const layout = buildRunledgerLayout(home, "posix");
		const db = openSessionDatabase(layout.database); installSessionStoreSchema(db);
		const store = new SessionStore(db); const ownerStore = new OwnerStore(db);
		const sessionId = createRuntimeId("session", "plan-cache");
		store.createSession({
			sessionId, workspaceId: createRuntimeId("workspace", "plan-cache"),
			repositoryId: createRuntimeId("repository", "plan-cache"),
			settingsDigest: "d".repeat(64), harnessProfile: standardHarnessProfileRef(2),
		});
		const models = builtinModels({ credentials: AuthStorage.create(layout) }); await models.refresh({ allowNetwork: false });
		let embedded: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>> | undefined;
		let client: SessionInteractiveController | undefined;
		try {
			embedded = await createEmbeddedSessionRuntime({
				sessionId, store, ownerStore,
				domain: {
					cwd: root, layout, models, settings: { autoTitle: false },
					securitySources: [{ source: "cli" as const, read: async () => ({ status: "available" as const, text: JSON.stringify({ profile: "danger-full-access", approvalPolicy: "never" }) }) }],
				},
			});
			client = new SessionInteractiveController(embedded.handle, await fetchDomainSnapshot(embedded));
			await claimDriver(embedded, client);
			const entered = await client.commandSessionDomain("plan.enter", { expectedRevision: 0 }, { correlationId: "enter", effectId: "enter", expectedRevision: 0 });
			if (!entered.ok || !isValidPlanModeState(entered.value.state)) throw new Error("plan enter failed");

			const counter = instrumentReplay(store);
			let state: PlanModeState = entered.value.state;
			let revision = 0;
			for (let index = 0; index < 12; index += 1) {
				const written = await client.commandSessionDomain("plan.write", {
					expectedRevision: state.revision, expectedPlanRevision: revision, content: `# Plan revision ${index}\n\n${"detail ".repeat(40)}`,
				}, { correlationId: `write-${index}`, effectId: `write-${index}`, expectedRevision: state.revision });
				if (!written.ok || !isValidPlanModeState(written.value.state)) throw new Error(`plan write ${index} failed`);
				state = written.value.state;
				revision = state.plan!.revision;
			}
			// 每次 inspect 都是缓存读取：12 次写入 + 之后的查询都不重放 plan 流。
			for (let index = 0; index < 12; index += 1) {
				const inspected = await client.querySessionDomain("plan.inspect", {}, { correlationId: `inspect-${index}`, effectId: `inspect-${index}` });
				expect(inspected).toMatchObject({ ok: true, value: { state: { status: "active", plan: { revision } } } });
			}
			expect(counter.fullReplays()).toBe(0);

			// 缓存失效后仍能给出同一投影：新 owner 完整重放并与重启前一致。
			const beforeRestart = state;
			client.dispose(); client = undefined;
			await embedded.handle.close(); await pauseIfLastAttachment(embedded, true, true);
			embedded = await createEmbeddedSessionRuntime({
				sessionId, store, ownerStore,
				domain: {
					cwd: root, layout, models, settings: { autoTitle: false },
					securitySources: [{ source: "cli" as const, read: async () => ({ status: "available" as const, text: JSON.stringify({ profile: "danger-full-access", approvalPolicy: "never" }) }) }],
				},
			});
			client = new SessionInteractiveController(embedded.handle, await fetchDomainSnapshot(embedded));
			const restored = await client.querySessionDomain("plan.inspect", {}, { correlationId: "restored", effectId: "restored" });
			expect(restored).toMatchObject({
				ok: true,
				value: { state: { status: "active", revision: beforeRestart.revision, plan: { revision: 12, digest: beforeRestart.plan!.digest } } },
			});
		} finally {
			client?.dispose(); await embedded?.handle.close().catch(() => undefined); await embedded?.runtime?.shutdownAfterLastAttachment("paused"); db.close(); rmSync(root, { recursive: true, force: true });
		}
	});
});
