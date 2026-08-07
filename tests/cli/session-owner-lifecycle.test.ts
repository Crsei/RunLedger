/**
 * P0 回归:标准 CLI 的 attachment/driver 生命周期。
 *
 * 这里直接复用 main 导出的 lifecycle helper，避免只证明低层 server callback。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { rmSyncRetry, rmRetry } from "../helpers/cleanup.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmbeddedSessionRuntime, type EmbeddedSessionRuntimeResult } from "../../src/cli/embedded-session-runtime.ts";
import { SessionClient } from "../../src/cli/session-client.ts";
import { SessionInteractiveController } from "../../src/cli/session-interactive-controller.ts";
import { claimDriver, fetchDomainSnapshot, pauseIfLastAttachment } from "../../src/cli/main.ts";
import { createRuntimeId, type SessionId } from "../../src/runtime/protocol/ids.ts";
import { openSessionDatabase } from "../../src/storage/session-store/database.ts";
import { OwnerStore } from "../../src/storage/session-store/owner-store.ts";
import { installSessionStoreSchema } from "../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../src/storage/session-store/session-store.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-owner-lifecycle-"));
});

afterEach(() => {
	rmSyncRetry(dir);
});

async function openEmbedded(): Promise<{ readonly embedded: EmbeddedSessionRuntimeResult; readonly store: SessionStore; readonly ownerStore: OwnerStore }> {
	const db = openSessionDatabase(join(dir, "state.db"));
	installSessionStoreSchema(db);
	const store = new SessionStore(db);
	const ownerStore = new OwnerStore(db);
	const sessionId = createRuntimeId("session", "lifecycle") as SessionId;
	store.createSession({
		sessionId,
		workspaceId: createRuntimeId("workspace", "w"),
		repositoryId: createRuntimeId("repository", "r"),
		settingsDigest: "d".repeat(64),
	});
	const embedded = await createEmbeddedSessionRuntime({ sessionId, store, ownerStore });
	return { embedded, store, ownerStore };
}

async function attachRemote(embedded: EmbeddedSessionRuntimeResult, store: SessionStore, ownerStore: OwnerStore) {
	const client = new SessionClient({
		store,
		ownerStore,
		claimTransport: embedded.server,
	});
	const opened = await client.openSession(embedded.handle.sessionId);
	if (!opened.ok) throw new Error(`remote attach failed: ${opened.code}`);
	return opened.handle;
}

describe("standard CLI Session Owner lifecycle", () => {
	it("waits headless while a remote attachment remains and stops only after the last detach", async () => {
		const { embedded, store, ownerStore } = await openEmbedded();
		const remote = await attachRemote(embedded, store, ownerStore);
		await embedded.handle.close();
		let stopped = false;
		const waiting = pauseIfLastAttachment(embedded).then(() => {
			stopped = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 2_200));
		expect(stopped).toBe(false);
		expect(embedded.owner.currentFence).toBeDefined();
		expect(embedded.runtime?.runtimeState).toBe("ready");
		await remote.close();
		await waiting;
		expect(embedded.runtime?.runtimeState).toBe("stopping");
		expect(embedded.owner.currentFence).toBeUndefined();
		store.database().close();
	});

	it("keeps a second standard client attached as observer when the driver is already held", async () => {
		const { embedded, store, ownerStore } = await openEmbedded();
		const firstSnapshot = await fetchDomainSnapshot(embedded);
		const firstController = new SessionInteractiveController(embedded.handle, firstSnapshot);
		expect(await claimDriver(embedded, firstController)).toBe("driver");

		const remote = await attachRemote(embedded, store, ownerStore);
		const remoteEmbedded = { ...embedded, handle: remote };
		const secondSnapshot = await fetchDomainSnapshot(remoteEmbedded);
		const secondController = new SessionInteractiveController(remote, secondSnapshot);
		await expect(claimDriver(remoteEmbedded, secondController)).resolves.toBe("observer");
		expect(embedded.server.connectionCounts()).toBe(2);

		firstController.dispose();
		secondController.dispose();
		await remote.close();
		await embedded.handle.close();
		await pauseIfLastAttachment(embedded);
		store.database().close();
	});

	it("exposes recovery status and assessment through the standard interactive controller", async () => {
		const { embedded, store } = await openEmbedded();
		const snapshot = await fetchDomainSnapshot(embedded);
		const controller = new SessionInteractiveController(embedded.handle, snapshot);
		await claimDriver(embedded, controller);
		const recovery = controller as unknown as {
			recoveryStatus?: () => Promise<{ readonly state: string; readonly unresolvedAttempts: number }>;
			recoveryAssess?: () => Promise<{ readonly state: string; readonly unresolvedRemaining: number }>;
		};
		expect(typeof recovery.recoveryStatus).toBe("function");
		expect(typeof recovery.recoveryAssess).toBe("function");
		await expect(recovery.recoveryStatus!()).resolves.toMatchObject({ state: "ready", unresolvedAttempts: 0 });
		await expect(recovery.recoveryAssess!()).resolves.toMatchObject({ state: "ready", unresolvedRemaining: 0 });
		controller.dispose();
		await embedded.handle.close();
		await pauseIfLastAttachment(embedded);
		store.database().close();
	});
});
