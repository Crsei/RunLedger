import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createEmbeddedSessionRuntime } from "../../../src/cli/embedded-session-runtime.ts";
import { SessionInteractiveController } from "../../../src/cli/session-interactive-controller.ts";
import { claimDriver, fetchDomainSnapshot } from "../../../src/cli/main.ts";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { minimalHarnessProfileRef, standardHarnessProfileRef } from "../../../src/runtime/harness-profiles/index.ts";
import type { SessionDomainPort } from "../../../src/runtime/session-runtime/session-runtime.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { AuthStorage } from "../../../src/storage/auth-storage.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { builtinModels } from "../../../src/providers/all.ts";
import type { AgentTool, ToolAuthorizationDecision } from "../../../src/runtime/types.ts";
import { contractAssistantMessage } from "../../tui/fixtures/contract-integration.ts";

const noPromptTestSecurity = [{
	source: "cli" as const,
	read: async () => ({ status: "available" as const, text: JSON.stringify({ profile: "danger-full-access", approvalPolicy: "never" }) }),
}];

interface GoalToolController {
	readonly tools: readonly AgentTool[];
	readonly policy: {
		authorize(request: {
			readonly assistantMessage: unknown;
			readonly toolCall: unknown;
			readonly args: Record<string, unknown>;
			readonly tool: AgentTool | undefined;
			readonly context: { readonly systemPrompt: string; readonly messages: readonly unknown[]; readonly tools: readonly AgentTool[] };
		}): ToolAuthorizationDecision | Promise<ToolAuthorizationDecision>;
	};
}

async function openSession(seed: string, profile: "standard" | "minimal") {
	const root = mkdtempSync(resolve(tmpdir(), `runledger-goal-tool-${seed}-`));
	const home = resolve(root, "home");
	mkdirSync(home, { recursive: true, mode: 0o700 });
	const layout = buildRunledgerLayout(home, "posix");
	const db = openSessionDatabase(layout.database);
	installSessionStoreSchema(db);
	const store = new SessionStore(db);
	const ownerStore = new OwnerStore(db);
	const sessionId = createRuntimeId("session", `goal-tool-${seed}`);
	store.createSession({
		sessionId,
		workspaceId: createRuntimeId("workspace", `goal-tool-${seed}`),
		repositoryId: createRuntimeId("repository", `goal-tool-${seed}`),
		settingsDigest: "d".repeat(64),
		harnessProfile: profile === "standard" ? standardHarnessProfileRef() : minimalHarnessProfileRef(),
	});
	const models = builtinModels({ credentials: AuthStorage.create(layout) });
	await models.refresh({ allowNetwork: false });
	const embedded = await createEmbeddedSessionRuntime({
		sessionId,
		store,
		ownerStore,
		domain: { cwd: root, layout, settings: { autoTitle: false }, models, securitySources: noPromptTestSecurity },
	});
	const client = new SessionInteractiveController(embedded.handle, await fetchDomainSnapshot(embedded));
	await claimDriver(embedded, client);
	const domain = (embedded.runtime as unknown as { domain: SessionDomainPort }).domain;
	const controller = domain.controller as unknown as GoalToolController;
	const cleanup = async () => {
		client.dispose();
		await embedded.handle.close().catch(() => undefined);
		await embedded.runtime?.shutdownAfterLastAttachment("paused");
		db.close();
		rmSync(root, { recursive: true, force: true });
	};
	return { controller, client, cleanup };
}

function authorize(controller: GoalToolController, name: string): ToolAuthorizationDecision | Promise<ToolAuthorizationDecision> {
	const tool = controller.tools.find((candidate) => candidate.name === name);
	return controller.policy.authorize({
		assistantMessage: contractAssistantMessage(),
		toolCall: { type: "toolCall", id: "goal-tool-admission", name, arguments: {} },
		args: {},
		tool,
		context: { systemPrompt: "", messages: [], tools: [...controller.tools] },
	});
}

describe("goal tool admission", () => {
	it("admits the composed goal tool instance in a standard session and exposes working operations", async () => {
		const { controller, client, cleanup } = await openSession("standard", "standard");
		try {
			const goalTool = controller.tools.find((tool) => tool.name === "goal");
			expect(goalTool).toBeDefined();
			expect(client.supports("goal.inspect")).toBe(true);

			// admission 按实例身份：组合进来的 goal 工具必须放行。
			expect(await authorize(controller, "goal")).toMatchObject({ decision: "allow" });

			// 工具真的可改 canonical 状态：create → get。
			const created = await goalTool!.execute("goal-admission-create", { op: "create", objective: "Ship the goal tool." } as never, undefined, undefined, undefined);
			expect(created.isError).toBeFalsy();
			const inspected = await goalTool!.execute("goal-admission-get", { op: "get" } as never, undefined, undefined, undefined);
			const text = (inspected.content[0] as { readonly text: string }).text;
			expect(JSON.parse(text)).toMatchObject({ state: { status: "active", objective: "Ship the goal tool." } });

			// 非法状态调用由 reducer 以 typed error 拒绝，而不是「工具不存在」。
			const duplicate = await goalTool!.execute("goal-admission-dup", { op: "create", objective: "second" } as never, undefined, undefined, undefined);
			expect(duplicate.isError).toBe(true);
			expect(JSON.parse((duplicate.content[0] as { readonly text: string }).text)).toMatchObject({ code: "illegal_transition" });
		} finally {
			await cleanup();
		}
	});

	it("denies a tool instance that is not part of the governed composition", async () => {
		const { controller, cleanup } = await openSession("foreign", "standard");
		try {
			const foreign = { ...controller.tools.find((tool) => tool.name === "goal")!, name: "goal" } as AgentTool;
			const decision = await controller.policy.authorize({
				assistantMessage: contractAssistantMessage(),
				toolCall: { type: "toolCall", id: "goal-tool-foreign", name: "goal", arguments: {} },
				args: {},
				tool: foreign,
				context: { systemPrompt: "", messages: [], tools: [...controller.tools, foreign] },
			});
			expect(decision).toMatchObject({ decision: "deny" });
		} finally {
			await cleanup();
		}
	});

	it("does not compose the goal tool or capability into a minimal session", async () => {
		const { controller, client, cleanup } = await openSession("minimal", "minimal");
		try {
			expect(controller.tools.some((tool) => tool.name === "goal")).toBe(false);
			expect(client.supports("goal.inspect")).toBe(false);
		} finally {
			await cleanup();
		}
	});
});
