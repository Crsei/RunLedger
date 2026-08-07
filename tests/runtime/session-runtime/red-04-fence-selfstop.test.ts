/**
 * RED-04(P0-4):旧 generation 的生产 Runtime 完整 self-stop。
 *
 * 回归对象:SessionOwner 支持 onFenced 回调,但生产 composition 未传入;
 * heartbeat 被 fence 后只停 owner timer,不关闭 RuntimeServer 也不中断领域
 * Runtime。本测试:
 * 1. 进程内:runtime + spy domain + 真实 TCP client;selfStopFenced 后
 *    domain.controller.interrupt 被调用、owner fence 清空、server 关闭、
 *    client 连接断开;
 * 2. 真实多进程:owner row 被外部覆盖(等价另一 generation 已接管)后,
 *    heartbeat 检测 changes=0 → 生产 onFenced wiring 触发完整 self-stop
 *    (owner 报告 fenced、fenceCleared、attachments=0)。
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { SessionOwner } from "../../../src/runtime/session-owner/session-owner.ts";
import { SessionRuntimeServer } from "../../../src/runtime/session-server/runtime-server.ts";
import { SessionRuntime } from "../../../src/runtime/session-runtime/session-runtime.ts";
import { restoreSession } from "../../../src/runtime/session-runtime/restore.ts";
import { LateBoundAttemptPort } from "../../../src/runtime/session-runtime/attempt-gateway.ts";
import { SessionClient } from "../../../src/cli/session-client.ts";
import type { SessionDomainPort } from "../../../src/runtime/session-runtime/session-runtime.ts";
import { createRuntimeId, type SessionId } from "../../../src/runtime/protocol/ids.ts";

const WORKER = fileURLToPath(new URL("../../fixtures/session-owner/runtime-worker.ts", import.meta.url));

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "red-04-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function openStores(): { store: SessionStore; ownerStore: OwnerStore; db: import("../../src/storage/session-store/database.ts").SessionDatabase } {
	const db = openSessionDatabase(join(dir, "state.db"));
	return { store: new SessionStore(db), ownerStore: new OwnerStore(db), db };
}

function setupSession(seed: string): SessionId {
	const db = openSessionDatabase(join(dir, "state.db"));
	installSessionStoreSchema(db);
	const store = new SessionStore(db);
	const sessionId = createRuntimeId("session", seed);
	store.createSession({
		sessionId,
		workspaceId: createRuntimeId("workspace", "w"),
		repositoryId: createRuntimeId("repository", "r"),
		settingsDigest: "d".repeat(64),
	});
	db.close();
	return sessionId;
}

async function waitFor(fn: () => boolean, timeoutMs = 20_000, label = "condition"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!fn()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describe("RED-04 a fenced production runtime fully self-stops", () => {
	it("selfStopFenced closes the server, interrupts the domain, clears the fence, and disconnects clients", async () => {
		const sessionId = setupSession("red04a");
		const { store, ownerStore } = openStores();
		const server = new SessionRuntimeServer({
			sessionId,
			store,
			controller: nullController(sessionId),
		});
		const claimOwner = new SessionOwner({
			store,
			ownerStore,
			transport: server,
			onFenced: () => {
				runtime.selfStopFenced();
			},
		});
		const result = await claimOwner.open(sessionId);
		expect(result.ok && result.outcome === "claimed").toBe(true);
		if (!result.ok || result.outcome !== "claimed") throw new Error("expected claim");
		const restored = restoreSession(store, sessionId);
		if (!restored.ok) throw new Error("restore failed");
		const interruptSpy = vi.fn();
		const spyDomain: SessionDomainPort = {
			controller: {
				subscribe: () => () => undefined,
				interrupt: interruptSpy,
			} as unknown as SessionDomainPort["controller"],
			snapshot: () => ({ messages: [], warnings: [], auditEntries: [], selection: { thinkingLevel: "off" }, toolCount: 0, inFlight: false, providerStatuses: [] }),
		};
		const runtime = new SessionRuntime({
			sessionId,
			store,
			ownerStore,
			owner: claimOwner,
			server,
			fence: result.fence,
			crashTakeover: false,
			restored,
			domain: spyDomain,
			attemptPortRef: new LateBoundAttemptPort(),
		});
		server.bindController(runtime);
		runtime.start();

		// 真实 TCP client attach(统一 open path,健康 owner 即时 attach)。
		const client = new SessionClient({ store, ownerStore, claimTransport: server });
		const opened = await client.openSession(sessionId);
		expect(opened.ok).toBe(true);
		if (!opened.ok) throw new Error("attach failed");
		await waitFor(() => server.connectionCounts() === 1, 5_000, "client attached");

		// 触发 fence(等价 heartbeat 检测到 row 已变更)。
		runtime.selfStopFenced();
		expect(interruptSpy).toHaveBeenCalled();
		expect(claimOwner.currentFence).toBeUndefined();
		expect(runtime.runtimeState).toBe("fenced");
		// server 关闭:所有 connection 断开。
		await waitFor(() => server.connectionCounts() === 0, 5_000, "server closed");
		// client 连接被断开:后续 request 失败。
		await expect(
			opened.handle.transport.request({
				frameId: `post_fence_${Date.now().toString(36)}`,
				kind: "query_request",
				protocolVersion: 1,
				body: { kind: "snapshot", body: {} },
			}),
		).rejects.toThrow();
		ownerStore.database().close();
	});

	it("heartbeat-detected fence triggers the production onFenced wiring (real multi-process)", async () => {
		const sessionId = setupSession("red04b");
		const workDir = join(dir, "fence");
		const holder = spawn(process.execPath, ["--import", "tsx", WORKER, "embedded", join(dir, "state.db"), sessionId, workDir, JSON.stringify({ reportFence: true, fenceDeadlineMs: 15_000 })], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		let holderOut = "";
		holder.stdout?.on("data", (chunk: Buffer) => {
			holderOut += chunk.toString("utf8");
		});
		await waitFor(() => existsSync(join(workDir, "result.json")), 20_000, "owner claim");
		const claim = JSON.parse(readFileSync(join(workDir, "result.json"), "utf8")) as Record<string, unknown>;
		expect(claim.ok).toBe(true);

		// remote client 保持连接。
		const remote = spawn(process.execPath, ["--import", "tsx", WORKER, "attach", join(dir, "state.db"), sessionId, join(dir, "remote"), JSON.stringify({ holdMs: 20_000 })], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		await waitFor(() => existsSync(join(dir, "remote", "result.json")), 20_000, "remote attach");
		const remoteResult = JSON.parse(readFileSync(join(dir, "remote", "result.json"), "utf8")) as Record<string, unknown>;
		expect(remoteResult.outcome).toBe("attached");

		// 外部覆盖 owner row(等价另一 generation 已完成 takeover CAS)。
		const { ownerStore } = openStores();
		ownerStore.database().runSync(
			"UPDATE session_owners SET runtime_id = ?, generation = generation + 1 WHERE session_id = ?",
			[`runtime_fenced_by_test_${Date.now().toString(36)}`, sessionId],
		);
		ownerStore.database().close();

		// heartbeat(3s)检测 changes=0 → 生产 onFenced → 完整 self-stop。
		await waitFor(() => existsSync(join(workDir, "result.json")) && holderOut.includes('"fenced"'), 20_000, "fence report");
		const report = JSON.parse(readFileSync(join(workDir, "result.json"), "utf8")) as Record<string, unknown>;
		expect(report.outcome).toBe("fenced");
		expect(report.fenceCleared).toBe(true);
		expect(Number(report.attachments)).toBe(0);
		// remote client 连接被断开:进程内 transport 后续请求失败(worker 会因
		// hold 后 close 正常退出,此处只验证 owner 侧已断开)。
		remote.kill("SIGTERM");
	}, 60_000);
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
