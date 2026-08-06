/**
 * R2 CLI:`runledger migrate session-store --confirm-archive` 与
 * `runledger storage prune-legacy --manifest <digest> --confirm-delete`。
 *
 * - migrate 只读取现行 canonical JSONL,固定 source digest manifest,导入、
 *   全量 verify 后原子归档;任一步失败 source 保持原位;
 * - 迁移前证明无 active legacy Host/writer,否则返回 legacy_host_active;
 * - 新 Runtime 永不读取 archive;物理删除只经 prune-legacy 显式执行;
 * - 不提供 background auto migration、legacy reader、dual write 或 fallback。
 */

import { resolveRunledgerHome } from "../storage/runledger-home.ts";
import { validateLegacyCliEnvironment } from "./authority.ts";
import { openSessionDatabase } from "../storage/session-store/database.ts";
import { installSessionStoreSchema, sessionStoreSchemaFormatDigest } from "../storage/session-store/schema.ts";
import { checkStoreCompatibility, beginOfflineMigration } from "../storage/session-store/schema-compatibility.ts";
import { JsonlMigrationError, migrateJsonlSessions, pruneLegacyArchive } from "../storage/session-store/jsonl-migration.ts";

const SESSION_STORE_MIGRATE_USAGE = `Usage: runledger migrate session-store --confirm-archive [--workspace-id <id>] [--repository-id <id>]

Import the current-format canonical JSONL sessions into <runledgerHome>/state.db,
then atomically archive the verified source under migration-backup/session-store/.
The source is only archived, never physically deleted. New Runtime never reads the archive.
`;

const PRUNE_LEGACY_USAGE = `Usage: runledger storage prune-legacy --manifest <digest> --confirm-delete

Physically delete the verified migration archive migration-backup/session-store/<digest>.
Requires the exact manifest digest and explicit confirmation.
`;

export interface SessionStoreMigrateArgs {
	readonly confirmArchive: boolean;
	readonly workspaceId?: string;
	readonly repositoryId?: string;
}

export function parseSessionStoreMigrateArgs(argv: readonly string[]): { args?: SessionStoreMigrateArgs; error?: string } {
	let confirmArchive = false;
	let workspaceId: string | undefined;
	let repositoryId: string | undefined;
	for (const arg of argv) {
		if (arg === "--confirm-archive") {
			confirmArchive = true;
			continue;
		}
		if (arg === "--workspace-id" || arg === "--repository-id") {
			return { error: `${arg} 需要值\n${SESSION_STORE_MIGRATE_USAGE}` };
		}
		if (arg.startsWith("--workspace-id=")) {
			workspaceId = arg.slice("--workspace-id=".length);
			continue;
		}
		if (arg.startsWith("--repository-id=")) {
			repositoryId = arg.slice("--repository-id=".length);
			continue;
		}
		return { error: `migrate session-store 不支持参数: ${arg}\n${SESSION_STORE_MIGRATE_USAGE}` };
	}
	if (!confirmArchive) return { error: "migrate session-store 需要显式 --confirm-archive\n" + SESSION_STORE_MIGRATE_USAGE };
	if (workspaceId !== undefined && !workspaceId.startsWith("workspace_")) {
		return { error: `--workspace-id 必须是 workspace_ 前缀的 Runtime ID\n${SESSION_STORE_MIGRATE_USAGE}` };
	}
	if (repositoryId !== undefined && !repositoryId.startsWith("repository_")) {
		return { error: `--repository-id 必须是 repository_ 前缀的 Runtime ID\n${SESSION_STORE_MIGRATE_USAGE}` };
	}
	return { args: { confirmArchive, workspaceId, repositoryId } };
}

export interface PruneLegacyArgs {
	readonly manifestDigest: string;
	readonly confirmDelete: boolean;
}

export function parsePruneLegacyArgs(argv: readonly string[]): { args?: PruneLegacyArgs; error?: string } {
	let manifestDigest: string | undefined;
	let confirmDelete = false;
	for (const arg of argv) {
		if (arg === "--manifest") {
			return { error: "--manifest 需要值\n" + PRUNE_LEGACY_USAGE };
		}
		if (arg.startsWith("--manifest=")) {
			manifestDigest = arg.slice("--manifest=".length);
			continue;
		}
		if (arg === "--confirm-delete") {
			confirmDelete = true;
			continue;
		}
		return { error: `storage prune-legacy 不支持参数: ${arg}\n${PRUNE_LEGACY_USAGE}` };
	}
	if (!manifestDigest) return { error: "storage prune-legacy 需要 --manifest <digest>\n" + PRUNE_LEGACY_USAGE };
	if (!confirmDelete) return { error: "storage prune-legacy 需要显式 --confirm-delete\n" + PRUNE_LEGACY_USAGE };
	return { args: { manifestDigest, confirmDelete } };
}

export async function runMigrateSessionStoreCommand(argv: readonly string[]): Promise<void> {
	const parsed = parseSessionStoreMigrateArgs(argv);
	if (parsed.error || !parsed.args) {
		process.stderr.write(`[runledger] ${parsed.error ?? "invalid migrate session-store arguments"}`);
		process.exit(2);
		return;
	}
	const environmentError = validateLegacyCliEnvironment();
	if (environmentError) {
		process.stderr.write(`[runledger] ${environmentError}\n`);
		process.exit(2);
		return;
	}
	const { layout } = await resolveRunledgerHome();
	const db = openSessionDatabase(layout.database);
	try {
		let compatibility = checkStoreCompatibility(db);
		if (!compatibility.ok && compatibility.code === "missing_header") {
			// 全新 state.db:安装首版 schema 后再走统一兼容性检查。
			installSessionStoreSchema(db);
			compatibility = checkStoreCompatibility(db);
		}
		if (!compatibility.ok) {
			process.stderr.write(`[runledger] migrate session-store failed: ${compatibility.code}: ${compatibility.detail}\n`);
			process.exit(2);
			return;
		}
		const gateResult = beginOfflineMigration(db);
		if (!gateResult.ok) {
			process.stderr.write(`[runledger] migrate session-store failed: ${gateResult.code}: ${gateResult.detail}\n`);
			process.exit(2);
			return;
		}
		try {
			const result = await migrateJsonlSessions(
				{
					layout,
					db,
					confirmArchive: parsed.args.confirmArchive,
					workspaceId: parsed.args.workspaceId,
					repositoryId: parsed.args.repositoryId,
				},
				gateResult.gate,
			);
			process.stdout.write(
				`[runledger] session-store migration committed: sessions=${result.importedSessions} entries=${result.importedEntries}\n` +
					`[runledger] manifest=${result.manifest.manifestDigest} archive=${result.archiveDir}\n`,
			);
		} catch (error) {
			const message = error instanceof JsonlMigrationError ? `${error.code}: ${error.message}` : String(error);
			process.stderr.write(`[runledger] session-store migration failed: ${message}\n`);
			process.exit(2);
			return;
		} finally {
			// 成功或失败:gate 显式收口,失败时 admission 恢复 ready,source 保持原位。
			gateResult.gate.release();
		}
	} finally {
		db.checkpoint();
		db.close();
	}
}

export async function runPruneLegacyCommand(argv: readonly string[]): Promise<void> {
	const parsed = parsePruneLegacyArgs(argv);
	if (parsed.error || !parsed.args) {
		process.stderr.write(`[runledger] ${parsed.error ?? "invalid storage prune-legacy arguments"}`);
		process.exit(2);
		return;
	}
	const environmentError = validateLegacyCliEnvironment();
	if (environmentError) {
		process.stderr.write(`[runledger] ${environmentError}\n`);
		process.exit(2);
		return;
	}
	const { layout } = await resolveRunledgerHome();
	try {
		const result = await pruneLegacyArchive({
			layout,
			manifestDigest: parsed.args.manifestDigest,
			confirmDelete: parsed.args.confirmDelete,
		});
		process.stdout.write(`[runledger] prune-legacy committed: files=${result.removedFiles} archive=${result.archiveDir}\n`);
	} catch (error) {
		const message = error instanceof JsonlMigrationError ? `${error.code}: ${error.message}` : String(error);
		process.stderr.write(`[runledger] prune-legacy failed: ${message}\n`);
		process.exit(2);
		return;
	}
}

export function sessionStoreSchemaDigest(): string {
	return sessionStoreSchemaFormatDigest();
}
