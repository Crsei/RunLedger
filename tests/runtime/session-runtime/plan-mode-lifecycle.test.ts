import { contractAssistantMessage } from "../../tui/fixtures/contract-integration.ts";
import type { ToolAuthorizationPolicy } from "../../../src/runtime/types.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmbeddedSessionRuntime } from "../../../src/cli/embedded-session-runtime.ts";
import { claimDriver, fetchDomainSnapshot, pauseIfLastAttachment } from "../../../src/cli/main.ts";
import { SessionInteractiveController } from "../../../src/cli/session-interactive-controller.ts";
import { builtinModels } from "../../../src/providers/all.ts";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { isValidPlanModeState } from "../../../src/runtime/modes/plan/reducer.ts";
import { PLAN_GOAL_MAX_BYTES } from "../../../src/runtime/modes/plan/types.ts";
import { standardHarnessProfileRef } from "../../../src/runtime/harness-profiles/index.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import type { ExecutionEnv } from "../../../src/runtime/execution-env.ts";
import type { SessionDomainPort } from "../../../src/runtime/session-runtime/session-runtime.ts";
import type { AgentTool } from "../../../src/runtime/types.ts";
import { AuthStorage } from "../../../src/storage/auth-storage.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";

type PlanController = { tools: readonly AgentTool[]; executionEnv: ExecutionEnv; policy: ToolAuthorizationPolicy };

describe("standard session plan mode lifecycle", () => {
	it("enters and exits plan mode in-session while keeping the workspace read-only during it", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-plan-lifecycle-"));
		const home = join(root, "home"); mkdirSync(home);
		const target = join(root, "source.txt"); writeFileSync(target, "unchanged\n");
		const layout = buildRunledgerLayout(home, "posix");
		const db = openSessionDatabase(layout.database); installSessionStoreSchema(db);
		const store = new SessionStore(db); const ownerStore = new OwnerStore(db);
		const sessionId = createRuntimeId("session", "plan-lifecycle");
		store.createSession({
			sessionId, workspaceId: createRuntimeId("workspace", "plan-lifecycle"),
			repositoryId: createRuntimeId("repository", "plan-lifecycle"),
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
		let embedded: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>> | undefined;
		let client: SessionInteractiveController | undefined;
		try {
			embedded = await createEmbeddedSessionRuntime(options);
			client = new SessionInteractiveController(embedded.handle, await fetchDomainSnapshot(embedded));
			await claimDriver(embedded, client);
			const domain = (embedded.runtime as unknown as { domain: SessionDomainPort }).domain;
			const controller = domain.controller as unknown as PlanController;
			const authorize = (name: string) => {
				const tool = controller.tools.find((candidate) => candidate.name === name);
				return controller.policy.authorize({
					assistantMessage: contractAssistantMessage(),
					toolCall: { type: "toolCall", id: "plan-lifecycle", name, arguments: {} },
					args: {}, tool,
					context: { systemPrompt: "", messages: [], tools: [...controller.tools] },
				});
			};

			// standard 会话默认 inactive，plan 工件工具不可用；工作区工具正常放行。
			const before = await client.querySessionDomain("plan.inspect", {}, { correlationId: "before", effectId: "before" });
			expect(before).toMatchObject({ ok: true, value: { state: { status: "inactive" } } });
			expect(await authorize("plan_write")).toMatchObject({ decision: "deny" });
			expect(await authorize("enter_plan_mode")).toMatchObject({ decision: "allow" });
			expect(await authorize("write")).toMatchObject({ decision: "allow" });

			// 进入 plan mode：单次 mutation 完成 pending → active，并 pin 新建的 revision 0。
			const entered = await client.commandSessionDomain("plan.enter", { expectedRevision: 0 }, { correlationId: "enter", effectId: "enter", expectedRevision: 0 });
			expect(entered.ok).toBe(true);
			if (!entered.ok || !isValidPlanModeState(entered.value.state)) throw new Error("plan enter failed");
			expect(entered.value.state).toMatchObject({ status: "active", revision: 2, plan: { revision: 0 } });
			expect(entered.value.state.sourceHead.sequence).toBeGreaterThan(0);

			// active 期间工作区 effect 与 plan 工件 writer 的判权都收紧。
			expect(await authorize("write")).toMatchObject({ decision: "deny" });
			expect(await authorize("bash")).toMatchObject({ decision: "deny" });
			expect(await authorize("plan_write")).toMatchObject({ decision: "allow" });
			expect(await authorize("enter_plan_mode")).toMatchObject({ decision: "deny" });

			// 重复 enter 是幂等快照：返回同一 revision，不产生新 attempt 或事件。
			const repeatRevision = entered.value.state.revision;
			const repeated = await client.commandSessionDomain("plan.enter", { expectedRevision: repeatRevision }, { correlationId: "enter", effectId: "enter", expectedRevision: repeatRevision });
			expect(repeated).toMatchObject({ ok: true, value: { state: { status: "active", revision: repeatRevision, plan: { revision: 0 } } } });
			expect(await client.querySessionDomain("plan.inspect", {}, { correlationId: "noop", effectId: "noop" })).toMatchObject({
				ok: true, value: { state: { revision: repeatRevision } },
			});

			// 写正文并通过模型侧工具语义提交审批（exit_plan_mode 自行 pin revision）。
			const active = entered.value.state;
			const written = await client.commandSessionDomain("plan.write", {
				expectedRevision: active.revision, expectedPlanRevision: 0, content: "# Feature\n\n1. Edit src/app.ts\n2. Run npm test",
			}, { correlationId: "write", effectId: "write", expectedRevision: active.revision });
			expect(written.ok).toBe(true);
			if (!written.ok || !isValidPlanModeState(written.value.state)) throw new Error("plan write failed");
			const writtenState = written.value.state;
			const requested = await client.commandSessionDomain("plan.request_approval", {
				expectedRevision: writtenState.revision, expectedPlanRevision: writtenState.plan!.revision, expectedPlanDigest: writtenState.plan!.digest,
			}, { correlationId: "request", effectId: "request", expectedRevision: writtenState.revision });
			expect(requested.ok).toBe(true);
			if (!requested.ok || !isValidPlanModeState(requested.value.state)) throw new Error("plan request failed");
			const awaiting = requested.value.state;
			expect(awaiting.status).toBe("awaiting_approval");

			// changes_requested 回到 active 并把意见作为结果返回，不改动工件正文。
			const changes = await client.commandSessionDomain("plan.resolve_approval", {
				expectedRevision: awaiting.revision, expectedPlanRevision: awaiting.plan!.revision, expectedPlanDigest: awaiting.plan!.digest,
				approvalId: awaiting.approval!.approvalId, decision: "changes_requested", feedback: "Add the migration step.",
			}, { correlationId: "changes", effectId: "changes", expectedRevision: awaiting.revision });
			expect(changes).toMatchObject({ ok: true, value: { state: { status: "active", approval: { status: "changes_requested" } }, feedback: "Add the migration step." } });
			if (!changes.ok || !isValidPlanModeState(changes.value.state)) throw new Error("changes request failed");
			expect(changes.value.state.plan!.digest).toEqual(writtenState.plan!.digest);

			// 退出 plan mode 后恢复原有判权，工作区仍未被修改。
			const exited = await client.commandSessionDomain("plan.exit", { expectedRevision: changes.value.state.revision }, { correlationId: "exit", effectId: "exit", expectedRevision: changes.value.state.revision });
			expect(exited).toMatchObject({ ok: true, value: { state: { status: "inactive" } } });
			expect(await authorize("write")).toMatchObject({ decision: "allow" });
			expect(await authorize("plan_write")).toMatchObject({ decision: "deny" });
			await expect(controller.executionEnv.fs.writeFile(target, "changed")).resolves.toBeUndefined();
			expect(readFileSync(target, "utf8")).toBe("changed");

			// reentry pin 既有 revision，不新建 revision。
			if (!exited.ok || !isValidPlanModeState(exited.value.state)) throw new Error("plan exit failed");
			const reentered = await client.commandSessionDomain("plan.reenter", { expectedRevision: exited.value.state.revision }, { correlationId: "reenter", effectId: "reenter", expectedRevision: exited.value.state.revision });
			expect(reentered).toMatchObject({ ok: true, value: { state: { status: "active", plan: { revision: 1 } } } });

			// 重启后投影与退出前一致，且 active 的只读边界仍然生效。
			// retainSession: 空会话在 paused 时会被回收，这里要验证 owner 重启而不是回收语义。
			if (!reentered.ok || !isValidPlanModeState(reentered.value.state)) throw new Error("plan reenter failed");
			const beforeRestart = reentered.value.state;
			client.dispose(); client = undefined;
			await embedded.handle.close(); await pauseIfLastAttachment(embedded, true, true);
			embedded = await createEmbeddedSessionRuntime(options);
			client = new SessionInteractiveController(embedded.handle, await fetchDomainSnapshot(embedded));
			const restored = await client.querySessionDomain("plan.inspect", {}, { correlationId: "restored", effectId: "restored" });
			expect(restored).toMatchObject({
				ok: true,
				value: { state: { status: "active", revision: beforeRestart.revision, plan: { revision: 1, digest: beforeRestart.plan!.digest } } },
			});
			const restoredController = ((embedded.runtime as unknown as { domain: SessionDomainPort }).domain.controller) as unknown as PlanController;
			expect(await restoredController.policy.authorize({
				assistantMessage: contractAssistantMessage(),
				toolCall: { type: "toolCall", id: "restored-deny", name: "bash", arguments: {} },
				args: {},
				tool: restoredController.tools.find((candidate) => candidate.name === "bash"),
				context: { systemPrompt: "", messages: [], tools: [...restoredController.tools] },
			})).toMatchObject({ decision: "deny" });
		} finally {
			client?.dispose(); await embedded?.handle.close().catch(() => undefined); await embedded?.runtime?.shutdownAfterLastAttachment("paused"); db.close(); rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a plan write that would exceed the per-goal byte budget", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-plan-bounds-"));
		const home = join(root, "home"); mkdirSync(home);
		const layout = buildRunledgerLayout(home, "posix");
		const db = openSessionDatabase(layout.database); installSessionStoreSchema(db);
		const store = new SessionStore(db); const ownerStore = new OwnerStore(db);
		const sessionId = createRuntimeId("session", "plan-bounds");
		store.createSession({
			sessionId, workspaceId: createRuntimeId("workspace", "plan-bounds"),
			repositoryId: createRuntimeId("repository", "plan-bounds"),
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

			// 首条 revision 受单条上限约束；把单 goal 预算填满后再写即被拒绝，且状态与 revision 不变。
			const chunk = "x".repeat(65_000);
			let revision = entered.value.state.plan!.revision;
			let stateRevision = entered.value.state.revision;
			let accepted = 0;
			for (;;) {
				const result = await client.commandSessionDomain("plan.write", {
					expectedRevision: stateRevision, expectedPlanRevision: revision, content: `${chunk}\n${accepted}`,
				}, { correlationId: `fill-${accepted}`, effectId: `fill-${accepted}`, expectedRevision: stateRevision });
				if (!result.ok) {
					expect(result).toMatchObject({ code: "plan_goal_byte_limit" });
					break;
				}
				if (!isValidPlanModeState(result.value.state)) throw new Error("plan write returned an invalid state");
				revision = result.value.state.plan!.revision;
				stateRevision = result.value.state.revision;
				accepted += 1;
				expect(accepted * 65_000).toBeLessThanOrEqual(PLAN_GOAL_MAX_BYTES + 65_000);
			}
			expect(accepted).toBe(Math.floor(PLAN_GOAL_MAX_BYTES / 65_000));

			const after = await client.querySessionDomain("plan.inspect", {}, { correlationId: "after", effectId: "after" });
			expect(after).toMatchObject({ ok: true, value: { state: { status: "active", plan: { revision } } } });
		} finally {
			client?.dispose(); await embedded?.handle.close().catch(() => undefined); await embedded?.runtime?.shutdownAfterLastAttachment("paused"); db.close(); rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps an agent-requested entry pending until the user activates it", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-plan-agent-entry-"));
		const home = join(root, "home"); mkdirSync(home);
		const layout = buildRunledgerLayout(home, "posix");
		const db = openSessionDatabase(layout.database); installSessionStoreSchema(db);
		const store = new SessionStore(db); const ownerStore = new OwnerStore(db);
		const sessionId = createRuntimeId("session", "plan-agent-entry");
		store.createSession({
			sessionId, workspaceId: createRuntimeId("workspace", "plan-agent-entry"),
			repositoryId: createRuntimeId("repository", "plan-agent-entry"),
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
			const controller = ((embedded.runtime as unknown as { domain: SessionDomainPort }).domain.controller) as unknown as PlanController;
			const authorize = (name: string) => controller.policy.authorize({
				assistantMessage: contractAssistantMessage(),
				toolCall: { type: "toolCall", id: "agent-entry", name, arguments: {} },
				args: {}, tool: controller.tools.find((candidate) => candidate.name === name),
				context: { systemPrompt: "", messages: [], tools: [...controller.tools] },
			});

			// 模型只能发起请求：进入 pending，且没有工件、权限不变。
			const requested = await client.commandSessionDomain("plan.enter", { expectedRevision: 0, requestedBy: "agent" }, {
				correlationId: "agent-enter", effectId: "agent-enter", expectedRevision: 0,
			});
			expect(requested.ok).toBe(true);
			if (!requested.ok || !isValidPlanModeState(requested.value.state)) throw new Error("agent entry failed");
			expect(requested.value.state).toMatchObject({ status: "pending" });
			expect(requested.value.state.plan).toBeUndefined();
			expect(await authorize("plan_write")).toMatchObject({ decision: "deny" });
			expect(await authorize("enter_plan_mode")).toMatchObject({ decision: "deny" });
			expect(await authorize("write")).toMatchObject({ decision: "allow" });
			expect(store.replaySessionEvents(sessionId).some((event) => event.eventType === "plan.enter_requested")).toBe(true);

			// 用户批准（plan.activate）才建立工件并转为 active。
			const activated = await client.commandSessionDomain("plan.activate", { expectedRevision: requested.value.state.revision }, {
				correlationId: "activate", effectId: "activate", expectedRevision: requested.value.state.revision,
			});
			if (!activated.ok) throw new Error(`plan activate failed: ${activated.code}`);
			expect(activated).toMatchObject({ value: { state: { status: "active", plan: { revision: 0 } } } });
			expect(await authorize("write")).toMatchObject({ decision: "deny" });
			expect(await authorize("plan_write")).toMatchObject({ decision: "allow" });
		} finally {
			client?.dispose(); await embedded?.handle.close().catch(() => undefined); await embedded?.runtime?.shutdownAfterLastAttachment("paused"); db.close(); rmSync(root, { recursive: true, force: true });
		}
	});
});
