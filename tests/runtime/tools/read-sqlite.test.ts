/**
 * `read` 的 SQLite 分支测试。
 *
 * 全部用真实库文件：先按当前运行时的驱动（node:sqlite / bun:sqlite）在
 * `os.tmpdir()` 下写一个库、读出它的完整字节，再把字节喂给 `readSqliteBytes`——
 * 与生产调用形态一致（调用方经 governed fs 读入字节，本模块只处理内存字节）。
 */

import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { looksLikeSqlite, readSqliteBytes } from "../../../src/runtime/tools/read-sqlite.ts";

const requireFromCjs = createRequire(import.meta.url);
const isBun = process.versions.bun !== undefined;

interface FixtureDatabase {
	exec(sql: string): void;
	close(): void;
}

type FixtureDatabaseConstructor = new (path: string) => FixtureDatabase;

/** 用当前运行时的驱动打开一个可写库文件（node/bun 的构造函数名与只读选项名不同）。 */
function openFixtureDatabase(file: string): FixtureDatabase {
	if (isBun) {
		const bunSqlite: { readonly Database: FixtureDatabaseConstructor } = requireFromCjs("bun:sqlite");
		return new bunSqlite.Database(file);
	}
	const nodeSqlite: { readonly DatabaseSync: FixtureDatabaseConstructor } = requireFromCjs("node:sqlite");
	return new nodeSqlite.DatabaseSync(file);
}

/** 执行 statements 建库，返回库文件的完整字节（临时目录随后清理）。 */
function createFixtureBytes(statements: readonly string[]): Uint8Array {
	const directory = mkdtempSync(join(tmpdir(), "read-sqlite-test-"));
	try {
		const file = join(directory, "fixture.db");
		const database = openFixtureDatabase(file);
		for (const statement of statements) database.exec(statement);
		database.close();
		return new Uint8Array(readFileSync(file));
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

const FIXTURE_STATEMENTS: readonly string[] = [
	"CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, score REAL)",
	"INSERT INTO users (id, name, email, score) VALUES (1, 'ada', 'ada@example.com', 9.5), (2, 'bob', 'bob@example.com', 7.25), (3, 'cy', NULL, 5.0)",
	"CREATE TABLE logs (event TEXT NOT NULL, level TEXT NOT NULL)",
	"INSERT INTO logs (event, level) VALUES ('boot', 'info'), ('ready', 'info'), ('fail', 'error')",
	"CREATE TABLE composite (a INTEGER NOT NULL, b INTEGER NOT NULL, note TEXT, PRIMARY KEY (a, b))",
	"INSERT INTO composite (a, b, note) VALUES (1, 1, 'first'), (1, 2, 'second')",
];

const fixture = createFixtureBytes(FIXTURE_STATEMENTS);

describe("looksLikeSqlite", () => {
	it("accepts a real database header and rejects other bytes", () => {
		expect(looksLikeSqlite(fixture.subarray(0, 16))).toBe(true);
		expect(looksLikeSqlite(new TextEncoder().encode("this is not a database"))).toBe(false);
		expect(looksLikeSqlite(fixture.subarray(0, 8))).toBe(false);
		expect(looksLikeSqlite(new Uint8Array())).toBe(false);
	});

	it("refuses to render bytes without the header", () => {
		expect(() => readSqliteBytes(new TextEncoder().encode("this is not a database"), "")).toThrow(
			/missing the 'SQLite format 3' header/u,
		);
	});
});

describe("readSqliteBytes selectors", () => {
	it("lists tables with row counts", () => {
		const result = readSqliteBytes(fixture, "");
		expect(result.truncated).toBe(false);
		expect(result.text).toContain("composite (2 rows)");
		expect(result.text).toContain("logs (3 rows)");
		expect(result.text).toContain("users (3 rows)");
		expect(result.text).not.toContain("sqlite_");
	});

	it("renders the schema plus sample rows for a bare table selector", () => {
		const result = readSqliteBytes(fixture, "users");
		expect(result.text).toContain("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, score REAL)");
		expect(result.text).toContain("Sample rows:");
		expect(result.text).toMatch(/\| id\s+\| name\s+\| email\s+\| score\s+\|/u);
		expect(result.text).toContain("ada@example.com");
	});

	it("reads a row by primary key and reports a missing key", () => {
		expect(readSqliteBytes(fixture, "users:2").text).toBe("id: 2\nname: bob\nemail: bob@example.com\nscore: 7.25");
		expect(readSqliteBytes(fixture, "users:42").text).toBe("No row found in table 'users' for key '42'.");
		expect(() => readSqliteBytes(fixture, "users:not-an-id")).toThrow(/must be an integer/u);
	});

	it("falls back to rowid for tables without a single-column primary key", () => {
		expect(readSqliteBytes(fixture, "logs:1").text).toBe("event: boot\nlevel: info");
		expect(() => readSqliteBytes(fixture, "composite:1")).toThrow(/composite primary key/u);
	});

	it("pages rows with where/order/limit/offset and reports what is left", () => {
		const result = readSqliteBytes(fixture, "users?where=score > 6&order=id:desc&limit=1&offset=0");
		expect(result.text).toContain("bob");
		expect(result.text).not.toContain("cy");
		expect(result.text).toContain("[1 more rows; append :users?limit=1&offset=1 to the database path to continue]");
	});

	it("keeps statement terminators inside quoted literals", () => {
		expect(readSqliteBytes(fixture, "users?where=name = 'ada'").text).toContain("ada");
		expect(() => readSqliteBytes(fixture, "users?where=name = 'x'; DROP TABLE users")).toThrow(
			/must not contain comments or statement terminators/u,
		);
		expect(() => readSqliteBytes(fixture, "users?where=id > 0 LIMIT 1")).toThrow(
			/must not contain LIMIT\/OFFSET\/UNION/u,
		);
	});

	it("executes raw SQL and rejects raw SQL that needs bound parameters", () => {
		const result = readSqliteBytes(fixture, "?q=SELECT name AS n, score FROM users ORDER BY id");
		expect(result.truncated).toBe(false);
		expect(result.text).toMatch(/\| n\s+\| score\s+\|/u);
		expect(result.text).toContain("ada");
		expect(readSqliteBytes(fixture, "?q=SELECT count(*) AS n FROM users").text).toContain("3");
		// 空结果集仍要给出列名（node 的列名走 columns()，bun 走 columnNames）。
		expect(readSqliteBytes(fixture, "?q=SELECT name FROM users WHERE 0").text).toContain("(no rows)");
		expect(() => readSqliteBytes(fixture, "?q=SELECT * FROM users WHERE id = ?")).toThrow(
			/raw queries do not support bound parameters/u,
		);
	});
});

describe("readSqliteBytes selector errors", () => {
	it("rejects unknown tables and parameters", () => {
		expect(() => readSqliteBytes(fixture, "nope")).toThrow(/SQLite table 'nope' not found/u);
		expect(() => readSqliteBytes(fixture, "users?bogus=1")).toThrow(/Unsupported SQLite query parameter 'bogus'/u);
		expect(() => readSqliteBytes(fixture, "?limit=1")).toThrow(/require a table selector/u);
		expect(() => readSqliteBytes(fixture, "users:1?limit=1")).toThrow(/row lookups cannot be combined/u);
		expect(() => readSqliteBytes(fixture, "users?q=SELECT 1")).toThrow(/cannot be combined with table selectors/u);
	});

	it("rejects malformed pagination and ordering", () => {
		expect(() => readSqliteBytes(fixture, "users?limit=0")).toThrow(/limit must be a positive integer/u);
		expect(() => readSqliteBytes(fixture, "users?offset=-1")).toThrow(/offset must be a non-negative integer/u);
		expect(() => readSqliteBytes(fixture, "users?order=missing")).toThrow(/order column 'missing' not found/u);
		expect(() => readSqliteBytes(fixture, "users?order=id:sideways")).toThrow(/order direction must be 'asc' or 'desc'/u);
		expect(() => readSqliteBytes(fixture, "?q=")).toThrow(/query parameter 'q' cannot be empty/u);
	});
});

describe("readSqliteBytes limits", () => {
	it("caps raw query rows and says so", () => {
		const result = readSqliteBytes(fixture, "?q=SELECT * FROM logs", { maxRows: 2 });
		expect(result.truncated).toBe(true);
		expect(result.text).toContain("boot");
		expect(result.text).not.toContain("fail");
		expect(result.text).toContain("[Output capped at 2 rows;");
	});

	it("caps rendered bytes and says so", () => {
		const result = readSqliteBytes(fixture, "users?limit=3", { maxBytes: 30 });
		expect(result.truncated).toBe(true);
		expect(result.text).toContain("[Output truncated at 30 bytes;");
	});

	it("leaves small results untruncated under the defaults", () => {
		const result = readSqliteBytes(fixture, "?q=SELECT * FROM logs");
		expect(result.truncated).toBe(false);
		expect(result.text).toContain("boot");
		expect(result.text).toContain("fail");
	});
});

describe("readSqliteBytes read-only guarantees", () => {
	it("fails on writes and never mutates the caller's bytes", () => {
		const before = Uint8Array.from(fixture);
		expect(() => readSqliteBytes(fixture, "?q=INSERT INTO users (id, name) VALUES (9, 'mallory')")).toThrow(
			/readonly database/u,
		);
		expect(() => readSqliteBytes(fixture, "?q=DROP TABLE users")).toThrow(/readonly database/u);
		expect(readSqliteBytes(fixture, "?q=SELECT count(*) AS n FROM users").text).toContain("3");
		expect(fixture).toEqual(before);
	});
});

describe("readSqliteBytes layout fallbacks", () => {
	it("switches to vertical blocks when a table cannot fit horizontally", () => {
		const columnNames = Array.from({ length: 20 }, (_, index) => `c${String(index).padStart(2, "0")}`);
		const values = columnNames.map((_, index) => `v${String(index).padStart(2, "0")}`);
		const wide = createFixtureBytes([
			`CREATE TABLE wide (${columnNames.map(name => `${name} TEXT`).join(", ")})`,
			`INSERT INTO wide VALUES (${values.map(value => `'${value}'`).join(", ")})`,
		]);
		const vertical = readSqliteBytes(wide, "wide?limit=1");
		expect(vertical.text).toContain("── Row 1 ──");
		expect(vertical.text).toContain("c00: v00");
		expect(vertical.text).not.toContain("| c00 |");

		const narrow = createFixtureBytes([
			"CREATE TABLE narrow (id INTEGER PRIMARY KEY, label TEXT)",
			"INSERT INTO narrow VALUES (1, 'row')",
		]);
		expect(readSqliteBytes(narrow, "narrow?limit=1").text).toMatch(/\| id\s+\| label\s+\|/u);
	});
});

describe("readSqliteBytes against a WAL-mode database", () => {
	it("reads a database whose header advertises the WAL format", () => {
		const walBytes = createFixtureBytes([
			"PRAGMA journal_mode = WAL",
			"CREATE TABLE items (id INTEGER PRIMARY KEY, label TEXT NOT NULL)",
			"INSERT INTO items (id, label) VALUES (1, 'wal-row')",
		]);
		expect(looksLikeSqlite(walBytes.subarray(0, 16))).toBe(true);
		expect(readSqliteBytes(walBytes, "").text).toContain("items (1 rows)");
		expect(readSqliteBytes(walBytes, "items:1").text).toBe("id: 1\nlabel: wal-row");
	});
});
