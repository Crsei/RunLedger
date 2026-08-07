/**
 * R2:JSONL → SQLite 显式一次性迁移(06 §12.2)。
 *
 * 流程固定:
 *   preflight(无 active legacy writer + offline admission gate)
 *   → 枚举 canonical JSONL → 冻结 source digest/archive manifest
 *   → 单个事务导入 → 全量 verify → mark committed
 *   → 原子 rename 到 migration-backup/session-store/<manifestDigest>/
 *   → 验证 archive digest 与 target reopen
 *
 * 硬规则:
 *   - 任一步失败:source 保持原位,target 不标记完成,gate 恢复 ready;
 *   - 迁移前必须证明无 active legacy writer,否则返回 legacy_host_active,
 *     不自动 kill、删 endpoint 或抢锁;
 *   - 新 Runtime 永不读取 archive;物理删除只能由
 *     `runledger storage prune-legacy --manifest <digest> --confirm-delete` 显式执行;
 *   - 不提供 background auto migration、legacy reader、dual write 或 fallback;
 *   - 不读取旧格式、不猜测损坏记录、不跨 RunledgerLayout root、不复制
 *     auth/credential secret 到 event payload。
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join, relative, sep, win32 } from "node:path";
import lockfile from "proper-lockfile";
import { canonicalDigest } from "../../runtime/protocol/canonical-json.ts";
import { runtimeDigest } from "../../runtime/protocol/foundation.ts";
import { createRuntimeId, type SessionId } from "../../runtime/protocol/ids.ts";
import { isCurrentLedgerEntry, isCurrentLedgerHeader } from "../../runtime/ledger/types.ts";
import type { RunledgerLayout } from "../../runtime/contracts/public.ts";
import type { SessionDatabase } from "./database.ts";
import { sessionEventHash } from "./session-store.ts";
import { beginOfflineMigration, type MigrationGateHandle } from "./schema-compatibility.ts";
import { SESSION_STORE_SCHEMA_VERSION } from "./schema.ts";

export const JSONL_MIGRATION_MANIFEST_VERSION = 1 as const;

export type JsonlMigrationErrorCode =
	| "confirm_archive_required"
	| "legacy_host_active"
	| "unsupported_session_format"
	| "source_read_failed"
	| "import_failed"
	| "verify_failed"
	| "archive_failed"
	| "store_incompatible"
	| "invalid_source";

export class JsonlMigrationError extends Error {
	public readonly code: JsonlMigrationErrorCode;
	public constructor(code: JsonlMigrationErrorCode, message: string) {
		super(message);
		this.name = "JsonlMigrationError";
		this.code = code;
	}
}

export interface JsonlSourceFileRecord {
	readonly relativeLocator: string;
	readonly sha256: string;
	readonly headerDigest: string;
	readonly sessionId: string;
	readonly entryCount: number;
	readonly createdAtMs: number;
	readonly fileMode: number;
	readonly lines: readonly string[];
	readonly workspaceId: string;
	readonly repositoryId: string;
}

export interface JsonlMigrationManifest {
	readonly manifestVersion: typeof JSONL_MIGRATION_MANIFEST_VERSION;
	readonly createdAtMs: number;
	readonly sourceRoot: string;
	readonly files: readonly Omit<JsonlSourceFileRecord, "lines">[];
	readonly sessionsCount: number;
	readonly totalEntries: number;
	readonly storeSchemaDigest: string;
	readonly manifestDigest: string;
	readonly verified: boolean;
}

export interface JsonlMigrationResult {
	readonly manifest: JsonlMigrationManifest;
	readonly archiveDir: string;
	readonly importedSessions: number;
	readonly importedEntries: number;
}

export interface MigrateJsonlOptions {
	readonly layout: RunledgerLayout;
	readonly db: SessionDatabase;
	readonly confirmArchive: boolean;
	/** 未提供时按 header metadata.cwd 确定性派生(与 Host identity 规则一致)。 */
	readonly workspaceId?: string;
	readonly repositoryId?: string;
}

function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function assertInsideHome(layout: RunledgerLayout, target: string): void {
	const relativeTarget = relative(layout.home, target);
	if (relativeTarget.startsWith(`..${sep}`) || relativeTarget === "..") {
		throw new JsonlMigrationError("invalid_source", `path escapes runledger home: ${target}`);
	}
}

/** 枚举 canonical JSONL:只接受 current-format 文件,任一格式错误立即失败,不跳过、不猜测。 */
export async function enumerateCanonicalJsonl(layout: RunledgerLayout): Promise<JsonlSourceFileRecord[]> {
	const records: JsonlSourceFileRecord[] = [];
	const sessionRoot = layout.sessions;
	let entries;
	try {
		entries = await fs.readdir(sessionRoot, { withFileTypes: true });
	} catch {
		return [];
	}
	async function visit(directory: string): Promise<void> {
		let children;
		try {
			children = await fs.readdir(directory, { withFileTypes: true });
		} catch (error) {
			throw new JsonlMigrationError("source_read_failed", `cannot read ${directory}: ${String(error)}`);
		}
		for (const child of children) {
			if (child.isSymbolicLink()) {
				throw new JsonlMigrationError("invalid_source", `symlink in canonical session root: ${join(directory, child.name)}`);
			}
			const childPath = join(directory, child.name);
			if (child.isDirectory()) {
				await visit(childPath);
				continue;
			}
			if (!child.isFile() || !child.name.endsWith(".jsonl")) continue;
			assertInsideHome(layout, childPath);
			const content = await fs.readFile(childPath, "utf8");
			const stat = await fs.stat(childPath);
			// Windows 无 POSIX mode 语义,chmod 位恒为 0666;mode 保护由 platform-capability 单独声明。
			if (!win32.isAbsolute(childPath) && (stat.mode & 0o077) !== 0) {
				throw new JsonlMigrationError("invalid_source", `legacy session file mode is wider than 0600: ${childPath}`);
			}
			const lines = content.split(/\r?\n/).filter((line) => line.length > 0);
			if (lines.length === 0) throw new JsonlMigrationError("unsupported_session_format", `empty session file: ${childPath}`);
			const header = JSON.parse(lines[0]!) as unknown;
			if (!isCurrentLedgerHeader(header)) {
				throw new JsonlMigrationError("unsupported_session_format", `unsupported header: ${childPath}`);
			}
			for (let index = 1; index < lines.length; index += 1) {
				const parsed = JSON.parse(lines[index]!) as unknown;
				if (!isCurrentLedgerEntry(parsed)) {
					throw new JsonlMigrationError("unsupported_session_format", `unsupported entry at line ${index + 1}: ${childPath}`);
				}
			}
			const cwd = typeof header.metadata?.cwd === "string" ? header.metadata.cwd : "";
			records.push({
				relativeLocator: relative(layout.home, childPath).split(sep).join("/"),
				sha256: sha256Hex(content),
				headerDigest: sha256Hex(JSON.stringify(header)),
				sessionId: header.sessionId,
				entryCount: lines.length - 1,
				createdAtMs: header.createdAt,
				fileMode: stat.mode & 0o777,
				lines,
				workspaceId: createRuntimeId("workspace", runtimeDigest({ home: layout.home, cwd }).digest.slice(0, 32)),
				repositoryId: createRuntimeId("repository", runtimeDigest({ cwd }).digest.slice(0, 32)),
			});
		}
	}
	await visit(sessionRoot);
	records.sort((left, right) => left.relativeLocator.localeCompare(right.relativeLocator));
	return records;
}

/** 证明无 active legacy Host/writer:对每个 source 文件尝试 proper-lockfile 独占锁。 */
export async function proveNoActiveLegacyWriter(layout: RunledgerLayout, files: readonly JsonlSourceFileRecord[]): Promise<() => Promise<void>> {
	const releases: Array<() => Promise<void>> = [];
	try {
		for (const file of files) {
			try {
				const release = await lockfile.lock(join(layout.home, file.relativeLocator), {
					retries: 0,
					stale: 20_000,
					lockfilePath: join(layout.home, file.relativeLocator) + ".lock",
				});
				releases.push(release);
			} catch (error) {
				throw new JsonlMigrationError(
					"legacy_host_active",
					`active legacy writer holds ${file.relativeLocator}: ${String(error)}`,
				);
			}
		}
	} catch (error) {
		for (const release of releases.reverse()) {
			await release().catch(() => undefined);
		}
		throw error;
	}
	return async () => {
		for (const release of releases.reverse()) {
			await release().catch(() => undefined);
		}
	};
}

function buildManifest(
	files: readonly JsonlSourceFileRecord[],
	storeSchemaDigest: string,
): JsonlMigrationManifest {
	const manifestBase = {
		manifestVersion: JSONL_MIGRATION_MANIFEST_VERSION,
		createdAtMs: Date.now(),
		sourceRoot: "sessions",
		files: files.map(({ lines: _ignored, ...record }) => record),
		sessionsCount: files.length,
		totalEntries: files.reduce((sum, file) => sum + file.entryCount, 0),
		storeSchemaDigest,
		verified: true,
	} as const;
	const manifestDigest = canonicalDigest({
		manifestVersion: manifestBase.manifestVersion,
		createdAtMs: manifestBase.createdAtMs,
		sourceRoot: manifestBase.sourceRoot,
		files: manifestBase.files.map(({ relativeLocator, sha256, headerDigest, sessionId, entryCount }) => ({
			relativeLocator,
			sha256,
			headerDigest,
			sessionId,
			entryCount,
		})),
	});
	return { ...manifestBase, manifestDigest } as JsonlMigrationManifest;
}

export interface HeldMigrationGate {
	readonly gate: MigrationGateHandle;
	readonly release: () => void;
}

/**
 * 执行一次显式迁移。调用方负责持有 offline gate(admission=migration_blocked);
 * 任何失败都保持 source 原位、target 不标记完成,gate 由调用方决定 abort。
 */
export async function migrateJsonlSessions(options: MigrateJsonlOptions, gate: MigrationGateHandle): Promise<JsonlMigrationResult> {
	if (!options.confirmArchive) {
		throw new JsonlMigrationError("confirm_archive_required", "migrate session-store requires explicit --confirm-archive");
	}
	const files = await enumerateCanonicalJsonl(options.layout);
	const releaseLegacyLocks = await proveNoActiveLegacyWriter(options.layout, files);
	try {
		const manifest = buildManifest(files, sha256Hex(SESSION_STORE_SCHEMA_VERSION.toString()));
		const archiveDir = join(options.layout.migrationBackups, "session-store", manifest.manifestDigest);

		// 导入:单个事务,任何失败整体回滚,source 保持原位。
		importJsonlIntoSqlite(options, files);

		// 全量 verify:counts + hash chain + archive 未写入前 target 必须可重放。
		verifyImport(options.db, manifest);

		// mark committed:先写 manifest 到 archive 目录。
		await fs.mkdir(archiveDir, { recursive: true, mode: 0o700 });
		await fs.writeFile(join(archiveDir, "manifest.json"), JSON.stringify(manifest, null, 2), { mode: 0o600 });

		// 原子归档:同文件系统 rename,保留 root-relative 结构。
		for (const file of files) {
			const sourcePath = join(options.layout.home, file.relativeLocator);
			const targetPath = join(archiveDir, file.relativeLocator);
			await fs.mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
			await fs.rename(sourcePath, targetPath);
			await fs.chmod(targetPath, 0o600);
		}

		// 验证 archive digest 与 target reopen。
		for (const file of files) {
			const archived = await fs.readFile(join(archiveDir, file.relativeLocator), "utf8");
			if (sha256Hex(archived) !== file.sha256) {
				throw new JsonlMigrationError("archive_failed", `archive digest mismatch: ${file.relativeLocator}`);
			}
		}
		verifyImport(options.db, manifest);

		return {
			manifest,
			archiveDir,
			importedSessions: manifest.sessionsCount,
			importedEntries: manifest.totalEntries,
		};
	} finally {
		await releaseLegacyLocks().catch(() => undefined);
	}
}

function importJsonlIntoSqlite(options: MigrateJsonlOptions, files: readonly JsonlSourceFileRecord[]): void {
	try {
		options.db.withImmediateTransactionSync((tx) => {
			for (const file of files) {
				const now = Date.now();
				tx.runSync(
					`INSERT INTO sessions
					 (session_id, workspace_id, repository_id, status, created_at_ms, updated_at_ms,
					  head_sequence, current_checkpoint_id, last_driver_client_id, driver_revision,
					  worktree_locator_json, settings_digest)
					 VALUES (?, ?, ?, 'active', ?, ?, 0, NULL, NULL, 0, NULL, ?)`,
					[
						file.sessionId,
						options.workspaceId ?? file.workspaceId,
						options.repositoryId ?? file.repositoryId,
						file.createdAtMs,
						now,
						file.headerDigest,
					],
				);
				let previous: string | null = null;
				for (let index = 0; index < file.entryCount; index += 1) {
					const raw = file.lines[index + 1]!;
					const entry = JSON.parse(raw) as Record<string, unknown>;
					const sequence = index + 1;
					const currentHash = sessionEventHash(file.sessionId, sequence, String(entry.id), String(entry.type), raw, previous);
					tx.runSync(
						`INSERT INTO session_events
						 (session_id, sequence, event_id, owner_generation, event_type, payload_json,
						  previous_event_hash, current_event_hash, created_at_ms)
						 VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?)`,
						[
							file.sessionId,
							sequence,
							String(entry.id),
							String(entry.type),
							raw,
							previous,
							currentHash,
							typeof entry.timestamp === "number" ? entry.timestamp : now,
						],
					);
					previous = currentHash;
				}
				tx.runSync("UPDATE sessions SET head_sequence = ?, updated_at_ms = ? WHERE session_id = ?", [
					file.entryCount,
					now,
					file.sessionId,
				]);
			}
		});
	} catch (error) {
		if (error instanceof JsonlMigrationError) throw error;
		throw new JsonlMigrationError("import_failed", `import failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function verifyImport(db: SessionDatabase, manifest: JsonlMigrationManifest): void {
	try {
		const sessionsRow = db.querySingle("SELECT COUNT(*) AS n FROM sessions");
		if (Number(sessionsRow?.n) !== manifest.sessionsCount) {
			throw new JsonlMigrationError("verify_failed", "imported session count does not match the manifest");
		}
		const eventsRow = db.querySingle("SELECT COUNT(*) AS n FROM session_events");
		if (Number(eventsRow?.n) !== manifest.totalEntries) {
			throw new JsonlMigrationError("verify_failed", "imported event count does not match the manifest");
		}
		for (const file of manifest.files) {
			const events = db.queryAll(
				"SELECT sequence, event_id, event_type, payload_json, previous_event_hash, current_event_hash FROM session_events WHERE session_id = ? ORDER BY sequence",
				[file.sessionId],
			);
			if (events.length !== file.entryCount) {
				throw new JsonlMigrationError("verify_failed", `entry count mismatch for ${file.sessionId}`);
			}
			let previous: string | null = null;
			for (const row of events) {
				const storedPrevious = row.previous_event_hash === null ? null : String(row.previous_event_hash);
				const expected = sessionEventHash(
					file.sessionId,
					Number(row.sequence),
					String(row.event_id),
					String(row.event_type),
					String(row.payload_json),
					previous,
				);
				if (expected !== String(row.current_event_hash) || storedPrevious !== previous) {
					throw new JsonlMigrationError("verify_failed", `hash chain mismatch for ${file.sessionId}@${String(row.sequence)}`);
				}
				previous = String(row.current_event_hash);
			}
		}
	} catch (error) {
		if (error instanceof JsonlMigrationError) throw error;
		throw new JsonlMigrationError("verify_failed", `verification failed: ${String(error)}`);
	}
}

export interface PruneLegacyOptions {
	readonly layout: RunledgerLayout;
	readonly manifestDigest: string;
	readonly confirmDelete: boolean;
}

export interface PruneLegacyResult {
	readonly archiveDir: string;
	readonly removedFiles: number;
}

/** 显式物理删除 archive;manifest 缺失/未 verified/文件不完整时 fail closed。 */
export async function pruneLegacyArchive(options: PruneLegacyOptions): Promise<PruneLegacyResult> {
	if (!options.confirmDelete) {
		throw new JsonlMigrationError("confirm_archive_required", "storage prune-legacy requires explicit --confirm-delete");
	}
	if (!/^[a-f0-9]{64}$/u.test(options.manifestDigest)) {
		throw new JsonlMigrationError("invalid_source", "manifest digest must be a sha256 hex digest");
	}
	const archiveDir = join(options.layout.migrationBackups, "session-store", options.manifestDigest);
	assertInsideHome(options.layout, archiveDir);
	let manifest: JsonlMigrationManifest;
	try {
		manifest = JSON.parse(await fs.readFile(join(archiveDir, "manifest.json"), "utf8")) as JsonlMigrationManifest;
	} catch (error) {
		throw new JsonlMigrationError("source_read_failed", `archive manifest not found or unreadable: ${options.manifestDigest}`);
	}
	if (manifest.manifestDigest !== options.manifestDigest || manifest.verified !== true) {
		throw new JsonlMigrationError("verify_failed", "archive manifest is not verified or digest mismatch");
	}
	for (const file of manifest.files) {
		const archivedPath = join(archiveDir, file.relativeLocator);
		assertInsideHome(options.layout, archivedPath);
		let content: string;
		try {
			content = await fs.readFile(archivedPath, "utf8");
		} catch {
			throw new JsonlMigrationError("verify_failed", `archived file missing: ${file.relativeLocator}`);
		}
		if (sha256Hex(content) !== file.sha256) {
			throw new JsonlMigrationError("verify_failed", `archived file digest mismatch: ${file.relativeLocator}`);
		}
	}
	await fs.rm(archiveDir, { recursive: true, force: false });
	return { archiveDir, removedFiles: manifest.files.length };
}
