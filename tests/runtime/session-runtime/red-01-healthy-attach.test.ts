/**
 * RED-01(P0-1):标准第二客户端立即 attach 健康 owner。
 *
 * 回归对象:健康 heartbeat 曾导致统一 open 无限 retry,只有 stale 后才
 * probe/attach;本测试用真实多进程证明 openSession 在 heartbeat fresh 时
 * 即时 attach(不等待 stale、不触发 takeover),generation 与 owner 一致。
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
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
	dir = mkdtempSync(join(tmpdir(), "red-01-"));
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

function spawnHolder(sessionId: string): { child: ChildProcess; stdout: () => string; stderr: () => string } {
	const child = spawn(process.execPath, ["--import", "tsx", WORKER, "embedded", join(dir, "state.db"), sessionId, dir, "{}"], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString("utf8");
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
	});
	return { child, stdout: () => stdout, stderr: () => stderr };
}

function runWorkerSync(command: string, sessionId: string, jsonArgs: Record<string, unknown> = {}): Record<string, unknown> {
	const result = execFileSync(process.execPath, ["--import", "tsx", WORKER, command, join(dir, "state.db"), sessionId, dir, JSON.stringify(jsonArgs)], {
		encoding: "utf8",
		timeout: 60_000,
	});
	return JSON.parse(result.trim().split("\n").pop() ?? "{}");
}

async function waitFor(fn: () => boolean, timeoutMs = 20_000, label = "condition"): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!fn()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}

describe("RED-01 healthy owner is attachable immediately", () => {
	it("a second standard client attaches to a fresh-heartbeat owner via the unified open path", async () => {
		const sessionId = setupSession("red01");
		const holder = spawnHolder(sessionId);
		try {
			await waitFor(() => existsSync(join(dir, "result.json")), 20_000, "owner claim");
		} catch (error) {
			throw new Error(`${String(error)} holder-stderr=${holder.stderr().slice(0, 800)} holder-exit=${holder.child.exitCode}`);
		}
		const ownerResult = JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) as Record<string, unknown>;
		expect(ownerResult.ok).toBe(true);
		expect(ownerResult.runtimeState).toBe("ready");

		// heartbeat 仍 fresh 时立即 attach(openSession 统一 path,不走 attachTo)。
		const started = Date.now();
		const attach = runWorkerSync("attach", sessionId, { holdMs: 100 });
		const elapsed = Date.now() - started;
		expect(attach.ok).toBe(true);
		expect(attach.outcome).toBe("attached");
		expect(attach.generation).toBe(ownerResult.generation);
		// 不应进入 stale 等待:attach 在 < 5s 内完成(fresh heartbeat 窗口 20s)。
		expect(elapsed).toBeLessThan(5_000);
		// attach 时 owner row 的 heartbeat 必须仍是 fresh(证明未等待 stale)。
		const db = openSessionDatabase(join(dir, "state.db"));
		const ownerStore = new OwnerStore(db);
		const record = ownerStore.readOwner(sessionId);
		expect(record?.state).toBe("running");
		expect(record?.heartbeatAtMs).toBeDefined();
		expect(Date.now() - (record?.heartbeatAtMs ?? 0)).toBeLessThan(20_000);
		db.close();

		writeFileSync(join(dir, "release"), "release");
		await waitFor(() => holder.stdout().includes('"paused_after_last_attachment"'), 20_000, "owner release");
	}, 60_000);
});
