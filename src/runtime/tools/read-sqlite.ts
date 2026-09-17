/**
 * `read` 的 SQLite 分支。
 *
 * 对应上游 `tools/sqlite-reader.ts`（927 行）+ `tools/read-sqlite.ts`（215 行）。
 * selector 语法与渲染输出沿用上游：
 *   - 空串                                  → 表清单（表名 + 行数）
 *   - `table`                               → 建表 SQL + 抽样行
 *   - `table:key`                           → 单行（单列主键按主键查，无主键按 rowid）
 *   - `table?limit=&offset=&order=&where=`  → 分页查询
 *   - `?q=SELECT ...`                       → 原始 SQL（与表选择器互斥）
 *
 * 与上游的差异：
 * - 上游自己 `new Database(path)` 读盘（bun:sqlite）；这里只接受调用方经 governed
 *   fs 读入的完整字节，本模块既不读原文件也不可能写坏它；
 * - 驱动按运行时选择，写法照抄 `storage/session-store/database.ts`：Bun 走
 *   `bun:sqlite`、Node 走 `node:sqlite`，两者只读选项名不同（bun `readonly` /
 *   node `readOnly`）；
 * - 内存库：Bun 的 `new Database(bytes)` 直接反序列化为内存库（实测该构造对入参
 *   做拷贝，之后改写这些字节不影响句柄），零 fs 用法。Node 的 `DatabaseSync` 只把
 *   参数当文件名（传 Uint8Array 会因路径里的 NUL 字节报 ERR_INVALID_ARG_TYPE，
 *   SQLite 也没暴露 `sqlite3_deserialize`），故把字节写进 `os.tmpdir()` 下的独占
 *   临时目录、以 `readOnly: true` 打开——这是本模块唯一的 fs 用法，句柄关闭后
 *   递归删除该目录；
 * - 打开后统一 `PRAGMA query_only = ON`（对齐 `database.ts`）并设置 `busy_timeout`；
 * - 上游的 `ToolError` 换成本仓 read 工具契约的普通 `Error`：失败即 throw。
 *
 * 已知边界（字节契约本身的结果，非本模块可修）：
 * - 只拿到主库文件的字节，看不到 `-wal` / `-shm` 侧车。若库处于 WAL 模式且最新事务
 *   还没 checkpoint，读到的是主库里的旧快照（表现为表/行"不存在"），而不是报错；
 * - `?` 之后的部分按 URL query 解码（上游同款）：`%20` → 空格，`+` → 空格。where
 *   子句里需要字面量 `+` 时写 `%2B`。
 *
 * 上游依赖的 `Bun.stringWidth` / `truncateToWidth` / `formatBytes` 分别改用仓内既有
 * 的 `string-width`、本文件的 `truncateToWidth`、`websource/scrapers/format.ts`。
 */

import stringWidth from "string-width";
import { formatBytes } from "../../websource/scrapers/format.ts";
import {
	openReadOnlySqliteBytes,
	type SqliteBinding,
	type SqliteConnection,
	type SqliteRow,
} from "../../storage/readonly-sqlite.ts";
import { DEFAULT_MAX_BYTES, truncateHead } from "./tool-support.ts";

/** 16 字节文件头：`SQLite format 3\0`。 */
const SQLITE_MAGIC = new Uint8Array([
	0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
]);

export interface SqliteReadResult {
	/** 给模型的 Markdown 正文。 */
	readonly text: string;
	/** 是否因上限截断。 */
	readonly truncated: boolean;
}

export interface SqliteReadOptions {
	/** 正文最多渲染的数据行数；缺省 {@link DEFAULT_MAX_ROWS}。 */
	readonly maxRows?: number;
	/** 正文最多字节数；缺省与 read 工具一致（{@link DEFAULT_MAX_BYTES}）。 */
	readonly maxBytes?: number;
}

/** 判定字节是否为 SQLite 库（前 16 字节文件头）。 */
export function looksLikeSqlite(head: Uint8Array): boolean {
	if (head.byteLength < SQLITE_MAGIC.byteLength) return false;
	for (const [index, byte] of SQLITE_MAGIC.entries()) {
		if (head[index] !== byte) return false;
	}
	return true;
}

const DEFAULT_QUERY_LIMIT = 20;
const DEFAULT_SCHEMA_SAMPLE_LIMIT = 5;
const MAX_QUERY_LIMIT = 500;
/** 单次渲染的数据行上限缺省值：raw `?q=` 的扫描上限，也是所有分支的最终行闸门。 */
const DEFAULT_MAX_ROWS = 1000;
const MAX_RENDER_WIDTH = 120;
const MAX_COLUMN_WIDTH = 40;
/** 每列显示宽度下限。宽度 2 时任何多字符单元格都会塌成一个省略号，故留 3 列。 */
const MIN_COLUMN_WIDTH = 3;
/** ASCII 表格每列的分隔开销（`" | "`）。 */
const COLUMN_SEPARATOR_WIDTH = 3;
/** 每行的固定框架宽度（行首 `"|"` + 行尾 `" |"` 中未被逐列记账的那 1 列）。 */
const TABLE_FRAME_WIDTH = 1;
/** 表清单统计行数的扫描上限：SQLite 无存量行数，`COUNT(*)` 是全 b-tree 扫描。 */
const ROW_COUNT_PROBE_CAP = 50_000;

/* -------------------------------------------------------------------------- */
/* selector                                                                    */
/* -------------------------------------------------------------------------- */

type SqliteSelector =
	| { readonly kind: "list" }
	| { readonly kind: "schema"; readonly table: string; readonly sampleLimit: number }
	| { readonly kind: "row"; readonly table: string; readonly key: string }
	| {
		readonly kind: "query";
		readonly table: string;
		readonly limit: number;
		readonly offset: number;
		readonly order?: string;
		readonly where?: string;
	}
	| { readonly kind: "raw"; readonly sql: string };

type SqliteRowLookup = { readonly kind: "pk"; readonly column: string; readonly type: string } | { readonly kind: "rowid" };

function quoteSqliteIdentifier(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function parseLimit(value: string | null, fallback: number): number {
	if (value === null || value.trim().length === 0) return fallback;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 1) {
		throw new Error(`SQLite limit must be a positive integer; got '${value}'`);
	}
	return Math.min(parsed, MAX_QUERY_LIMIT);
}

function parseOffset(value: string | null): number {
	if (value === null || value.trim().length === 0) return 0;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0) {
		throw new Error(`SQLite offset must be a non-negative integer; got '${value}'`);
	}
	return parsed;
}

const FORBIDDEN_WHERE_KEYWORDS: Record<string, true> = {
	limit: true,
	offset: true,
	union: true,
	intersect: true,
	except: true,
	attach: true,
	detach: true,
	pragma: true,
};

/** `table?` 允许的结构化查询参数；其余键一律报错，不静默忽略。 */
const KNOWN_QUERY_KEYS: Record<string, true> = { limit: true, offset: true, order: true, where: true };

const COMMENT_OR_TERMINATOR_ERROR =
	"SQLite 'where' clause must not contain comments or statement terminators; use '?q=SELECT ...' for raw SQL";
const FORBIDDEN_KEYWORD_ERROR =
	"SQLite 'where' clause must not contain LIMIT/OFFSET/UNION/INTERSECT/EXCEPT/ATTACH/DETACH/PRAGMA; use '?q=SELECT ...' for raw SQL";

/**
 * 把 SQL 里的字符串/标识符字面量（含 `''` / `""` 转义）整体替换成等长空白，只留
 * 引号外的字符。`where=` 校验与 raw 参数检测都以「引号外」为界，共用这一层。
 */
function maskSqlLiterals(sql: string): string {
	const characters = [...sql];
	const masked: string[] = [];
	let quote: "'" | '"' | null = null;
	for (let index = 0; index < characters.length; index += 1) {
		const character = characters[index];
		if (quote !== null) {
			masked.push(" ");
			if (character !== quote) continue;
			if (characters[index + 1] === quote) {
				masked.push(" ");
				index += 1;
				continue;
			}
			quote = null;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			masked.push(" ");
			continue;
		}
		masked.push(character);
	}
	return masked.join("");
}

/**
 * 结构化 `where=` 的越界语法检查：注释、语句结束符与分页/ATTACH/PRAGMA 关键字会
 * 让 `LIMIT ? OFFSET ?` 的绑定语义失控。原始 SQL 仍可通过 `?q=SELECT ...` 使用。
 */
function findWhereClauseViolation(sql: string): string | null {
	const masked = maskSqlLiterals(sql);
	if (/;|--|\/\*|\*\//u.test(masked)) return COMMENT_OR_TERMINATOR_ERROR;
	for (const token of masked.match(/[A-Za-z0-9_]+/gu) ?? []) {
		if (token.toLowerCase() in FORBIDDEN_WHERE_KEYWORDS) return FORBIDDEN_KEYWORD_ERROR;
	}
	return null;
}

function validateWhereClause(where: string | undefined): string | undefined {
	if (!where) return undefined;
	const trimmed = where.trim();
	if (!trimmed) return undefined;
	const violation = findWhereClauseViolation(trimmed);
	if (violation) throw new Error(violation);
	return trimmed;
}

/** raw `?q=` 不接受绑定参数（上游同款：`paramsCount > 0` 即拒绝）。 */
function hasSqlParameters(sql: string): boolean {
	const withoutComments = maskSqlLiterals(sql).replaceAll(/--[^\n]*|\/\*[\s\S]*?\*\//gu, " ");
	return /[?:@$]/u.test(withoutComments);
}

function resolveOrderClause(order: string | undefined, columns: readonly string[]): string {
	if (!order) return "";
	const trimmed = order.trim();
	if (!trimmed) return "";
	const separatorIndex = trimmed.lastIndexOf(":");
	const column = separatorIndex === -1 ? trimmed : trimmed.slice(0, separatorIndex);
	const direction = separatorIndex === -1 ? "asc" : trimmed.slice(separatorIndex + 1).trim().toLowerCase();
	if (!columns.includes(column)) {
		throw new Error(`SQLite order column '${column}' not found in table schema`);
	}
	if (direction !== "asc" && direction !== "desc") {
		throw new Error(`SQLite order direction must be 'asc' or 'desc'; got '${direction}'`);
	}
	return ` ORDER BY ${quoteSqliteIdentifier(column)} ${direction.toUpperCase()}`;
}

/**
 * SQLite 库文件的扩展名集合（用于在 `read` 的行选择器解析**之前**切分路径）。
 * 与上游 `sqlite-reader.ts` 的 sniff 列表一致。
 */
const SQLITE_EXTENSIONS = [".sqlite", ".sqlite3", ".db", ".db3"] as const;

/**
 * 判定 `rawPath` 是否是 sqlite 读取，并切出「库文件路径」与「selector」。
 *
 * 必须在 `splitPathAndSel` 之前调用：`db.sqlite:users:1` 会被行选择器解析器
 * 拆成 path=`db.sqlite:users` / sel=`1`，`db.sqlite?q=SELECT 1` 则整串被当成
 * 路径。这里按扩展名边界切分，剩余部分（含 `?query`）整体作为 selector。
 *
 * 返回 `null` 表示不是 sqlite 形态（调用方继续走文本/归档路径）。注意这只是
 * **形状**判定，真正的类型判定仍由 `looksLikeSqlite` 的魔数负责。
 */
export function parseSqliteReadTarget(rawPath: string): { readonly dbPath: string; readonly selector: string } | null {
	for (const extension of SQLITE_EXTENSIONS) {
		const index = rawPath.toLowerCase().lastIndexOf(extension);
		if (index === -1) continue;
		const boundary = index + extension.length;
		const remainder = rawPath.slice(boundary);
		// 扩展名之后只允许 `:` 或 `?` 开头；否则（如 `a.db3-backup`）不是 sqlite 形态。
		if (remainder.length > 0 && remainder[0] !== ":" && remainder[0] !== "?") continue;
		return { dbPath: rawPath.slice(0, boundary), selector: remainder };
	}
	return null;
}

/**
 * 解析 `path:` 之后的部分。空串列清单；`table[:key]` 走表；`?q=` 走原始 SQL。
 * 前导冒号容忍（`file.db::table` 与 `file.db:table` 等价）。
 */
function parseSqliteSelector(selector: string): SqliteSelector {
	const queryIndex = selector.indexOf("?");
	const subPath = (queryIndex === -1 ? selector : selector.slice(0, queryIndex)).replace(/^:+/u, "").trim();
	const queryString = queryIndex === -1 ? "" : selector.slice(queryIndex + 1);
	const params = new URLSearchParams(queryString);
	const rawQuery = params.get("q");

	if (rawQuery !== null) {
		const otherKeys = [...params.keys()].filter(key => key !== "q");
		if (subPath || otherKeys.length > 0) {
			throw new Error("SQLite raw queries cannot be combined with table selectors or pagination");
		}
		if (!rawQuery.trim()) throw new Error("SQLite query parameter 'q' cannot be empty");
		return { kind: "raw", sql: rawQuery };
	}

	if (!subPath) {
		if (params.size > 0) throw new Error("SQLite query parameters require a table selector or q=SELECT...");
		return { kind: "list" };
	}

	const separatorIndex = subPath.indexOf(":");
	const table = separatorIndex === -1 ? subPath : subPath.slice(0, separatorIndex);
	const key = separatorIndex === -1 ? undefined : subPath.slice(separatorIndex + 1);
	if (!table) throw new Error("SQLite selectors must include a table name");

	if (key !== undefined && key.length > 0) {
		if (params.size > 0) throw new Error("SQLite row lookups cannot be combined with query parameters");
		return { kind: "row", table, key };
	}

	const where = validateWhereClause(params.get("where") ?? undefined);
	const order = params.get("order")?.trim() || undefined;
	if (params.has("limit") || params.has("offset") || order !== undefined || where !== undefined) {
		for (const keyName of params.keys()) {
			if (!(keyName in KNOWN_QUERY_KEYS)) throw new Error(`Unsupported SQLite query parameter '${keyName}'`);
		}
		return {
			kind: "query",
			table,
			limit: parseLimit(params.get("limit"), DEFAULT_QUERY_LIMIT),
			offset: parseOffset(params.get("offset")),
			order,
			where,
		};
	}

	for (const keyName of params.keys()) throw new Error(`Unsupported SQLite query parameter '${keyName}'`);

	return { kind: "schema", table, sampleLimit: DEFAULT_SCHEMA_SAMPLE_LIMIT };
}

/* -------------------------------------------------------------------------- */
/* 读侧查询                                                                    */
/* -------------------------------------------------------------------------- */

interface SqliteTableInfoRow {
	readonly name: string;
	readonly type: string;
	readonly pk: number;
}

type TableRowCount =
	| { readonly kind: "exact"; readonly rows: number }
	| { readonly kind: "estimate"; readonly rows: number }
	| { readonly kind: "atLeast"; readonly rows: number };

interface SqliteTableSummary {
	readonly name: string;
	readonly count: TableRowCount;
}

function stringField(row: SqliteRow | undefined, key: string): string {
	const value = row?.[key];
	return typeof value === "string" ? value : String(value ?? "");
}

function numberField(row: SqliteRow | undefined, key: string): number {
	const value = row?.[key];
	if (typeof value === "number") return value;
	if (typeof value === "bigint") return Number(value);
	return Number(value ?? 0);
}

function getTableMasterRow(connection: SqliteConnection, table: string): SqliteRow {
	const row = connection
		.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name = ?")
		.get(table);
	if (row === undefined) throw new Error(`SQLite table '${table}' not found`);
	return row;
}

function getTableInfoRows(connection: SqliteConnection, table: string): SqliteTableInfoRow[] {
	getTableMasterRow(connection, table);
	return connection.prepare(`PRAGMA table_info(${quoteSqliteIdentifier(table)})`).all().map(row => ({
		name: stringField(row, "name"),
		type: stringField(row, "type"),
		pk: numberField(row, "pk"),
	}));
}

function getTableColumns(connection: SqliteConnection, table: string): string[] {
	return getTableInfoRows(connection, table).map(column => column.name);
}

function getPrimaryKeyColumns(connection: SqliteConnection, table: string): SqliteTableInfoRow[] {
	return getTableInfoRows(connection, table)
		.filter(column => column.pk > 0)
		.sort((left, right) => left.pk - right.pk);
}

function getTableSchema(connection: SqliteConnection, table: string): string {
	const schema = stringField(getTableMasterRow(connection, table), "sql");
	if (!schema) throw new Error(`SQLite schema for table '${table}' is unavailable`);
	return schema;
}

function coerceIntegerKey(key: string, label: string): number {
	const trimmed = key.trim();
	if (!/^-?\d+$/u.test(trimmed)) throw new Error(`${label} must be an integer; got '${key}'`);
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is out of range; got '${key}'`);
	return parsed;
}

function coerceLookupValue(key: string, type: string): SqliteBinding {
	const normalizedType = type.trim().toUpperCase();
	if (normalizedType.includes("INT")) return coerceIntegerKey(key, `Primary key '${key}'`);
	return key;
}

/**
 * `table:key` 的定位方式：单列主键按主键查；复合主键与 WITHOUT ROWID 表没有唯一
 * 隐式键，明确报错并指向 `?where=`。
 */
function resolveTableRowLookup(connection: SqliteConnection, table: string): SqliteRowLookup {
	const primaryKeyColumns = getPrimaryKeyColumns(connection, table);
	if (primaryKeyColumns.length === 1) {
		const column = primaryKeyColumns[0];
		return { kind: "pk", column: column.name, type: column.type };
	}
	if (primaryKeyColumns.length > 1) {
		throw new Error(`SQLite table '${table}' has a composite primary key; use '?where=' instead`);
	}
	if (/\bWITHOUT\s+ROWID\b/iu.test(getTableSchema(connection, table))) {
		throw new Error(`SQLite table '${table}' does not expose ROWID; use '?where=' instead`);
	}
	return { kind: "rowid" };
}

function queryRows(
	connection: SqliteConnection,
	table: string,
	options: { readonly limit: number; readonly offset: number; readonly order?: string; readonly where?: string },
): { readonly columns: readonly string[]; readonly rows: readonly SqliteRow[]; readonly totalCount: number } {
	const columns = getTableColumns(connection, table);
	const where = validateWhereClause(options.where);
	const whereClause = where ? ` WHERE ${where}` : "";
	const orderClause = resolveOrderClause(options.order, columns);
	const totalCount = numberField(
		connection.prepare(`SELECT COUNT(*) AS count FROM ${quoteSqliteIdentifier(table)}${whereClause}`).get(),
		"count",
	);
	const rows = connection
		.prepare(
			`SELECT * FROM ${quoteSqliteIdentifier(table)}${whereClause}${orderClause} LIMIT ? OFFSET ?`,
		)
		.all(options.limit, options.offset);
	return { columns, rows, totalCount };
}

function getRowByKey(
	connection: SqliteConnection,
	table: string,
	pk: { readonly column: string; readonly type: string },
	key: string,
): SqliteRow | undefined {
	getTableMasterRow(connection, table);
	return connection
		.prepare(`SELECT * FROM ${quoteSqliteIdentifier(table)} WHERE ${quoteSqliteIdentifier(pk.column)} = ? LIMIT 1`)
		.get(coerceLookupValue(key, pk.type));
}

function getRowByRowId(connection: SqliteConnection, table: string, key: string): SqliteRow | undefined {
	getTableMasterRow(connection, table);
	return connection
		.prepare(`SELECT * FROM ${quoteSqliteIdentifier(table)} WHERE rowid = ? LIMIT 1`)
		.get(coerceIntegerKey(key, "SQLite ROWID"));
}

/** 原始 SQL 逐行取到 `maxRows` 行；再多取到一行即判定截断。 */
function executeReadQuery(
	connection: SqliteConnection,
	sql: string,
	maxRows: number,
): { readonly columns: readonly string[]; readonly rows: SqliteRow[]; readonly truncated: boolean } {
	if (hasSqlParameters(sql)) throw new Error("SQLite raw queries do not support bound parameters");
	const statement = connection.prepare(sql);
	const rows: SqliteRow[] = [];
	let truncated = false;
	for (const row of statement.iterate()) {
		if (rows.length >= maxRows) {
			truncated = true;
			break;
		}
		rows.push(row);
	}
	return { columns: statement.columns, rows, truncated };
}

/**
 * `sqlite_stat1`（`ANALYZE` 写入）里每张表的行数估计。只在估计值大到不值得精确
 * 计数时才采信，避免清单页触发全表扫描。
 */
function loadRowEstimates(connection: SqliteConnection): Map<string, number> {
	const estimates = new Map<string, number>();
	const stat1 = connection
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_stat1'")
		.get();
	if (stat1 === undefined) return estimates;
	for (const row of connection.prepare("SELECT tbl, stat FROM sqlite_stat1").all()) {
		const stat = stringField(row, "stat");
		if (!stat) continue;
		const rows = Number.parseInt(stat, 10);
		if (!Number.isFinite(rows)) continue;
		const table = stringField(row, "tbl");
		const previous = estimates.get(table);
		if (previous === undefined || rows > previous) estimates.set(table, rows);
	}
	return estimates;
}

/** 最多扫 `cap + 1` 行的精确计数；超过则退化成下限估计。 */
function probeRowCount(connection: SqliteConnection, table: string, cap: number): TableRowCount {
	const counted = numberField(
		connection
			.prepare(`SELECT COUNT(*) AS count FROM (SELECT 1 FROM ${quoteSqliteIdentifier(table)} LIMIT ${cap + 1})`)
			.get(),
		"count",
	);
	return counted > cap ? { kind: "atLeast", rows: cap } : { kind: "exact", rows: counted };
}

function listTables(connection: SqliteConnection): SqliteTableSummary[] {
	const estimates = loadRowEstimates(connection);
	return connection
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name COLLATE NOCASE")
		.all()
		.map(row => {
			const name = stringField(row, "name");
			const estimate = estimates.get(name);
			const count: TableRowCount = estimate !== undefined && estimate > ROW_COUNT_PROBE_CAP
				? { kind: "estimate", rows: estimate }
				: probeRowCount(connection, name, ROW_COUNT_PROBE_CAP);
			return { name, count };
		});
}

/* -------------------------------------------------------------------------- */
/* 渲染                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 按显示宽度截断（CJK / emoji 记 2 列）。超宽时保留 `width - 1` 列 + 省略号，
 * 与上游 `truncateToWidth` 的默认省略号行为一致。
 */
function truncateToWidth(value: string, width: number): string {
	if (stringWidth(value) <= width) return value;
	let result = "";
	let used = 0;
	for (const character of value) {
		const next = stringWidth(character);
		if (used + next > width - 1) break;
		result += character;
		used += next;
	}
	return `${result}…`;
}

/** 单元格里的控制字符会破坏表格布局：tab 转空格，换行转字面量 `\n`。 */
function sanitizeCell(value: string): string {
	return value.replaceAll("\t", " ").replaceAll(/\r?\n/gu, "\\n");
}

function stringifySqliteValue(value: unknown): string {
	if (value === null) return "NULL";
	if (value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
	if (value instanceof Uint8Array) return `<BLOB ${formatBytes(value.byteLength)}>`;
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function padCell(value: string, width: number): string {
	const truncated = truncateToWidth(sanitizeCell(value), Math.max(width, MIN_COLUMN_WIDTH));
	const visible = stringWidth(truncated);
	return visible >= width ? truncated : `${truncated}${" ".repeat(width - visible)}`;
}

/**
 * 列数过多时的纵向兜底（对齐 `psql` 的 expanded 模式）：每行渲染成
 * `列名: 值` 的块，列名右填充到同一宽度后对齐冒号。
 */
function buildVerticalBlocks(columns: readonly string[], rows: readonly SqliteRow[]): string {
	if (rows.length === 0) return "(no rows)";
	let nameWidth = MIN_COLUMN_WIDTH;
	for (const column of columns) {
		nameWidth = Math.max(nameWidth, stringWidth(sanitizeCell(column)));
	}
	nameWidth = Math.min(MAX_COLUMN_WIDTH, nameWidth);
	return rows
		.map((row, index) => {
			const block = [`── Row ${index + 1} ──`];
			for (const column of columns) {
				const name = padCell(column, nameWidth);
				block.push(truncateToWidth(`${name}: ${sanitizeCell(stringifySqliteValue(row[column]))}`, MAX_RENDER_WIDTH));
			}
			return block.join("\n");
		})
		.join("\n\n");
}

function buildAsciiTable(columns: readonly string[], rows: readonly SqliteRow[]): string {
	if (columns.length === 0) {
		return rows.length === 0 ? "(no rows)" : "(rows returned without named columns)";
	}
	// 每列压到下限时仍放不下（默认渲染宽度下超过 19 列）就整体改纵向布局：继续横排
	// 只会让每列都被削成一个省略号。
	if (MIN_COLUMN_WIDTH * columns.length + COLUMN_SEPARATOR_WIDTH * columns.length + TABLE_FRAME_WIDTH > MAX_RENDER_WIDTH) {
		return buildVerticalBlocks(columns, rows);
	}

	const widths = columns.map(column =>
		Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, stringWidth(sanitizeCell(column)))),
	);
	for (const row of rows) {
		for (const [index, column] of columns.entries()) {
			const cellWidth = stringWidth(sanitizeCell(stringifySqliteValue(row[column])));
			const current = widths[index] ?? MIN_COLUMN_WIDTH;
			widths[index] = Math.max(current, Math.min(MAX_COLUMN_WIDTH, cellWidth));
		}
	}

	const overhead = columns.length * COLUMN_SEPARATOR_WIDTH + TABLE_FRAME_WIDTH;
	let totalWidth = widths.reduce((sum, width) => sum + width, 0) + overhead;
	// 超宽时逐列削最宽的一列，保证每列不低于下限。
	while (totalWidth > MAX_RENDER_WIDTH) {
		let widestIndex = -1;
		let widestWidth = MIN_COLUMN_WIDTH;
		for (const [index, width] of widths.entries()) {
			if (width > widestWidth) {
				widestIndex = index;
				widestWidth = width;
			}
		}
		if (widestIndex === -1) break;
		widths[widestIndex] = Math.max(MIN_COLUMN_WIDTH, (widths[widestIndex] ?? MIN_COLUMN_WIDTH) - 1);
		totalWidth = widths.reduce((sum, width) => sum + width, 0) + overhead;
	}

	const header = `| ${columns.map((column, index) => padCell(column, widths[index] ?? MIN_COLUMN_WIDTH)).join(" | ")} |`;
	const divider = `| ${widths.map(width => "-".repeat(Math.max(width, MIN_COLUMN_WIDTH))).join(" | ")} |`;
	const lines = [header, divider];

	if (rows.length === 0) {
		lines.push("(no rows)");
		return lines.map(line => truncateToWidth(line, MAX_RENDER_WIDTH)).join("\n");
	}

	for (const row of rows) {
		const cells = columns.map((column, index) =>
			padCell(stringifySqliteValue(row[column]), widths[index] ?? MIN_COLUMN_WIDTH),
		);
		lines.push(`| ${cells.join(" | ")} |`);
	}
	return lines.map(line => truncateToWidth(line, MAX_RENDER_WIDTH)).join("\n");
}

function formatRowCount(count: TableRowCount): string {
	switch (count.kind) {
		case "exact":
			return `${count.rows} rows`;
		case "estimate":
			return `~${count.rows} rows`;
		case "atLeast":
			return `${count.rows}+ rows`;
	}
}

function renderTableList(tables: readonly SqliteTableSummary[]): string {
	if (tables.length === 0) return "(no tables)";
	return tables
		.map(table => truncateToWidth(`${table.name} (${formatRowCount(table.count)})`, MAX_RENDER_WIDTH))
		.join("\n");
}

function renderSchema(
	createSql: string,
	sampleRows: { readonly columns: readonly string[]; readonly rows: readonly SqliteRow[] },
): string {
	const schemaLines = createSql.split("\n").map(line => truncateToWidth(line, MAX_RENDER_WIDTH));
	return [schemaLines.join("\n"), "", "Sample rows:", buildAsciiTable(sampleRows.columns, sampleRows.rows)].join("\n");
}

function renderRow(row: SqliteRow): string {
	const entries = Object.entries(row);
	if (entries.length === 0) return "(no columns)";
	return entries
		.map(([column, value]) => truncateToWidth(`${column}: ${stringifySqliteValue(value)}`, MAX_RENDER_WIDTH))
		.join("\n");
}

function renderTable(
	columns: readonly string[],
	rows: readonly SqliteRow[],
	meta: { readonly totalCount: number; readonly offset: number; readonly limit: number; readonly table: string },
): string {
	const parts = [buildAsciiTable(columns, rows)];
	const shown = Math.min(meta.totalCount, meta.offset + rows.length);
	if (shown < meta.totalCount) {
		const remaining = meta.totalCount - shown;
		const nextOffset = meta.offset + rows.length;
		parts.push(
			truncateToWidth(
				`[${remaining} more rows; append :${meta.table}?limit=${meta.limit}&offset=${nextOffset} to the database path to continue]`,
				MAX_RENDER_WIDTH,
			),
		);
	}
	return parts.join("\n");
}

/* -------------------------------------------------------------------------- */
/* 入口                                                                        */
/* -------------------------------------------------------------------------- */

/** 按 selector 渲染正文；`truncatedByRows` 表示行闸门（含 raw 扫描上限）触发。 */
function renderSelector(
	connection: SqliteConnection,
	selector: SqliteSelector,
	maxRows: number,
): { readonly text: string; readonly truncatedByRows: boolean } {
	switch (selector.kind) {
		case "list": {
			const tables = listTables(connection);
			const shown = tables.slice(0, maxRows);
			const omitted = tables.length - shown.length;
			const hint = omitted > 0 ? `\n[${omitted} more tables; narrow with a table selector]` : "";
			return { text: `${renderTableList(shown)}${hint}`, truncatedByRows: omitted > 0 };
		}
		case "schema": {
			const sample = queryRows(connection, selector.table, {
				limit: Math.min(selector.sampleLimit, maxRows),
				offset: 0,
			});
			let text = renderSchema(getTableSchema(connection, selector.table), sample);
			if (sample.rows.length < sample.totalCount) {
				const remaining = sample.totalCount - sample.rows.length;
				text += `\n[${remaining} more rows; append :${selector.table}?limit=20&offset=${sample.rows.length} to the database path to continue]`;
			}
			return { text, truncatedByRows: false };
		}
		case "row": {
			const lookup = resolveTableRowLookup(connection, selector.table);
			const row = lookup.kind === "pk"
				? getRowByKey(connection, selector.table, lookup, selector.key)
				: getRowByRowId(connection, selector.table, selector.key);
			const text = row === undefined
				? `No row found in table '${selector.table}' for key '${selector.key}'.`
				: renderRow(row);
			return { text, truncatedByRows: false };
		}
		case "query": {
			const page = queryRows(connection, selector.table, {
				limit: Math.min(selector.limit, maxRows),
				offset: selector.offset,
				order: selector.order,
				where: selector.where,
			});
			const text = renderTable(page.columns, page.rows, {
				totalCount: page.totalCount,
				offset: selector.offset,
				limit: selector.limit,
				table: selector.table,
			});
			return { text, truncatedByRows: false };
		}
		case "raw": {
			const result = executeReadQuery(connection, selector.sql, maxRows);
			let text = renderTable(result.columns, result.rows, {
				totalCount: result.rows.length,
				offset: 0,
				limit: result.rows.length,
				table: "query",
			});
			if (result.truncated) {
				text += `\n[Output capped at ${maxRows} rows; add a LIMIT/OFFSET clause to the query to page through more]`;
			}
			return { text, truncatedByRows: result.truncated };
		}
	}
}

/**
 * 渲染 sqlite 内容。`bytes` 是已由调用方（read 工具，经 governed fs）读入的完整文件
 * 字节；`selector` 是 `path:...` 之后的部分（可能为空串）。只读打开 + `query_only`，
 * 任何失败 throw。
 */
export function readSqliteBytes(
	bytes: Uint8Array,
	selector: string,
	options: SqliteReadOptions = {},
): SqliteReadResult {
	const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	if (!Number.isSafeInteger(maxRows) || maxRows < 1) {
		throw new Error(`SQLite row limit must be a positive integer; got '${maxRows}'`);
	}
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
		throw new Error(`SQLite byte limit must be a positive integer; got '${maxBytes}'`);
	}
	if (!looksLikeSqlite(bytes.subarray(0, SQLITE_MAGIC.byteLength))) {
		throw new Error("Not a SQLite database: missing the 'SQLite format 3' header");
	}

	const opened = openReadOnlySqliteBytes(bytes);
	try {
		const rendered = renderSelector(opened.connection, parseSqliteSelector(selector), maxRows);
		const capped = truncateHead(rendered.text, { maxLines: Number.MAX_SAFE_INTEGER, maxBytes });
		const text = capped.truncation.truncated
			? `${capped.text}\n[Output truncated at ${maxBytes} bytes; narrow the selector (?limit=/?where=) to read the rest]`
			: rendered.text;
		return { text, truncated: capped.truncation.truncated || rendered.truncatedByRows };
	} finally {
		opened.close();
	}
}
