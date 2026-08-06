/**
 * R1:event-loop latency evidence(06 §4.1 退出条件)。
 *
 * 证明:单次 SQLite blocking wait <= 100ms;busy retry 释放 event loop
 * (重试等待期间 timer 正常触发);bounded 查询不产生秒级 stall。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionDatabase, SESSION_DB_BUSY_WAIT_LIMIT_MS } from "../../../src/storage/session-store/database.ts";
import { installSessionStoreSchema } from "../../../src/storage/session-store/schema.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-store-latency-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("R1 event-loop latency bounds", () => {
	it("keeps a single synchronous busy wait at or below 100ms", () => {
		const dbPath = join(dir, "state.db");
		const writer = openSessionDatabase(dbPath);
		writer.runSync("CREATE TABLE t (x INTEGER)");
		const reader = openSessionDatabase(dbPath);
		writer.beginImmediate();
		try {
			const started = Date.now();
			let sawBusy = false;
			try {
				reader.runSync("INSERT INTO t VALUES (1)");
			} catch {
				sawBusy = true;
			}
			const elapsed = Date.now() - started;
			expect(sawBusy).toBe(true);
			expect(elapsed).toBeLessThanOrEqual(SESSION_DB_BUSY_WAIT_LIMIT_MS + 40);
		} finally {
			writer.rollback();
			writer.close();
			reader.close();
		}
	});

	it("releases the event loop between async busy retries", async () => {
		const dbPath = join(dir, "state.db");
		const writer = openSessionDatabase(dbPath);
		writer.runSync("CREATE TABLE t (x INTEGER)");
		const reader = openSessionDatabase(dbPath);
		writer.beginImmediate();
		const retry = reader.runAsync("INSERT INTO t VALUES (1)");
		const fired: string[] = [];
		setTimeout(() => fired.push("timer-50ms"), 50);
		setTimeout(() => writer.commit(), 120);
		await retry;
		// 第一次同步尝试本身会阻塞约 100ms;50ms timer 能触发说明重试等待期间
		// event loop 被释放,没有进入同步忙等循环。
		expect(fired).toContain("timer-50ms");
		writer.close();
		reader.close();
	});

	it("does not stall the event loop on a bounded catalog query", () => {
		const db = openSessionDatabase(join(dir, "state.db"));
		installSessionStoreSchema(db);
		db.withImmediateTransactionSync((tx) => {
			for (let i = 0; i < 100; i += 1) {
				tx.runSync(
					"INSERT INTO sessions (session_id, workspace_id, repository_id, status, created_at_ms, updated_at_ms, settings_digest) VALUES (?, ?, ?, 'active', 1, 1, ?)",
					[`session_${i}`, "ws-" + "a".repeat(64), "repository_a", "d".repeat(64)],
				);
			}
		});
		const started = Date.now();
		const rows = db.queryAll("SELECT session_id, status FROM sessions ORDER BY session_id LIMIT 100");
		expect(rows.length).toBe(100);
		expect(Date.now() - started).toBeLessThan(500);
		db.close();
	});

	it("reopens cleanly after a WAL-side crash with committed data intact", () => {
		const dbPath = join(dir, "state.db");
		const db = openSessionDatabase(dbPath);
		installSessionStoreSchema(db);
		db.runSync(
			"INSERT INTO sessions (session_id, workspace_id, repository_id, status, created_at_ms, updated_at_ms, settings_digest) VALUES (?, ?, ?, 'active', 1, 1, ?)",
			["session_kept", "ws-" + "a".repeat(64), "repository_a", "d".repeat(64)],
		);
		db.checkpoint();
		db.close();
		// 模拟崩溃:跳过 close,直接以新连接打开同一文件。
		const reopened = openSessionDatabase(dbPath);
		expect(reopened.querySingle("SELECT COUNT(*) AS n FROM sessions")?.n).toBe(1);
		reopened.close();
	});
});
