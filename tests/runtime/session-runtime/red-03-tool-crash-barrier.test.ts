/**
 * RED-03(P0-2):真实工具副作用进入 recovery barrier。
 *
 * 回归对象:真实 Write/Bash/WebFetch 曾直接走本地 fs/shell/fetch,不调用
 * beginAttempt/settleAttempt;工具执行中崩溃时 DB 无 unresolved receipt,
 * 新 owner 的 assess() 误判 clean 并关闭 barrier。本测试:
 * 1. owner 经生产 attempt gateway 对阻塞 FIFO 执行真实 Write(workspace_mutation),
 *    started receipt 落库后进程被 SIGKILL(工具执行中崩溃,不 settle);
 * 2. takeover 后 barrier 必须保持 open(unresolved ≥ 1),assess() 不得收口;
 * 3. barrier 内新的 gated 副作用(Write)被拒绝(spawnCount=0)。
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { rmSyncRetry, rmRetry } from "../../helpers/cleanup.ts";
import { IS_WINDOWS } from "../../helpers/platform.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionDatabase } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";
import { SessionStore } from "../../../src/storage/session-store/session-store.ts";
import { OwnerStore } from "../../../src/storage/session-store/owner-store.ts";
import { createRuntimeId, type SessionId } from "../../../src/runtime/protocol/ids.ts";

const WORKER = fileURLToPath(new URL("../../fixtures/session-owner/runtime-worker.ts", import.meta.url));

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "red-03-"));
});

afterEach(() => {
	rmSyncRetry(dir);
});

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

function openStores(): { store: SessionStore; ownerStore: OwnerStore; db: import("../../src/storage/session-store/database.ts").SessionDatabase } {
	const db = openSessionDatabase(join(dir, "state.db"));
	return { store: new SessionStore(db), ownerStore: new OwnerStore(db), db };
}

async function waitFor(fn: () => boolean, timeoutMs = 20_000, label = "condition"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!fn()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

async function spawnWorkerAsync(command: string, sessionId: string, workDir: string, jsonArgs: Record<string, unknown> = {}): Promise<{ child: import("node:child_process").ChildProcess; stdout: () => string }> {
	const child = spawn(process.execPath, ["--import", "tsx", WORKER, command, join(dir, "state.db"), sessionId, workDir, JSON.stringify(jsonArgs)], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	await new Promise((resolve) => setTimeout(resolve, 100));
	return { child, stdout: () => stdout };
}

describe("RED-03 tool side effects enter the recovery barrier", () => {
	it("a crash inside a real gated Write leaves an unresolved receipt; takeover barrier stays open and blocks new side effects", { skip: IS_WINDOWS, timeout: 60_000 }, async () => {
		const sessionId = setupSession("red03");
		const workDir = join(dir, "crash");
		const holder = await spawnWorkerAsync("crash-after-attempt", sessionId, workDir);
		await waitFor(() => existsSync(join(workDir, "result.json")), 20_000, "started receipt");
		const started = JSON.parse(readFileSync(join(workDir, "result.json"), "utf8")) as Record<string, unknown>;
		expect(started, JSON.stringify(started)).toBeTruthy();
		expect(started.ok, JSON.stringify(started)).toBe(true);
		expect(started.attemptStarted).toBe(true);

		// started receipt 必须已落库(effectClass=workspace_mutation,无 settled)。
		const { store } = openStores();
		await waitFor(
			() => store.listAllAttemptReceipts(sessionId).some((receipt) => receipt.effectClass === "workspace_mutation" && receipt.outcome === "started"),
			20_000,
			"durable started receipt",
		);
		const receipts = store.listAllAttemptReceipts(sessionId);
		const gateStarted = receipts.filter((receipt) => receipt.effectClass === "workspace_mutation" && receipt.outcome === "started");
		expect(gateStarted.length).toBeGreaterThanOrEqual(1);
		expect(receipts.some((receipt) => receipt.effectClass === "workspace_mutation" && receipt.outcome !== "started" && receipt.attemptId === gateStarted[0]?.attemptId)).toBe(false);

		// 工具执行中崩溃:SIGKILL,不 settle。
		holder.child.kill("SIGKILL");
		await new Promise((resolve) => setTimeout(resolve, 500));
		// backdate heartbeat → takeover。
		{
			const { ownerStore } = openStores();
			ownerStore.database().runSync("UPDATE session_owners SET heartbeat_at_ms = ? WHERE session_id = ?", [Date.now() - 60_000, sessionId]);
			ownerStore.database().close();
		}
		// takeover 进程进入 RECOVERY_REQUIRED,probeBarrier 验证 barrier 保持 open。
		const takeoverOut = execFileSync(process.execPath, ["--import", "tsx", WORKER, "takeover-deadline", join(dir, "state.db"), sessionId, workDir, JSON.stringify({ deadlineMs: 25_000, probeBarrier: true })], {
			encoding: "utf8",
			timeout: 60_000,
		});
		const last = JSON.parse(takeoverOut.trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
		expect(last.ok).toBe(true);
		expect(last.runtimeState).toBe("recovery_required");
		expect(last.barrierState).toBe("open");
		expect(Number(last.unresolvedRemaining)).toBeGreaterThanOrEqual(1);
		// final leaf:barrier 内新副作用被拒,spawnCount 必须为 0。
		expect(last.gatedRejected).toBe(true);
		expect(Number(last.spawnCount)).toBe(0);
		// assess() 不得误判 clean(unresolved receipt 存在)。
		expect(Number(last.unresolvedRemaining)).toBeGreaterThanOrEqual(1);
		store.database().close();
	});
});
