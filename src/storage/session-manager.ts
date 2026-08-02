/**
 * SessionManager —— canonical user-home session writer。
 *
 * Session 文件只能位于 `RunledgerLayout.sessions/YYYY/MM/DD/`。cwd 只作为
 * metadata identity；它、环境变量和任意外部路径都不能再改变写入根。
 */

import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
	isContainedRuntimePath,
	isRuntimeId,
	sessionRelativeLocator,
	type RunledgerLayout,
	type RuntimePathFlavor,
} from "../runtime/contracts/public.ts";
import { createRuntimeId } from "../runtime/protocol/ids.ts";
import type { SessionId } from "../runtime/protocol/ids.ts";
import {
	isCurrentLedgerEntry,
	isCurrentLedgerHeader,
	newId,
	UnsupportedSessionFormatError,
	type LedgerHeader,
} from "../runtime/ledger/types.ts";
import { JsonlLedger } from "../runtime/ledger/jsonl-ledger.ts";
import { acquireLedgerLock } from "../runtime/ledger/lockfile.ts";

export interface SessionManagerOptions {
	readonly layout: RunledgerLayout;
	readonly cwd: string;
	/** 指定 canonical sessionId；未指定时由 Runtime ID 工厂生成。 */
	readonly sessionId?: string;
	/** header.metadata；cwd 始终由 composition root 写入，不能被覆盖。 */
	readonly metadata?: Record<string, unknown>;
}

export interface SessionInfo {
	readonly id: string;
	readonly filePath: string;
	readonly createdAt: number;
	readonly cwd?: string;
	readonly modifiedMs: number;
}

export type SessionStorageErrorCode =
	| "session_path_outside_home"
	| "session_path_symlink"
	| "invalid_session_id"
	| "session_conflict";

export class SessionStorageError extends Error {
	readonly code: SessionStorageErrorCode;
	readonly filePath: string;

	constructor(code: SessionStorageErrorCode, filePath: string) {
		super(`${code}: ${filePath}`);
		this.name = "SessionStorageError";
		this.code = code;
		this.filePath = filePath;
	}
}

export class SessionManager {
	private readonly _ledger: JsonlLedger;
	private readonly _layout: RunledgerLayout;
	private readonly _cwd: string;
	private readonly _filePath: string;
	private _releaseLock: (() => Promise<void>) | undefined;

	constructor(
		ledger: JsonlLedger,
		layout: RunledgerLayout,
		cwd: string,
		filePath: string,
	) {
		this._ledger = ledger;
		this._layout = layout;
		this._cwd = cwd;
		this._filePath = filePath;
	}

	ledger(): JsonlLedger {
		return this._ledger;
	}

	sessionId(): string {
		return this._ledger.sessionId;
	}

	filePath(): string {
		return this._filePath;
	}

	/** 兼容查询接口；返回固定 canonical sessions 根，不接受写入参数。 */
	sessionDir(): string {
		return this._layout.sessions;
	}

	cwd(): string {
		return this._cwd;
	}

	async closeAll(): Promise<void> {
		await this._ledger.close();
		const release = this._releaseLock;
		this._releaseLock = undefined;
		if (release) await release();
	}

	/** 活跃写会话持整场独占锁；重复调用幂等。 */
	async acquireLock(): Promise<void> {
		if (this._releaseLock) return;
		await assertCanonicalFile(this._layout, this._filePath);
		await this._ledger.initialize();
		this._releaseLock = await acquireLedgerLock(this._ledger);
	}

	static async create(options: SessionManagerOptions): Promise<SessionManager> {
		const sessionId = allocateSessionId(options.sessionId);
		const createdAt = new Date().toISOString();
		const filePath = canonicalSessionPath(options.layout, sessionId, createdAt);
		await ensureCanonicalParent(options.layout, filePath);
		if (existsSync(filePath)) throw new SessionStorageError("session_conflict", filePath);

		const ledger = new JsonlLedger({
			filePath,
			sessionId,
			metadata: { ...(options.metadata ?? {}), cwd: options.cwd },
		});
		await ledger.initialize();
		await hardenCanonicalFile(options.layout, filePath);
		return new SessionManager(ledger, options.layout, options.cwd, filePath);
	}

	/** 只允许打开已存在的 canonical session；根外文件必须走显式迁移。 */
	static async open(layout: RunledgerLayout, filePath: string): Promise<SessionManager> {
		const absolute = canonicalAbsolutePath(filePath);
		await assertCanonicalFile(layout, absolute);
		const ledger = new JsonlLedger({ filePath: absolute });
		await ledger.initialize();
		await hardenCanonicalFile(layout, absolute);
		const header = ledger.header();
		const headerCwd = header.metadata?.cwd;
		return new SessionManager(
			ledger,
			layout,
			typeof headerCwd === "string" ? headerCwd : "",
			absolute,
		);
	}

	static async continueRecent(
		layout: RunledgerLayout,
		cwd: string,
	): Promise<SessionManager> {
		const recent = await findMostRecentSession(layout, cwd);
		if (!recent) return SessionManager.create({ layout, cwd });
		return SessionManager.open(layout, recent);
	}

	/**
	 * 在 canonical root 内 fork；parentSession 只保存 root-relative locator，
	 * 不把用户输入的绝对路径写入 durable record。
	 */
	static async forkFrom(
		layout: RunledgerLayout,
		sourcePath: string,
		targetCwd: string,
	): Promise<SessionManager> {
		const sourceAbsolute = canonicalAbsolutePath(sourcePath);
		await assertCanonicalFile(layout, sourceAbsolute);
		const content = await fs.readFile(sourceAbsolute, "utf8");
		const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
		if (lines.length === 0) throw new UnsupportedSessionFormatError(sourceAbsolute);

		const first = JSON.parse(lines[0]!) as unknown;
		if (!isCurrentLedgerHeader(first)) throw new UnsupportedSessionFormatError(sourceAbsolute);
		const newSessionId = allocateSessionId();
		const createdAt = new Date().toISOString();
		const targetPath = canonicalSessionPath(layout, newSessionId, createdAt);
		const parentLocator = path.relative(layout.home, sourceAbsolute).split(path.sep).join("/");
		const newHeader: LedgerHeader = {
			...first,
			id: newId(),
			sessionId: newSessionId,
			createdAt: Date.now(),
			metadata: {
				...(first.metadata ?? {}),
				cwd: targetCwd,
				parentSession: parentLocator,
				parentSessionId: first.sessionId,
			},
		};
		lines[0] = JSON.stringify(newHeader);
		for (let index = 1; index < lines.length; index += 1) {
			const parsed = JSON.parse(lines[index]!) as unknown;
			if (!isCurrentLedgerEntry(parsed)) throw new UnsupportedSessionFormatError(sourceAbsolute);
			lines[index] = JSON.stringify({
				...parsed,
				sessionId: newSessionId,
				parentId: parsed.parentId === first.id ? newHeader.id : parsed.parentId,
			});
		}

		await writeAtomicCanonicalFile(layout, targetPath, lines.join("\n") + "\n");
		return SessionManager.open(layout, targetPath);
	}

	static async list(layout: RunledgerLayout, cwd: string): Promise<SessionInfo[]> {
		if (!existsSync(layout.sessions)) return [];
		await assertCanonicalDirectory(layout, layout.sessions);
		const files = await collectCanonicalSessionFiles(layout.sessions);
		const out: SessionInfo[] = [];
		for (const filePath of files) {
			try {
				const header = await readHeader(filePath);
				if (!header) continue;
				if (cwd.length > 0 && header.metadata?.cwd !== cwd) continue;
				const info = await fs.stat(filePath);
				out.push({
					id: header.sessionId,
					filePath,
					createdAt: header.createdAt,
					cwd: typeof header.metadata?.cwd === "string" ? header.metadata.cwd : undefined,
					modifiedMs: info.mtimeMs,
				});
			} catch (error) {
				process.stderr.write(
					`[runledger] session header parse failed at ${filePath}: ${String(error)}\n` +
						"  skip;继续扫余下文件\n",
				);
			}
		}
		out.sort((left, right) => right.modifiedMs - left.modifiedMs);
		return out;
	}

	static async listAll(layout: RunledgerLayout): Promise<SessionInfo[]> {
		return SessionManager.list(layout, "");
	}
}

function allocateSessionId(value?: string): string {
	const sessionId = value ?? createRuntimeId("session");
	if (!isRuntimeId(sessionId, "session")) {
		throw new SessionStorageError("invalid_session_id", sessionId);
	}
	return sessionId;
}

function canonicalSessionPath(layout: RunledgerLayout, sessionId: string, createdAt: string): string {
	const relativeLocator = sessionRelativeLocator(sessionId as SessionId, createdAt, false);
	const filePath = path.resolve(layout.home, relativeLocator);
	assertContainedLexically(layout, filePath);
	return filePath;
}

function canonicalAbsolutePath(filePath: string): string {
	if (!path.isAbsolute(filePath)) throw new SessionStorageError("session_path_outside_home", filePath);
	return path.resolve(filePath);
}

async function ensureCanonicalParent(layout: RunledgerLayout, filePath: string): Promise<void> {
	await fs.mkdir(layout.home, { recursive: true, mode: 0o700 });
	await assertCanonicalDirectory(layout, layout.home);
	await assertNoSymlinkComponents(layout, path.dirname(filePath));
	await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
	await assertCanonicalDirectory(layout, path.dirname(filePath));
}

async function assertCanonicalFile(layout: RunledgerLayout, filePath: string): Promise<void> {
	assertContainedLexically(layout, filePath);
	let info;
	try {
		info = await fs.lstat(filePath);
	} catch {
		throw new Error(`session file not found: ${filePath}`);
	}
	if (info.isSymbolicLink()) throw new SessionStorageError("session_path_symlink", filePath);
	const root = await fs.realpath(layout.home);
	const actual = await fs.realpath(filePath);
	if (!isContainedRuntimePath(root, actual, runtimePathFlavor())) {
		throw new SessionStorageError("session_path_outside_home", filePath);
	}
}

async function hardenCanonicalFile(layout: RunledgerLayout, filePath: string): Promise<void> {
	await assertCanonicalFile(layout, filePath);
	await fs.chmod(filePath, 0o600);
}

async function assertCanonicalDirectory(layout: RunledgerLayout, directory: string): Promise<void> {
	assertContainedLexically(layout, directory);
	let info;
	try {
		info = await fs.lstat(directory);
	} catch {
		throw new SessionStorageError("session_path_outside_home", directory);
	}
	if (info.isSymbolicLink()) throw new SessionStorageError("session_path_symlink", directory);
	const root = await fs.realpath(layout.home);
	const actual = await fs.realpath(directory);
	if (!isContainedRuntimePath(root, actual, runtimePathFlavor())) {
		throw new SessionStorageError("session_path_outside_home", directory);
	}
}

async function assertNoSymlinkComponents(layout: RunledgerLayout, target: string): Promise<void> {
	assertContainedLexically(layout, target);
	const relativeTarget = path.relative(layout.home, target);
	let current = layout.home;
	for (const segment of relativeTarget.split(path.sep).filter((value) => value.length > 0)) {
		current = path.join(current, segment);
		try {
			const info = await fs.lstat(current);
			if (info.isSymbolicLink()) throw new SessionStorageError("session_path_symlink", current);
		} catch (error) {
			if (error instanceof SessionStorageError) throw error;
			break;
		}
	}
}

function assertContainedLexically(layout: RunledgerLayout, target: string): void {
	if (!isContainedRuntimePath(layout.home, target, runtimePathFlavor())) {
		throw new SessionStorageError("session_path_outside_home", target);
	}
}

function runtimePathFlavor(): RuntimePathFlavor {
	return process.platform === "win32" ? "win32" : "posix";
}

async function writeAtomicCanonicalFile(
	layout: RunledgerLayout,
	targetPath: string,
	content: string,
): Promise<void> {
	await ensureCanonicalParent(layout, targetPath);
	if (existsSync(targetPath)) throw new SessionStorageError("session_conflict", targetPath);
	const temporaryPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.tmp-${newId()}`);
	assertContainedLexically(layout, temporaryPath);
	await fs.writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
	try {
		await hardenCanonicalFile(layout, temporaryPath);
		await fs.rename(temporaryPath, targetPath);
		await hardenCanonicalFile(layout, targetPath);
	} catch (error) {
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function collectCanonicalSessionFiles(root: string): Promise<string[]> {
	const out: string[] = [];
	async function visit(directory: string): Promise<void> {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isSymbolicLink()) continue;
			const entryPath = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				await visit(entryPath);
				continue;
			}
			if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(entryPath);
		}
	}
	await visit(root);
	return out;
}

async function findMostRecentSession(layout: RunledgerLayout, cwd: string): Promise<string | undefined> {
	const sessions = await SessionManager.list(layout, cwd);
	return sessions[0]?.filePath;
}

async function readHeader(filePath: string): Promise<LedgerHeader | undefined> {
	let content: string;
	try {
		content = await fs.readFile(filePath, "utf8");
	} catch {
		return undefined;
	}
	const newlineIndex = content.indexOf("\n");
	const firstLine = (newlineIndex === -1 ? content : content.slice(0, newlineIndex)).trim();
	if (firstLine.length === 0) return undefined;
	try {
		const parsed = JSON.parse(firstLine) as unknown;
		return isCurrentLedgerHeader(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}
