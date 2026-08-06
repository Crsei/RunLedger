/**
 * R1:Session Store SQLite database foundation fixtures。
 *
 * 覆盖:open/pragmas、100ms 单次 busy 上限、异步有界 jitter 重试、typed error
 * taxonomy、transaction wrapper、close/checkpoint、symlink/mode fail-closed。
 */

import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	SessionDatabase,
	SESSION_DB_BUSY_WAIT_LIMIT_MS,
	SessionStoreDatabaseError,
	openSessionDatabase,
} from "../../../src/storage/session-store/database.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-store-db-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function dbPath(name = "state.db"): string {
	return join(dir, name);
}

describe("R1 SessionDatabase open and pragmas", () => {
	it("opens a fresh database with fixed pragmas and enforces 0600 file mode", () => {
		const path = dbPath();
		const db = openSessionDatabase(path);
		expect(db.isOpen()).toBe(true);
		expect(db.querySingle("PRAGMA journal_mode")?.journal_mode).toBe("wal");
		expect(db.querySingle("PRAGMA synchronous")?.synchronous).toBe(2);
		expect(db.querySingle("PRAGMA foreign_keys")?.foreign_keys).toBe(1);
		expect(db.querySingle("PRAGMA busy_timeout")?.timeout).toBe(SESSION_DB_BUSY_WAIT_LIMIT_MS);
		expect(db.querySingle("PRAGMA trusted_schema")?.trusted_schema).toBe(0);
		const mode = (require("node:fs").statSync(path).mode & 0o777) as number;
		expect(mode).toBe(0o600);
		db.close();
	});

	it("fails closed when the database path is a symlink", () => {
		const target = dbPath("target.db");
		openSessionDatabase(target).close();
		const link = dbPath("state.db");
		symlinkSync(target, link);
		expect(() => openSessionDatabase(link)).toThrowError(SessionStoreDatabaseError);
		try {
			openSessionDatabase(link);
		} catch (error) {
			expect(error).toBeInstanceOf(SessionStoreDatabaseError);
			expect((error as SessionStoreDatabaseError).code).toBe("open_failed");
		}
	});

	it("fails closed when an existing database file has permissive mode", () => {
		const path = dbPath();
		openSessionDatabase(path).close();
		chmodSync(path, 0o644);
		expect(() => openSessionDatabase(path)).toThrowError(/permission|mode/i);
	});

	it("fails closed when the file is not a SQLite database", () => {
		const path = dbPath();
		writeFileSync(path, "this is not a sqlite database\n");
		chmodSync(path, 0o600);
		expect(() => openSessionDatabase(path)).toThrowError(SessionStoreDatabaseError);
		try {
			openSessionDatabase(path);
		} catch (error) {
			expect((error as SessionStoreDatabaseError).code).toBe("not_a_database");
		}
	});
});

describe("R1 bounded busy handling and async retry", () => {
	it("caps a single synchronous busy wait at 100ms and returns a typed busy error", async () => {
		const path = dbPath();
		const writer = openSessionDatabase(path);
		writer.runSync("CREATE TABLE t (x INTEGER)");
		const reader = openSessionDatabase(path);
		writer.beginImmediate();
		try {
			const started = Date.now();
			let busyError: SessionStoreDatabaseError | undefined;
			try {
				reader.runSync("INSERT INTO t VALUES (1)");
			} catch (error) {
				busyError = error as SessionStoreDatabaseError;
			}
			expect(busyError).toBeDefined();
			expect(busyError?.code).toBe("busy");
			expect(busyError?.retryable).toBe(true);
			const elapsed = Date.now() - started;
			expect(elapsed).toBeLessThanOrEqual(SESSION_DB_BUSY_WAIT_LIMIT_MS + 60);
		} finally {
			writer.rollback();
			writer.close();
			reader.close();
		}
	});

	it("retries asynchronously with bounded backoff after the writer commits", async () => {
		const path = dbPath();
		const writer = openSessionDatabase(path);
		writer.runSync("CREATE TABLE t (x INTEGER)");
		const reader = openSessionDatabase(path);
		writer.beginImmediate();
		const retry = reader.runAsync("INSERT INTO t VALUES (1)");
		let timerFired = false;
		const timer = setTimeout(() => {
			timerFired = true;
		}, 30);
		setTimeout(() => {
			writer.commit();
		}, 80);
		await retry;
		clearTimeout(timer);
		expect(timerFired).toBe(true);
		expect(reader.querySingle("SELECT COUNT(*) AS n FROM t")?.n).toBe(1);
		writer.close();
		reader.close();
	});

	it("fails with typed busy after the overall deadline is exceeded", async () => {
		const path = dbPath();
		const writer = openSessionDatabase(path);
		writer.runSync("CREATE TABLE t (x INTEGER)");
		const reader = openSessionDatabase(path);
		writer.beginImmediate();
		await expect(
			reader.runAsync("INSERT INTO t VALUES (1)", [], { deadlineMs: 400 }),
		).rejects.toThrowError(SessionStoreDatabaseError);
		try {
			await reader.runAsync("INSERT INTO t VALUES (1)", [], { deadlineMs: 400 });
		} catch (error) {
			expect((error as SessionStoreDatabaseError).code).toBe("busy");
		}
		writer.rollback();
		writer.close();
		reader.close();
	});
});

describe("R1 transaction wrapper, close and checkpoint", () => {
	it("wraps short transactions with BEGIN IMMEDIATE and rolls back on failure", () => {
		const db = openSessionDatabase(dbPath());
		db.runSync("CREATE TABLE t (x INTEGER)");
		db.withImmediateTransactionSync((tx) => {
			tx.runSync("INSERT INTO t VALUES (1)");
		});
		expect(db.querySingle("SELECT COUNT(*) AS n FROM t")?.n).toBe(1);
		expect(() =>
			db.withImmediateTransactionSync((tx) => {
				tx.runSync("INSERT INTO t VALUES (2)");
				throw new Error("boom");
			}),
		).toThrowError("boom");
		expect(db.querySingle("SELECT COUNT(*) AS n FROM t")?.n).toBe(1);
		db.close();
	});

	it("closes and checkpoints without losing committed data", () => {
		const path = dbPath();
		const db = openSessionDatabase(path);
		db.runSync("CREATE TABLE t (x INTEGER)");
		db.runSync("INSERT INTO t VALUES (7)");
		db.checkpoint();
		db.close();
		expect(existsSync(path + "-wal")).toBe(false);

		const reopened = openSessionDatabase(path);
		expect(reopened.querySingle("SELECT COUNT(*) AS n FROM t")?.n).toBe(1);
		reopened.close();
	});
});
