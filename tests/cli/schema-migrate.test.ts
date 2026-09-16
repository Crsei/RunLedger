import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSessionDatabase } from "../../src/storage/session-store/database.ts";
import { SESSION_STORE_SCHEMA_V5_SQL, sessionStoreSchemaFormatDigest } from "../../src/storage/session-store/schema.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const cli = resolve("src/cli/cli.ts");

function run(root: string, args: string[]) {
	return spawnSync(process.execPath, ["--import", resolve("node_modules/tsx/dist/loader.mjs"), cli, ...args], {
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
});
