/**
 * 只读 SQLite 字节适配器。
 *
 * 由 `read` 工具的 sqlite 分支调用：把「已由调用方经 governed I/O 读入的库字节」
 * 交给当前运行时的内建 SQLite，并以**只读**打开。
 *
 * 为什么这个模块在 `src/storage/` 而不是工具目录：它需要 `node:fs`（见下面的
 * Node 分支），而 `src/runtime/tools/**` 被 `check:execution-boundaries` 禁止触碰
 * raw fs。原始 I/O 的归属层是 storage adapter —— 与 `session-store/database.ts`
 * 同一层次、同一豁免理由，工具层只消费这里返回的结构化连接。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** 可绑定的 SQL 值（两个驱动都接受这一集合，不含命名参数对象）。 */
export type SqliteBinding = string | number | bigint | null | Uint8Array;

/** 行对象：node 返回 null 原型对象，bun 返回普通对象，此处只按 own key 访问。 */
export type SqliteRow = Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* 驱动：node:sqlite / bun:sqlite 的结构最小面                                  */
/* -------------------------------------------------------------------------- */

/**
 * 两个驱动的语句结构差异（不依赖 @types/bun 的精确声明）：
 * node 的 `StatementSync` 把行返回成 `unknown`、列名走 `columns()`；
 * bun 的 `Statement` 直接暴露 `columnNames`。
 */
interface DriverStatement {
	all(...params: readonly SqliteBinding[]): unknown;
	get(...params: readonly SqliteBinding[]): unknown;
	iterate(...params: readonly SqliteBinding[]): Iterable<unknown>;
	readonly columnNames?: readonly string[];
	columns?(): readonly { readonly name: string }[];
}

interface DriverDatabase {
	prepare(sql: string): DriverStatement;
	exec(sql: string): unknown;
	close(): unknown;
}

interface SqliteStatement {
	all(...params: readonly SqliteBinding[]): SqliteRow[];
	get(...params: readonly SqliteBinding[]): SqliteRow | undefined;
	iterate(...params: readonly SqliteBinding[]): Iterable<SqliteRow>;
	readonly columns: readonly string[];
}

export interface SqliteConnection {
	exec(sql: string): void;
	prepare(sql: string): SqliteStatement;
	close(): void;
}

const requireFromCjs = createRequire(import.meta.url);
type SqliteDriverConstructor = new (
	path: string | Uint8Array,
	options?: { readonly readOnly?: boolean; readonly readonly?: boolean },
) => DriverDatabase;

const processVersions = process.versions as NodeJS.ProcessVersions & { readonly bun?: string };

interface SqliteDriver {
	readonly Database: SqliteDriverConstructor;
	readonly readOnlyOption: "readOnly" | "readonly";
}

/**
 * 载入当前运行时的内建 SQLite。必须按需载入：`bun:sqlite` 在 Node 下不存在，
 * `node:sqlite` 在 Bun 下解析结果不可靠。
 */
function loadSqliteDriver(): SqliteDriver {
	if (processVersions.bun === undefined) {
		// createRequire 返回 any；内建模块导出无法在运行时校验，只在这一处收敛成
		// 构造函数类型，其余代码走 DriverDatabase 结构面。
		const nodeSqlite: { readonly DatabaseSync: SqliteDriverConstructor } = requireFromCjs("node:sqlite");
		return { Database: nodeSqlite.DatabaseSync, readOnlyOption: "readOnly" };
	}
	const bunSqlite: { readonly Database: SqliteDriverConstructor } = requireFromCjs("bun:sqlite");
	return { Database: bunSqlite.Database, readOnlyOption: "readonly" };
}

function isSqliteRow(value: unknown): value is SqliteRow {
	return typeof value === "object" && value !== null;
}

function* rowStream(values: Iterable<unknown>): Iterable<SqliteRow> {
	for (const value of values) {
		if (isSqliteRow(value)) yield value;
	}
}

/** 列名：bun 走 `columnNames`，node 走 `columns()`。空结果集也据此保表头。 */
function statementColumns(statement: DriverStatement): readonly string[] {
	if (statement.columnNames !== undefined) return statement.columnNames;
	return (statement.columns?.() ?? []).map(column => column.name);
}

function wrapStatement(statement: DriverStatement): SqliteStatement {
	return {
		all: (...params) => {
			const values = statement.all(...params);
			return Array.isArray(values) ? values.filter(isSqliteRow) : [];
		},
		get: (...params) => {
			const row = statement.get(...params);
			return isSqliteRow(row) ? row : undefined;
		},
		iterate: (...params) => rowStream(statement.iterate(...params)),
		columns: statementColumns(statement),
	};
}

function wrapDatabase(database: DriverDatabase): SqliteConnection {
	return {
		exec: (sql) => {
			database.exec(sql);
		},
		prepare: (sql) => wrapStatement(database.prepare(sql)),
		close: () => {
			database.close();
		},
	};
}

/** 每连接固定 pragma。`query_only` 是只读性的第二道闸（第一道是驱动的只读打开）。 */
const READ_CONNECTION_PRAGMAS = ["PRAGMA query_only = ON", "PRAGMA busy_timeout = 3000"] as const;

function openReadConnection(database: DriverDatabase): SqliteConnection {
	const connection = wrapDatabase(database);
	try {
		for (const pragma of READ_CONNECTION_PRAGMAS) connection.exec(pragma);
	} catch (error) {
		// pragma 失败必须关掉句柄，否则 node 分支的临时文件会被占用。
		connection.close();
		throw error;
	}
	return connection;
}

export interface OpenedSqlite {
	readonly connection: SqliteConnection;
	readonly close: () => void;
}

/**
 * 把字节交给当前运行时的 SQLite 并只读打开。Bun 直接反序列化成内存库（无 fs）；
 * Node 走临时文件（见文件头注释），句柄关闭时递归清理该临时目录。
 */
export function openReadOnlySqliteBytes(bytes: Uint8Array): OpenedSqlite {
	const driver = loadSqliteDriver();
	if (processVersions.bun !== undefined) {
		const connection = openReadConnection(new driver.Database(bytes));
		return { connection, close: () => connection.close() };
	}

	const directory = mkdtempSync(join(tmpdir(), "runledger-read-sqlite-"));
	const removeTempDirectory = (): void => {
		rmSync(directory, { recursive: true, force: true });
	};
	try {
		const file = join(directory, "source.db");
		writeFileSync(file, bytes);
		const connection = openReadConnection(
			new driver.Database(file, driver.readOnlyOption === "readOnly" ? { readOnly: true } : { readonly: true }),
		);
		return {
			connection,
			close: () => {
				try {
					connection.close();
				} finally {
					removeTempDirectory();
				}
			},
		};
	} catch (error) {
		removeTempDirectory();
		throw error;
	}
}
