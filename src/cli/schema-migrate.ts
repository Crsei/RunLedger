import { stat } from "node:fs/promises";
import { resolveRunledgerHome } from "../storage/runledger-home.ts";
import { openSessionDatabase } from "../storage/session-store/database.ts";
import { migrateSessionStoreToCurrent } from "../storage/session-store/schema-compatibility.ts";
import { validateLegacyCliEnvironment } from "./authority.ts";

/** 显式离线 schema 迁移；不创建空库、不变更既有 Session 的 profile。 */
export async function runMigrateSchemaCommand(argv: readonly string[]): Promise<void> {
	if (argv.length !== 1 || argv[0] !== "--confirm") {
		process.stderr.write("[runledger] Usage: runledger migrate schema --confirm\nStop all active Sessions before upgrading the existing state.db.\n");
		process.exitCode = 2;
		return;
	}
	try {
		const environmentError = validateLegacyCliEnvironment();
		if (environmentError !== undefined) throw new Error(environmentError);
		const { layout } = await resolveRunledgerHome();
		if (!(await stat(layout.database)).isFile()) throw new Error("state.db is not an existing file");
		const db = openSessionDatabase(layout.database);
		try {
			const result = migrateSessionStoreToCurrent(db);
			if (!result.ok) throw new Error(`${result.code}: ${result.detail}`);
			process.stdout.write(`[runledger] session store schema ${result.storeVersion} ready; existing Session profiles preserved\n`);
		} finally { db.close(); }
	} catch (error) {
		process.stderr.write(`[runledger] schema migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 2;
	}
}
