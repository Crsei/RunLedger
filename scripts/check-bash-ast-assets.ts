import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { scanBashAstSecurityBoundaries } from "./bash-ast-security-boundaries.ts";

const execFileAsync = promisify(execFile);
const repoRoot = dirname(fileURLToPath(import.meta.url));
const root = join(repoRoot, "..");
const assetRoot = join(root, "assets", "tree-sitter");
const maxAssetBytes = 5 * 1024 * 1024;

const expectedAssets = {
	"tree-sitter-bash.wasm": "8292919c88a0f7d3fb31d0cd0253ca5a9531bc1ede82b0537f2c63dd8abe6a7a",
	"web-tree-sitter.wasm": "715cae35f31b7b03a13592bc5ac9039d5c6d2c2bda9f9e0c2b8abab77b3f64cc",
} as const;

async function digest(path: string): Promise<{ readonly size: number; readonly sha256: string }> {
	const bytes = await readFile(path);
	return { size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function assertAssets(): Promise<void> {
	for (const [name, expected] of Object.entries(expectedAssets)) {
		const path = join(assetRoot, name);
		const info = await stat(path);
		if (!info.isFile() || info.size <= 0 || info.size > maxAssetBytes) {
			throw new Error(`invalid Bash AST asset size: ${relative(root, path)}`);
		}
		const actual = await digest(path);
		if (actual.sha256 !== expected) {
			throw new Error(`Bash AST asset hash mismatch: ${relative(root, path)}`);
		}
	}
}

async function assertSingleWasmLoader(): Promise<void> {
	const moduleRoot = join(root, "src", "security", "permission", "bash-ast");
	const files = (await readdir(moduleRoot)).filter((name) => name.endsWith(".ts") && name !== "worker.ts");
	for (const name of files) {
		const text = await readFile(join(moduleRoot, name), "utf8");
		if (/from ["']web-tree-sitter|Language\.load|Parser\.init/u.test(text)) {
			throw new Error(`Tree-sitter WASM loading must remain in worker.ts: ${relative(root, join(moduleRoot, name))}`);
		}
	}
	const legacyHost = await readFile(join(root, "src", "cli", "runtime-host-security.ts"), "utf8");
	if (/bash-ast|BashSecurityAnalyzer/u.test(legacyHost)) {
		throw new Error("legacy Host security must not import or own Bash AST authorization");
	}
}

async function assertPackageManifest(): Promise<void> {
	const packageText = await readFile(join(root, "package.json"), "utf8");
	const packageJson = JSON.parse(packageText) as {
		readonly files?: readonly string[];
		readonly dependencies?: Readonly<Record<string, string>>;
	};
	if (!packageJson.files?.includes("assets/tree-sitter")) {
		throw new Error("package.json files must include assets/tree-sitter");
	}
	for (const name of ["tree-sitter-bash", "web-tree-sitter"] as const) {
		const version = packageJson.dependencies?.[name];
		if (version !== (name === "tree-sitter-bash" ? "0.25.1" : "0.26.11")) {
			throw new Error(`package.json must pin ${name} to an exact version`);
		}
	}
}

async function assertPackedAssets(): Promise<void> {
	const result = await execFileAsync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root });
	const reports = JSON.parse(result.stdout) as readonly { readonly files?: readonly { readonly path: string }[] }[];
	const files = reports.flatMap((report) => report.files ?? []).map((file) => file.path);
	for (const name of Object.keys(expectedAssets)) {
		const packedPath = `assets/tree-sitter/${name}`;
		if (!files.includes(packedPath)) throw new Error(`npm pack omitted ${packedPath}`);
	}
}

function assertSecurityBoundaries(): void {
	const violations = scanBashAstSecurityBoundaries(root);
	if (violations.length === 0) return;
	throw new Error(`Bash AST security boundary violation: ${violations.map((item) => `${item.file}:${item.kind}`).join(", ")}`);
}

try {
	await assertAssets();
	await assertSingleWasmLoader();
	assertSecurityBoundaries();
	await assertPackageManifest();
	await assertPackedAssets();
	console.log("[check:bash-ast-assets] assets, loader boundary, and npm pack contents are valid");
} catch (error) {
	console.error(`[check:bash-ast-assets] ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
