/**
 * R4 测试 harness:内存 DB + 真实 claim + 真实 TCP RuntimeServer + 测试 controller。
 * 与生产共用 SessionStore/OwnerStore/SessionOwner/SessionRuntimeServer 代码路径。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { SessionOwner } from "../../../src/runtime/session-owner/session-owner.ts";
import { SessionRuntimeServer, SESSION_MUTATING_COMMAND_KINDS, type SessionController } from "../../../src/runtime/session-server/runtime-server.ts";
import { createRuntimeId, type SessionId } from "../../../src/runtime/protocol/ids.ts";

export { SessionRuntimeServer, SessionOwner };

export interface ServerHarness {
	readonly dir: string;
	readonly store: SessionStore;
	readonly ownerStore: OwnerStore;
	readonly owner: SessionOwner;
	readonly server: SessionRuntimeServer;
	readonly sessionId: SessionId;
	readonly token: string;
	readonly fence: { readonly sessionId: SessionId; readonly runtimeId: string; readonly generation: number };
	cleanup(): void;
}

export interface TestControllerOptions {
	readonly sessionId: SessionId;
	readonly store: SessionStore;
	/** prompt 时取当前 owner fence(claim 后才可用)。 */
	readonly getFence: () => { readonly sessionId: SessionId; readonly runtimeId: string; readonly generation: number };
	/** prompt 时追加的 durable 事件(assistant delta)。 */
	readonly onPrompt?: () => void;
}

/** 测试 controller:prompt 走 owner-fenced appendEvent + 广播;其余 command 拒绝。 */
export function createTestController(options: TestControllerOptions): SessionController {
	const listeners = new Set<(event: { eventType: string; payload: Record<string, unknown>; sequence?: number }) => void>();
	let eventSequence = 0;
	let promptCount = 0;
	return {
		sessionId: options.sessionId,
		snapshot: () => ({
			sessionId: options.sessionId,
			headSequence: eventSequence,
			sessionStatus: "active",
			runtimeState: "running",
		}),
		isMutatingKind: (kind) => (SESSION_MUTATING_COMMAND_KINDS as readonly string[]).includes(kind),
		async handleCommand(request, meta) {
			if (request.kind !== "prompt") return { ok: false, code: "unknown_command" };
			if (!meta.isDriver) return { ok: false, code: "observer_mutation_forbidden" };
			promptCount += 1;
			eventSequence += 1;
			const tail = options.store.replaySessionEvents(options.sessionId).at(-1);
			options.store.appendEvent(options.getFence(), {
				eventId: createRuntimeId("event", `prompt-${promptCount}`),
				ownerGeneration: options.getFence().generation,
				eventType: "assistant.delta",
				payloadJson: JSON.stringify({ text: `response-${promptCount}` }),
				createdAtMs: Date.now(),
				expectedPreviousEventHash: tail?.currentEventHash ?? null,
			});
			for (const listener of listeners) {
				listener({ eventType: "assistant.delta", payload: { text: `response-${promptCount}` }, sequence: eventSequence });
			}
			options.onPrompt?.();
			return { ok: true, kind: "prompt", result: { accepted: true, promptCount } };
		},
		async handleQuery(request) {
			if (request.kind === "snapshot") return { ok: true, kind: "snapshot", headSequence: eventSequence, promptCount };
			return { ok: true, kind: request.kind, result: {} };
		},
		onEvent(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

/** 完整 harness:create session → claim → publish running → activate server。 */
export async function createServerHarness(): Promise<ServerHarness> {
	const dir = mkdtempSync(join(tmpdir(), "session-server-harness-"));
	const db = openSessionDatabase(join(dir, "state.db"));
	installSessionStoreSchema(db);
	const store = new SessionStore(db);
	const ownerStore = new OwnerStore(db);
	const sessionId = createRuntimeId("session", "harness");
	store.createSession({
		sessionId,
		workspaceId: createRuntimeId("workspace", "w"),
		repositoryId: createRuntimeId("repository", "r"),
		settingsDigest: "d".repeat(64),
	});
	let claimedFence: { readonly sessionId: SessionId; readonly runtimeId: string; readonly generation: number } | undefined;
	const controller = createTestController({
		sessionId,
		store,
		getFence: () => {
			if (claimedFence === undefined) throw new Error("harness not claimed");
			return claimedFence;
		},
	});
	const server = new SessionRuntimeServer({ sessionId, store, controller });
	const owner = new SessionOwner({ store, ownerStore, transport: server });
	const claimed = await owner.open(sessionId);
	if (!claimed.ok || claimed.outcome !== "claimed") throw new Error("harness claim failed");
	claimedFence = claimed.fence;
	owner.publish("running");
	server.activate(claimed.fence, owner.currentAuthToken, "running");
	return {
		dir,
		store,
		ownerStore,
		owner,
		server,
		sessionId,
		token: owner.currentAuthToken,
		fence: claimed.fence,
		cleanup: () => {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
