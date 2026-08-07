import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CLI_PATH = join(process.cwd(), "src", "cli", "cli.ts");

describe("Bun CLI runtime compatibility", () => {
	it("loads the production CLI entrypoint without rejecting Node SQLite", () => {
		const result = spawnSync("bun", [CLI_PATH, "--help"], {
			cwd: process.cwd(),
			encoding: "utf8",
		});

		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("Usage: runledger");
		expect(result.stderr).not.toContain("No such built-in module: node:sqlite");
	});

	it("opens and queries the session database with Bun SQLite", () => {
		const tempRoot = join(process.cwd(), "tmp");
		mkdirSync(tempRoot, { recursive: true });
		const home = mkdtempSync(join(tempRoot, "bun-sqlite-"));
		chmodSync(home, 0o700);
		try {
			const result = spawnSync(
				"bun",
				[
					"-e",
					'import { openSessionDatabase } from "./src/storage/session-store/database.ts"; const db = openSessionDatabase(process.argv[1]); db.execSync("CREATE TABLE smoke (value TEXT NOT NULL)"); if (db.querySingle("SELECT value FROM smoke") !== undefined) throw new Error("empty query must return undefined"); db.runSync("INSERT INTO smoke(value) VALUES (?)", ["ok"]); console.log(JSON.stringify(db.querySingle("SELECT value FROM smoke"))); db.close();',
					join(home, "state.db"),
				],
				{ cwd: process.cwd(), encoding: "utf8" },
			);

			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout.trim()).toBe('{"value":"ok"}');
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
