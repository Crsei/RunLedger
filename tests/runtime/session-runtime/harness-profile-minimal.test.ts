import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Model } from "../../../src/types.ts";
import { createEmbeddedSessionRuntime } from "../../../src/cli/embedded-session-runtime.ts";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import {
	minimalHarnessProfileRef,
	MINIMAL_HARNESS_SYSTEM_PROMPT,
	standardHarnessProfileRef,
} from "../../../src/runtime/harness-profiles/index.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import type { SessionDomainPort } from "../../../src/runtime/session-runtime/session-runtime.ts";
import type { TraceRecorderFactory, TraceRecorderFactoryInput } from "../../../src/runtime/trace/composition.ts";
import { bashSchema } from "../../../src/runtime/tools/bash.ts";
import { editSchema } from "../../../src/runtime/tools/edit.ts";
import type { AgentTool, ModelContextAssembler } from "../../../src/runtime/types.ts";
import { builtinModels } from "../../../src/providers/all.ts";
import { AuthStorage } from "../../../src/storage/auth-storage.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { loadProjectSettings } from "../../../src/storage/settings-manager.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const noPromptTestSecurity = [{
	source: "cli" as const,
	read: async () => ({ status: "available" as const, text: JSON.stringify({ profile: "danger-full-access" }) }),
}];

const contextModel = {
	id: "minimal-context-model",
	name: "Minimal context model",
	api: "openai-completions",
	provider: "openai",
	baseUrl: "http://127.0.0.1.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_000,
	maxTokens: 4_096,
} satisfies Model<"openai-completions">;

type InspectableController = SessionDomainPort["controller"] & {
	readonly systemPrompt: string;
	readonly tools: readonly AgentTool[];
	readonly modelContextAssembler?: ModelContextAssembler;
	readonly traceRecorderFactory?: TraceRecorderFactory;
	readonly extensionHookRuntime?: unknown;
	readonly extensionTurnAdmission?: unknown;
	readonly extensionTurnAbort?: unknown;
};

describe("minimal@1 production composition", () => {
	it("projects the durable profile to the exact provider-facing prompt, tools, and empty-source context", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-harness-minimal-"));
		roots.push(root);
		const home = join(root, "home");
		mkdirSync(home, { recursive: true, mode: 0o700 });
		const layout = buildRunledgerLayout(home, "posix");
		const db = openSessionDatabase(layout.database);
		installSessionStoreSchema(db);
		const store = new SessionStore(db);
		const ownerStore = new OwnerStore(db);
		const sessionId = createRuntimeId("session", "minimal-production-composition");
		writeFileSync(join(root, "minimal-edit.txt"), "before\n", "utf8");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "minimal-production-composition"),
			repositoryId: createRuntimeId("repository", "minimal-production-composition"),
			harnessProfile: minimalHarnessProfileRef(),
			settingsDigest: "d".repeat(64),
		});
		const settings = await loadProjectSettings({ layout });
		const models = builtinModels({ credentials: AuthStorage.create(layout) });
		await models.refresh({ allowNetwork: false });
		const traceInputs: TraceRecorderFactoryInput[] = [];
		let embedded: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>> | undefined;
		try {
			embedded = await createEmbeddedSessionRuntime({
				sessionId,
				store,
				ownerStore,
				domain: {
					cwd: root,
					layout,
					settings,
					models,
					securitySources: noPromptTestSecurity,
					traceRecorderFactory: {
						create: async (input) => {
							traceInputs.push(input);
							return undefined;
						},
					},
				},
			});
			if (embedded.runtime === undefined) throw new Error("production runtime was not claimed");
			const domain = (embedded.runtime as unknown as { readonly domain?: SessionDomainPort }).domain;
			if (domain === undefined) throw new Error("production domain was not assembled");
			const controller = domain.controller as InspectableController;

			expect(controller.systemPrompt).toBe(MINIMAL_HARNESS_SYSTEM_PROMPT);
			expect(controller.tools.map((tool) => tool.name)).toEqual(["bash", "edit"]);
			expect(Object.keys(controller.tools[0]!.parameters.properties)).toEqual([
				"command",
				"timeout",
				"stdin",
				"output_format",
			]);
			expect(controller.tools[0]!.parameters).toEqual({
				...bashSchema,
				additionalProperties: false,
				properties: {
					command: bashSchema.properties.command,
					timeout: bashSchema.properties.timeout,
					stdin: bashSchema.properties.stdin,
					output_format: bashSchema.properties.output_format,
				},
			});
			expect(controller.tools[1]!.parameters).toEqual(editSchema);
			expect(controller.extensionHookRuntime).toBeUndefined();
			expect(controller.extensionTurnAdmission).toBeUndefined();
			expect(controller.extensionTurnAbort).toBeUndefined();
			expect(domain.childRuntime).toBeUndefined();
			expect(domain.multiAgent).toBeUndefined();
			expect(embedded.handle.supports("extension.inspect")).toBe(false);
			expect(embedded.handle.supports("mcp.list")).toBe(false);
			expect(embedded.handle.supports("agent.inspect")).toBe(false);
			expect(embedded.handle.supports("security.settings.inspect")).toBe(true);

			const assembled = await controller.modelContextAssembler?.({
				model: contextModel,
				context: {
					systemPrompt: controller.systemPrompt,
					messages: [{ role: "user", content: "selected user history", timestamp: 1 }],
					tools: [...controller.tools],
				},
				sessionId,
				turn: 1,
				sources: [{
					fragmentId: "injected-extension-source",
					key: "injected-extension-source",
					layer: "resources",
					content: "must not enter minimal context",
					trust: "trusted",
					taint: "none",
					priority: "normal",
				}],
			});
			expect(assembled?.context.systemPrompt).toBe(MINIMAL_HARNESS_SYSTEM_PROMPT);
			expect(assembled?.context.messages).toHaveLength(1);
			expect(assembled?.receipt.fragmentIds).toEqual(["agent-system-prompt", "agent-history-0"]);
			expect(assembled?.receipt.fragmentIds).not.toContain("injected-extension-source");

			const compositionEvents = store.replaySessionEvents(sessionId)
				.filter((event) => event.eventType === "harness.composed");
			expect(compositionEvents).toHaveLength(1);
			const compositionReceipt = JSON.parse(compositionEvents[0]!.payloadJson) as Record<string, unknown>;
			expect(compositionReceipt).toMatchObject({
				sessionId,
				ownerGeneration: embedded.ownerFence?.generation,
				profile: minimalHarnessProfileRef(),
				extensions: { tools: false, context: false, hooks: false, lifecycle: false },
				multiAgent: false,
			});
			expect(compositionReceipt).not.toHaveProperty("systemPrompt");
			await controller.traceRecorderFactory?.create({ sessionId: "caller-session-id-is-not-authority" });
			expect(traceInputs).toEqual([{
				sessionId,
				ownerGeneration: embedded.ownerFence?.generation,
				metadata: {
					harnessProfileId: "minimal",
					harnessProfileVersion: 1,
					harnessCompositionDigest: (compositionReceipt.compositionDigest as { readonly digest: string }).digest,
				},
			}]);

			const bashResult = await controller.tools[0]!.execute(
				createRuntimeId("toolCall", "minimal-governed-bash"),
				{ command: "printf minimal-governed-bash" },
			);
			expect(bashResult).toMatchObject({ isError: false, details: { exitCode: 0 } });
			const editResult = await controller.tools[1]!.execute(
				createRuntimeId("toolCall", "minimal-governed-edit"),
				{
					path: "minimal-edit.txt",
					edits: [{ oldText: "before", newText: "after" }],
				},
			);
			expect(editResult.isError).not.toBe(true);
			expect(readFileSync(join(root, "minimal-edit.txt"), "utf8")).toBe("after\n");
		const settledEffects = store.listAllAttemptReceipts(sessionId)
			.filter((receipt) => receipt.outcome === "committed")
			.map((receipt) => receipt.effectClass);
		expect(settledEffects).toEqual(expect.arrayContaining(["process_spawn", "workspace_mutation"]));
		} finally {
			await embedded?.handle.close().catch(() => undefined);
			await embedded?.runtime?.shutdownAfterLastAttachment("paused");
			db.close();
		}
	});

	it("keeps simultaneous standard and minimal Sessions isolated", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-harness-profile-isolation-"));
		roots.push(root);
		const home = join(root, "home");
		mkdirSync(home, { recursive: true, mode: 0o700 });
		const layout = buildRunledgerLayout(home, "posix");
		const db = openSessionDatabase(layout.database);
		installSessionStoreSchema(db);
		const store = new SessionStore(db);
		const ownerStore = new OwnerStore(db);
		const standardSessionId = createRuntimeId("session", "profile-isolation-standard");
		const minimalSessionId = createRuntimeId("session", "profile-isolation-minimal");
		for (const [sessionId, harnessProfile] of [
			[standardSessionId, standardHarnessProfileRef()],
			[minimalSessionId, minimalHarnessProfileRef()],
		] as const) {
			store.createSession({
				sessionId,
				workspaceId: createRuntimeId("workspace", sessionId),
				repositoryId: createRuntimeId("repository", sessionId),
				harnessProfile,
				settingsDigest: "d".repeat(64),
			});
		}
		const settings = await loadProjectSettings({ layout });
		const models = builtinModels({ credentials: AuthStorage.create(layout) });
		await models.refresh({ allowNetwork: false });
		let standard: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>> | undefined;
		let minimal: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>> | undefined;
		try {
			[standard, minimal] = await Promise.all([
				createEmbeddedSessionRuntime({
					sessionId: standardSessionId,
					store,
					ownerStore,
					domain: {
						cwd: root,
						layout,
						settings,
						models,
						systemPrompt: "standard isolated prompt",
						securitySources: noPromptTestSecurity,
					},
				}),
				createEmbeddedSessionRuntime({
					sessionId: minimalSessionId,
					store,
					ownerStore,
					domain: { cwd: root, layout, settings, models, securitySources: noPromptTestSecurity },
				}),
			]);
			if (standard.runtime === undefined || minimal.runtime === undefined) throw new Error("both production runtimes must be claimed");
			const standardDomain = (standard.runtime as unknown as { readonly domain?: SessionDomainPort }).domain;
			const minimalDomain = (minimal.runtime as unknown as { readonly domain?: SessionDomainPort }).domain;
			const standardController = standardDomain?.controller as InspectableController;
			const minimalController = minimalDomain?.controller as InspectableController;
			expect(standardController.systemPrompt).toBe("standard isolated prompt");
			expect(standardController.tools.map((tool) => tool.name)).toContain("lsp");
			expect(standard.handle.supports("extension.inspect")).toBe(true);
			expect(standardDomain?.childRuntime).toBeDefined();
			expect(minimalController.systemPrompt).toBe(MINIMAL_HARNESS_SYSTEM_PROMPT);
			expect(minimalController.tools.map((tool) => tool.name)).toEqual(["bash", "edit"]);
			expect(minimal.handle.supports("extension.inspect")).toBe(false);
			expect(minimalDomain?.childRuntime).toBeUndefined();
		} finally {
			await standard?.handle.close().catch(() => undefined);
			await minimal?.handle.close().catch(() => undefined);
			await standard?.runtime?.shutdownAfterLastAttachment("paused");
			await minimal?.runtime?.shutdownAfterLastAttachment("paused");
			db.close();
		}
	});

	it("fails closed and releases the claimed owner when minimal receives a prompt override", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-harness-minimal-override-"));
		roots.push(root);
		const home = join(root, "home");
		mkdirSync(home, { recursive: true, mode: 0o700 });
		const layout = buildRunledgerLayout(home, "posix");
		const db = openSessionDatabase(layout.database);
		installSessionStoreSchema(db);
		const store = new SessionStore(db);
		const ownerStore = new OwnerStore(db);
		const sessionId = createRuntimeId("session", "minimal-prompt-override");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "minimal-prompt-override"),
			repositoryId: createRuntimeId("repository", "minimal-prompt-override"),
			harnessProfile: minimalHarnessProfileRef(),
			settingsDigest: "d".repeat(64),
		});
		const settings = await loadProjectSettings({ layout });
		const models = builtinModels({ credentials: AuthStorage.create(layout) });
		await models.refresh({ allowNetwork: false });
		try {
			await expect(createEmbeddedSessionRuntime({
				sessionId,
				store,
				ownerStore,
				domain: {
					cwd: root,
					layout,
					settings,
					models,
					systemPrompt: "override is forbidden",
					securitySources: noPromptTestSecurity,
				},
			})).rejects.toMatchObject({ code: "harness_prompt_override_conflict" });
			expect(ownerStore.readOwner(sessionId)?.state).toBe("unowned");
		} finally {
			db.close();
		}
	});
});
