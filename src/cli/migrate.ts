import { migrateLegacyData, MigrationError } from "../storage/migration.ts";
import { resolveRunledgerHome } from "../storage/runledger-home.ts";
import { validateLegacyCliEnvironment } from "./authority.ts";
import { runMigrateSessionStoreCommand } from "./session-store-migrate.ts";

export interface MigrateArgs {
	readonly source: string;
	readonly confirmDelete: boolean;
}
export interface MigrateParseResult {
	readonly args?: MigrateArgs;
	readonly error?: string;
}

const MIGRATE_USAGE = `Usage: runledger migrate --source <path> --confirm-delete

Destructively migrate current-format legacy settings/auth/AGENTS/session files into
the canonical RUNLEDGER_DIR home, then delete only the verified source manifest.
--dry-run, --read-only and --fallback are not supported.
`;

export function parseMigrateArgs(argv: readonly string[]): MigrateParseResult {
	let source: string | undefined;
	let confirmDelete = false;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]!;
		if (arg === "--source") {
			const value = argv[++index];
			if (value === undefined || value.length === 0) return { error: "migrate --source 缺少值\n" + MIGRATE_USAGE };
			source = value;
			continue;
		}
		if (arg.startsWith("--source=")) {
			const value = arg.slice("--source=".length);
			if (value.length === 0) return { error: "migrate --source 缺少值\n" + MIGRATE_USAGE };
			source = value;
			continue;
		}
		if (arg === "--confirm-delete") {
			confirmDelete = true;
			continue;
		}
		if (arg === "--dry-run" || arg === "--read-only" || arg === "--fallback") {
			return { error: `unsupported_migration_mode: ${arg} 不提供成功路径\n${MIGRATE_USAGE}` };
		}
		return { error: `migrate 不支持参数: ${arg}\n${MIGRATE_USAGE}` };
	}
	if (!source) return { error: "migrate 需要 --source <path>\n" + MIGRATE_USAGE };
	if (!confirmDelete) return { error: "migrate 需要显式 --confirm-delete\n" + MIGRATE_USAGE };
	return { args: { source, confirmDelete } };
}

export async function runMigrateCommand(argv: readonly string[]): Promise<void> {
	if (argv[0] === "session-store") {
		await runMigrateSessionStoreCommand(argv.slice(1));
		return;
	}
	const parsed = parseMigrateArgs(argv);
	if (parsed.error || !parsed.args) {
		process.stderr.write(`[runledger] ${parsed.error ?? "invalid migrate arguments"}`);
		process.exit(2);
		return;
	}
	const environmentError = validateLegacyCliEnvironment();
	if (environmentError) {
		process.stderr.write(`[runledger] ${environmentError}\n`);
		process.exit(2);
		return;
	}
	try {
		const { layout } = await resolveRunledgerHome();
		process.stdout.write(`[runledger] migration source=${parsed.args.source} target=${layout.home}\n`);
		const result = await migrateLegacyData({
			layout,
			sourcePath: parsed.args.source,
			confirmDelete: parsed.args.confirmDelete,
		});
		for (const item of result.items) {
			process.stdout.write(`[runledger] ${item.status} ${item.targetLocator}\n`);
		}
		process.stdout.write(`[runledger] migration ${result.batchId} receipt=${result.receiptPath}\n`);
	} catch (error) {
		const message = error instanceof MigrationError ? `${error.code}: ${error.message}` : String(error);
		process.stderr.write(`[runledger] migration failed: ${message}\n`);
		process.exit(2);
	}
}
