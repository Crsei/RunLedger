import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeHarness, type RuntimeHarness } from "./harness.ts";
import type { SessionDomainPort } from "../../../src/runtime/session-runtime/session-runtime.ts";
import type { MultiAgentDomainPort } from "../../../src/runtime/agents/domain.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { createEmbeddedSessionRuntime } from "../../../src/cli/embedded-session-runtime.ts";
import { buildRunledgerLayout, workspaceStorageKey } from "../../../src/runtime/contracts/storage-layout.ts";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { loadLayeredProjectSettings, loadProjectSettings, saveProjectSettings } from "../../../src/storage/settings-manager.ts";
import { builtinModels } from "../../../src/providers/all.ts";
import { AuthStorage } from "../../../src/storage/auth-storage.ts";
import { deriveGovernedChildCapabilitySubset } from "../../../src/runtime/agents/capability-subset.ts";

let harness: RuntimeHarness | undefined;

afterEach(async () => {
	if (harness === undefined) return;
	await harness.server.close();
	harness.store.database().close();
	harness.cleanup();
	harness = undefined;
});

function domain(): SessionDomainPort {
	const multiAgent: MultiAgentDomainPort = {
		operationManifest: [
			{ operation: "agent.inspect", capability: "session.multi-agent", access: "read" },
			{ operation: "agent.spawn", capability: "session.multi-agent", access: "mutate" },
			{ operation: "agent.cancel", capability: "session.multi-agent", access: "mutate" },
		],
		query: async (operation) => ({ ok: true, status: "ok", operation, domainRevision: 1, value: { nodes: [] } }),
		mutate: async (operation) => ({ ok: true, status: "ok", operation, domainRevision: 1, value: {} }),
		spawn: async () => ({ ok: false, error: { code: "recovery_required", message: "barrier" } }),
		recover: async () => ({ ok: true, value: { stopped: [], recoveryRequired: [] } }),
	};
	return {
		controller: { subscribe: () => () => undefined } as unknown as SessionDomainPort["controller"],
		multiAgent,
		snapshot: () => ({ messages: [], warnings: [], auditEntries: [], selection: { thinkingLevel: "off" }, toolCount: 0, inFlight: false, providerStatuses: [] }),
	};
}

const noPromptTestSecurity = [{
	source: "cli" as const,
	read: async () => ({ status: "available" as const, text: JSON.stringify({ profile: "danger-full-access" }) }),
}];

function workspacePolicyKey(workspaceId: string, repositoryId: string): string {
	return workspaceStorageKey({
		authorityId: createRuntimeId("authority", "session-owner-runtime"),
		tenantId: createRuntimeId("tenant", "local-user"),
		workspaceId: createRuntimeId("workspace", workspaceId),
		repositoryId: createRuntimeId("repository", repositoryId),
	});
}

async function layeredMultiAgentSources(layout: ReturnType<typeof buildRunledgerLayout>, workspaceKey: string) {
	const layered = await loadLayeredProjectSettings({ layout, workspaceKey });
	const source = (layer: typeof layered.user) => layer.multiAgent.state === "valid"
		? layer.multiAgent.value
		: layer.multiAgent.state === "invalid" ? layer.multiAgent.raw : undefined;
	return { user: source(layered.user), workspace: source(layered.workspace) };
}

describe("SessionRuntime multi-agent composition", () => {
	it("routes inspect asynchronously and keeps the agent operation manifest explicit", async () => {
		harness = await createRuntimeHarness("multi-agent-composition", { domain: domain() });
		const result = await harness.runtime.handleQuery({
			kind: "domain_query",
			body: {
				sessionId: harness.sessionId,
				generation: harness.fence.generation,
				correlationId: "correlation-inspect",
				effectId: "effect-inspect",
				operation: "agent.inspect",
				payload: {},
			},
		});
		expect(result).toMatchObject({ ok: true, status: "ok", operation: "agent.inspect", value: { nodes: [] } });
		expect(harness.runtime.protocolManifest().protocolCapabilities).toContain("session.multi-agent");
	});

	it("does not expose an agent.reconcile mutation and preserves driver fencing", async () => {
		harness = await createRuntimeHarness("multi-agent-composition-fence", { domain: domain() });
		const unknown = await harness.runtime.handleQuery({
			kind: "domain_query",
			body: {
				sessionId: harness.sessionId,
				generation: harness.fence.generation,
				correlationId: "correlation-reconcile",
				effectId: "effect-reconcile",
				operation: "agent.reconcile",
				payload: {},
			},
		});
		expect(unknown).toMatchObject({ ok: false, status: "unavailable", code: "operation_unavailable" });
		const observer = await harness.runtime.handleCommand({
			commandId: createRuntimeId("command", "observer-agent"),
			kind: "domain_command",
			body: {
				sessionId: harness.sessionId,
				generation: harness.fence.generation,
				correlationId: "correlation-spawn",
				effectId: "effect-spawn",
				operation: "agent.spawn",
				expectedRevision: 0,
				payload: {},
			},
		}, { connectionId: createRuntimeId("connection", "observer-agent"), clientId: "client_observer_agent", isDriver: false });
		expect(observer).toEqual({ ok: false, code: "observer_mutation_forbidden" });
	});

	it("rejects a non-record payload before routing an async multi-agent operation", async () => {
		let queries = 0;
		const multiAgent: MultiAgentDomainPort = {
			operationManifest: [
				{ operation: "agent.inspect", capability: "session.multi-agent", access: "read" },
			],
			query: async () => {
				queries += 1;
				return { ok: true, status: "ok", operation: "agent.inspect", domainRevision: 0, value: {} };
			},
			mutate: async (operation) => ({ ok: true, status: "ok", operation, domainRevision: 0, value: {} }),
			spawn: async () => ({ ok: false, error: { code: "runtime_unavailable", message: "not used" } }),
			recover: async () => ({ ok: true, value: { stopped: [], recoveryRequired: [] } }),
		};
		const invalidDomain: SessionDomainPort = {
			controller: { subscribe: () => () => undefined } as unknown as SessionDomainPort["controller"],
			multiAgent,
			snapshot: () => ({ messages: [], warnings: [], auditEntries: [], selection: { thinkingLevel: "off" }, toolCount: 0, inFlight: false, providerStatuses: [] }),
		};
		harness = await createRuntimeHarness("multi-agent-invalid-payload", { domain: invalidDomain });
		const result = await harness.runtime.handleQuery({
			kind: "domain_query",
			body: {
				sessionId: harness.sessionId,
				generation: harness.fence.generation,
				correlationId: "correlation-invalid-payload",
				effectId: "effect-invalid-payload",
				operation: "agent.inspect",
				payload: new Date(0),
			},
		});
		expect(result).toMatchObject({ ok: false, status: "failed", code: "invalid_domain_envelope" });
		expect(queries).toBe(0);
	});

	it("assembles the enabled production domain only after durable root registration and projects governed child tools", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-session-multi-agent-production-"));
		const home = join(root, "home");
		mkdirSync(home, { recursive: true, mode: 0o700 });
		const layout = buildRunledgerLayout(home, "posix");
		const db = openSessionDatabase(layout.database);
		installSessionStoreSchema(db);
		const store = new SessionStore(db);
		const ownerStore = new OwnerStore(db);
		const workspaceId = "multi-agent-production";
		const repositoryId = "multi-agent-production";
		const workspaceKey = workspacePolicyKey(workspaceId, repositoryId);
		await saveProjectSettings({ layout }, { multiAgent: { enabled: true } });
		await saveProjectSettings({ layout, workspaceKey }, { multiAgent: { enabled: true } });
		const sessionId = createRuntimeId("session", "multi-agent-production");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", workspaceId),
			repositoryId: createRuntimeId("repository", repositoryId),
			settingsDigest: "d".repeat(64),
		});
		const settings = await loadProjectSettings({ layout });
		const models = builtinModels({ credentials: AuthStorage.create(layout) });
		await models.refresh({ allowNetwork: false });
		let embedded: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>> | undefined;
		try {
			const sources = await layeredMultiAgentSources(layout, workspaceKey);
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
					multiAgent: { runtimeEnabled: true, ...sources },
				},
			});
			expect(embedded.runtime).toBeDefined();
			if (embedded.runtime === undefined) throw new Error("production runtime was not claimed");
			const productionDomain = (embedded.runtime as unknown as { readonly domain?: SessionDomainPort }).domain;
			const multiAgent = productionDomain?.multiAgent;
			const productionSource = productionDomain?.childRuntime?.productionToolSource;
			expect(multiAgent?.tools.map((tool) => tool.name)).toEqual(["spawn_agent"]);
			expect(productionSource?.tools.some((tool) => tool.name === "spawn_agent")).toBe(false);
			expect(productionDomain?.controller.toolCount).toBe((productionSource?.tools.length ?? 0) + 1);
			expect(embedded.handle.supports("agent.inspect")).toBe(true);

			const rootEvent = store.replaySessionEvents(sessionId).find((event) => event.eventType === "agent.root_registered");
			expect(rootEvent).toBeDefined();
			expect(rootEvent?.sequence).toBeGreaterThan(0);
			expect(rootEvent?.payloadJson).toContain("policyReceiptDigest");

			const subset = await deriveGovernedChildCapabilitySubset(productionSource, ["workspace.read", "workspace.search", "workspace.list"]);
			expect(subset).toMatchObject({ ok: true });
			if (!subset.ok) return;
			expect(subset.value.tools.map((tool) => tool.name)).toEqual(["read", "grep", "find", "glob", "ls"]);
		} finally {
			await embedded?.handle.close().catch(() => undefined);
			await embedded?.runtime?.shutdownAfterLastAttachment("paused");
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps spawn_agent unavailable when the production runtime gate is closed", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-session-multi-agent-disabled-"));
		const home = join(root, "home");
		mkdirSync(home, { recursive: true, mode: 0o700 });
		const layout = buildRunledgerLayout(home, "posix");
		const db = openSessionDatabase(layout.database);
		installSessionStoreSchema(db);
		const store = new SessionStore(db);
		const ownerStore = new OwnerStore(db);
		const workspaceId = "multi-agent-disabled";
		const repositoryId = "multi-agent-disabled";
		const workspaceKey = workspacePolicyKey(workspaceId, repositoryId);
		await saveProjectSettings({ layout }, { multiAgent: { enabled: true } });
		await saveProjectSettings({ layout, workspaceKey }, { multiAgent: { enabled: true } });
		const sessionId = createRuntimeId("session", "multi-agent-disabled");
		store.createSession({
			sessionId,
			workspaceId: createRuntimeId("workspace", workspaceId),
			repositoryId: createRuntimeId("repository", repositoryId),
			settingsDigest: "d".repeat(64),
		});
		const settings = await loadProjectSettings({ layout });
		const models = builtinModels({ credentials: AuthStorage.create(layout) });
		await models.refresh({ allowNetwork: false });
		let embedded: Awaited<ReturnType<typeof createEmbeddedSessionRuntime>> | undefined;
		try {
			const sources = await layeredMultiAgentSources(layout, workspaceKey);
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
					multiAgent: { runtimeEnabled: false, ...sources },
				},
			});
			expect(embedded.runtime).toBeDefined();
			expect(embedded.handle.supports("agent.inspect")).toBe(false);
			expect(store.replaySessionEvents(sessionId).some((event) => event.eventType === "agent.root_registered")).toBe(false);
		} finally {
			await embedded?.handle.close().catch(() => undefined);
			await embedded?.runtime?.shutdownAfterLastAttachment("paused");
			db.close();
			rmSync(root, { recursive: true, force: true });
		}
	});
});
