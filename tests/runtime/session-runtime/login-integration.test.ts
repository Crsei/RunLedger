/**
 * R6/credential reverse-request 端到端:真实 TCP 上 driver 连接经
 * reverse-request 完成 api-key login 并写入 auth.json。
 *
 * 复刻 embedded composition(server + owner + runtime + start),但用真实
 * Models(AuthStorage 为 credential store)与最小 domain controller,
 * 不依赖完整 InteractiveSessionController/security/ledger 装配。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { rmSyncRetry } from "../../../tests/helpers/cleanup.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSessionDatabase, type SessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { AuthStorage } from "../../../src/storage/auth-storage.ts";
import { builtinModels } from "../../../src/providers/all.ts";
import { SessionOwner } from "../../../src/runtime/session-owner/session-owner.ts";
import { SessionRuntimeServer } from "../../../src/runtime/session-server/runtime-server.ts";
import { SessionRuntime, type SessionDomainPort } from "../../../src/runtime/session-runtime/session-runtime.ts";
import { restoreSession } from "../../../src/runtime/session-runtime/restore.ts";
import { SessionClient } from "../../../src/cli/session-client.ts";
import { SessionInteractiveController, type SessionInteractiveSnapshot } from "../../../src/cli/session-interactive-controller.ts";
import { buildRunledgerLayout } from "../../../src/runtime/contracts/storage-layout.ts";
import { createRuntimeId, type SessionId } from "../../../src/runtime/protocol/ids.ts";
import type { SessionFrameEnvelope } from "../../../src/runtime/session-server/protocol.ts";
import type { AuthInteraction, AuthType } from "../../../src/auth/types.ts";
import type { InteractiveSessionControllerPort, ProviderStatus } from "../../../src/runtime/interactive-session-controller.ts";

let dir: string;
let homeDir: string;
const dbs: SessionDatabase[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-login-e2e-"));
	homeDir = mkdtempSync(join(tmpdir(), "session-login-home-"));
});

afterEach(() => {
	for (const db of dbs.splice(0)) db.close();
	rmSyncRetry(dir);
	rmSyncRetry(homeDir);
});

function openStores(): { store: SessionStore; ownerStore: OwnerStore } {
	const db = openSessionDatabase(join(dir, "state.db"));
	dbs.push(db);
	installSessionStoreSchema(db);
	return { store: new SessionStore(db), ownerStore: new OwnerStore(db) };
}

/** 真实 Models(AuthStorage 落库)+ 最小 domain controller。 */
function buildDomain(): SessionDomainPort {
	const layout = buildRunledgerLayout(homeDir, "posix");
	const models = builtinModels({ credentials: AuthStorage.create(layout) });
	const controller = {
		subscribe: () => () => undefined,
		messages: [],
		warnings: [],
		auditEntries: [],
		toolCount: 0,
		currentSelection: { thinkingLevel: "off" },
		getSteeringMessages: () => [],
		getFollowUpMessages: () => [],
		getProviderStatuses: async (): Promise<ProviderStatus[]> =>
			models.getProviders().map((provider) => ({
				id: provider.id,
				name: provider.name,
				configured: provider.id === "deepseek",
				authTypes: provider.auth.apiKey ? ["api_key"] : [],
				interactiveAuthTypes: provider.auth.apiKey?.login ? ["api_key"] : [],
			})),
		getProvider: () => undefined,
		getAvailableModels: async () => [],
		login: (providerId: string, type: AuthType, interaction: AuthInteraction) => models.login(providerId, type, interaction),
		logout: async () => undefined,
		selectModel: async () => undefined,
		setThinkingLevel: async (level: string) => level,
		prompt: async () => undefined,
		interrupt: () => undefined,
		clearAllQueues: () => ({ steering: [], followUp: [] }),
		waitForIdle: async () => undefined,
		dispose: () => undefined,
	} as unknown as InteractiveSessionControllerPort;
	return {
		controller,
		snapshot: () => ({
			messages: [],
			warnings: [],
			auditEntries: [],
			selection: { thinkingLevel: "off" },
			toolCount: 0,
			inFlight: false,
			providerStatuses: [],
		}),
	};
}

/** 自动应答 secret prompt 的 reverseRequestHandler(验证 wire 往返)。 */
const autoAnswer = async (frame: SessionFrameEnvelope): Promise<Record<string, unknown>> => {
	const body = frame.body as Record<string, unknown>;
	if (body.kind === "credential_prompt") return { ok: true, value: "sk-e2e-test" };
	return {};
};

describe("credential reverse-request login end-to-end", () => {
	it("completes api-key login over real TCP and writes auth.json", async () => {
		const { store, ownerStore } = openStores();
		const sessionId = createRuntimeId("session", "e2e");
		store.createSession({ sessionId, workspaceId: createRuntimeId("workspace", "w"), repositoryId: createRuntimeId("repository", "r"), settingsDigest: "d".repeat(64) });

		const server = new SessionRuntimeServer({ sessionId, store, controller: nullController(sessionId) });
		const owner = new SessionOwner({ store, ownerStore, transport: server });
		const result = await owner.open(sessionId);
		if (!result.ok || result.outcome !== "claimed") throw new Error(`expected claim, got ${JSON.stringify(result)}`);
		const restored = restoreSession(store, sessionId);
		if (!restored.ok) throw new Error("restore failed");
		const runtime = new SessionRuntime({
			sessionId,
			store,
			ownerStore,
			owner,
			server,
			fence: result.fence,
			crashTakeover: false,
			restored,
			domain: buildDomain(),
		});
		server.bindController(runtime);
		runtime.start();

		const client = new SessionClient({ store, ownerStore, claimTransport: server, reverseRequestHandler: autoAnswer });
		const opened = await client.attachTo(ownerStore.readOwner(sessionId)!, server.endpoint, owner.currentAuthToken);
		if (!opened.ok) throw new Error(`local attach failed: ${opened.code}`);
		const snapshot: SessionInteractiveSnapshot = {
			sessionId,
			messages: [],
			warnings: [],
			auditEntries: [],
			selection: { thinkingLevel: "off" },
			toolCount: 0,
			eventCursor: 0,
			driverRevision: 0,
		};
		const controller = new SessionInteractiveController(opened.handle, snapshot);
		await controller.resumeEvents();

		// 首个 client 成为 driver(mutating login 命令需要 driver authority)。
		const claim = await opened.handle.transport.request({
			frameId: `driver_claim_${Date.now().toString(36)}`,
			kind: "command_request" as const,
			protocolVersion: 1,
			body: { commandId: `command_${Date.now().toString(36)}`, kind: "driver_claim", body: {} },
		});
		expect(claim.body.ok).toBe(true);

		await expect(controller.login("deepseek", "api_key", undefined as never)).resolves.toBeDefined();

		// credential 已写入 canonical auth.json。
		const authPath = join(homeDir, "auth.json");
		const stored = JSON.parse(readFileSync(authPath, "utf8")) as Record<string, unknown>;
		expect(stored.deepseek).toEqual({ type: "api_key", key: "sk-e2e-test" });
	});
});

function nullController(sessionId: SessionId) {
	return {
		sessionId,
		snapshot: () => ({ sessionId, headSequence: 0, sessionStatus: "active", runtimeState: "starting" }),
		handleCommand: async () => ({ ok: false as const, code: "not_bound" }),
		handleQuery: async () => ({ ok: false, kind: "not_bound" }),
		onEvent: () => () => undefined,
		isMutatingKind: () => false,
	};
}
