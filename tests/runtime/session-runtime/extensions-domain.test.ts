import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionDomainPort } from "../../../src/runtime/session-runtime/session-runtime.ts";
import type { SessionProtocolOperationDescriptor } from "../../../src/runtime/session-server/protocol.ts";
import { createProductionSessionExtensionComposition, createSessionExtensionComposition } from "../../../src/runtime/session-runtime/extension-composition.ts";
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
			manager: {
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
					counts: { plugins: 1, skills: 0, hooks: 0, mcpServers: 0, ready: 1, blocked: 0, failed: 0 },
					digest: "e".repeat(64),
				}),
			},
			mcp: {
				start: async () => ({ ok: true, snapshots: [], requiredFailures: [] }),
				snapshots: () => [{ serverId: `mcp-server:${name}`, displayName: name, transport: "stdio" as const, required: false, state: "ready" as const, generation: 1, tools: [], diagnostics: [] }],
				tools: () => [],
				close: async () => undefined,
			},
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
			manager: { load: async () => ({ status: "ready" as const }), publicSnapshot: () => undefined },
			mcp: {
				start: async () => ({ ok: false, snapshots: [], requiredFailures: [{ serverId: "mcp-server:required", code: "startup_failed", message: "offline" }] }),
				snapshots: () => [],
				tools: () => [],
				close: async () => { closed += 1; },
			},
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
			manager: { load: async () => ({ status: "ready" as const }), publicSnapshot: () => undefined },
			mcp: {
				start: async () => ({ ok: true, snapshots: [{ serverId: "mcp-server:optional", transport: "stdio" as const, required: false, state: "failed" as const, generation: 1, tools: [], diagnostics: [] }], requiredFailures: [] }),
				snapshots: () => [],
				tools: () => [],
				close: async () => undefined,
			},
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
			manager: { load: async () => ({ status: "ready" as const }), publicSnapshot: () => undefined },
			mcp: {
				start: async () => ({ ok: true, snapshots: [], requiredFailures: [] }),
				snapshots: () => [],
				tools: () => [{ name: "mcp_catalog" } as AgentTool],
				close: async () => { order.push("mcp"); },
			},
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
