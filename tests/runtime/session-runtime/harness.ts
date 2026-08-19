/**
 * R5 测试 harness:真实 claim + SessionRuntime + TCP server 组合。
 * 覆盖 checkpoint/restore/recovery barrier 的 integration 入口。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { SessionOwner } from "../../../src/runtime/session-owner/session-owner.ts";
import { SessionRuntimeServer } from "../../../src/runtime/session-server/runtime-server.ts";
import { SessionRuntime, type SessionDomainPort } from "../../../src/runtime/session-runtime/session-runtime.ts";
import { restoreSession } from "../../../src/runtime/session-runtime/restore.ts";
import type { OwnerFence } from "../../../src/runtime/session-owner/types.ts";
import { createRuntimeId, type SessionId } from "../../../src/runtime/protocol/ids.ts";
import { SESSION_CORE_PROTOCOL_MANIFEST } from "../../../src/runtime/session-server/protocol.ts";
import type { LateBoundHumanInputWaitPort } from "../../../src/runtime/session-runtime/approval-reverse-request.ts";
import type { LateBoundAgentRunBudgetUsage } from "../../../src/runtime/session-runtime/run-timing.ts";
import type { EffectiveRecapSettings } from "../../../src/storage/settings-manager.ts";

export interface RuntimeHarness {
	readonly dir: string;
	readonly store: SessionStore;
	readonly ownerStore: OwnerStore;
	readonly owner: SessionOwner;
	readonly server: SessionRuntimeServer;
	readonly runtime: SessionRuntime;
	readonly sessionId: SessionId;
	readonly fence: OwnerFence;
	cleanup(): void;
}

/** 完整 runtime harness:create → claim → restore → runtime.start()。 */
export async function createRuntimeHarness(seed = "h", options: {
	readonly crashTakeover?: boolean;
	readonly domain?: SessionDomainPort;
	readonly humanInputWaitPortRef?: LateBoundHumanInputWaitPort;
	readonly runBudgetUsageRef?: LateBoundAgentRunBudgetUsage;
	readonly lifecycleCleanup?: (reason: "paused" | "detached" | "error" | "fenced") => Promise<void>;
	readonly recapSettings?: EffectiveRecapSettings;
} = {}): Promise<RuntimeHarness> {
	const dir = mkdtempSync(join(tmpdir(), "session-runtime-harness-"));
	const db = openSessionDatabase(join(dir, "state.db"));
	installSessionStoreSchema(db);
	const store = new SessionStore(db);
	const ownerStore = new OwnerStore(db);
	const sessionId = createRuntimeId("session", seed);
	store.createSession({
		sessionId,
		workspaceId: createRuntimeId("workspace", "w"),
		repositoryId: createRuntimeId("repository", "r"),
		settingsDigest: "d".repeat(64),
	});
	let runtime: SessionRuntime | undefined;
	const server = new SessionRuntimeServer({
		sessionId,
		store,
		controller: nullController(sessionId),
		onDriverStateChange: () => runtime?.handleDriverStateChange(),
	});
	const owner = new SessionOwner({ store, ownerStore, transport: server });
	const claimed = await owner.open(sessionId);
	if (!claimed.ok || claimed.outcome !== "claimed") throw new Error("harness claim failed");
	const restored = restoreSession(store, sessionId);
	if (!restored.ok) throw new Error("harness restore failed");
	const createdRuntime = new SessionRuntime({
		sessionId,
		store,
		ownerStore,
		owner,
		server,
		fence: claimed.fence,
		crashTakeover: options.crashTakeover === true,
		restored,
		...(options.domain === undefined ? {} : { domain: options.domain }),
		...(options.humanInputWaitPortRef === undefined ? {} : { humanInputWaitPortRef: options.humanInputWaitPortRef }),
		...(options.runBudgetUsageRef === undefined ? {} : { runBudgetUsageRef: options.runBudgetUsageRef }),
		...(options.lifecycleCleanup === undefined ? {} : { lifecycleCleanup: options.lifecycleCleanup }),
		...(options.recapSettings === undefined ? {} : { recapSettings: options.recapSettings }),
	});
	runtime = createdRuntime;
	server.bindController(createdRuntime);
	createdRuntime.start();
	return {
		dir,
		store,
		ownerStore,
		owner,
		server,
		runtime: createdRuntime,
		sessionId,
		fence: claimed.fence,
		cleanup: () => {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function nullController(sessionId: SessionId) {
	return {
		sessionId,
		protocolManifest: () => SESSION_CORE_PROTOCOL_MANIFEST,
		snapshot: () => ({ sessionId, headSequence: 0, sessionStatus: "active", runtimeState: "starting" }),
		handleCommand: async () => ({ ok: false as const, code: "not_bound" }),
		handleQuery: async () => ({ ok: false, kind: "not_bound" }),
		onEvent: () => () => undefined,
		isMutatingKind: () => false,
	};
}
