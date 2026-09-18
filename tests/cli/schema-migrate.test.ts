import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { rmSyncRetry } from "../helpers/cleanup.ts";
import { proveDeadOwners } from "../../src/cli/schema-migrate.ts";
import { openSessionDatabase, type SessionDatabase } from "../../src/storage/session-store/database.ts";
import { checkStoreCompatibility, migrateSessionStoreToCurrent } from "../../src/storage/session-store/schema-compatibility.ts";
import { SESSION_STORE_SCHEMA_V1_SQL, SESSION_STORE_SCHEMA_V5_SQL, SESSION_STORE_SCHEMA_VERSION, sessionStoreSchemaFormatDigest } from "../../src/storage/session-store/schema.ts";
import type { OwnerEndpointLiveness } from "../../src/runtime/session-server/owner-probe.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSyncRetry(root); });
const cli = resolve("src/cli/cli.ts");
/**
 * `--import` 只接受模块说明符,Windows 盘符绝对路径会被判成非法 URL scheme;
 * 同时子进程 cwd 是临时目录,裸 `tsx` 在那里解析不到。统一用 file:// URL。
 */
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

function run(root: string, args: string[]) {
	return spawnSync(process.execPath, ["--import", TSX_LOADER, cli, ...args], {
		encoding: "utf8", timeout: 30_000, cwd: root,
		env: { PATH: process.env.PATH, HOME: root, RUNLEDGER_DIR: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache") },
	});
}

describe("explicit schema migration CLI", () => {
	it("does not open a store without confirmation and does not create a missing database", () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-schema-confirm-")); roots.push(root);
		const missing = run(root, ["migrate", "schema"]);
		expect(missing.status, missing.stderr).toBe(2);
		expect(missing.stderr).toContain("--confirm");
		expect(existsSync(join(root, "state.db"))).toBe(false);
		const confirmed = run(root, ["migrate", "schema", "--confirm"]);
		expect(confirmed.status).toBe(2);
		expect(existsSync(join(root, "state.db"))).toBe(false);
	}, 60_000);

	it("ordinary startup leaves schema 5 unchanged and explicit migration upgrades it", () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-schema-startup-")); roots.push(root);
		mkdirSync(join(root, "config"));
		const db = openSessionDatabase(join(root, "state.db"));
		try {
			db.execSync(SESSION_STORE_SCHEMA_V5_SQL);
			db.runSync("INSERT INTO schema_meta VALUES (5, ?, 1)", [sessionStoreSchemaFormatDigest(SESSION_STORE_SCHEMA_V5_SQL)]);
			db.execSync("INSERT INTO store_control (singleton_id, admission, migration_epoch, catalog_revision, updated_at_ms) VALUES (1, 'ready', 0, 0, 1)");
			const startup = run(root, ["dump", "base"]);
			expect(startup.status, startup.stderr).toBe(2);
			expect(startup.stderr).toContain("runledger migrate schema --confirm");
			expect(db.querySingle("SELECT schema_version FROM schema_meta")).toEqual({ schema_version: 5 });
			const migration = run(root, ["migrate", "schema", "--confirm"]);
			expect(migration.stderr).not.toContain("migration failed");
			expect(migration.status).toBe(0);
			expect(migration.stdout).toContain("schema 7 ready");
			expect(db.querySingle("SELECT schema_version FROM schema_meta")).toEqual({ schema_version: 7 });
		} finally { db.close(); }
	}, 60_000);

	it("upgrades a legacy store whose owner crashed, instead of deadlocking on it", async () => {
		const root = mkdtempSync(join(tmpdir(), "runledger-schema-dead-owner-")); roots.push(root);
		mkdirSync(join(root, "config"));
		const port = await freeLoopbackPort();
		const db = openSessionDatabase(join(root, "state.db"));
		try {
			db.execSync(SESSION_STORE_SCHEMA_V1_SQL);
			db.runSync("INSERT INTO schema_meta VALUES (1, ?, 1)", [sessionStoreSchemaFormatDigest(SESSION_STORE_SCHEMA_V1_SQL)]);
			db.runSync("INSERT INTO store_control (singleton_id, admission, migration_epoch, updated_at_ms) VALUES (1, 'ready', 0, 1)");
			db.runSync(
				"INSERT INTO sessions (session_id, workspace_id, repository_id, status, created_at_ms, updated_at_ms, settings_digest) VALUES ('session_legacy', 'workspace_legacy', 'repository_legacy', 'active', 1, 1, ?)",
				["d".repeat(64)],
			);
			db.runSync(
				`INSERT INTO session_owners (session_id, runtime_id, generation, state, port, heartbeat_at_ms, owner_started_at_ms, updated_at_ms)
				 VALUES ('session_legacy', 'runtime_legacy', 1, 'running', ?, ?, 1, 1)`,
				[port, Date.now() - 86_400_000],
			);
		} finally { db.close(); }

		// 普通启动先被 schema gate 挡住;迁移若不做死亡证明则会被 active owner 永久阻塞。
		const startup = run(root, ["dump", "base"]);
		expect(startup.status, startup.stderr).toBe(2);
		const blocked = run(root, ["migrate", "schema", "--confirm"]);
		expect(blocked.status).toBe(0);
		expect(blocked.stdout).toContain("provably dead owner session_legacy generation 1");
		expect(blocked.stdout).toContain("schema 7 ready");

		const verify = openSessionDatabase(join(root, "state.db"));
		try {
			expect(checkStoreCompatibility(verify)).toMatchObject({ ok: true, header: { storeVersion: SESSION_STORE_SCHEMA_VERSION, admission: "ready" } });
			expect(verify.querySingle("SELECT COUNT(*) AS n FROM sessions")).toEqual({ n: 1 });
		} finally { verify.close(); }
	}, 60_000);
});

async function freeLoopbackPort(): Promise<number> {
	const server = net.createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const address = server.address();
	const port = typeof address === "object" && address !== null ? address.port : 0;
	await new Promise<void>((resolve) => { server.close(() => resolve()); });
	return port;
}

describe("provably dead owner admission", () => {
	const NOW = 1_700_000_000_000;
	const SESSION_ID = "session_legacy";

	function installV1Store(directory: string): SessionDatabase {
		const db = openSessionDatabase(join(directory, "state.db"));
		db.withImmediateTransactionSync((tx) => {
			tx.execSync(SESSION_STORE_SCHEMA_V1_SQL);
			tx.runSync("INSERT INTO schema_meta (schema_version, format_digest, applied_at_ms) VALUES (1, ?, 1)", [sessionStoreSchemaFormatDigest(SESSION_STORE_SCHEMA_V1_SQL)]);
			tx.runSync("INSERT INTO store_control (singleton_id, admission, migration_epoch, updated_at_ms) VALUES (1, 'ready', 0, 1)");
			tx.runSync(
				"INSERT INTO sessions (session_id, workspace_id, repository_id, status, created_at_ms, updated_at_ms, settings_digest) VALUES (?, ?, ?, 'active', 1, 1, ?)",
				[SESSION_ID, "workspace_legacy", "repository_legacy", "d".repeat(64)],
			);
		});
		return db;
	}

	function insertOwner(
		db: SessionDatabase,
		overrides: {
			readonly heartbeatAtMs?: number;
			readonly port?: number | null;
			readonly generation?: number;
			readonly runtimeId?: string;
		} = {},
	): void {
		db.runSync(
			`INSERT INTO session_owners (session_id, runtime_id, generation, state, port, heartbeat_at_ms, owner_started_at_ms, updated_at_ms)
			 VALUES (?, ?, ?, 'running', ?, ?, 1, 1)`,
			[
				SESSION_ID,
				overrides.runtimeId ?? "runtime_legacy",
				overrides.generation ?? 1,
				overrides.port === undefined ? 4000 : overrides.port,
				overrides.heartbeatAtMs === undefined ? NOW - 60_000 : overrides.heartbeatAtMs,
			],
		);
	}

	/** 固定 now + 可编排的探测结果,避免依赖真实 loopback 时序。 */
	function prove(db: SessionDatabase, results: readonly OwnerEndpointLiveness[] | OwnerEndpointLiveness) {
		const queue = Array.isArray(results) ? [...results] : undefined;
		return proveDeadOwners(db, {
			now: () => NOW,
			probeLiveness: async () => queue?.shift() ?? (results as OwnerEndpointLiveness),
		});
	}

	function fixture(): SessionDatabase {
		const directory = mkdtempSync(join(tmpdir(), "runledger-dead-owner-")); roots.push(directory);
		return installV1Store(directory);
	}

	it("proves an owner dead when its heartbeat is stale and the endpoint refuses", async () => {
		const db = fixture();
		insertOwner(db);
		expect(await prove(db, "refused")).toEqual([{ sessionId: SESSION_ID, runtimeId: "runtime_legacy", generation: 1 }]);
		db.close();
	});

	it("keeps an owner active while its heartbeat is still fresh", async () => {
		const db = fixture();
		insertOwner(db, { heartbeatAtMs: NOW - 1_000 });
		expect(await prove(db, "refused")).toEqual([]);
		db.close();
	});

	it("keeps an owner active when anything still listens on its endpoint", async () => {
		const db = fixture();
		insertOwner(db);
		expect(await prove(db, "listening")).toEqual([]);
		db.close();
	});

	it("keeps an owner active when its endpoint cannot be proven closed", async () => {
		const db = fixture();
		insertOwner(db);
		expect(await prove(db, "unreachable")).toEqual([]);
		db.close();
	});

	it("keeps an owner active when no endpoint was recorded", async () => {
		const db = fixture();
		insertOwner(db, { port: null });
		expect(await prove(db, "refused")).toEqual([]);
		db.close();
	});

	it("requires every probe attempt to be refused", async () => {
		const db = fixture();
		insertOwner(db);
		expect(await prove(db, ["refused", "refused", "listening"])).toEqual([]);
		db.close();
	});

	it("migrates a legacy store whose only owner is provably dead", async () => {
		const db = fixture();
		insertOwner(db);
		expect(migrateSessionStoreToCurrent(db)).toMatchObject({ ok: false, code: "active_owners_present" });
		expect(migrateSessionStoreToCurrent(db, { deadOwners: await prove(db, "refused") })).toEqual({
			ok: true,
			storeVersion: SESSION_STORE_SCHEMA_VERSION,
		});
		expect(checkStoreCompatibility(db)).toMatchObject({ ok: true, header: { storeVersion: SESSION_STORE_SCHEMA_VERSION, admission: "ready" } });
		db.close();
	});

	it("rejects evidence that does not match the owner generation", async () => {
		const db = fixture();
		insertOwner(db, { generation: 3 });
		expect(
			migrateSessionStoreToCurrent(db, { deadOwners: [{ sessionId: SESSION_ID, runtimeId: "runtime_legacy", generation: 2 }] }),
		).toMatchObject({ ok: false, code: "active_owners_present" });
		db.close();
	});

	it("rejects evidence that does not match the owner runtime", async () => {
		const db = fixture();
		insertOwner(db);
		expect(
			migrateSessionStoreToCurrent(db, { deadOwners: [{ sessionId: SESSION_ID, runtimeId: "runtime_other", generation: 1 }] }),
		).toMatchObject({ ok: false, code: "active_owners_present" });
		db.close();
	});
});
