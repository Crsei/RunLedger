/** 检查维护中的 TS consumer 是否由唯一、正确的类型环境覆盖。 */
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const CONFIGS = ["tsconfig.tests.json", "tsconfig.bun-tests.json", "tsconfig.scripts.json", "tsconfig.examples.json"] as const;
const ROOT_CONSUMERS = new Map([["vitest.config.ts", "tsconfig.scripts.json"]]);

async function listTypescriptFiles(directory: string): Promise<string[]> {
	let entries;
	try { entries = await readdir(directory, { withFileTypes: true }); }
	catch (error: unknown) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
	const files = await Promise.all(entries.map(async (entry) => {
		const path = resolve(directory, entry.name);
		return entry.isDirectory() ? listTypescriptFiles(path) : /\.(?:[cm]?ts|tsx)$/.test(path) ? [path] : [];
	}));
	return files.flat();
}

/**
 * workspace 包的 TS 文件必须被该包 `scripts.check` 实际执行的那组 tsconfig 唯一覆盖；
 * 只做 emit 的 tsconfig（如 tsconfig.build.json）不算类型环境。
 */
async function inspectWorkspacePackages(
	root: string,
	diagnostics: string[],
): Promise<{ files: string[]; owners: Map<string, string[]> }> {
	const owners = new Map<string, string[]>(), files: string[] = [];
	let names: string[];
	try { names = (await readdir(resolve(root, "packages"), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(); }
	catch (error: unknown) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return { files, owners };
		throw error;
	}
	for (const name of names) {
		const directory = resolve(root, "packages", name);
		const manifestPath = resolve(directory, "package.json");
		let manifest: { scripts?: Record<string, string> };
		try { manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { scripts?: Record<string, string> }; }
		catch (error: unknown) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") { diagnostics.push(`missing_package_manifest: packages/${name}`); continue; }
			throw error;
		}
		const check = manifest.scripts?.check;
		if (check === undefined) { diagnostics.push(`missing_package_check: packages/${name}`); continue; }
		const configs = [...check.matchAll(/(?:^|\s)-p\s+(\S+)/g)].map((match) => match[1]!);
		if (configs.length === 0) diagnostics.push(`missing_package_check_config: packages/${name}`);
		for (const config of configs) {
			const label = `packages/${name}/${config}`;
			const path = resolve(directory, config);
			const read = ts.readConfigFile(path, ts.sys.readFile);
			if (read.error) { diagnostics.push(`invalid_config: ${label}: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`); continue; }
			const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, directory, undefined, path);
			for (const error of parsed.errors) diagnostics.push(`invalid_config: ${label}: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`);
			for (const file of parsed.fileNames) owners.set(file, [...(owners.get(file) ?? []), label]);
		}
		files.push(...(await listTypescriptFiles(resolve(directory, "src"))), ...(await listTypescriptFiles(resolve(directory, "test"))));
	}
	return { files: files.sort(), owners };
}

async function run(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.length !== 0 && (args.length !== 2 || args[0] !== "--root")) throw new Error("usage: check-typecheck-coverage.ts [--root <directory>]");
	const root = resolve(args[1] ?? fileURLToPath(new URL("..", import.meta.url)));
	const diagnostics: string[] = [];
	const owners = new Map<string, string[]>();
	for (const config of CONFIGS) {
		const path = resolve(root, config);
		const read = ts.readConfigFile(path, ts.sys.readFile);
		if (read.error) {
			diagnostics.push(`invalid_config: ${config}: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`);
			continue;
		}
		const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root, undefined, path);
		for (const error of parsed.errors) diagnostics.push(`invalid_config: ${config}: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`);
		if (config === "tsconfig.bun-tests.json" && !parsed.options.types?.includes("bun")) diagnostics.push(`missing_bun_types: ${config}`);
		if (config !== "tsconfig.bun-tests.json" && parsed.options.types?.includes("bun")) diagnostics.push(`unexpected_bun_types: ${config}`);
		for (const file of parsed.fileNames) owners.set(file, [...(owners.get(file) ?? []), config]);
	}
	const files = [
		...(await Promise.all(["tests", "scripts", "examples"].map((directory) => listTypescriptFiles(resolve(root, directory))))).flat(),
		...Array.from(ROOT_CONSUMERS.keys(), (file) => resolve(root, file)),
	].sort();
	for (const file of files) {
		const path = relative(root, file).replaceAll("\\", "/");
		const fileOwners = owners.get(file) ?? [];
		const expectedOwner = ROOT_CONSUMERS.get(path) ?? (path.startsWith("scripts/") ? "tsconfig.scripts.json" : path.startsWith("examples/") ? "tsconfig.examples.json" : path.endsWith(".bun.test.ts") ? "tsconfig.bun-tests.json" : "tsconfig.tests.json");
		if (fileOwners.length === 0) diagnostics.push(`unowned_consumer: ${path}`);
		else if (fileOwners.length > 1) diagnostics.push(`overlapping_consumer: ${path}: ${fileOwners.join(", ")}`);
		else if (fileOwners[0] !== expectedOwner) diagnostics.push(`wrong_consumer_environment: ${path}: expected ${expectedOwner}`);
	}
	const packages = await inspectWorkspacePackages(root, diagnostics);
	for (const file of packages.files) {
		const path = relative(root, file).replaceAll("\\", "/");
		const fileOwners = packages.owners.get(file) ?? [];
		if (fileOwners.length === 0) diagnostics.push(`unowned_package_consumer: ${path}`);
		else if (fileOwners.length > 1) diagnostics.push(`overlapping_package_consumer: ${path}: ${fileOwners.join(", ")}`);
	}
	for (const diagnostic of diagnostics) console.error(diagnostic);
	console.log(`typecheck coverage: ${files.length + packages.files.length} consumers, ${diagnostics.length} diagnostics`);
	if (diagnostics.length > 0) process.exitCode = 1;
}

run().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
});
