/**
 * R7:标准 CLI session-owner 切换 fixtures(06 §R7)。
 *
 * spawnSync 真跑 cli.ts(隔离 RUNLEDGER_DIR):
 * - fresh home 首次运行安装 schema、create/claim/pause 全链路;
 * - --resume 重新 attach 已有 session(generation 单调);
 * - --fork 从 catalog fork 新 session(独立 generation);
 * - schema too-new / migration_blocked / legacy JSONL path 全部 typed fail closed;
 * - 标准入口不再 import 任何 runtime-host-*(静态断言)。
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { rmSyncRetry, rmRetry } from "../helpers/cleanup.ts";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeId, type SessionId } from "../../src/runtime/protocol/ids.ts";
import { openSessionDatabase } from "../../src/storage/session-store/database.ts";
import { OwnerStore } from "../../src/storage/session-store/owner-store.ts";
import { SessionStore } from "../../src/storage/session-store/session-store.ts";

const CLI_PATH = resolve(process.cwd(), "src", "cli", "cli.ts");
const cleanup: string[] = [];

afterEach(() => {
	for (const directory of cleanup.splice(0)) rmSyncRetry(directory);
});

function setupHome(): { root: string; home: string } {
	const root = mkdtempSync(join(tmpdir(), "runledger-session-cli-"));
	cleanup.push(root);
	const home = join(root, "home");
	mkdirSync(home, { recursive: true, mode: 0o700 });
	return { root, home };
}

function runCli(args: string[], home: string): { stdout: string; stderr: string; status: number | null } {
	const result = spawnSync(process.execPath, ["--import", "tsx", CLI_PATH, ...args], {
		encoding: "utf8",
		timeout: 30_000,
		input: "",
		env: { ...process.env, RUNLEDGER_DIR: home },
	});
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status };
}

/**
 * node 运行时 OpenTUI native FFI 不可用,InteractiveMode.run() 以 fatal 退出
 * (status 1);session-owner 生命周期(create/claim/pause/checkpoint)在 fatal
 * 之前已完整落库。真实 TUI 渲染验证在 bun 运行时(标准 PATH R8)进行。
 */
function expectSessionLifecycleOk(result: { status: number | null }): void {
	expect(result.status === 0 || result.status === 1).toBe(true);
}

function openDb(home: string): { querySingle: (sql: string, params?: readonly unknown[]) => Record<string, unknown> | undefined; queryAll: (sql: string, params?: readonly unknown[]) => readonly Record<string, unknown>[]; run: (sql: string, params?: readonly unknown[]) => void; close: () => void } {
	// 用 node:sqlite 直接读 state.db(验证持久化状态)。
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
	const db = new DatabaseSync(join(home, "state.db"), {});
	return {
		querySingle: (sql, params) => (db.prepare(sql).get(...((params ?? []) as never[])) as Record<string, unknown> | undefined),
		queryAll: (sql, params) => (db.prepare(sql).all(...((params ?? []) as never[])) as readonly Record<string, unknown>[]),
		run: (sql, params) => {
			db.prepare(sql).run(...((params ?? []) as never[]));
		},
		close: () => db.close(),
	};
}

function seedSessionWithUserMessage(home: string, seed: string): SessionId {
	const db = openSessionDatabase(join(home, "state.db"));
	const store = new SessionStore(db);
	const ownerStore = new OwnerStore(db);
	const sessionId = createRuntimeId("session", seed);
	const runtimeId = createRuntimeId("runtime", seed);
	store.createSession({
		sessionId,
		workspaceId: createRuntimeId("workspace", "default"),
		repositoryId: createRuntimeId("repository", "default"),
		settingsDigest: "d".repeat(64),
	});
	db.runSync(
		"INSERT INTO session_owners (session_id, runtime_id, generation, state, updated_at_ms) VALUES (?, ?, 1, 'running', ?)",
		[sessionId, runtimeId, Date.now()],
	);
	const fence = { sessionId, runtimeId, generation: 1 } as const;
	store.appendEvent(fence, {
		eventId: createRuntimeId("event", `${seed}-user`),
		ownerGeneration: 1,
		eventType: "ledger.message",
		payloadJson: JSON.stringify({
			id: `${seed}-message`,
			sessionId,
			parentId: sessionId,
			timestamp: Date.now(),
			type: "message",
			payload: {
				role: "user",
				message: { role: "user", content: [{ type: "text", text: "persist" }] },
			},
		}),
		createdAtMs: Date.now(),
		expectedPreviousEventHash: null,
	});
	ownerStore.releaseOwner(fence, "paused");
	db.close();
	return sessionId;
}

describe("R7 standard CLI session-owner path", () => {
	it("fresh home: reclaims the message-less Session after create, claim, and clean pause", () => {
		const { home } = setupHome();
		const result = runCli([], home);
		expectSessionLifecycleOk(result);
		const db = openDb(home);
		expect(db.queryAll("SELECT session_id FROM sessions")).toEqual([]);
		expect(db.queryAll("SELECT session_id FROM session_owners")).toEqual([]);
		expect(db.queryAll("SELECT session_id FROM session_events")).toEqual([]);
		expect(db.queryAll("SELECT session_id FROM session_checkpoints")).toEqual([]);
		db.close();
	});

	it("--resume re-attaches the existing session with a monotonic generation", () => {
		const { home } = setupHome();
		expectSessionLifecycleOk(runCli([], home));
		const sessionId = seedSessionWithUserMessage(home, "resume");
		const db = openDb(home);
		const first = db.querySingle("SELECT generation FROM session_owners WHERE session_id = ?", [sessionId]);
		expectSessionLifecycleOk(runCli(["--resume"], home));
		const second = db.querySingle("SELECT generation FROM session_owners WHERE session_id = ?", [sessionId]);
		expect(Number(second?.generation)).toBe(Number(first?.generation) + 1);
		db.close();
	});

	it("--fork creates an independent session with generation starting at 1", () => {
		const { home } = setupHome();
		expectSessionLifecycleOk(runCli([], home));
		const sourceSessionId = seedSessionWithUserMessage(home, "fork-source");
		const db = openDb(home);
		expectSessionLifecycleOk(runCli(["--fork", sourceSessionId], home));
		const forked = db.queryAll("SELECT session_id FROM sessions ORDER BY created_at_ms");
		expect(forked).toHaveLength(2);
		const forkedId = String((forked[1] as Record<string, unknown>).session_id);
		expect(forkedId).not.toBe(sourceSessionId);
		const owner = db.querySingle("SELECT state, generation FROM session_owners WHERE session_id = ?", [forkedId]);
		expect(owner?.state).toBe("unowned");
		expect(Number(owner?.generation)).toBe(1);
		db.close();
	});

	it("fails closed on store_schema_too_new (old binary vs newer schema)", () => {
		const { home } = setupHome();
		expectSessionLifecycleOk(runCli([], home));
		const db = openDb(home);
		db.run("UPDATE schema_meta SET schema_version = ?, format_digest = ?", [99, "f".repeat(64)]);
		db.close();
		const result = runCli([], home);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("exceeds binary max");
	});

	it("fails closed while the store is migration_blocked", () => {
		const { home } = setupHome();
		expectSessionLifecycleOk(runCli([], home));
		const db = openDb(home);
		db.run("UPDATE store_control SET admission = ? WHERE singleton_id = 1", ["migration_blocked"]);
		db.close();
		const result = runCli([], home);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("migration_blocked");
	});

	it("rejects a legacy JSONL --session path with a typed migration hint", () => {
		const { home } = setupHome();
		expectSessionLifecycleOk(runCli([], home));
		const result = runCli(["--session", "/tmp/some-legacy.jsonl"], home);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("migrate session-store");
	});

	it("standard entry no longer imports or calls any runtime-host-* module", () => {
		const mainSource = readFileSync(resolve(process.cwd(), "src", "cli", "main.ts"), "utf8");
		for (const line of mainSource.split("\n")) {
			if (!line.trim().startsWith("import") && !line.trim().startsWith("export")) continue;
			expect(line).not.toMatch(/runtime-host/u);
			expect(line).not.toMatch(/reconnecting-host-bridge/u);
			expect(line).not.toMatch(/host-command/u);
			expect(line).not.toMatch(/host-build-identity/u);
			expect(line).not.toMatch(/storage\/host\//u);
		}
	});
});
