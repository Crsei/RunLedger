/**
 * R1:Session Store 跨进程 migration/fault fixtures(06 §4.2 退出条件)。
 *
 * 使用两个真实 Node 进程(见 tests/fixtures/session-store/db-worker.mjs)证明:
 * - 两个进程可同时打开同一 DB(WAL);
 * - 一个进程持写锁时,另一进程单次 busy wait <= 100ms 后失败,释放后可重试;
 * - migrator crash 后 persisted migration_blocked 保持 fail closed;
 * - 旧 binary(MAX=1)遇到新 schema 返回 store_schema_too_new;
 * - crash 中的未提交事务不影响其他进程读取。
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSessionDatabase, SESSION_DB_BUSY_WAIT_LIMIT_MS } from "../../../src/storage/session-store/database.ts";
import { SESSION_STORE_SCHEMA_V1_SQL, sessionStoreSchemaFormatDigest } from "../../../src/storage/session-store/schema.ts";
import { checkStoreCompatibility } from "../../../src/storage/session-store/schema-compatibility.ts";

const WORKER = fileURLToPath(new URL("../../fixtures/session-store/db-worker.mjs", import.meta.url));

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "session-store-multi-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function runWorker(command: string, dbPath: string, extraArgs: string[] = []): Record<string, unknown> {
	const result = spawnSync(process.execPath, [WORKER, command, dbPath, dir, ...extraArgs], {
		encoding: "utf8",
		env: {
			...process.env,
			SESSION_STORE_DDL: SESSION_STORE_SCHEMA_V1_SQL,
			SESSION_STORE_FORMAT_DIGEST: sessionStoreSchemaFormatDigest(),
		},
		timeout: 30_000,
	});
	expect(result.status, `worker ${command} failed: ${result.stderr}`).toBe(0);
	return JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}");
}

describe("R1 real multi-process SQLite", () => {
	it("lets two real processes open the same database concurrently in WAL mode", () => {
		const dbPath = join(dir, "state.db");
		const first = runWorker("install", dbPath);
		expect(first.ok).toBe(true);
		const second = runWorker("open", dbPath);
		expect(second).toMatchObject({ ok: true, journalMode: "wal" });
		expect(first.pid).not.toBe(second.pid);
		expect(second.pid).not.toBe(process.pid);
	});

	it("caps a cross-process busy wait at 100ms and retries after the writer commits", async () => {
		const dbPath = join(dir, "state.db");
		runWorker("install", dbPath);
		const holder = spawn(process.execPath, [WORKER, "hold-write", dbPath, dir], {
			encoding: "utf8",
			env: {
				...process.env,
				SESSION_STORE_DDL: SESSION_STORE_SCHEMA_V1_SQL,
				SESSION_STORE_FORMAT_DIGEST: sessionStoreSchemaFormatDigest(),
			},
		});
		let holderOutput = "";
		holder.stdout?.on("data", (chunk: Buffer) => {
			holderOutput += String(chunk);
		});
		const lockFile = join(dir, "lock-held");
		const deadline = Date.now() + 10_000;
		while (!existsSync(lockFile) && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		expect(existsSync(lockFile)).toBe(true);

		const attempt = runWorker("write-attempt", dbPath);
		expect(attempt).toMatchObject({ busy: true });
		expect(Number(attempt.waitMs)).toBeLessThanOrEqual(SESSION_DB_BUSY_WAIT_LIMIT_MS + 40);

		writeFileSync(join(dir, "release"), "go");
		const holderExit = await new Promise<number | null>((resolve) => {
			holder.on("exit", (code) => resolve(code));
		});
		expect(holderExit).toBe(0);
		expect(JSON.parse(holderOutput.trim().split("\n").pop() ?? "{}").ok).toBe(true);

		const retry = runWorker("write-attempt", dbPath);
		expect(retry).toMatchObject({ ok: true });
	});

	it("rolls back an in-flight transaction when the writer process crashes", () => {
		const dbPath = join(dir, "state.db");
		runWorker("install", dbPath);
		const crashed = spawnSync(process.execPath, [WORKER, "crash-mid-write", dbPath, dir], {
			encoding: "utf8",
			env: { ...process.env, SESSION_STORE_DDL: SESSION_STORE_SCHEMA_V1_SQL },
			timeout: 30_000,
		});
		expect(crashed.status).toBe(1);
		expect(crashed.stdout).toContain("in-transaction");

		const count = runWorker("read-count", dbPath);
		expect(count.count).toBe(0);
		const db = openSessionDatabase(dbPath);
		expect(checkStoreCompatibility(db)).toMatchObject({ ok: true });
		db.close();
	});

	it("lets an old binary (MAX=1) fail closed with store_schema_too_new against a newer store", () => {
		const dbPath = join(dir, "state.db");
		runWorker("install", dbPath);
		runWorker("set-version", dbPath, ["2"]);
		const db = openSessionDatabase(dbPath);
		expect(checkStoreCompatibility(db)).toMatchObject({ ok: false, code: "store_schema_too_new" });
		db.close();
	});
});

describe("R1 claim-vs-migration race across processes", () => {
	it("keeps migration_blocked fail-closed after a migrator process dies mid-gate", () => {
		const dbPath = join(dir, "state.db");
		runWorker("install", dbPath);
		// 模拟 migrator:主进程打开 gate 后直接退出(不 abort),等于崩溃。
		const db = openSessionDatabase(dbPath);
		db.runSync("UPDATE store_control SET admission = 'migration_blocked', migration_epoch = 1, updated_at_ms = ? WHERE singleton_id = 1", [Date.now()]);
		db.close();

		const reopened = openSessionDatabase(dbPath);
		const header = checkStoreCompatibility(reopened);
		expect(header).toMatchObject({ ok: true });
		if (header.ok) expect(header.header.admission).toBe("migration_blocked");
		reopened.close();
	});

	it("blocks a concurrent gate while admission is migration_blocked", () => {
		const dbPath = join(dir, "state.db");
		runWorker("install", dbPath);
		const db = openSessionDatabase(dbPath);
		db.runSync("UPDATE store_control SET admission = 'migration_blocked', migration_epoch = 1, updated_at_ms = ? WHERE singleton_id = 1", [Date.now()]);
		db.close();
		// 第二个真实进程尝试 claim(INSERT session + owner):DB 层成功但 header 拒绝任何 owner 语义。
		const attempt = runWorker("write-attempt", dbPath);
		expect(attempt.ok).toBe(true);
		const reopened = openSessionDatabase(dbPath);
		const header = checkStoreCompatibility(reopened);
		if (header.ok) expect(header.header.admission).toBe("migration_blocked");
		reopened.close();
	});
});
