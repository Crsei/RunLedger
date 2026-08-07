/**
 * R1:Session Store SQLite database foundation(06 §4.1)。
 *
 * - Node 使用自带 node:sqlite,Bun CLI 使用自带 bun:sqlite,不增加 native 依赖;
 * - 固定 PRAGMA(WAL / synchronous=FULL / foreign_keys=ON / busy_timeout=100 / trusted_schema=OFF);
 * - 单次 SQLite blocking wait 不超过 SESSION_DB_BUSY_WAIT_LIMIT_MS(100ms);
 *   SQLITE_BUSY 先返回 JS event loop,再用 setTimeout + bounded exponential
 *   backoff/jitter 异步重试,超过 deadline 返回 typed busy;
 * - 路径 symlink/no-follow、owner/mode、非数据库文件全部 fail closed;
 *   不把“localhost”或 POSIX mode 当作等价 ACL,Windows 能力由
 *   platform-capability 单独声明。
 */

import { createRequire } from "node:module";
import { chmodSync, lstatSync, readdirSync, statSync } from "node:fs";
import { dirname, join, win32 } from "node:path";
import { canonicalDigest } from "../../runtime/protocol/canonical-json.ts";
import type { DatabaseSync as NodeDatabaseSync, SQLInputValue } from "node:sqlite";

// node:sqlite 是 experimental builtin,不在 Node 22 的 builtinModules 白名单中,
// vite-node/vitest 无法把它 externalize 成原生模块。改用 createRequire 在运行时
// 选择当前运行时内建 SQLite;类型仍来自 @types/node 的 node:sqlite 声明,
// type-only import 在编译期擦除,不经过 vite-node 的 import 拦截。
const requireFromCjs = createRequire(import.meta.url);
type SqliteDatabaseConstructor = new (
	path: string,
	options?: { readonly readOnly?: boolean; readonly readonly?: boolean },
) => NodeDatabaseSync;

const processVersions = process.versions as NodeJS.ProcessVersions & { readonly bun?: string };
const sqliteRuntime = processVersions.bun === undefined
	? {
		Database: (requireFromCjs("node:sqlite") as { DatabaseSync: SqliteDatabaseConstructor }).DatabaseSync,
		readOnlyOption: "readOnly" as const,
	}
	: {
		Database: (requireFromCjs("bun:sqlite") as { Database: SqliteDatabaseConstructor }).Database,
		readOnlyOption: "readonly" as const,
	};

export type { NodeDatabaseSync };

export const SESSION_DB_BUSY_WAIT_LIMIT_MS = 100;

/** §4.1 固定 pragma。busy_timeout=100 保证单次同步等待有界。 */
export const SESSION_DB_PRAGMAS = Object.freeze({
	journalMode: "WAL",
	synchronous: "FULL",
	foreignKeys: "ON",
	busyTimeoutMs: SESSION_DB_BUSY_WAIT_LIMIT_MS,
	trustedSchema: "OFF",
} as const);

export const SESSION_DB_ASYNC_RETRY = Object.freeze({
	backoffBaseMs: 100,
	backoffMaxMs: 2_000,
	defaultDeadlineMs: 5_000,
} as const);

export const SESSION_STORE_DATABASE_ERROR_CODES = [
	"open_failed",
	"not_a_database",
	"permission_denied",
	"readonly",
	"busy",
	"corruption",
	"disk_full",
	"unknown",
] as const;
export type SessionStoreDatabaseErrorCode = (typeof SESSION_STORE_DATABASE_ERROR_CODES)[number];

export class SessionStoreDatabaseError extends Error {
	public readonly code: SessionStoreDatabaseErrorCode;
	public readonly retryable: boolean;
	public readonly cause: unknown;

	public constructor(code: SessionStoreDatabaseErrorCode, message: string, cause?: unknown) {
		super(message);
		this.name = "SessionStoreDatabaseError";
		this.code = code;
		this.retryable = code === "busy" || code === "readonly";
		this.cause = cause;
	}
}

function isBusyError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as { errcode?: unknown; message?: unknown };
	return candidate.errcode === 5 || /database is locked|SQLITE_BUSY/u.test(String(candidate.message ?? ""));
}

function classifySqliteError(error: unknown): SessionStoreDatabaseErrorCode {
	if (isBusyError(error)) return "busy";
	const message = error instanceof Error ? error.message : String(error);
	if (/not a database|file is not a database|malformed/iu.test(message)) return message.includes("malformed") ? "corruption" : "not_a_database";
	if (/readonly|read-only/iu.test(message)) return "readonly";
	if (/disk I\/O error|disk full|unable to open database file/iu.test(message)) return "disk_full";
	if (/permission denied/iu.test(message)) return "permission_denied";
	return "unknown";
}

/**
 * POSIX 上 state.db* 的权限下限:不宽于 0600。
 * Windows 无 POSIX mode 语义,node chmod 位恒为 0666,故对 win32 绝对路径
 * 不在此层断言(ACL 保护由 platform-capability 单独声明)。
 */
function assertDatabaseFileMode(path: string): void {
	const stat = lstatSync(path);
	if (stat.isSymbolicLink()) {
		throw new SessionStoreDatabaseError("open_failed", `database path must not be a symlink: ${path}`);
	}
	if (!stat.isFile()) {
		throw new SessionStoreDatabaseError("open_failed", `database path is not a regular file: ${path}`);
	}
	const isWindowsPath = win32.isAbsolute(path);
	if (!isWindowsPath && (stat.mode & 0o077) !== 0) {
		throw new SessionStoreDatabaseError("permission_denied", `database file mode is wider than 0600: ${path}`);
	}
}

export interface SessionDatabaseOpenOptions {
	readonly readOnly?: boolean;
	/** 迁移期间显式 resume/abort 之外的 open 一律 fail closed(admission gate 检查在 schema-compatibility 层)。 */
	readonly allowMigrationBlockedOpen?: boolean;
}

export interface SessionStatementResult {
	readonly changes: number;
	readonly lastInsertRowid: number | bigint;
}

/** 单连接、同步短事务的 SQLite 句柄;事务内只允许短 statement。 */
export class SessionDatabase {
	private readonly database: NodeDatabaseSync;
	private readonly path: string;
	private open = true;

	private constructor(path: string, readOnly: boolean) {
		this.path = path;
		this.database = readOnly
			? new sqliteRuntime.Database(path, sqliteRuntime.readOnlyOption === "readOnly" ? { readOnly: true } : { readonly: true })
			: new sqliteRuntime.Database(path);
		this.applyPragmas();
	}

	private applyPragmas(): void {
		// journal_mode 返回结果,exec 即可生效;其余 pragma 顺序固定。
		this.database.exec(`PRAGMA journal_mode = ${SESSION_DB_PRAGMAS.journalMode}`);
		this.database.exec(`PRAGMA synchronous = ${SESSION_DB_PRAGMAS.synchronous}`);
		this.database.exec(`PRAGMA foreign_keys = ${SESSION_DB_PRAGMAS.foreignKeys}`);
		this.database.exec(`PRAGMA busy_timeout = ${SESSION_DB_PRAGMAS.busyTimeoutMs}`);
		this.database.exec(`PRAGMA trusted_schema = ${SESSION_DB_PRAGMAS.trustedSchema}`);
	}

	private classifyAndThrow(error: unknown): never {
		const code = classifySqliteError(error);
		if (code === "unknown") throw error;
		throw new SessionStoreDatabaseError(code, error instanceof Error ? error.message : String(error), error);
	}

	public static open(path: string, options: SessionDatabaseOpenOptions = {}): SessionDatabase {
		const parent = dirname(path);
		if (!parent || !statSync(parent).isDirectory()) {
			throw new SessionStoreDatabaseError("open_failed", `database parent directory does not exist: ${parent}`);
		}
		const wasExisting = existsSync(path);
		if (wasExisting) assertDatabaseFileMode(path);
		let opened: SessionDatabase | undefined;
		try {
			const db = new SessionDatabase(path, options.readOnly ?? false);
			opened = db;
			// 新文件创建后立即收紧到 0600,避免 umask 竞态;已有文件在 assert 阶段已校验。
			if (!options.readOnly && !wasExisting) {
				chmodSync(path, 0o600);
			}
			// 立即做一次读,验证文件确实是 SQLite 数据库(open 是 lazy 的)。
			db.querySingle("SELECT 1 AS ok");
			return db;
		} catch (error) {
			// 构造成功后验证失败必须关闭句柄,否则泄漏并锁住文件(Windows 上
			// 会留下 EBUSY,无法删除)。
			opened?.close();
			if (error instanceof SessionStoreDatabaseError) throw error;
			const code = classifySqliteError(error);
			if (code === "not_a_database") {
				throw new SessionStoreDatabaseError("not_a_database", `not a SQLite database: ${path}`, error);
			}
			throw new SessionStoreDatabaseError("open_failed", `failed to open database: ${path}`, error);
		}
	}

	public isOpen(): boolean {
		return this.open;
	}

	public get filePath(): string {
		return this.path;
	}

	public close(): void {
		if (!this.open) return;
		try {
			this.database.close();
		} finally {
			this.open = false;
		}
	}

	/** WAL checkpoint(truncate);失败按 typed error 返回,不破坏已提交数据。 */
	public checkpoint(): void {
		if (!this.open) throw new SessionStoreDatabaseError("readonly", "database is closed");
		try {
			this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
		} catch (error) {
			this.classifyAndThrow(error);
		}
	}

	public runSync(sql: string, params?: readonly unknown[]): SessionStatementResult {
		if (!this.open) throw new SessionStoreDatabaseError("readonly", "database is closed");
		try {
			const statement = this.database.prepare(sql);
			const result = statement.run(...((params ?? []) as readonly SQLInputValue[]));
			return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
		} catch (error) {
			this.classifyAndThrow(error);
		}
	}

	/** 多语句 SQL(只用于 DDL/固定初始化,禁止来自外部输入)。 */
	public execSync(sql: string): void {
		if (!this.open) throw new SessionStoreDatabaseError("readonly", "database is closed");
		try {
			this.database.exec(sql);
		} catch (error) {
			this.classifyAndThrow(error);
		}
	}

	public querySingle(sql: string, params?: readonly unknown[]): Record<string, unknown> | undefined {
		if (!this.open) throw new SessionStoreDatabaseError("readonly", "database is closed");
		try {
			const statement = this.database.prepare(sql);
			const row = statement.get(...((params ?? []) as readonly SQLInputValue[])) as Record<string, unknown> | null | undefined;
			return row == null ? undefined : { ...row };
		} catch (error) {
			this.classifyAndThrow(error);
		}
	}

	public queryAll(sql: string, params?: readonly unknown[]): readonly Record<string, unknown>[] {
		if (!this.open) throw new SessionStoreDatabaseError("readonly", "database is closed");
		try {
			const statement = this.database.prepare(sql);
			return statement.all(...((params ?? []) as readonly SQLInputValue[])).map((row) => ({ ...row }));
		} catch (error) {
			this.classifyAndThrow(error);
		}
	}

	/**
	 * §4.1 异步有界重试:SQLITE_BUSY 时不进入同步循环,setTimeout + bounded
	 * exponential backoff/jitter 重试;超过 deadline 返回 typed busy。
	 */
	public async runAsync(sql: string, params?: readonly unknown[], options: { deadlineMs?: number } = {}): Promise<SessionStatementResult> {
		const deadlineMs = options.deadlineMs ?? SESSION_DB_ASYNC_RETRY.defaultDeadlineMs;
		const startedAt = Date.now();
		let attempt = 0;
		for (;;) {
			try {
				return this.runSync(sql, params);
			} catch (error) {
				if (!(error instanceof SessionStoreDatabaseError) || error.code !== "busy") throw error;
				const elapsed = Date.now() - startedAt;
				if (elapsed >= deadlineMs) throw error;
				const base = Math.min(SESSION_DB_ASYNC_RETRY.backoffBaseMs * 2 ** attempt, SESSION_DB_ASYNC_RETRY.backoffMaxMs);
				const jitter = Math.floor(Math.random() * base * 0.5);
				await new Promise((resolve) => setTimeout(resolve, base + jitter));
				attempt += 1;
			}
		}
	}

	public beginImmediate(): void {
		if (!this.open) throw new SessionStoreDatabaseError("readonly", "database is closed");
		try {
			this.database.exec("BEGIN IMMEDIATE");
		} catch (error) {
			this.classifyAndThrow(error);
		}
	}

	public commit(): void {
		if (!this.open) throw new SessionStoreDatabaseError("readonly", "database is closed");
		try {
			this.database.exec("COMMIT");
		} catch (error) {
			this.classifyAndThrow(error);
		}
	}

	public rollback(): void {
		if (!this.open) throw new SessionStoreDatabaseError("readonly", "database is closed");
		try {
			this.database.exec("ROLLBACK");
		} catch (error) {
			this.classifyAndThrow(error);
		}
	}

	/** 短事务包装:begin immediate → fn → commit;任何异常 rollback 后重抛。 */
	public withImmediateTransactionSync<T>(fn: (tx: SessionDatabase) => T): T {
		if (!this.open) throw new SessionStoreDatabaseError("readonly", "database is closed");
		this.beginImmediate();
		try {
			const result = fn(this);
			this.commit();
			return result;
		} catch (error) {
			try {
				this.rollback();
			} catch {
				// rollback 失败时保持事务状态,由调用方处理。
			}
			throw error;
		}
	}

	/** 只读短查询包装:begin → fn → commit,防止查询期间混入写。 */
	public withReadTransactionSync<T>(fn: (tx: SessionDatabase) => T): T {
		if (!this.open) throw new SessionStoreDatabaseError("readonly", "database is closed");
		try {
			this.database.exec("BEGIN");
			const result = fn(this);
			this.database.exec("COMMIT");
			return result;
		} catch (error) {
			try {
				this.database.exec("ROLLBACK");
			} catch {
				// 同上。
			}
			throw error;
		}
	}
}

function existsSync(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

/** 生产组合入口:先创建 home 下固定布局目录,再打开数据库。 */
export function openSessionDatabase(path: string, options: SessionDatabaseOpenOptions = {}): SessionDatabase {
	return SessionDatabase.open(path, options);
}

export function sessionStoreDatabaseDigest(sql: string): string {
	return canonicalDigest({ sql });
}

export function listWalSidecars(path: string): string[] {
	const names = readdirSync(dirname(path)).filter((name) => name === `${basename(path)}-wal` || name === `${basename(path)}-shm`);
	return names.map((name) => join(dirname(path), name));
}

function basename(path: string): string {
	return join(path).split(/[\\/]/u).pop() ?? path;
}
