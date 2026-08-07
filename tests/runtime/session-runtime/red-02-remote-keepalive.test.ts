/**
 * RED-02(P0-3):local UI detach 不再无条件终止 owner。
 *
 * 回归对象:CLI finally 关闭本地 handle 后无条件 runtime.pause(),remote
 * attachment 存在时 owner 也被杀掉;attachment count 必须决定 runtime
 * lifetime。本测试:owner 本地 view detach + remote 保持连接 → owner 进程
 * 存活、row 仍 running、generation/stream 不重启;remote 离开后才
 * pause/checkpoint/release(unowned,generation 不回退)。
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	dir = mkdtempSync(join(tmpdir(), "red-02-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
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

function spawnHolder(sessionId: string): { child: ChildProcess; stdout: () => string } {
	const child = spawn(process.execPath, ["--import", "tsx", WORKER, "embedded", join(dir, "state.db"), sessionId, dir, "{}"], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	return { child, stdout: () => stdout };
}

function spawnAttach(sessionId: string, holdMs: number): { child: ChildProcess; stdout: () => string } {
	const child = spawn(process.execPath, ["--import", "tsx", WORKER, "attach", join(dir, "state.db"), sessionId, dir, JSON.stringify({ holdMs })], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	return { child, stdout: () => stdout };
}

async function waitFor(fn: () => boolean, timeoutMs = 20_000, label = "condition"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!fn()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

function readOwnerRow(): { record: ReturnType<OwnerStore["readOwner"]>; close: () => void } {
	const db = openSessionDatabase(join(dir, "state.db"));
	return { record: new OwnerStore(db).readOwner(sessionIdForRead), close: () => db.close() };
}

let sessionIdForRead = "";

describe("RED-02 remote attachment keeps the owner alive after local UI detach", () => {
	it("owner survives local detach while remote is attached, then pauses when the remote leaves", async () => {
		const sessionId = setupSession("red02");
		sessionIdForRead = sessionId;
		const holder = spawnHolder(sessionId);
		await waitFor(() => existsSync(join(dir, "result.json")), 20_000, "owner claim");
		const ownerResult = JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) as Record<string, unknown>;
		const generation = Number(ownerResult.generation);
		expect(generation).toBe(1);

		// remote 客户端 attach 并保持 3s。
		const remote = spawnAttach(sessionId, 3_000);
		await waitFor(() => remote.stdout().includes('"attached"'), 20_000, "remote attach");
		// 本地 UI detach(模拟 CLI finally 关闭本地 handle)。
		writeFileSync(join(dir, "release"), "release");
		await new Promise((resolve) => setTimeout(resolve, 1_000));

		// remote 仍连接:owner 必须存活、row running、generation 不重启。
		expect(holder.child.exitCode).toBeNull();
		const afterDetach = readOwnerRow();
		expect(afterDetach.record?.state).toBe("running");
		expect(afterDetach.record?.generation).toBe(generation);
		afterDetach.close();
		// owner 不应已 pause(无 paused_after_last_attachment 输出)。
		expect(holder.stdout().includes("paused_after_last_attachment")).toBe(false);

		// remote 离开(holdMs 到点)→ attachment 归零 → owner pause/release。
		await waitFor(() => holder.stdout().includes('"paused_after_last_attachment"'), 20_000, "owner release after remote detach");
		const afterPause = readOwnerRow();
		expect(afterPause.record?.state).toBe("unowned");
		expect(afterPause.record?.generation).toBe(generation);
		afterPause.close();
	}, 60_000);
});
