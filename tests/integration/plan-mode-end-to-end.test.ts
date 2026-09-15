import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmbeddedSessionRuntime } from "../../src/cli/embedded-session-runtime.ts";
import { claimDriver, fetchDomainSnapshot, pauseIfLastAttachment } from "../../src/cli/main.ts";
import { SessionInteractiveController } from "../../src/cli/session-interactive-controller.ts";
import { builtinModels } from "../../src/providers/all.ts";
import { buildRunledgerLayout } from "../../src/runtime/contracts/storage-layout.ts";
import { buildPlanFragment } from "../../src/runtime/modes/plan/prompt.ts";
import { isValidPlanModeState } from "../../src/runtime/modes/plan/reducer.ts";
import { standardHarnessProfileRef } from "../../src/runtime/harness-profiles/index.ts";
import type { PlanModeState } from "../../src/runtime/modes/plan/types.ts";
import { createRuntimeId } from "../../src/runtime/protocol/ids.ts";
import { runtimeDigest } from "../../src/runtime/protocol/foundation.ts";
import { AuthStorage } from "../../src/storage/auth-storage.ts";
import { openSessionDatabase } from "../../src/storage/session-store/database.ts";
import { OwnerStore } from "../../src/storage/session-store/owner-store.ts";
import { installSessionStoreSchema } from "../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../src/storage/session-store/session-store.ts";

const PLAN_V1 = "# Retire the legacy host\n\n1. Delete src/runtime/host\n2. Run npm run check";
const PLAN_V2 = "# Retire the legacy host\n\n1. Delete src/runtime/host\n2. Migrate the remaining callers\n3. Run npm run check";

async function harness() {
	const root = mkdtempSync(join(tmpdir(), "runledger-plan-e2e-"));
	const home = join(root, "home"); mkdirSync(home);
	const layout = buildRunledgerLayout(home, "posix");
	const db = openSessionDatabase(layout.database); installSessionStoreSchema(db);
	const store = new SessionStore(db); const ownerStore = new OwnerStore(db);
	const sessionId = createRuntimeId("session", "plan-e2e");
	store.createSession({
		sessionId, workspaceId: createRuntimeId("workspace", "plan-e2e"),
		repositoryId: createRuntimeId("repository", "plan-e2e"),
		settingsDigest: "d".repeat(64), harnessProfile: standardHarnessProfileRef(2),
	});
	const models = builtinModels({ credentials: AuthStorage.create(layout) }); await models.refresh({ allowNetwork: false });
	const options = {
		sessionId, store, ownerStore,
		domain: {
			cwd: root, layout, models, settings: { autoTitle: false },
			securitySources: [{ source: "cli" as const, read: async () => ({ status: "available" as const, text: JSON.stringify({ profile: "danger-full-access", approvalPolicy: "never" }) }) }],
		},
	};
	return { root, layout, db, store, ownerStore, sessionId, options };
}

describe("plan mode end to end", () => {
	it("runs entry, revision, review changes, approval, handoff and export on one durable chain", async () => {
		const h = await harness();
		let embedded: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>> | undefined;
		let client: SessionInteractiveController | undefined;
		try {
			embedded = await createEmbeddedSessionRuntime(h.options);
			client = new SessionInteractiveController(embedded.handle, await fetchDomainSnapshot(embedded));
			await claimDriver(embedded, client);
			const command = (operation: string, body: Record<string, unknown>, id: string, revision: number) =>
				client!.commandSessionDomain(operation, body, { correlationId: id, effectId: id, expectedRevision: revision });
			const stateOf = (result: Awaited<ReturnType<typeof command>>): PlanModeState => {
				if (!result.ok || !isValidPlanModeState(result.value.state)) throw new Error(`step failed: ${result.ok ? "invalid state" : result.code}`);
				return result.value.state;
			};

			// 1) 进入 plan mode，起草第一版。
			let state = stateOf(await command("plan.enter", { expectedRevision: 0 }, "enter", 0));
			state = stateOf(await command("plan.write", { expectedRevision: state.revision, expectedPlanRevision: 0, content: PLAN_V1 }, "write-1", state.revision));
			state = stateOf(await command("plan.request_approval", {
				expectedRevision: state.revision, expectedPlanRevision: state.plan!.revision, expectedPlanDigest: state.plan!.digest,
			}, "request-1", state.revision));

			// 2) 要求修改：回到 active，反馈随结果返回，工件不变。
			const changes = await command("plan.resolve_approval", {
				expectedRevision: state.revision, expectedPlanRevision: state.plan!.revision, expectedPlanDigest: state.plan!.digest,
				approvalId: state.approval!.approvalId, decision: "changes_requested", feedback: "Also migrate the remaining callers.",
			}, "changes", state.revision);
			expect(changes).toMatchObject({ ok: true, value: { state: { status: "active", approval: { status: "changes_requested" } }, feedback: "Also migrate the remaining callers." } });
			state = stateOf(changes);
			expect(state.plan!.revision).toBe(1);

			// 3) 按反馈写第二版并再次提交。
			state = stateOf(await command("plan.write", { expectedRevision: state.revision, expectedPlanRevision: 1, content: PLAN_V2 }, "write-2", state.revision));
			expect(state.plan!.revision).toBe(2);
			state = stateOf(await command("plan.request_approval", {
				expectedRevision: state.revision, expectedPlanRevision: 2, expectedPlanDigest: state.plan!.digest,
			}, "request-2", state.revision));

			// 4) 批准：审批 receipt 绑定被批准的 revision 与 digest。
			state = stateOf(await command("plan.resolve_approval", {
				expectedRevision: state.revision, expectedPlanRevision: 2, expectedPlanDigest: state.plan!.digest,
				approvalId: state.approval!.approvalId, decision: "approved",
			}, "approve", state.revision));
			expect(state).toMatchObject({ status: "exit_pending", approval: { status: "approved", revision: 2 } });
			const approvedDigest = state.plan!.digest.digest;

			// 5) 交接：目标标准会话自包含，不带 planning tail。
			const handoff = await command("plan.handoff", { expectedRevision: state.revision }, "handoff", state.revision);
			expect(handoff.ok).toBe(true);
			if (!handoff.ok) throw new Error("handoff failed");
			const targetSessionId = (handoff.value.handoff as { targetSessionId: string }).targetSessionId;
			expect(h.store.getSession(targetSessionId as never)).toMatchObject({ harnessProfile: { id: "standard", version: 2 } });
			expect(h.store.replaySessionEvents(targetSessionId)).toHaveLength(0);

			// 6) 结束工作流并导出：mode 回到 inactive，投影落在 canonical home。
			state = stateOf(await command("plan.settle_exit", { expectedRevision: state.revision }, "settle", state.revision));
			expect(state.status).toBe("inactive");
			const exported = await command("plan.export", { expectedRevision: state.revision }, "export", state.revision);
			expect(exported.ok).toBe(true);
			if (!exported.ok) throw new Error("export failed");
			const exportPath = (exported.value as { exportPath?: string }).exportPath;
			expect(exportPath).toBeDefined();
			expect(readFileSync(exportPath!, "utf8")).toBe(PLAN_V2);

			// 7) 完整链可重放：重启后 digest、审批与导出记录一致。
			client.dispose(); client = undefined;
			await embedded.handle.close(); await pauseIfLastAttachment(embedded, true, true);
			embedded = await createEmbeddedSessionRuntime(h.options);
			client = new SessionInteractiveController(embedded.handle, await fetchDomainSnapshot(embedded));
			const restored = await client.querySessionDomain("plan.inspect", {}, { correlationId: "restored", effectId: "restored" });
			// 退出后 state.plan 已清空；正文与 revision 链由工作指针与持久化 revision 证明。
			expect(restored).toMatchObject({ ok: true, value: { content: PLAN_V2, state: { status: "inactive" } } });
			const revisions = await client.querySessionDomain("plan.list", {}, { correlationId: "list", effectId: "list" });
			expect(revisions).toMatchObject({ ok: true, value: { revisions: [{ revision: 0 }, { revision: 1 }, { revision: 2, current: true, digest: { digest: approvedDigest } }] } });

			// 8) 批准确认（审批 receipt 与还原出的 digest 同一性）。
			const events = h.store.replaySessionEvents(h.sessionId);
			const eventTypes: readonly string[] = events.map((event: { readonly eventType: string }) => event.eventType);
			// 用户路径的 enter 在同一 commit 内完成 pending → active，因此只落 plan.entered。
			expect(eventTypes).toEqual(expect.arrayContaining([
				"plan.entered", "plan.revision_written", "plan.approval_requested", "plan.changes_requested",
				"plan.approved", "plan.handoff_created", "plan.exited", "plan.exported",
			]));
			expect(eventTypes.filter((type) => type === "plan.revision_written")).toHaveLength(2);
			expect(eventTypes.filter((type) => type === "plan.approval_requested")).toHaveLength(2);
			// 全链路不出现语义混淆的失败事件：拒绝与失效各有专名。
			expect(eventTypes.filter((type) => type === "plan.failed")).toHaveLength(0);
			expect(eventTypes).not.toContain("artifact.created");
		} finally {
			client?.dispose(); await embedded?.handle.close().catch(() => undefined); await embedded?.runtime?.shutdownAfterLastAttachment("paused"); h.db.close(); rmSync(h.root, { recursive: true, force: true });
		}
	});

	it("keeps the injected plan fragment bounded and revision-scoped across the lifecycle", () => {
		const sessionId = createRuntimeId("session", "plan-fragment-e2e");
		const goalId = createRuntimeId("goal", "plan-fragment-e2e");
		const digest = runtimeDigest("plan-fragment-e2e");
		const base: PlanModeState = {
			status: "active", sessionId, goalId, revision: 3,
			plan: { goalId, workspaceId: createRuntimeId("workspace", "plan-fragment-e2e"), revision: 1, digest, artifactRef: { subjectKind: "artifact", digest, mediaType: "text/markdown", size: PLAN_V2.length } },
			policyCeilingDigest: digest, sourceHead: { streamId: sessionId, sequence: 3, eventHash: digest },
			projectionDigest: digest, completeness: "complete", updatedAt: "2026-09-16T00:00:00.000Z",
		};
		// 同一 revision 的重复组装不重复投正文；收敛提示改变 key 但不改变正文。
		const first = buildPlanFragment({ state: base, content: PLAN_V2 })!;
		const reopened = buildPlanFragment({ state: base, content: PLAN_V2, contentInlined: true })!;
		const nudged = buildPlanFragment({ state: base, content: PLAN_V2, convergenceReminder: 2 })!;
		expect(first.key).toBe(reopened.key);
		expect(first.text).toContain(PLAN_V2);
		expect(reopened.text).not.toContain(PLAN_V2);
		expect(nudged.key).not.toBe(first.key);
		expect(nudged.text).toContain("<convergence>");
		expect(first.text).not.toContain("<convergence>");
	});
});
