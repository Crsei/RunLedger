/**
 * R6:SessionRuntime `login` 命令 —— driver 专属、reverse-request interaction
 * 注入、失败 typed 化。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { rmSyncRetry } from "../../helpers/cleanup.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSessionDatabase, type SessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { SessionRuntime, type SessionDomainPort } from "../../../src/runtime/session-runtime/session-runtime.ts";
import type { InteractiveSessionControllerPort, ProviderStatus } from "../../../src/runtime/interactive-session-controller.ts";
import type { AuthInteraction, AuthType, Credential } from "../../../src/auth/types.ts";
import type { SessionId } from "../../../src/runtime/protocol/ids.ts";
import { createRuntimeId } from "../../../src/runtime/protocol/ids.ts";
import { restoreSession } from "../../../src/runtime/session-runtime/restore.ts";
import type { SessionDomainSnapshot } from "../../../src/runtime/session-runtime/session-runtime.ts";
import type { AgentMessage, AgentTool } from "../../../src/runtime/types.ts";
import type { RuntimeSelection } from "../../../src/runtime/interactive-session-controller.ts";

let dir: string;
const dbs: SessionDatabase[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-login-cmd-"));
});

afterEach(() => {
	for (const db of dbs.splice(0)) db.close();
	rmSyncRetry(dir);
});

interface Ctx {
	store: SessionStore;
	ownerStore: OwnerStore;
	sessionId: SessionId;
}

function openCtx(): Ctx {
	const db = openSessionDatabase(join(dir, "state.db"));
	dbs.push(db);
	installSessionStoreSchema(db);
	const store = new SessionStore(db);
	const ownerStore = new OwnerStore(db);
	const sessionId = createRuntimeId("session", "login");
	store.createSession({ sessionId, workspaceId: createRuntimeId("workspace", "w"), repositoryId: createRuntimeId("repository", "r"), settingsDigest: "d".repeat(64) });
	return { store, ownerStore, sessionId };
}

/** 最小 mock controller,只实现 SessionRuntime 用到的面。 */
function mockDomain(loginImpl?: (providerId: string, type: AuthType, interaction: AuthInteraction) => Promise<void>): { domain: SessionDomainPort; loginArgs: Array<{ providerId: string; type: AuthType }> } {
	const loginArgs: Array<{ providerId: string; type: AuthType }> = [];
	const controller = {
		subscribe: () => () => undefined,
		messages: [] as readonly AgentMessage[],
		warnings: [] as readonly string[],
		auditEntries: [] as readonly unknown[],
		toolCount: 0,
		inFlight: false,
		currentSelection: { thinkingLevel: "off" } as RuntimeSelection,
		getSteeringMessages: () => [],
		getFollowUpMessages: () => [],
		getProviderStatuses: async (): Promise<ProviderStatus[]> => [{ id: "deepseek", name: "DeepSeek", configured: true, authTypes: ["api_key"], interactiveAuthTypes: ["api_key"] }],
		getProvider: () => undefined,
		getAvailableModels: async () => [],
		login: async (providerId: string, type: AuthType, interaction: AuthInteraction) => {
			loginArgs.push({ providerId, type });
			await loginImpl?.(providerId, type, interaction);
		},
		logout: async () => undefined,
		selectModel: async () => undefined,
		setThinkingLevel: async (level: string) => level,
		prompt: async () => undefined,
		interrupt: () => undefined,
		clearAllQueues: () => ({ steering: [], followUp: [] }),
		waitForIdle: async () => undefined,
		dispose: () => undefined,
	} as unknown as InteractiveSessionControllerPort;
	const domain: SessionDomainPort = {
		controller,
		snapshot: (): SessionDomainSnapshot => ({
			messages: [],
			warnings: [],
			auditEntries: [],
			selection: { thinkingLevel: "off" },
			toolCount: 0,
			inFlight: false,
			providerStatuses: [],
		}),
	};
	return { domain, loginArgs };
}

async function runtimeWithDomain(domain: SessionDomainPort): Promise<SessionRuntime> {
	// 直接构造 runtime 即可;不 bind server/start(handleCommand 可独立调用)。
	// 需要一个 server 供 reverse-request sender;用 stub 不需要真连。
	const ctx = openCtx();
	const restored = restoreSession(ctx.store, ctx.sessionId);
	if (!restored.ok) throw new Error("restore failed");
	const fence = { sessionId: ctx.sessionId, generation: 1, runtimeId: createRuntimeId("runtime", "login") };
	const runtime = new SessionRuntime({
		sessionId: ctx.sessionId,
		store: ctx.store,
		ownerStore: ctx.ownerStore,
		owner: {} as never,
		server: { requestToConnection: async () => { throw new Error("reverse request timed out"); } } as never,
		fence,
		crashTakeover: false,
		restored,
		domain,
	});
	return runtime;
}

describe("SessionRuntime login command", () => {
	it("allows an observer to execute an operation classified as read-only", async () => {
		const { domain } = mockDomain();
		const runtime = await runtimeWithDomain(domain);
		const result = await runtime.handleCommand({ commandId: createRuntimeId("command", "read"), kind: "provider_status", body: {} }, {
			connectionId: createRuntimeId("connection", "obs-read"),
			clientId: "client_observer" as never,
			isDriver: false,
		});
		expect(result).toMatchObject({ ok: true, kind: "provider_status" });
	});

	it("rejects non-driver connections", async () => {
		const { domain } = mockDomain();
		const runtime = await runtimeWithDomain(domain);
		const result = await runtime.handleCommand({ commandId: createRuntimeId("command", "c"), kind: "login", body: { providerId: "deepseek", authType: "api_key" } }, {
			connectionId: createRuntimeId("connection", "obs"),
			clientId: "client_observer" as never,
			isDriver: false,
		});
		expect(result).toMatchObject({ ok: false, code: "observer_mutation_forbidden" });
	});

	it("returns domain_unavailable when no domain is composed", async () => {
		const ctx = openCtx();
		const restored = restoreSession(ctx.store, ctx.sessionId);
		if (!restored.ok) throw new Error("restore failed");
		const fence = { sessionId: ctx.sessionId, generation: 1, runtimeId: createRuntimeId("runtime", "login") };
		const runtime = new SessionRuntime({
			sessionId: ctx.sessionId,
			store: ctx.store,
			ownerStore: ctx.ownerStore,
			owner: {} as never,
			server: {} as never,
			fence,
			crashTakeover: false,
			restored,
		});
		const result = await runtime.handleCommand({ commandId: createRuntimeId("command", "c"), kind: "login", body: { providerId: "deepseek", authType: "api_key" } }, {
			connectionId: createRuntimeId("connection", "d"),
			clientId: "client_driver" as never,
			isDriver: true,
		});
		expect(result).toMatchObject({ ok: false, code: "domain_unavailable" });
	});

	it("validates providerId and authType", async () => {
		const { domain } = mockDomain();
		const runtime = await runtimeWithDomain(domain);
		const meta = { connectionId: createRuntimeId("connection", "d"), clientId: "client_driver" as never, isDriver: true };
		await expect(runtime.handleCommand({ commandId: createRuntimeId("command", "c"), kind: "login", body: { providerId: "", authType: "api_key" } }, meta)).resolves.toMatchObject({ ok: false, code: "invalid_input" });
		await expect(runtime.handleCommand({ commandId: createRuntimeId("command", "c"), kind: "login", body: { providerId: "deepseek", authType: "magic" } }, meta)).resolves.toMatchObject({ ok: false, code: "invalid_input" });
	});

	it("runs domain login with a reverse-request interaction and returns provider status", async () => {
		let receivedInteraction: AuthInteraction | undefined;
		const { domain, loginArgs } = mockDomain(async (_providerId, _type, interaction) => {
			receivedInteraction = interaction;
		});
		const runtime = await runtimeWithDomain(domain);
		const result = await runtime.handleCommand({ commandId: createRuntimeId("command", "c"), kind: "login", body: { providerId: "deepseek", authType: "api_key" } }, {
			connectionId: createRuntimeId("connection", "d"),
			clientId: "client_driver" as never,
			isDriver: true,
		});
		expect(result.ok).toBe(true);
		expect(loginArgs).toEqual([{ providerId: "deepseek", type: "api_key" }]);
		expect(receivedInteraction).toBeDefined();
		expect(typeof receivedInteraction?.prompt).toBe("function");
		expect(typeof receivedInteraction?.notify).toBe("function");
		if (result.ok) expect(result.result.providers).toEqual([{ id: "deepseek", name: "DeepSeek", configured: true, authTypes: ["api_key"], interactiveAuthTypes: ["api_key"] }]);
	});

	it("maps a failed login to login_failed with detail", async () => {
		const { domain } = mockDomain(async () => {
			throw new Error("login cancelled by user");
		});
		const runtime = await runtimeWithDomain(domain);
		const result = await runtime.handleCommand({ commandId: createRuntimeId("command", "c"), kind: "login", body: { providerId: "deepseek", authType: "api_key" } }, {
			connectionId: createRuntimeId("connection", "d"),
			clientId: "client_driver" as never,
			isDriver: true,
		});
		expect(result).toMatchObject({ ok: false, code: "login_failed", detail: "login cancelled by user" });
	});
});
