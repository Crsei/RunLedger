import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionDomainPort } from "../../../src/runtime/session-runtime/session-runtime.ts";
import type { SessionProtocolOperationDescriptor } from "../../../src/runtime/session-server/protocol.ts";
import { createProductionSessionExtensionComposition, createSessionExtensionComposition } from "../../../src/runtime/session-runtime/extension-composition.ts";
import type { ExtensionReloadResult } from "../../../src/extensions/manager.ts";
import type { AgentTool } from "../../../src/runtime/types.ts";
import { localExecutionEnv } from "../../../src/runtime/execution-env.ts";
import { createEmbeddedSessionRuntime } from "../../../src/cli/embedded-session-runtime.ts";
import { buildRunledgerLayout, workspaceStorageKey } from "../../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { loadProjectSettings } from "../../../src/storage/settings-manager.ts";
import { builtinModels } from "../../../src/providers/all.ts";
import { AuthStorage } from "../../../src/storage/auth-storage.ts";
import { createRuntimeHarness } from "./harness.ts";

function snapshot() {
	return {
		messages: [],
		warnings: [],
		auditEntries: [],
		selection: { thinkingLevel: "off" as const },
		toolCount: 0,
		inFlight: false,
		providerStatuses: [],
	};
}

const readyReload: ExtensionReloadResult = { status: "ready" };

function managerStub(extra: Record<string, unknown> = {}): Parameters<typeof createSessionExtensionComposition>[0]["manager"] {
	return {
		load: async () => readyReload,
		reload: async () => readyReload,
		setEnabled: async () => readyReload,
		trust: async () => readyReload,
		untrust: async () => readyReload,
		trustSkill: async () => readyReload,
		untrustSkill: async () => readyReload,
		publicSnapshot: () => undefined,
		...extra,
	} as Parameters<typeof createSessionExtensionComposition>[0]["manager"];
}

/** 从 extension.inspect 的 domain value 中安全读取 skillProviders 投影。 */
function inspectSkillProviders(value: unknown): readonly { readonly providerId?: string; readonly state?: string; readonly candidateCount?: number }[] {
	if (value === null || typeof value !== "object" || !("snapshot" in value)) return [];
	const snapshot = (value as { readonly snapshot?: unknown }).snapshot;
	if (snapshot === null || typeof snapshot !== "object" || !("skillProviders" in snapshot)) return [];
	const providers = (snapshot as { readonly skillProviders?: unknown }).skillProviders;
	return Array.isArray(providers) ? providers as readonly { readonly providerId?: string; readonly state?: string; readonly candidateCount?: number }[] : [];
}

function mcpStub(extra: Record<string, unknown> = {}): Parameters<typeof createSessionExtensionComposition>[0]["mcp"] {
	return {
		start: async () => ({ ok: true, snapshots: [], requiredFailures: [] }),
		snapshots: () => [],
		restart: async () => ({ ok: false, error: { code: "server_not_found", message: "no server", retryable: false } }),
		tools: () => [],
		close: async () => undefined,
		...extra,
	} as Parameters<typeof createSessionExtensionComposition>[0]["mcp"];
}

const noPromptTestSecurity = [{
	source: "cli" as const,
	read: async () => ({ status: "available" as const, text: JSON.stringify({ profile: "danger-full-access" }) }),
}];

function writeMcpConfig(path: string, name: string, input: { readonly enabled: boolean; readonly required: boolean }): void {
	mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
	writeFileSync(path, JSON.stringify({
		mcpServers: {
			[name]: {
				transport: "stdio",
				command: resolve(path, "..", "missing-mcp-server"),
				enabled: input.enabled,
				required: input.required,
				startupTimeoutMs: 500,
				toolTimeoutMs: 500,
			},
		},
	}), { mode: 0o600 });
}

function workspaceMcpPath(
	layout: ReturnType<typeof buildRunledgerLayout>,
	workspaceId: string,
	repositoryId: string,
): string {
	const storageKey = workspaceStorageKey({
		authorityId: createRuntimeId("authority", "session-owner-runtime"),
		tenantId: createRuntimeId("tenant", "local-user"),
		workspaceId: createRuntimeId("workspace", workspaceId),
		repositoryId: createRuntimeId("repository", repositoryId),
	});
	return join(layout.state, "extensions", "workspaces", storageKey, "mcp.json");
}

describe("SessionRuntime extension domain", () => {
	it("assembles extensions only inside the SessionRuntime production domain", () => {
		const source = readFileSync(resolve(process.cwd(), "src/runtime/session-runtime/domain.ts"), "utf8");
		expect(source).toContain('from "./extension-composition.ts"');
		expect(source).toContain("createProductionSessionExtensionComposition");
		expect(source).toContain("extensionHookRuntime");
		expect(source).toContain("extensionTurnAdmission");
		expect(source).toContain("extensionTurnAbort");
		expect(source).toContain("modelContextAssembler");
		expect(source).not.toMatch(/runtime-host-(?:mcp|hooks|skills)/u);
		expect(source).not.toContain('new Set(["Skill"');
	});

	it("the real embedded production path owns an isolated extension snapshot and Skill tool", async () => {
		const root = mkdtempSync(resolve(tmpdir(), "runledger-session-extensions-"));
		const home = resolve(root, "home");
		mkdirSync(home, { recursive: true, mode: 0o700 });
		const layout = buildRunledgerLayout(home, "posix");
		const db = openSessionDatabase(layout.database);
		installSessionStoreSchema(db);
		const store = new SessionStore(db);
		const ownerStore = new OwnerStore(db);
		const sessionId = createRuntimeId("session", "production-extensions");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "extensions"),
			repositoryId: createRuntimeId("repository", "extensions"),
			settingsDigest: "d".repeat(64),
		});
		const settings = await loadProjectSettings({ layout });
		const models = builtinModels({ credentials: AuthStorage.create(layout) });
		await models.refresh({ allowNetwork: false });
		let embedded: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>> | undefined;
		try {
			embedded = await createEmbeddedSessionRuntime({
				sessionId,
				store,
				ownerStore,
				domain: { cwd: root, layout, settings, models, securitySources: noPromptTestSecurity },
			});
			expect(embedded.runtime).toBeDefined();
			expect(embedded.handle.supports("extension.inspect")).toBe(true);
			expect(embedded.handle.supports("mcp.list")).toBe(true);
			const inspected = await embedded.handle.transport.request({
				frameId: "query_extension_production",
				kind: "query_request",
				protocolVersion: 3,
				body: {
					queryId: "query_extension_production",
					kind: "domain_query",
					body: {
						sessionId,
						generation: embedded.handle.generation,
						correlationId: "correlation-production-extension",
						effectId: "effect-production-extension",
						operation: "extension.inspect",
						payload: {},
					},
				},
			});
			expect(inspected.body).toMatchObject({ ok: true, value: { snapshot: { descriptors: [] }, mcp: [] } });
			const snapshot = await embedded.handle.transport.request({
				frameId: "query_domain_snapshot_extensions",
				kind: "query_request",
				protocolVersion: 3,
				body: { queryId: "query_domain_snapshot_extensions", kind: "snapshot", body: {} },
			});
			expect((snapshot.body as { toolCount?: number }).toolCount).toBeGreaterThan(0);
		} finally {
			await embedded?.handle.close().catch(() => undefined);
			await embedded?.runtime?.shutdownAfterLastAttachment("paused");
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("a real required MCP startup failure prevents activation and releases the owner", async () => {
		const root = mkdtempSync(resolve(tmpdir(), "runledger-session-required-mcp-"));
		const home = resolve(root, "home");
		mkdirSync(home, { recursive: true, mode: 0o700 });
		const layout = buildRunledgerLayout(home, "posix");
		writeMcpConfig(join(layout.state, "extensions", "user", "mcp.json"), "required-broken", { enabled: true, required: true });
		const db = openSessionDatabase(layout.database);
		installSessionStoreSchema(db);
		const store = new SessionStore(db);
		const ownerStore = new OwnerStore(db);
		const sessionId = createRuntimeId("session", "required-mcp-failure");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "required-mcp"),
			repositoryId: createRuntimeId("repository", "required-mcp"),
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
				domain: { cwd: root, layout, settings, models, securitySources: noPromptTestSecurity },
			})).rejects.toMatchObject({ code: "required_extension_startup_failed" });
			expect(ownerStore.readOwner(sessionId)?.state).toBe("unowned");
			expect(store.replaySessionEvents(sessionId).map((event) => event.eventType)).toContain("extension.mcp.required_failed");
		} finally {
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("a real optional MCP startup failure remains auditable and permits activation", async () => {
		const root = mkdtempSync(resolve(tmpdir(), "runledger-session-optional-mcp-"));
		const home = resolve(root, "home");
		mkdirSync(home, { recursive: true, mode: 0o700 });
		const layout = buildRunledgerLayout(home, "posix");
		writeMcpConfig(join(layout.state, "extensions", "user", "mcp.json"), "optional-broken", { enabled: true, required: false });
		const db = openSessionDatabase(layout.database);
		installSessionStoreSchema(db);
		const store = new SessionStore(db);
		const ownerStore = new OwnerStore(db);
		const sessionId = createRuntimeId("session", "optional-mcp-failure");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", "optional-mcp"),
			repositoryId: createRuntimeId("repository", "optional-mcp"),
			settingsDigest: "d".repeat(64),
		});
		const settings = await loadProjectSettings({ layout });
		const models = builtinModels({ credentials: AuthStorage.create(layout) });
		await models.refresh({ allowNetwork: false });
		let embedded: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>> | undefined;
		try {
			embedded = await createEmbeddedSessionRuntime({
				sessionId,
				store,
				ownerStore,
				domain: { cwd: root, layout, settings, models, securitySources: noPromptTestSecurity },
			});
			expect(embedded.runtime).toBeDefined();
			expect(ownerStore.readOwner(sessionId)?.state).toBe("running");
			expect(store.replaySessionEvents(sessionId).map((event) => event.eventType)).toContain("extension.mcp.optional_failed");
		} finally {
			await embedded?.handle.close().catch(() => undefined);
			await embedded?.runtime?.shutdownAfterLastAttachment("paused");
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("two simultaneous production Sessions own separate MCP managers and workspace configs", async () => {
		const root = mkdtempSync(resolve(tmpdir(), "runledger-session-mcp-isolation-"));
		const home = resolve(root, "home");
		mkdirSync(home, { recursive: true, mode: 0o700 });
		const layout = buildRunledgerLayout(home, "posix");
		const db = openSessionDatabase(layout.database);
		installSessionStoreSchema(db);
		const store = new SessionStore(db);
		const ownerStore = new OwnerStore(db);
		const settings = await loadProjectSettings({ layout });
		const models = builtinModels({ credentials: AuthStorage.create(layout) });
		await models.refresh({ allowNetwork: false });
		const firstWorkspace = "mcp-isolation-first";
		const secondWorkspace = "mcp-isolation-second";
		const firstRepository = "mcp-isolation-first";
		const secondRepository = "mcp-isolation-second";
		writeMcpConfig(workspaceMcpPath(layout, firstWorkspace, firstRepository), "first-only", { enabled: false, required: false });
		writeMcpConfig(workspaceMcpPath(layout, secondWorkspace, secondRepository), "second-only", { enabled: false, required: false });
		const firstSessionId = createRuntimeId("session", "mcp-isolation-first");
		const secondSessionId = createRuntimeId("session", "mcp-isolation-second");
		store.createSession({ sessionId: firstSessionId, workspaceId: createRuntimeId("workspace", firstWorkspace), repositoryId: createRuntimeId("repository", firstRepository), settingsDigest: "d".repeat(64) });
		store.createSession({ sessionId: secondSessionId, workspaceId: createRuntimeId("workspace", secondWorkspace), repositoryId: createRuntimeId("repository", secondRepository), settingsDigest: "d".repeat(64) });
		let first: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>> | undefined;
		let second: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>> | undefined;
		try {
			[first, second] = await Promise.all([
				createEmbeddedSessionRuntime({ sessionId: firstSessionId, store, ownerStore, domain: { cwd: root, layout, settings, models, securitySources: noPromptTestSecurity } }),
				createEmbeddedSessionRuntime({ sessionId: secondSessionId, store, ownerStore, domain: { cwd: root, layout, settings, models, securitySources: noPromptTestSecurity } }),
			]);
			const query = async (embedded: NonNullable<typeof first>, sessionId: string, seed: string) => embedded.handle.transport.request({
				frameId: `query_${seed}`,
				kind: "query_request",
				protocolVersion: 3,
				body: { queryId: `query_${seed}`, kind: "domain_query", body: { sessionId, generation: embedded.handle.generation, correlationId: `correlation_${seed}`, effectId: `effect_${seed}`, operation: "mcp.list", payload: {} } },
			});
			const firstResult = await query(first, firstSessionId, "mcp_first");
			const secondResult = await query(second, secondSessionId, "mcp_second");
			expect(JSON.stringify(firstResult.body)).toContain("first-only");
			expect(JSON.stringify(firstResult.body)).not.toContain("second-only");
			expect(JSON.stringify(secondResult.body)).toContain("second-only");
			expect(JSON.stringify(secondResult.body)).not.toContain("first-only");
		} finally {
			await first?.handle.close().catch(() => undefined);
			await second?.handle.close().catch(() => undefined);
			await first?.runtime?.shutdownAfterLastAttachment("paused");
			await second?.runtime?.shutdownAfterLastAttachment("paused");
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reuses local-user Plugin trust across different production Sessions", async () => {
		const root = mkdtempSync(resolve(tmpdir(), "runledger-session-stable-extension-principal-"));
		const home = resolve(root, "home");
		const layout = buildRunledgerLayout(home, "posix");
		const pluginRoot = join(layout.state, "extensions", "user", "plugins", "anthropic-smoke");
		mkdirSync(join(pluginRoot, ".runledger-plugin"), { recursive: true, mode: 0o700 });
		mkdirSync(join(pluginRoot, "skills", "frontend-design"), { recursive: true, mode: 0o700 });
		writeFileSync(join(pluginRoot, ".runledger-plugin", "plugin.json"), JSON.stringify({
			name: "anthropic-smoke",
			version: "1.0.0",
			description: "Stable trust fixture",
			skills: ["./skills"],
		}), { mode: 0o600 });
		writeFileSync(join(pluginRoot, "skills", "frontend-design", "SKILL.md"), "---\nname: frontend-design\ndescription: Build polished interfaces\n---\nStable trusted body.", { mode: 0o600 });
		const firstHarness = await createRuntimeHarness("stable-extension-principal-first");
		const secondHarness = await createRuntimeHarness("stable-extension-principal-second", { crashTakeover: true });
		const managedProcess = {
			start: async () => { throw new Error("MCP transport must not start"); },
		} as unknown as Parameters<typeof createProductionSessionExtensionComposition>[0]["managedProcess"];
		let first: Awaited<ReturnType<typeof createProductionSessionExtensionComposition>> | undefined;
		let second: Awaited<ReturnType<typeof createProductionSessionExtensionComposition>> | undefined;
		try {
			first = await createProductionSessionExtensionComposition({
				layout,
				cwd: root,
				store: firstHarness.store,
				fence: firstHarness.fence,
				workspaceId: createRuntimeId("workspace", "stable-extension-principal"),
				repositoryId: createRuntimeId("repository", "stable-extension-principal"),
				executionEnv: localExecutionEnv(root),
				managedProcess,
				attemptPort: () => undefined,
				baseToolNames: ["read", "write"],
			});
			await first.start();
			const listed = await first.resources.query("plugin.list", {}, { correlationId: "corr-first-plugin", effectId: "effect-first-plugin" });
			expect(listed.ok).toBe(true);
			if (!listed.ok) throw new Error("plugin list failed");
			const pluginId = (listed.value as { readonly items?: readonly { readonly identity?: { readonly qualifiedId?: string } }[] }).items?.[0]?.identity?.qualifiedId;
			expect(pluginId).toContain("anthropic-smoke");
			if (pluginId === undefined) throw new Error("plugin identity missing");
			const mutationContext = { correlationId: "corr-first-mutation", effectId: "effect-first-mutation", expectedRevision: 1 };
			await expect(first.resources.mutate!("plugin.trust", { pluginId }, mutationContext)).resolves.toMatchObject({ ok: true });
			await expect(first.resources.mutate!("plugin.enable", { pluginId }, mutationContext)).resolves.toMatchObject({ ok: true });
			await first.shutdown("paused");

			second = await createProductionSessionExtensionComposition({
				layout,
				cwd: root,
				store: secondHarness.store,
				fence: secondHarness.fence,
				workspaceId: createRuntimeId("workspace", "stable-extension-principal"),
				repositoryId: createRuntimeId("repository", "stable-extension-principal"),
				executionEnv: localExecutionEnv(root),
				managedProcess,
				attemptPort: () => undefined,
				baseToolNames: ["read", "write"],
			});
			await second.start();
			const skills = await second.resources.query("skill.list", {}, { correlationId: "corr-second-skill", effectId: "effect-second-skill" });
			expect(skills).toMatchObject({
				ok: true,
				value: { items: [expect.objectContaining({ displayName: "frontend-design", ready: true, trusted: true })] },
			});
			expect("contextSources" in second).toBe(true);
			if (!("contextSources" in second)) return;
			const contextSources = (second as unknown as { readonly contextSources: (modelContextChars: number) => readonly { readonly layer: string; readonly content: string }[] }).contextSources(20_000);
			expect(contextSources).toEqual([expect.objectContaining({ layer: "resources" })]);
			expect(contextSources[0]?.content).toContain("frontend-design");
			expect(contextSources[0]?.content).toContain("skill:plugin:user:");
			expect(contextSources[0]?.content).not.toContain("Stable trusted body.");
			const skillTool = second.tools.find((tool) => tool.name === "Skill");
			expect(skillTool).toBeDefined();
			if (skillTool === undefined) throw new Error("Skill tool missing");
			await expect(skillTool.execute("toolCall_stable_skill", { name: "frontend-design" }, new AbortController().signal)).resolves.toMatchObject({
				content: [{ type: "text", text: "Stable trusted body." }],
			});
		} finally {
			await second?.shutdown("paused").catch(() => undefined);
			await first?.shutdown("paused").catch(() => undefined);
			await firstHarness.runtime.shutdownAfterLastAttachment("paused").catch(() => undefined);
			await secondHarness.runtime.shutdownAfterLastAttachment("paused").catch(() => undefined);
			firstHarness.cleanup();
			secondHarness.cleanup();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("lets a canonical user standalone Skill enter the standard production Session through exact trust", async () => {
		const root = mkdtempSync(resolve(tmpdir(), "runledger-session-standalone-skill-"));
		const home = resolve(root, "home");
		mkdirSync(home, { recursive: true, mode: 0o700 });
		const layout = buildRunledgerLayout(home, "posix");
		// 正控：Plugin-owned Skill 仍经 runledger-plugin provider 进入标准 Session。
		const pluginRoot = join(layout.state, "extensions", "user", "plugins", "anthropic-smoke");
		mkdirSync(join(pluginRoot, ".runledger-plugin"), { recursive: true, mode: 0o700 });
		mkdirSync(join(pluginRoot, "skills", "frontend-design"), { recursive: true, mode: 0o700 });
		writeFileSync(join(pluginRoot, ".runledger-plugin", "plugin.json"), JSON.stringify({ name: "anthropic-smoke", version: "1.0.0", description: "Plugin fixture", skills: ["./skills"] }), { mode: 0o600 });
		writeFileSync(join(pluginRoot, "skills", "frontend-design", "SKILL.md"), "---\nname: frontend-design\ndescription: Build polished interfaces\n---\nPlugin body.", { mode: 0o600 });
		// canonical user standalone Skill（02 计划 §6.1 runledger-user 装配后进入 production）。
		const standaloneRoot = join(layout.state, "extensions", "user", "skills", "release-review");
		mkdirSync(standaloneRoot, { recursive: true, mode: 0o700 });
		writeFileSync(join(standaloneRoot, "SKILL.md"), "---\nname: release-review\ndescription: Review a release safely\n---\nStandalone body.", { mode: 0o600 });
		const harness = await createRuntimeHarness("standalone-skill");
		const managedProcess = { start: async () => { throw new Error("MCP transport must not start"); } } as unknown as Parameters<typeof createProductionSessionExtensionComposition>[0]["managedProcess"];
		let composition: Awaited<ReturnType<typeof createProductionSessionExtensionComposition>> | undefined;
		try {
			composition = await createProductionSessionExtensionComposition({
				layout,
				cwd: root,
				store: harness.store,
				fence: harness.fence,
				workspaceId: createRuntimeId("workspace", "standalone-skill"),
				repositoryId: createRuntimeId("repository", "standalone-skill"),
				executionEnv: localExecutionEnv(root),
				managedProcess,
				attemptPort: () => undefined,
				baseToolNames: ["read", "write"],
			});
			await composition.start();
			const listed = await composition.resources.query("plugin.list", {}, { correlationId: "corr-skill-plugin", effectId: "effect-skill-plugin" });
			expect(listed.ok).toBe(true);
			if (!listed.ok) throw new Error("plugin list failed");
			const pluginId = (listed.value as { readonly items?: readonly { readonly identity?: { readonly qualifiedId?: string } }[] }).items?.[0]?.identity?.qualifiedId;
			expect(pluginId).toContain("anthropic-smoke");
			if (pluginId === undefined) throw new Error("plugin identity missing");
			const mutationContext = { correlationId: "corr-skill-mutation", effectId: "effect-skill-mutation", expectedRevision: 1 };
			await expect(composition.resources.mutate!("plugin.trust", { pluginId }, mutationContext)).resolves.toMatchObject({ ok: true });
			await expect(composition.resources.mutate!("plugin.enable", { pluginId }, mutationContext)).resolves.toMatchObject({ ok: true });

			const listSkills = async (): Promise<readonly { readonly displayName?: string; readonly identity?: { readonly qualifiedId?: string }; readonly ready?: boolean; readonly trusted?: boolean; readonly activation?: string }[]> => {
				const result = await composition!.resources.query("skill.list", {}, { correlationId: "corr-skill-list", effectId: "effect-skill-list" });
				expect(result.ok).toBe(true);
				if (!result.ok) throw new Error("skill list failed");
				return (result.value as { readonly items?: readonly { readonly displayName?: string; readonly identity?: { readonly qualifiedId?: string }; readonly ready?: boolean; readonly trusted?: boolean; readonly activation?: string }[] }).items ?? [];
			};
			const skillTool = composition.tools.find((tool) => tool.name === "Skill");
			expect(skillTool).toBeDefined();
			if (skillTool === undefined) throw new Error("Skill tool missing");
			const contextSources = (composition as unknown as { readonly contextSources: (modelContextChars: number) => readonly { readonly content: string }[] }).contextSources(20_000);

			// provider status/counts 进入有界 public snapshot（P3）。
			const inspected = await composition.resources.query("extension.inspect", {}, { correlationId: "corr-skill-inspect", effectId: "effect-skill-inspect" });
			expect(inspected.ok).toBe(true);
			if (!inspected.ok) throw new Error("extension inspect failed");
			const skillProviders = inspectSkillProviders(inspected.value);
			const userProvider = skillProviders.find((item) => item.providerId === "runledger-user");
			expect(userProvider).toMatchObject({ state: "loaded", candidateCount: 1 });

			// 未 trust：standalone 是 inspect 可见的 blocked 候选，不进 catalog、loader 不可达。
			const before = await listSkills();
			const standaloneId = before.find((item) => item.displayName === "release-review")?.identity?.qualifiedId;
			const standaloneBefore = before.find((item) => item.displayName === "release-review");
			expect(standaloneBefore).toMatchObject({ ready: false, trusted: false, activation: "blocked" });
			expect(standaloneId).toContain("skill:user:");
			if (standaloneId === undefined) throw new Error("standalone skill identity missing");
			const pluginBefore = before.find((item) => item.displayName === "frontend-design");
			expect(pluginBefore).toMatchObject({ ready: true, trusted: true });
			expect(contextSources[0]?.content).toContain("frontend-design");
			expect(contextSources[0]?.content).not.toContain("release-review");
			await expect(skillTool.execute("toolCall_s_plugin", { name: "frontend-design" }, new AbortController().signal)).resolves.toMatchObject({ content: [{ type: "text", text: "Plugin body." }] });
			const untrustedCall = await skillTool.execute("toolCall_s_untrusted", { name: "release-review" }, new AbortController().signal);
			expect(untrustedCall.details).toMatchObject({ matched: false, code: "not_found" });

			// exact trust 后：standalone 进入 catalog 并按需读取正文。
			await expect(composition.resources.mutate!("skill.trust", { skillId: standaloneId }, mutationContext)).resolves.toMatchObject({ ok: true });
			const after = await listSkills();
			expect(after.find((item) => item.displayName === "release-review")).toMatchObject({ ready: true, trusted: true, activation: "ready" });
			const afterSources = (composition as unknown as { readonly contextSources: (modelContextChars: number) => readonly { readonly content: string }[] }).contextSources(20_000);
			expect(afterSources[0]?.content).toContain("release-review");
			expect(afterSources[0]?.content).not.toContain("Standalone body.");
			await expect(skillTool.execute("toolCall_s_trusted", { name: "release-review" }, new AbortController().signal)).resolves.toMatchObject({ content: [{ type: "text", text: "Standalone body." }] });

			// untrust 后：撤出 active，loader 不可达，正文不再可读。
			await expect(composition.resources.mutate!("skill.untrust", { skillId: standaloneId }, mutationContext)).resolves.toMatchObject({ ok: true });
			const revoked = await listSkills();
			expect(revoked.find((item) => item.displayName === "release-review")).toMatchObject({ ready: false, trusted: false, activation: "blocked" });
			const revokedCall = await skillTool.execute("toolCall_s_revoked", { name: "release-review" }, new AbortController().signal);
			expect(revokedCall.details).toMatchObject({ matched: false, code: "not_found" });

			// provider enable/disable 只改 canonical policy 并 idle reload；关闭不遮蔽其他 provider。
			const listProviders = async (): Promise<readonly { readonly providerId?: string; readonly state?: string }[]> => {
				const result = await composition!.resources.query("skill.provider.list", {}, { correlationId: "corr-skill-providers", effectId: "effect-skill-providers" });
				expect(result.ok).toBe(true);
				if (!result.ok) throw new Error("skill provider list failed");
				const value = result.value;
				if (value === undefined || typeof value !== "object" || !("items" in value) || !Array.isArray(value.items)) return [];
				return value.items as readonly { readonly providerId?: string; readonly state?: string }[];
			};
			await expect(composition.resources.mutate!("skill.provider.disable", { providerId: "runledger-user" }, mutationContext)).resolves.toMatchObject({ ok: true });
			const afterDisable = await listSkills();
			expect(afterDisable.find((item) => item.displayName === "release-review")).toBeUndefined();
			expect(afterDisable.find((item) => item.displayName === "frontend-design")).toMatchObject({ ready: true, trusted: true });
			const disabledProvider = (await listProviders()).find((item) => item.providerId === "runledger-user");
			expect(disabledProvider).toMatchObject({ state: "disabled" });
			const persistedDocument = JSON.parse(readFileSync(layout.settings, "utf8")) as unknown;
			const persistedProviders = persistedDocument !== null && typeof persistedDocument === "object" && "skills" in persistedDocument
				? (persistedDocument as { readonly skills?: unknown }).skills
				: undefined;
			const persistedMap = persistedProviders !== null && typeof persistedProviders === "object" && "providers" in persistedProviders
				? (persistedProviders as { readonly providers?: Record<string, boolean> }).providers
				: undefined;
			expect(persistedMap?.["runledger-user"]).toBe(false);
			await expect(composition.resources.mutate!("skill.provider.enable", { providerId: "runledger-user" }, mutationContext)).resolves.toMatchObject({ ok: true });
			const afterEnable = await listSkills();
			expect(afterEnable.find((item) => item.displayName === "release-review")).toMatchObject({ activation: "blocked" });
		} finally {
			await composition?.shutdown("paused").catch(() => undefined);
			await harness.runtime.shutdownAfterLastAttachment("paused").catch(() => undefined);
			harness.cleanup();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("publishes and routes only the Session-scoped extension operation manifest", async () => {
		const operationManifest: readonly SessionProtocolOperationDescriptor[] = [
			{ operation: "extension.inspect", capability: "session.extensions", access: "read" },
			{ operation: "mcp.list", capability: "session.mcp", access: "read" },
		];
		const domain = {
			controller: { subscribe: () => () => undefined },
			resources: {
				operationManifest,
				query: async (operation: string) => ({
					ok: true as const,
					status: "ok" as const,
					operation,
					domainRevision: 1,
					value: { snapshot: { generation: 1, descriptors: [] } },
				}),
			},
			snapshot,
		} as unknown as SessionDomainPort;
		const harness = await createRuntimeHarness("extension-domain", { domain });
		try {
			const manifest = harness.runtime.protocolManifest();
			expect(manifest.protocolCapabilities).toEqual(expect.arrayContaining(["session.extensions", "session.mcp"]));
			expect(manifest.operationManifest).toEqual(expect.arrayContaining(operationManifest));

			const result = await harness.runtime.handleQuery({
				queryId: "query_extension_inspect",
				kind: "domain_query",
				body: {
					sessionId: harness.sessionId,
					generation: harness.fence.generation,
					correlationId: "correlation-extension",
					effectId: "effect-extension",
					operation: "extension.inspect",
					payload: {},
				},
			});
			expect(result).toMatchObject({ ok: true, operation: "extension.inspect", value: { snapshot: { generation: 1 } } });
		} finally {
			await harness.runtime.shutdownAfterLastAttachment("paused");
			harness.cleanup();
		}
	});

	it("keeps extension and MCP snapshots isolated per owned Session", async () => {
		const build = (name: string) => createSessionExtensionComposition({
			sessionId: `session_${name}`,
			generation: 1,
			manager: managerStub({
				load: async () => ({ status: "ready" as const }),
				publicSnapshot: () => ({
					snapshotId: `snapshot_${name}`,
					generation: 1,
					createdAt: "2026-08-09T00:00:00.000Z",
					descriptors: [{
						kind: "plugin" as const,
						identity: { kind: "plugin" as const, qualifiedId: `plugin:${name}`, version: "1.0.0", source: "project" as const, digest: "d".repeat(64) },
						enabled: true,
						trusted: true,
						ready: true,
					}],
					diagnostics: [],
					counts: { plugins: 1, skills: 0, hooks: 0, mcpServers: 0, mcpTools: 0, ready: 1, blocked: 0, disabled: 0, error: 0 },
					digest: "e".repeat(64),
				}),
			}),
			mcp: mcpStub({
				snapshots: () => [{ serverId: `mcp-server:${name}`, displayName: name, transport: "stdio" as const, required: false, state: "ready" as const, generation: 1, tools: [], diagnostics: [] }],
			}),
			closeHooks: async () => undefined,
			closePlugins: async () => undefined,
			cleanup: async () => undefined,
		});
		const first = build("first");
		const second = build("second");
		await first.start();
		await second.start();

		const firstResult = await first.resources.query("extension.inspect", {}, { correlationId: "corr-first", effectId: "effect-first" });
		const secondResult = await second.resources.query("extension.inspect", {}, { correlationId: "corr-second", effectId: "effect-second" });
		expect(firstResult).toMatchObject({ ok: true, value: { snapshot: { descriptors: expect.arrayContaining([expect.objectContaining({ identity: expect.objectContaining({ qualifiedId: "plugin:first" }) })]) } } });
		expect(JSON.stringify(firstResult)).not.toContain("plugin:second");
		expect(secondResult).toMatchObject({ ok: true, value: { mcp: [expect.objectContaining({ serverId: "mcp-server:second" })] } });
		expect(first.resources.operationManifest).toEqual(expect.arrayContaining([
			expect.objectContaining({ operation: "extension.inspect", capability: "session.extensions", access: "read" }),
			expect.objectContaining({ operation: "mcp.list", capability: "session.mcp", access: "read" }),
		]));
	});

	it("fails closed for required MCP startup and audits optional failures", async () => {
		const audit: string[] = [];
		let closed = 0;
		const required = createSessionExtensionComposition({
			sessionId: "session_required",
			generation: 2,
			manager: managerStub({ load: async () => ({ status: "ready" as const }), publicSnapshot: () => undefined }),
			mcp: mcpStub({
				start: async () => ({ ok: false, snapshots: [], requiredFailures: [{ serverId: "mcp-server:required", code: "startup_failed", message: "offline" }] }),
				close: async () => { closed += 1; },
			}),
			closeHooks: async () => undefined,
			closePlugins: async () => undefined,
			cleanup: async () => undefined,
			audit: async (event) => { audit.push(event.eventType); },
		});
		await expect(required.start()).rejects.toMatchObject({ code: "required_extension_startup_failed" });
		expect(closed).toBe(1);
		expect(audit).toContain("extension.mcp.required_failed");

		const optional = createSessionExtensionComposition({
			sessionId: "session_optional",
			generation: 1,
			manager: managerStub({ load: async () => ({ status: "ready" as const }), publicSnapshot: () => undefined }),
			mcp: mcpStub({
				start: async () => ({ ok: true, snapshots: [{ serverId: "mcp-server:optional", displayName: "optional", transport: "stdio" as const, required: false, state: "failed" as const, generation: 1, tools: [], diagnostics: [] }], requiredFailures: [] }),
			}),
			closeHooks: async () => undefined,
			closePlugins: async () => undefined,
			cleanup: async () => undefined,
			audit: async (event) => { audit.push(event.eventType); },
		});
		await expect(optional.start()).resolves.toBeUndefined();
		expect(audit).toContain("extension.mcp.optional_failed");
	});

	it("exposes Skill only through the injected revalidating loader and closes in fixed order", async () => {
		const order: string[] = [];
		const composition = createSessionExtensionComposition({
			sessionId: "session_skill",
			generation: 4,
			manager: managerStub({ load: async () => ({ status: "ready" as const }), publicSnapshot: () => undefined }),
			mcp: mcpStub({
				tools: () => [{ name: "mcp_catalog" } as AgentTool],
				close: async () => { order.push("mcp"); },
			}),
			skillLoader: async () => ({ ok: true, body: "trusted body", allowedTools: ["read"] }),
			closeHooks: async () => { order.push("hooks"); },
			closePlugins: async () => { order.push("plugins"); },
			cleanup: async () => { order.push("cleanup"); },
		});
		const skill = composition.tools.find((tool) => tool.name === "Skill");
		expect(skill).toBeDefined();
		if (skill === undefined) return;
		const loaded = await skill.execute("toolCall_skill", { name: "skill:trusted" }, new AbortController().signal);
		expect(loaded).toMatchObject({
			content: [{ type: "text", text: "trusted body" }],
			details: { matched: true, allowedTools: ["read"] },
		});
		expect(composition.tools.map((tool) => tool.name)).toContain("mcp_catalog");

		await composition.shutdown("paused");
		expect(order).toEqual(["mcp", "hooks", "plugins", "cleanup"]);
	});

	it("denies mcp_call at the recovery barrier before touching an MCP transport", async () => {
		const harness = await createRuntimeHarness("extension-mcp-barrier");
		const layout = buildRunledgerLayout(join(harness.dir, "home"), "posix");
		let settlements = 0;
		const composition = await createProductionSessionExtensionComposition({
			layout,
			cwd: harness.dir,
			store: harness.store,
			fence: harness.fence,
			workspaceId: createRuntimeId("workspace", "extension-mcp-barrier"),
			repositoryId: createRuntimeId("repository", "extension-mcp-barrier"),
			executionEnv: localExecutionEnv(harness.dir),
			managedProcess: {
				start: async () => { throw new Error("MCP transport must not start"); },
			} as unknown as Parameters<typeof createProductionSessionExtensionComposition>[0]["managedProcess"],
			attemptPort: () => ({
				beginAttempt: () => ({ error: "recovery_barrier_active" }),
				settleAttempt: () => { settlements += 1; return { ok: true }; },
			}),
			baseToolNames: ["read", "write", "bash"],
		});
		try {
			await composition.start();
			const call = composition.tools.find((tool) => tool.name === "mcp_call");
			expect(call).toBeDefined();
			if (call === undefined) return;
			const result = await call.execute("toolCall_mcp_barrier", {
				serverId: "mcp-server:fixture",
				toolName: "mutate",
				input: { value: "must-not-run" },
			}, new AbortController().signal);
			expect(result).toMatchObject({ isError: true, details: { code: "recovery_barrier_active" } });
			expect(settlements).toBe(0);
		} finally {
			await composition.shutdown("paused");
			await harness.runtime.shutdownAfterLastAttachment("paused");
			harness.cleanup();
		}
	});

	it("routes extension mutations to resources.mutate through the Session domain command channel", async () => {
		const mutated: string[] = [];
		const operationManifest: readonly SessionProtocolOperationDescriptor[] = [
			{ operation: "extension.inspect", capability: "session.extensions", access: "read" },
			{ operation: "plugin.enable", capability: "session.plugins", access: "mutate" },
			{ operation: "plugin.trust", capability: "session.plugins", access: "mutate" },
			{ operation: "mcp.restart", capability: "session.mcp", access: "mutate" },
		];
		const domain = {
			controller: { subscribe: () => () => undefined },
			resources: {
				operationManifest,
				query: async (operation: string) => ({
					ok: true as const,
					status: "ok" as const,
					operation,
					domainRevision: 1,
					value: {},
				}),
				mutate: async (operation: string, payload: Record<string, unknown>) => {
					mutated.push(`${operation}:${JSON.stringify(payload)}`);
					return {
						ok: true as const,
						status: "ok" as const,
						operation,
						domainRevision: 1,
						value: { pluginId: payload.pluginId, serverId: payload.serverId },
					};
				},
			},
			snapshot,
		} as unknown as SessionDomainPort;
		const harness = await createRuntimeHarness("extension-mutation-route", { domain });
		const meta = { connectionId: "connection_ext_mutation" as never, clientId: "driver", isDriver: true };
		try {
			const command = async (operation: string, payload: Record<string, unknown>) => harness.runtime.handleCommand({
				commandId: `command_${operation.replaceAll(".", "_")}`,
				kind: "domain_command",
				body: {
					sessionId: harness.sessionId,
					generation: harness.fence.generation,
					correlationId: `correlation_${operation}`,
					effectId: `effect_${operation}`,
					operation,
					payload,
					expectedRevision: 1,
				},
			}, meta);
			const enabled = await command("plugin.enable", { pluginId: "plugin:fixture" });
			const trusted = await command("plugin.trust", { pluginId: "plugin:fixture" });
			const restarted = await command("mcp.restart", { serverId: "mcp-server:fixture" });
			expect(enabled).toMatchObject({ ok: true, result: { ok: true, operation: "plugin.enable" } });
			expect(trusted).toMatchObject({ ok: true, result: { ok: true, operation: "plugin.trust" } });
			expect(restarted).toMatchObject({ ok: true, result: { ok: true, operation: "mcp.restart" } });
			expect(mutated).toEqual([
				'plugin.enable:{"pluginId":"plugin:fixture"}',
				'plugin.trust:{"pluginId":"plugin:fixture"}',
				'mcp.restart:{"serverId":"mcp-server:fixture"}',
			]);
		} finally {
			await harness.runtime.shutdownAfterLastAttachment("paused");
			harness.cleanup();
		}
	});

	it("rejects extension mutations while the recovery barrier is open", async () => {
		const operationManifest: readonly SessionProtocolOperationDescriptor[] = [
			{ operation: "plugin.enable", capability: "session.plugins", access: "mutate" },
		];
		let mutationCalls = 0;
		const domain = {
			controller: { subscribe: () => () => undefined },
			process: { operationManifest: [], hasRecoveryUncertainty: () => true },
			resources: {
				operationManifest,
				query: async (operation: string) => ({
					ok: true as const,
					status: "ok" as const,
					operation,
					domainRevision: 1,
					value: {},
				}),
				mutate: async () => {
					mutationCalls += 1;
					return { ok: false, status: "failed" as const, code: "must_not_run", operation: "plugin.enable" };
				},
			},
			snapshot,
		} as unknown as SessionDomainPort;
		const harness = await createRuntimeHarness("extension-mutation-barrier", { crashTakeover: true, domain });
		try {
			expect(harness.runtime.recoveryAssess()).toMatchObject({ barrierState: "open" });
			const result = await harness.runtime.handleCommand({
				commandId: "command_plugin_enable_barrier",
				kind: "domain_command",
				body: {
					sessionId: harness.sessionId,
					generation: harness.fence.generation,
					correlationId: "correlation_barrier",
					effectId: "effect_barrier",
					operation: "plugin.enable",
					payload: { pluginId: "plugin:fixture" },
					expectedRevision: 1,
				},
			}, { connectionId: "connection_ext_barrier" as never, clientId: "driver", isDriver: true });
			expect(result).toMatchObject({ ok: true, result: { ok: false, status: "recovery_required", code: "recovery_barrier_active" } });
			expect(mutationCalls).toBe(0);
		} finally {
			await harness.runtime.shutdownAfterLastAttachment("paused");
			harness.cleanup();
		}
	});

	it("routes plugin mutations and MCP restarts through the composition manager", async () => {
		const calls: string[] = [];
		const reloaded: ExtensionReloadResult = { status: "ready", snapshot: {
			snapshotId: "snapshot_reloaded",
			generation: 2,
			createdAt: "2026-08-09T00:00:00.000Z",
			descriptors: [],
			diagnostics: [],
			counts: { plugins: 0, skills: 0, hooks: 0, mcpServers: 0, mcpTools: 0, ready: 0, blocked: 0, disabled: 0, error: 0 },
			digest: "f".repeat(64),
		} };
		const composition = createSessionExtensionComposition({
			sessionId: "session_mutation",
			generation: 1,
			manager: {
				load: async () => ({ status: "ready" as const }),
				reload: async () => { calls.push("reload"); return reloaded; },
				setEnabled: async (pluginId, enabled) => { calls.push(`setEnabled:${pluginId}:${enabled}`); return reloaded; },
				trust: async (pluginId) => { calls.push(`trust:${pluginId}`); return reloaded; },
				untrust: async (pluginId) => { calls.push(`untrust:${pluginId}`); return reloaded; },
				publicSnapshot: () => reloaded.snapshot ?? undefined,
			},
			mcp: {
				start: async () => ({ ok: true, snapshots: [], requiredFailures: [] }),
				snapshots: () => [],
				restart: async (serverId) => { calls.push(`restart:${serverId}`); return { ok: true, value: { serverId, displayName: serverId, transport: "stdio" as const, required: false, state: "ready" as const, generation: 3, tools: [], diagnostics: [] } }; },
				tools: () => [],
				close: async () => undefined,
			},
			closeHooks: async () => undefined,
			closePlugins: async () => undefined,
			cleanup: async () => undefined,
		});
		const ctx = { correlationId: "corr-m", effectId: "effect-m", expectedRevision: 1 };

		await expect(composition.resources.mutate!("plugin.enable", { pluginId: "plugin:fixture" }, ctx)).resolves.toMatchObject({ ok: true, operation: "plugin.enable" });
		await expect(composition.resources.mutate!("plugin.trust", { pluginId: "plugin:fixture" }, ctx)).resolves.toMatchObject({ ok: true, operation: "plugin.trust" });
		await expect(composition.resources.mutate!("extension.reload", {}, ctx)).resolves.toMatchObject({ ok: true, operation: "extension.reload" });
		await expect(composition.resources.mutate!("mcp.restart", { serverId: "mcp-server:fixture" }, ctx)).resolves.toMatchObject({ ok: true, operation: "mcp.restart" });
		await expect(composition.resources.mutate!("plugin.enable", {}, ctx)).resolves.toMatchObject({ ok: false, code: "plugin_id_required" });
		expect(calls).toEqual([
			"setEnabled:plugin:fixture:true",
			"trust:plugin:fixture",
			"reload",
			"restart:mcp-server:fixture",
		]);
	});

	it("closes external lifecycles before checkpointing and releasing the owner", async () => {
		const order: string[] = [];
		const domain = {
			controller: {
				subscribe: () => () => undefined,
				interrupt: () => undefined,
				waitForIdle: async () => { order.push("settle"); },
				dispose: () => undefined,
			},
			snapshot,
		} as unknown as SessionDomainPort;
		const harness = await createRuntimeHarness("extension-shutdown-order", {
			domain,
			lifecycleCleanup: async () => { order.push("extensions-closed"); },
		});
		const unsubscribe = harness.runtime.onEvent((event) => {
			if (event.eventType === "session.checkpoint") order.push("checkpoint");
		});
		try {
			await harness.runtime.shutdownAfterLastAttachment("paused");
			expect(order).toEqual(["settle", "extensions-closed", "checkpoint"]);
			expect(harness.ownerStore.readOwner(harness.sessionId)?.state).toBe("unowned");
		} finally {
			unsubscribe();
			harness.cleanup();
		}
	});
});
