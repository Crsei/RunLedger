import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { AuthStorage } from "../../../src/storage/auth-storage.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";

const PLAN_BODY = "# Split PyO3 methods\n\n1. Edit src/handler.rs\n2. Run cargo test";

describe("plan artifact export", () => {
	it("writes an approved-revision projection under canonical home and records it durably", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-plan-export-"));
		const home = join(root, "home"); mkdirSync(home);
		const layout = buildRunledgerLayout(home, "posix");
		const db = openSessionDatabase(layout.database); installSessionStoreSchema(db);
		const store = new SessionStore(db); const ownerStore = new OwnerStore(db);
		const sessionId = createRuntimeId("session", "plan-export");
		store.createSession({
			sessionId, workspaceId: createRuntimeId("workspace", "plan-export"),
			repositoryId: createRuntimeId("repository", "plan-export"),
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

			// inactive 会话没有工件可导出。
			expect(await client.commandSessionDomain("plan.export", { expectedRevision: 0 }, { correlationId: "export-early", effectId: "export-early", expectedRevision: 0 }))
				.toMatchObject({ ok: false, code: "plan_export_requires_artifact" });

			const entered = await client.commandSessionDomain("plan.enter", { expectedRevision: 0 }, { correlationId: "enter", effectId: "enter", expectedRevision: 0 });
			if (!entered.ok || !isValidPlanModeState(entered.value.state)) throw new Error("plan enter failed");
			const written = await client.commandSessionDomain("plan.write", {
				expectedRevision: entered.value.state.revision, expectedPlanRevision: 0, content: PLAN_BODY,
			}, { correlationId: "write", effectId: "write", expectedRevision: entered.value.state.revision });
			if (!written.ok || !isValidPlanModeState(written.value.state)) throw new Error("plan write failed");

			const exported = await client.commandSessionDomain("plan.export", { expectedRevision: written.value.state.revision }, {
				correlationId: "export", effectId: "export", expectedRevision: written.value.state.revision,
			});
			expect(exported.ok).toBe(true);
			if (!exported.ok) throw new Error("plan export failed");
			const exportPath = typeof exported.value.exportPath === "string" ? exported.value.exportPath : undefined;
			expect(exportPath).toBeDefined();
			expect(exportPath!.startsWith(layout.plans)).toBe(true);
			expect(exportPath!.endsWith("SPLIT_PYO3_METHODS_PLAN.md")).toBe(true);
			expect(readFileSync(exportPath!, "utf8")).toBe(PLAN_BODY);
			// 导出不是状态转移：mode 与 revision 都不变。
			if (!isValidPlanModeState(exported.value.state)) throw new Error("plan export returned an invalid state");
			expect(exported.value.state).toMatchObject({ status: "active", plan: { revision: 1 } });
			expect(exported.value.state.revision).toBe(written.value.state.revision);

			// 重试（新 correlationId）不覆盖既有投影，而是按 -N 退避。
			const second = await client.commandSessionDomain("plan.export", { expectedRevision: written.value.state.revision }, {
				correlationId: "export-again", effectId: "export-again", expectedRevision: written.value.state.revision,
			});
			expect(second).toMatchObject({ ok: true });
			if (!second.ok) throw new Error("second export failed");
			const secondPath = typeof second.value.exportPath === "string" ? second.value.exportPath : undefined;
			expect(secondPath).not.toBe(exportPath);
			expect(secondPath!.endsWith("SPLIT_PYO3_METHODS_PLAN-1.md")).toBe(true);
			expect(readFileSync(exportPath!, "utf8")).toBe(PLAN_BODY);

			// 导出事件留在 durable 流里，重启后仍是同一 revision 的审计记录。
			const events = store.replaySessionEvents(sessionId);
			const exportEvents = events.filter((event) => event.eventType === "plan.exported");
			expect(exportEvents).toHaveLength(2);
			expect(exportEvents[0]!.payloadJson).toContain("SPLIT_PYO3_METHODS_PLAN.md");

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
			// 投影文件是可删除重建的：删掉后状态与 revision 不受影响。
			rmSync(layout.plans, { recursive: true, force: true });
			expect(existsSync(exportPath!)).toBe(false);
			const inspected = await client.querySessionDomain("plan.inspect", {}, { correlationId: "after", effectId: "after" });
			expect(inspected).toMatchObject({ ok: true, value: { content: PLAN_BODY, state: { plan: { revision: 1 } } } });
		} finally {
			client?.dispose(); await embedded?.handle.close().catch(() => undefined); await embedded?.runtime?.shutdownAfterLastAttachment("paused"); db.close(); rmSync(root, { recursive: true, force: true });
		}
	});
});
