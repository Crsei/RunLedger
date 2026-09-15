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
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { AuthStorage } from "../../../src/storage/auth-storage.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";

const PLAN_BODY = "# Migrate auth storage\n\n1. Rewrite src/auth/store.ts\n2. Run npm test";
const UNEDITED_TAIL = "abandoned exploration note";

async function planHarness() {
	const root = mkdtempSync(join(tmpdir(), "runledger-plan-handoff-"));
	const home = join(root, "home"); mkdirSync(home);
	const layout = buildRunledgerLayout(home, "posix");
	const db = openSessionDatabase(layout.database); installSessionStoreSchema(db);
	const store = new SessionStore(db); const ownerStore = new OwnerStore(db);
	const sessionId = createRuntimeId("session", "plan-handoff");
	store.createSession({
		sessionId, workspaceId: createRuntimeId("workspace", "plan-handoff"),
		repositoryId: createRuntimeId("repository", "plan-handoff"),
		settingsDigest: "d".repeat(64), harnessProfile: standardHarnessProfileRef(2),
	});
	const models = builtinModels({ credentials: AuthStorage.create(layout) }); await models.refresh({ allowNetwork: false });
	return {
		root, layout, db, store, ownerStore, sessionId, models,
		options: {
			sessionId, store, ownerStore,
			domain: {
				cwd: root, layout, models, settings: { autoTitle: false },
				securitySources: [{ source: "cli" as const, read: async () => ({ status: "available" as const, text: JSON.stringify({ profile: "danger-full-access", approvalPolicy: "never" }) }) }],
			},
		},
	};
}

describe("plan implementation handoff", () => {
	it("creates an implementation session from an approved revision and audits the handoff", async () => {
		const harness = await planHarness();
		let embedded: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>> | undefined;
		let client: SessionInteractiveController | undefined;
		try {
			embedded = await createEmbeddedSessionRuntime(harness.options);
			client = new SessionInteractiveController(embedded.handle, await fetchDomainSnapshot(embedded));
			await claimDriver(embedded, client);

			// 未批准时不能交接。
			const entered = await client.commandSessionDomain("plan.enter", { expectedRevision: 0 }, { correlationId: "enter", effectId: "enter", expectedRevision: 0 });
			if (!entered.ok || !isValidPlanModeState(entered.value.state)) throw new Error("plan enter failed");
			expect(await client.commandSessionDomain("plan.handoff", { expectedRevision: entered.value.state.revision }, { correlationId: "handoff-early", effectId: "handoff-early", expectedRevision: entered.value.state.revision }))
				.toMatchObject({ ok: false, code: "plan_handoff_requires_approved_plan" });

			const written = await client.commandSessionDomain("plan.write", {
				expectedRevision: entered.value.state.revision, expectedPlanRevision: 0, content: PLAN_BODY,
			}, { correlationId: "write", effectId: "write", expectedRevision: entered.value.state.revision });
			if (!written.ok || !isValidPlanModeState(written.value.state)) throw new Error("plan write failed");
			const requested = await client.commandSessionDomain("plan.request_approval", {
				expectedRevision: written.value.state.revision, expectedPlanRevision: 1, expectedPlanDigest: written.value.state.plan!.digest,
			}, { correlationId: "request", effectId: "request", expectedRevision: written.value.state.revision });
			if (!requested.ok || !isValidPlanModeState(requested.value.state)) throw new Error("plan request failed");

			// awaiting_approval 仍不是批准状态。
			expect(await client.commandSessionDomain("plan.handoff", { expectedRevision: requested.value.state.revision }, { correlationId: "handoff-awaiting", effectId: "handoff-awaiting", expectedRevision: requested.value.state.revision }))
				.toMatchObject({ ok: false, code: "plan_handoff_requires_approved_plan" });

			const approved = await client.commandSessionDomain("plan.resolve_approval", {
				expectedRevision: requested.value.state.revision, expectedPlanRevision: 1, expectedPlanDigest: requested.value.state.plan!.digest,
				approvalId: requested.value.state.approval!.approvalId, decision: "approved",
			}, { correlationId: "approve", effectId: "approve", expectedRevision: requested.value.state.revision });
			if (!approved.ok || !isValidPlanModeState(approved.value.state)) throw new Error("plan approve failed");

			const handoff = await client.commandSessionDomain("plan.handoff", { expectedRevision: approved.value.state.revision }, {
				correlationId: "handoff", effectId: "handoff", expectedRevision: approved.value.state.revision,
			});
			expect(handoff.ok).toBe(true);
			if (!handoff.ok) throw new Error("plan handoff failed");
			const target = handoff.value.handoff as {
				targetSessionId: string; harnessProfileId: string; harnessProfileVersion: number; revision: number; digest: { digest: string }; receiptDigest: { digest: string }; content: string;
			};
			expect(target).toMatchObject({ harnessProfileId: "standard", harnessProfileVersion: 2, revision: 1, content: PLAN_BODY });
			expect(target.digest.digest).toBe(approved.value.state.plan!.digest.digest);
			expect(target.receiptDigest.digest).toBe(approved.value.state.approval!.receiptRef!.digest.digest);

			// 目标会话是独立的标准会话，不复制源历史，也不携带未批准的 exploration。
			const created = harness.store.getSession(target.targetSessionId as never);
			expect(created).toBeDefined();
			expect(created!.harnessProfile).toMatchObject({ id: "standard", version: 2 });
			expect(harness.store.replaySessionEvents(target.targetSessionId)).toHaveLength(0);
			expect(JSON.stringify(handoff.value)).not.toContain(UNEDITED_TAIL);

			// 交接事件留在源 session 的 durable 流里，绑定审批 receipt 与目标。
			const handoffEvents = harness.store.replaySessionEvents(harness.sessionId).filter((event) => event.eventType === "plan.handoff_created");
			expect(handoffEvents).toHaveLength(1);
			expect(handoffEvents[0]!.payloadJson).toContain(target.targetSessionId);
			expect(handoffEvents[0]!.payloadJson).toContain(target.receiptDigest.digest);

			// 源会话状态不因交接改变；同一 correlationId 重放得到同一结果。
			expect(handoff.value.state).toMatchObject({ status: "exit_pending", approval: { status: "approved" } });
			const replayed = await client.commandSessionDomain("plan.handoff", { expectedRevision: approved.value.state.revision }, {
				correlationId: "handoff", effectId: "handoff", expectedRevision: approved.value.state.revision,
			});
			expect(replayed).toEqual(handoff);
			// 重放不产生第二个目标会话。
			expect(harness.store.replaySessionEvents(harness.sessionId).filter((event) => event.eventType === "plan.handoff_created")).toHaveLength(1);

			// 重启后 handoff 结果仍可从 durable 事件重建，且正文来自同一 revision 的工件。
			client.dispose(); client = undefined;
			await embedded.handle.close(); await pauseIfLastAttachment(embedded, true, true);
			embedded = await createEmbeddedSessionRuntime(harness.options);
			client = new SessionInteractiveController(embedded.handle, await fetchDomainSnapshot(embedded));
			const restored = await client.querySessionDomain("plan.inspect", {}, { correlationId: "restored", effectId: "restored" });
			expect(restored).toMatchObject({ ok: true, value: { state: { status: "exit_pending", plan: { revision: 1 } } } });
		} finally {
			client?.dispose(); await embedded?.handle.close().catch(() => undefined); await embedded?.runtime?.shutdownAfterLastAttachment("paused"); harness.db.close(); rmSync(harness.root, { recursive: true, force: true });
		}
	});
});
