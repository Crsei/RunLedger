/**
 * Storage/CLI canonical-home 静态边界检查。
 *
 * 历史路径 helper 只允许留在 `src/storage/paths.ts` 作为 migration source
 * locator；canonical writer 不得重新导入它们、写入旧目录或把
 * RUNLEDGER_SESSION_DIR 当成路径解析输入。
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export interface StorageBoundaryViolation {
	readonly file: string;
	readonly reason: string;
}

const SOURCE_LOCATOR_FILE = "src/storage/paths.ts";
const AUTHORITY_CHECK_FILE = "src/cli/authority.ts";
const CANONICAL_WRITER_FILES = new Set([
	"src/storage/settings-manager.ts",
	"src/storage/auth-storage.ts",
	"src/storage/session-manager.ts",
	"src/storage/migration.ts",
	"src/storage/runledger-home.ts",
	"src/cli/main.ts",
	"src/cli/migrate.ts",
]);

const LEGACY_PATH_LITERAL = /(?:~\/\.runledger\/agent|\.runledger\/)/u;
const LEGACY_PATH_IMPORT = /from\s+["'][^"']*\/paths\.ts["']/u;
const LEGACY_ENV_READ = /\benv\.RUNLEDGER_SESSION_DIR\b/u;
const WRITE_CALL = /\b(?:writeFile|appendFile|mkdir|rename|unlink|rm|createWriteStream)\b/u;

function listTypeScriptFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const filePath = join(directory, entry.name);
		if (entry.isDirectory()) return listTypeScriptFiles(filePath);
		return entry.isFile() && entry.name.endsWith(".ts") ? [filePath] : [];
	});
}

export function scanStorageCliBoundaries(repoRoot: string): StorageBoundaryViolation[] {
	const files = [
		...listTypeScriptFiles(join(repoRoot, "src/storage")),
		...listTypeScriptFiles(join(repoRoot, "src/cli")),
	];
	const violations: StorageBoundaryViolation[] = [];
	for (const file of files) {
		const relativePath = relative(repoRoot, file).split("\\").join("/");
		const source = readFileSync(file, "utf8");
		if (relativePath !== SOURCE_LOCATOR_FILE && LEGACY_PATH_IMPORT.test(source)) {
			violations.push({ file: relativePath, reason: "canonical code imports the historical path locator" });
		}
		if (CANONICAL_WRITER_FILES.has(relativePath) && LEGACY_PATH_LITERAL.test(source)) {
			violations.push({ file: relativePath, reason: "canonical writer contains a legacy storage path literal" });
		}
		if (LEGACY_ENV_READ.test(source) && relativePath !== AUTHORITY_CHECK_FILE) {
			violations.push({ file: relativePath, reason: "RUNLEDGER_SESSION_DIR is read outside the fail-closed authority check" });
		}
		if (relativePath === SOURCE_LOCATOR_FILE && WRITE_CALL.test(source)) {
			violations.push({ file: relativePath, reason: "historical path locator contains a filesystem write call" });
		}
	}
	return violations.sort((left, right) => left.file.localeCompare(right.file) || left.reason.localeCompare(right.reason));
}

function run(): void {
	const repoRoot = resolve(process.argv[2] ?? new URL("..", import.meta.url).pathname);
	const violations = scanStorageCliBoundaries(repoRoot);
	if (violations.length > 0) {
		for (const violation of violations) console.error(`${violation.file}: ${violation.reason}`);
		process.exitCode = 1;
		return;
	}
	console.log("storage/CLI boundary check passed");
}

if (process.argv[1]?.endsWith("check-storage-boundaries.ts")) run();
