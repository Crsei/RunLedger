import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	BASH_GRAMMAR_WASM_SHA256,
	BASH_PARSER_DIGEST,
	TREE_SITTER_RUNTIME_WASM_SHA256,
	type BashAstAssetPaths,
} from "./types.ts";

function assetRoot(moduleUrl: string): string {
	return resolve(dirname(fileURLToPath(moduleUrl)), "../../../../assets/tree-sitter");
}

async function verifiedFile(path: string, expectedDigest: string): Promise<string | undefined> {
	try {
		const canonical = await realpath(path);
		const info = await stat(canonical);
		if (!info.isFile() || info.size <= 0 || info.size > 5 * 1024 * 1024) return undefined;
		const digest = createHash("sha256").update(await readFile(canonical)).digest("hex");
		return digest === expectedDigest ? canonical : undefined;
	} catch {
		return undefined;
	}
}

export async function resolveBashAstAssets(
	moduleUrl = import.meta.url,
): Promise<BashAstAssetPaths | undefined> {
	const root = assetRoot(moduleUrl);
	const [runtimeWasm, grammarWasm] = await Promise.all([
		verifiedFile(join(root, "web-tree-sitter.wasm"), TREE_SITTER_RUNTIME_WASM_SHA256),
		verifiedFile(join(root, "tree-sitter-bash.wasm"), BASH_GRAMMAR_WASM_SHA256),
	]);
	if (!runtimeWasm || !grammarWasm) return undefined;
	return {
		runtimeWasm,
		grammarWasm,
		parserDigest: BASH_PARSER_DIGEST,
	};
}
